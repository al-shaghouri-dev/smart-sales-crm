# Single-server install (Ubuntu + host Caddy + host PostgreSQL)

`crm-setup.sh` installs or updates Smart Sales CRM on one Ubuntu server without Docker:

| | |
|---|---|
| code | `/opt/crm` (previous release kept in `/opt/crm.prev`, automatic rollback if the new one fails its health check) |
| service | systemd `crm`, dedicated user `crm`, listening on `127.0.0.1:3002` only |
| config | `/etc/crm/crm.env` (`root:crm 640`, secrets generated on the server with `openssl`, first run only) |
| database | PostgreSQL `crm`, roles `crm_owner` (migrations) and `crm_app` (no RLS bypass) |
| backups | **verified dump before every migration** + daily dump at 03:15, kept 14 days, in `/var/backups/crm` |
| Caddy | new Caddyfile installed only if `caddy validate` passes; previous copy kept |
| origin protection | when the site is behind Cloudflare, only Cloudflare IPs may connect (list refreshed on every run, verified after reload, switched off automatically if the site is not reachable through Cloudflare) |

```bash
# first install (as root, on the server)
CRM_DOMAIN=crm.example.com bash crm-setup.sh /tmp/crm-release.tgz /tmp/Caddyfile
# updates: the domain is read from /etc/crm/crm.env
bash crm-setup.sh /tmp/crm-release.tgz /tmp/Caddyfile
```

`crm-release.tgz` is the project source without `node_modules`, `dist` and `.env`; the server runs
`npm ci`, builds the frontend and applies migrations itself. `crm.caddy` is the site block to add to
the Caddyfile (replace `crm.example.com`).
