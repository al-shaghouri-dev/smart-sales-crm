const crypto = require('crypto');
const { SYSTEM_ROLES } = require('../permissions');
const { hashPassword } = require('../security/passwords');
const { conflict, badRequest } = require('../errors');
const { audit } = require('./audit');

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
 * Create a company with its settings, branding, default roles and owner membership.
 * Must run inside a platform-admin context (company INSERT is restricted by RLS).
 * Shared by the CLI today and by Super Admin / self-registration flows in Phase 2.
 */
async function createCompany(trx, req, input) {
  const { name, ownerEmail, ownerName, ownerPassword, status = 'active', timezone = 'UTC', currency = 'USD', defaultLocale = 'en' } = input;
  if (!name || !ownerEmail || !ownerName) throw badRequest('validation.required', 'name, ownerEmail and ownerName are required');

  const companyId = crypto.randomUUID();
  await trx('companies').insert({
    id: companyId, name, slug: await uniqueSlug(trx, name), status,
    timezone, currency, default_locale: defaultLocale, created_by: req?.user?.id || null
  });
  await trx('company_settings').insert({ company_id: companyId });
  await trx('company_branding').insert({ company_id: companyId });
  const roles = await createSystemRoles(trx, companyId);

  let userId = (await trx.raw('SELECT app_user_id_by_email(?) AS id', [ownerEmail])).rows[0].id;
  if (!userId) {
    userId = crypto.randomUUID();
    await trx('users').insert({
      id: userId, email: ownerEmail, name: ownerName,
      password_hash: ownerPassword ? await hashPassword(ownerPassword) : null,
      password_changed_at: ownerPassword ? trx.fn.now() : null
    });
  }
  await trx('company_memberships').insert({ company_id: companyId, user_id: userId, role_id: roles.owner, status: 'active' });

  await audit(trx, req, { action: 'company.created', companyId, entityType: 'company', entityId: companyId, after: { name, status, ownerEmail } });
  return { companyId, ownerUserId: userId, roles };
}

module.exports = { createCompany, createSystemRoles, slugify };
