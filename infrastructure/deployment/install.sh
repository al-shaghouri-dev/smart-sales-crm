#!/usr/bin/env bash
# =====================================================================================================
# Smart Sales CRM — one-command installer for a fresh Ubuntu 22.04/24.04 or Debian 12 server.
#
#   sudo bash install.sh --domain crm.example.com --email you@example.com
#
# Uploaded the application yourself (e.g. unzipped to /opt/smart-sales-crm)? Run the script from there:
#   sudo bash /opt/smart-sales-crm/infrastructure/deployment/install.sh --domain … --email …
# It then uses those files instead of downloading from GitHub.
#
# What it does (safe to run again; it never overwrites an existing .env or database):
#   1. checks the server and that the domain's DNS points here
#   2. installs Docker (official script) and git if missing; adds swap on small servers
#   3. downloads the application to /opt/smart-sales-crm (branch saas/phase-0-1-clean)
#   4. creates /opt/smart-sales-crm/.env with secrets generated ON THIS SERVER (never sent anywhere)
#   5. starts PostgreSQL → migrations → app → Caddy (automatic HTTPS for your domain)
#   6. creates the first Super Admin and prints its one-time password ONCE
#   7. installs a daily database backup (14 days kept) and opens ports 22/80/443 if ufw is active
# =====================================================================================================
set -euo pipefail

DOMAIN=""; EMAIL=""
REPO="${SSCRM_REPO:-https://github.com/al-shaghouri-dev/smart-sales-crm.git}"
BRANCH="${SSCRM_BRANCH:-saas/phase-0-1-clean}"
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd || true)"
# Default: the copy this script belongs to when it was uploaded with the app, else /opt/smart-sales-crm.
if [ -n "$SCRIPT_ROOT" ] && [ -f "$SCRIPT_ROOT/Dockerfile" ] && [ -f "$SCRIPT_ROOT/package.json" ]; then DEFAULT_DIR="$SCRIPT_ROOT"; else DEFAULT_DIR=/opt/smart-sales-crm; fi
DIR="${SSCRM_DIR:-$DEFAULT_DIR}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"
BUILD_FLAG="${SSCRM_BUILD_FLAG:---build}"   # testing hook: "--no-build" reuses an existing image

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run as root: sudo bash install.sh --domain <domain> --email <email>"
[ -n "$DOMAIN" ] || die "Missing --domain (e.g. crm.example.com)"
[ -n "$EMAIL" ] || die "Missing --email (Super Admin login and Let's Encrypt notices)"
echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$|^localhost$' || die "Invalid domain: $DOMAIN"
echo "$EMAIL" | grep -Eq '^[^@ ]+@[^@ ]+\.[^@ ]+$' || die "Invalid email: $EMAIL"

say "1/7 Checking the server"
. /etc/os-release 2>/dev/null || true
echo "System: ${PRETTY_NAME:-unknown}, $(nproc) CPU, $(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo) RAM, $(df -h / | awk 'NR==2{print $4}') free disk"
case "${ID:-}" in ubuntu|debian) ;; *) warn "Tested on Ubuntu/Debian; continuing on ${ID:-unknown}." ;; esac
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl; }
if [ "$SKIP_DNS_CHECK" != "1" ] && [ "$DOMAIN" != "localhost" ]; then
  PUBLIC_IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
  DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
  echo "Server public IP: ${PUBLIC_IP:-unknown} · $DOMAIN resolves to: ${DNS_IP:-nothing}"
  if [ -z "$DNS_IP" ] || [ "$DNS_IP" != "$PUBLIC_IP" ]; then
    die "The DNS A record of $DOMAIN must point to ${PUBLIC_IP:-this server} before installing (HTTPS certificate). Fix DNS, wait a few minutes, run again. (Behind a proxy/CDN: SKIP_DNS_CHECK=1)"
  fi
fi

say "2/7 Installing Docker and git"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (install docker-compose-plugin)"
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
command -v openssl >/dev/null || { apt-get update -qq && apt-get install -y -qq openssl; }
systemctl enable --now docker >/dev/null 2>&1 || true
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && ! swapon --show | grep -q .; then
  echo "Less than 2 GB RAM: adding a 2 GB swap file (needed for the build)."
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "3/7 Downloading the application ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin "$BRANCH" && git -C "$DIR" checkout --quiet "$BRANCH" && git -C "$DIR" pull --quiet --ff-only origin "$BRANCH"
elif [ -f "$DIR/package.json" ] && [ -f "$DIR/Dockerfile" ]; then
  echo "Using the files already uploaded to $DIR (no download)."
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"
echo "Version: $(git rev-parse --short HEAD 2>/dev/null || echo uploaded-copy)"

say "4/7 Creating configuration (secrets are generated here and stay on this server)"
FIRST_INSTALL=0
ADMIN_PASSWORD=""
if [ ! -f .env ]; then
  FIRST_INSTALL=1
  hex() { openssl rand -hex "$1"; }
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)Aa9"
  umask 077
  cat > .env <<ENV
# Generated by install.sh on $(date -u +%F). Keep a copy of this file in a password manager.
NODE_ENV=production
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
APP_URL=https://$DOMAIN
TRUST_PROXY=1
POSTGRES_SUPERUSER_PASSWORD=$(hex 24)
SSCRM_OWNER_PASSWORD=$(hex 24)
SSCRM_APP_PASSWORD=$(hex 24)
SSCRM_DB_NAME=sscrm
APP_ENCRYPTION_KEYS=k1:$(openssl rand -base64 32)
APP_ENCRYPTION_PRIMARY_KEY_ID=k1
WEBHOOK_SECRET_KEY=$(openssl rand -base64 32)
CHANNEL_PROVIDERS=telegram
BOOTSTRAP_ADMIN_EMAIL=$EMAIL
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASSWORD
# Optional email (otherwise invitation/reset links are shown on screen):
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
ENV
  chmod 600 .env
  echo "Created $DIR/.env (mode 600)."
else
  echo "Existing .env kept unchanged."
  # A previous run stopped before finishing: the one-time admin password is still pending.
  if grep -q '^BOOTSTRAP_ADMIN_PASSWORD=' .env; then
    FIRST_INSTALL=1
    ADMIN_PASSWORD="$(grep '^BOOTSTRAP_ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2-)"
    EMAIL="$(grep '^BOOTSTRAP_ADMIN_EMAIL=' .env | head -1 | cut -d= -f2- || echo "$EMAIL")"
  fi
fi

say "5/7 Building and starting (first build takes a few minutes)"
C="docker compose -f infrastructure/docker/docker-compose.production.yml --env-file .env --profile caddy"
$C up -d $BUILD_FLAG
echo "Waiting for the application to become ready…"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:3000/api/ready >/dev/null 2>&1; then echo "Application ready."; break; fi
  sleep 5
  [ "$i" = "60" ] && { $C logs --tail 50 migrate app; die "The application did not become ready (logs above)."; }
done

if [ "$FIRST_INSTALL" = "1" ]; then
  # The admin now exists: remove the one-time password from the configuration.
  sed -i '/^BOOTSTRAP_ADMIN_EMAIL=/d;/^BOOTSTRAP_ADMIN_PASSWORD=/d' .env
  $C up -d --no-build app >/dev/null 2>&1 || true
fi

say "6/7 Checking HTTPS for https://$DOMAIN"
HTTPS_OK=0
for i in $(seq 1 24); do
  if curl -fsS --max-time 10 "https://$DOMAIN/api/ready" >/dev/null 2>&1; then HTTPS_OK=1; break; fi
  sleep 5
done
[ "$HTTPS_OK" = "1" ] && echo "HTTPS works." || warn "HTTPS not reachable yet. Check ports 80/443 in your provider's firewall, then: $C logs caddy"

say "7/7 Backups and firewall"
install -d -m 700 "$DIR/backups"
cat > /etc/cron.d/smart-sales-crm-backup <<CRON
# Daily database backup at 03:30 (kept 14 days) — $DIR/backups
30 3 * * * root cd $DIR && $C exec -T db pg_dump -U postgres -d sscrm --format=custom --exclude-schema=pgboss -f /backups/sscrm-\$(date +\%F).dump && chmod 600 $DIR/backups/*.dump && find $DIR/backups -name 'sscrm-*.dump' -mtime +14 -delete
CRON
echo "Daily backup installed (/etc/cron.d/smart-sales-crm-backup)."
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  echo "ufw: ports 22, 80, 443 allowed."
fi

printf '\n\033[1;32m================ Installation complete ================\033[0m\n'
echo "Site:        https://$DOMAIN"
echo "Super Admin: https://$DOMAIN/admin/login"
if [ "$FIRST_INSTALL" = "1" ]; then
  echo "  email:     $EMAIL"
  echo "  password:  $ADMIN_PASSWORD   <- shown ONCE. Sign in and change it in 'My account'."
fi
echo
echo "IMPORTANT: copy $DIR/.env to a password manager (it holds the encryption key)."
echo "Logs:      cd $DIR && $C logs -f app"
echo "Update:    sudo bash $DIR/infrastructure/deployment/install.sh --domain $DOMAIN --email $EMAIL"
