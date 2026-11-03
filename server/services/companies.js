const crypto = require('crypto');
const { SYSTEM_ROLES } = require('../permissions');
const { hashPassword } = require('../security/passwords');
const { conflict, badRequest } = require('../errors');
const { audit } = require('./audit');
const { issueToken } = require('./tokens');
const { addPeriod } = require('./subscriptions');

function slugify(name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'company';
}

async function uniqueSlug(trx, name) {
  const base = slugify(name);
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    const taken = await trx('companies').where({ slug: candidate }).first('id');
    if (!taken) return candidate;
  }
  throw conflict('company.slug_taken', 'Could not generate a unique company slug');
}

/** Create the default roles (+ permissions) for a company. Returns { [key]: roleId }. */
async function createSystemRoles(trx, companyId) {
  const ids = {};
  for (const role of SYSTEM_ROLES) {
    const id = crypto.randomUUID();
    await trx('roles').insert({ id, company_id: companyId, key: role.key, is_system: true, is_owner: Boolean(role.isOwner) });
    if (role.permissions.length) {
      await trx('role_permissions').insert(role.permissions.map(p => ({ company_id: companyId, role_id: id, permission_key: p })));
    }
    ids[role.key] = id;
  }
  return ids;
}

/**
 * Create or replace a company's subscription from a plan.
 * input: { planId, status, interval?, startsAt?, endsAt?, periods?, price?, currency?, trial?, notes? }
 */
async function upsertSubscription(trx, req, companyId, input) {
  const plan = await trx('plans').where({ id: input.planId }).first();
  if (!plan) throw badRequest('plans.not_found', 'Plan not found', { field: 'planId' });
  const interval = input.interval || plan.billing_interval;
  const durationDays = input.durationDays || plan.duration_days;
  if (interval === 'custom' && !durationDays && !input.endsAt) throw badRequest('validation.required', 'Custom plans need a duration or end date', { field: 'endsAt' });
  const status = input.status || 'active';
  const trial = Boolean(input.trial) && plan.trial_days > 0;
  const startsAt = input.startsAt ? new Date(input.startsAt) : (status === 'pending' ? null : new Date());
  let endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (!endsAt && startsAt) {
    endsAt = trial ? new Date(startsAt.getTime() + plan.trial_days * 86400000) : addPeriod(startsAt, interval, input.periods || 1, durationDays);
  }
  if (startsAt && endsAt && endsAt <= startsAt) throw badRequest('subscription.invalid_dates', 'End date must be after start date', { field: 'endsAt' });
  const row = {
    company_id: companyId, plan_id: plan.id, status, billing_interval: interval,
    price: input.price !== undefined ? input.price : (trial ? 0 : plan.price),
    currency: input.currency || plan.currency, is_trial: trial,
    starts_at: startsAt, ends_at: endsAt, notes: input.notes ?? null,
    cancelled_at: status === 'cancelled' ? new Date() : null, updated_by: req?.user?.id || null, updated_at: new Date()
  };
  const before = await trx('subscriptions').where({ company_id: companyId }).first();
  if (before) await trx('subscriptions').where({ company_id: companyId }).update(row);
  else await trx('subscriptions').insert(row);
  const after = await trx('subscriptions').where({ company_id: companyId }).first();
  await audit(trx, req, { action: before ? 'subscription.updated' : 'subscription.created', companyId, entityType: 'subscription', entityId: after.id, before, after });
  return after;
}

/**
 * Create a company with its settings, branding, default roles and owner membership.
 * Must run inside a platform-admin context (company INSERT is restricted by RLS).
 * Shared by the CLI, the Super Admin console and approval of self-registrations.
 *
 * If `ownerPassword` is omitted and the owner account is new, the owner is created as "invited"
 * and a one-time invitation token is returned (`inviteToken`) — no password is ever generated.
 */
async function createCompany(trx, req, input) {
  const {
    name, ownerEmail, ownerName, ownerPhone = null, ownerPassword, status = 'active', timezone = 'UTC', currency = 'USD', defaultLocale = 'en',
    email = null, phone = null, country = null, businessType = null, subscription = null
  } = input;
  if (!name || !ownerEmail || !ownerName) throw badRequest('validation.required', 'name, ownerEmail and ownerName are required');

  const companyId = crypto.randomUUID();
  await trx('companies').insert({
    id: companyId, name, slug: await uniqueSlug(trx, name), status,
    timezone, currency, default_locale: defaultLocale, email, phone, country, business_type: businessType,
    created_by: req?.user?.id || null
  });
  await trx('company_settings').insert({ company_id: companyId });
  await trx('company_branding').insert({ company_id: companyId });
  const roles = await createSystemRoles(trx, companyId);

  let userId = (await trx.raw('SELECT app_user_id_by_email(?) AS id', [ownerEmail])).rows[0].id;
  let inviteToken = null;
  const existingAccount = Boolean(userId);
  if (!userId) {
    userId = crypto.randomUUID();
    await trx('users').insert({
      id: userId, email: ownerEmail, name: ownerName, phone: ownerPhone,
      password_hash: ownerPassword ? await hashPassword(ownerPassword) : null,
      password_changed_at: ownerPassword ? trx.fn.now() : null,
      status: ownerPassword ? 'active' : 'invited'
      // locale stays NULL: the UI follows the person's device until they choose a language themselves.
    });
    if (!ownerPassword) inviteToken = await issueToken(trx, { purpose: 'invite', userId, companyId, createdBy: req?.user?.id });
  }
  await trx('company_memberships').insert({ company_id: companyId, user_id: userId, role_id: roles.owner, status: 'active' });

  await audit(trx, req, { action: 'company.created', companyId, entityType: 'company', entityId: companyId, after: { name, status, ownerEmail } });
  if (subscription?.planId) await upsertSubscription(trx, req, companyId, subscription);
  return { companyId, ownerUserId: userId, roles, inviteToken, existingAccount };
}

module.exports = { createCompany, createSystemRoles, upsertSubscription, slugify };
