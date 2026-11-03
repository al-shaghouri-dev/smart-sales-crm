const { conflict } = require('../errors');

/**
 * Plan seat limits, safe under concurrency.
 *
 * Every path that can make a membership ACTIVE (add, invite, reactivate) must call
 * `reserveSeat(trx, companyId)` inside the same transaction that writes the membership.
 * A transaction-scoped advisory lock serialises those transactions per company, so the
 * count → insert sequence cannot interleave; the lock is released automatically on commit
 * or rollback. The limit is re-read inside the lock (never trusted from the request).
 */
const SEAT_LOCK_NAMESPACE = 727002;

async function reserveSeat(trx, companyId) {
  await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [SEAT_LOCK_NAMESPACE, String(companyId)]);
  const limit = await trx('subscriptions as s').join('plans as p', 'p.id', 's.plan_id')
    .where('s.company_id', companyId).first('p.max_employees');
  const max = limit?.max_employees;
  if (!max) return; // no subscription, or unlimited plan
  const used = await trx('company_memberships').where({ company_id: companyId, status: 'active' }).count('* as n').first();
  if (Number(used.n) >= max) throw conflict('team.plan_limit', `Your plan allows up to ${max} team members`);
}

module.exports = { reserveSeat, SEAT_LOCK_NAMESPACE };
