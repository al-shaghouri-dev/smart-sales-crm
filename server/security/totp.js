const crypto = require('crypto');

/**
 * TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) — compatible with Google Authenticator,
 * Microsoft Authenticator, 1Password, Authy, etc. No external dependency.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/**
 * Returns the matched time step (to store for replay protection) or null.
 * Accepts the previous, current and next step (±30 s clock drift) and never a step ≤ lastStep.
 */
function verify(secret, code, { lastStep = 0, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = currentStep(now);
  for (const step of [s - 1, s, s + 1]) {
    if (step <= lastStep) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

const otpauthUrl = ({ secret, account, issuer }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

/** Recovery codes: 10 × "xxxx-xxxx" (lowercase base32, ~40 bits each); only SHA-256 hashes are stored. */
const hashRecovery = code => crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-z2-7]/g, '')).digest('hex');
function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(5)).toLowerCase().slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

module.exports = { generateSecret, verify, codeAt, currentStep, otpauthUrl, generateRecoveryCodes, hashRecovery, base32Encode, base32Decode };
