/** Keys that must never be written to the audit log. */
const SENSITIVE = /password|token|secret|hash|credential/i;

function scrub(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : scrub(v)]));
}

/** Only keep fields whose value changed, so entries stay small and readable. */
function diff(before, after) {
  if (!before || !after) return { before: scrub(before) || null, after: scrub(after) || null };
  const b = {}, a = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updated_at') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) { b[key] = before[key]; a[key] = after[key]; }
  }
  return { before: scrub(b), after: scrub(a) };
}

/**
 * Record an audit event inside the caller's transaction.
 * @param trx  knex transaction (already carrying the security context)
 * @param req  express request (actor + ip), may be null for CLI actions
 */
async function audit(trx, req, { action, companyId = null, entityType = null, entityId = null, before = null, after = null }) {
  const changes = before || after ? diff(before, after) : { before: null, after: null };
  await trx('audit_logs').insert({
    company_id: companyId,
    actor_user_id: req?.user?.id || null,
    actor_email: req?.user?.email || null,
    action,
    entity_type: entityType,
    entity_id: entityId ? String(entityId) : null,
    before: changes.before ? JSON.stringify(changes.before) : null,
    after: changes.after ? JSON.stringify(changes.after) : null,
    ip: req?.ip || null,
    user_agent: req?.get ? String(req.get('user-agent') || '').slice(0, 300) : null
  });
}

module.exports = { audit, scrub };
