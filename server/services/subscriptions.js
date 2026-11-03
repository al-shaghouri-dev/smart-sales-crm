const { compose } = require('./mailer');

const DAY = 24 * 3600 * 1000;
const NOTICE_DAYS = [7, 1];
const INACTIVE = ['expired', 'suspended', 'cancelled'];

/** End date for one or more billing periods starting at `start`. Calendar months/years, clamped (Jan 31 + 1 month = Feb 28/29). */
function addPeriod(start, interval, count = 1, durationDays = null) {
  const d = new Date(start);
  if (interval === 'custom') return new Date(d.getTime() + count * durationDays * DAY);
  const months = interval === 'year' ? 12 * count : count;
  const day = d.getUTCDate();
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, lastDay));
  return r;
}

/** Monthly-equivalent revenue of a subscription (for MRR). */
function monthlyValue(sub) {
  const price = Number(sub.price) || 0;
  if (sub.is_trial || price === 0) return 0;
  if (sub.billing_interval === 'month') return price;
  if (sub.billing_interval === 'year') return price / 12;
  const days = (new Date(sub.ends_at) - new Date(sub.starts_at)) / DAY;
  return days > 0 ? price * (30 / days) : 0;
}

/**
 * What a company may do given its subscription and the platform policy.
 *   full       – no subscription record (manually managed / legacy) or active / pending / trial
 *   read_only  – inactive subscription, policy "read_only": reads allowed, writes refused
 *   blocked    – inactive subscription, policy "block": only billing / account pages
 */
function accessFor(sub, policy, now = new Date()) {
  if (!sub) return 'full';
  const lapsed = sub.status === 'active' && sub.ends_at && new Date(sub.ends_at) <= now;
  if (!INACTIVE.includes(sub.status) && !lapsed) return 'full';
  return policy === 'block' ? 'blocked' : 'read_only';
}

function summary(sub, plan, policy, now = new Date()) {
  if (!sub) return null;
  const daysLeft = sub.ends_at ? Math.ceil((new Date(sub.ends_at) - now) / DAY) : null;
  return {
    status: sub.status, isTrial: sub.is_trial, interval: sub.billing_interval, price: Number(sub.price), currency: sub.currency,
    startsAt: sub.starts_at, endsAt: sub.ends_at, daysLeft, access: accessFor(sub, policy, now),
    plan: plan ? { id: plan.id, key: plan.key, name: plan.name, maxEmployees: plan.max_employees, maxChannels: plan.max_channels, features: plan.features } : null
  };
}

/**
 * Hourly maintenance (idempotent):
 *  - active subscriptions past ends_at → status "expired" (data is never touched or deleted)
 *  - notify owners/billing admins 7 and 1 days before expiry and on expiry (deduplicated per period)
 * Runs in platform context. Returns counts for logging/tests.
 */
const MAINTENANCE_LOCK = 727001;

async function runSubscriptionMaintenance(db, { mailer, appName, now = new Date() } = {}) {
  const result = { expired: 0, notified: 0, emailed: 0, skipped: false };
  await db.withContext({ platformAdmin: true }, async trx => {
    // Transaction-scoped lock: only one instance runs maintenance at a time; released on commit.
    const lock = await trx.raw('SELECT pg_try_advisory_xact_lock(?) AS ok', [MAINTENANCE_LOCK]);
    if (!lock.rows[0].ok) { result.skipped = true; return; }
    const expired = await trx('subscriptions').where({ status: 'active' }).where('ends_at', '<=', now)
      .update({ status: 'expired', updated_at: now }).returning(['id', 'company_id', 'ends_at']);
    result.expired = expired.length;
    for (const s of expired) {
      await trx('audit_logs').insert({ company_id: s.company_id, action: 'subscription.expired', entity_type: 'subscription', entity_id: s.id, after: JSON.stringify({ ends_at: s.ends_at }) });
    }

    const horizon = new Date(now.getTime() + Math.max(...NOTICE_DAYS) * DAY);
    const candidates = await trx('subscriptions as s').join('companies as c', 'c.id', 's.company_id')
      .where(q => q.where(q2 => q2.where('s.status', 'active').where('s.ends_at', '<=', horizon)).orWhereIn('s.id', expired.map(e => e.id)))
      .select('s.id', 's.company_id', 's.status', 's.ends_at', 'c.name as company_name', 'c.default_locale');

    for (const s of candidates) {
      const daysLeft = Math.ceil((new Date(s.ends_at) - now) / DAY);
      let type, stage;
      if (s.status === 'expired') { type = 'subscription_expired'; stage = 'expired'; }
      else { stage = NOTICE_DAYS.filter(d => daysLeft <= d).sort((a, b) => a - b)[0]; type = 'subscription_expiring'; }
      if (!stage) continue;
      // One notification per user, per subscription period, per stage.
      const dedupe = `sub:${s.id}:${new Date(s.ends_at).toISOString()}:${stage}`;
      const recipients = await trx('company_memberships as m').join('users as u', 'u.id', 'm.user_id')
        .join('role_permissions as rp', 'rp.role_id', 'm.role_id')
        .where({ 'm.company_id': s.company_id, 'm.status': 'active', 'u.status': 'active', 'rp.permission_key': 'billing.view' })
        .distinct('u.id', 'u.email', 'u.locale');
      for (const r of recipients) {
        const inserted = await trx('notifications').insert({
          company_id: s.company_id, user_id: r.id, type, dedupe_key: dedupe,
          data: JSON.stringify({ daysLeft: Math.max(daysLeft, 0), endsAt: s.ends_at })
        }).onConflict(['user_id', 'dedupe_key']).ignore().returning('id');
        if (!inserted.length) continue;
        result.notified++;
        if (mailer?.enabled) {
          const msg = compose(type, r.locale || s.default_locale, appName || 'CRM', s.company_name, Math.max(daysLeft, 0));
          const sent = await mailer.send({ to: r.email, ...msg });
          if (sent.delivered) result.emailed++;
        }
      }
    }
  });
  return result;
}

// Scheduling lives in server/jobs (pg-boss schedule "subscription.maintenance"), so there is a single
// scheduler across all instances. The transaction-scoped advisory lock above remains as a safety net.

module.exports = { addPeriod, monthlyValue, accessFor, summary, runSubscriptionMaintenance, INACTIVE };
