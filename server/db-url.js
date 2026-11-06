/**
 * Normalise PostgreSQL connection strings from managed providers.
 *  - Neon adds `channel_binding=require`, which node-postgres does not read from URLs; it is removed
 *    (TLS with certificate verification still applies through `sslmode`).
 * Returns the input unchanged when it is not a parseable URL.
 */
function normalizePgUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch { return raw; }
}

module.exports = { normalizePgUrl };
