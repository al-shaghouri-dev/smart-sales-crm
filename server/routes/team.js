const express = require('express');
const crypto = require('crypto');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { hashPassword, validatePassword, MIN_LENGTH } = require('../security/passwords');
const { badRequest, conflict, forbidden, notFound } = require('../errors');
const { audit } = require('../services/audit');
const { issueToken, linkFor } = require('../services/tokens');
const { compose } = require('../services/mailer');

const MEMBER_FIELDS = ['m.id', 'm.user_id', 'm.status', 'm.job_title', 'm.created_at', 'm.role_id',
  'u.name', 'u.email', 'u.phone', 'u.last_login_at', 'u.status as user_status', 'r.key as role_key', 'r.name as role_name', 'r.is_owner'];

const out = m => ({
  id: m.id, userId: m.user_id, name: m.name, email: m.email, phone: m.phone, status: m.status, jobTitle: m.job_title,
  invitationPending: m.user_status === 'invited',
  roleId: m.role_id, roleKey: m.role_key, roleName: m.role_name, isOwner: m.is_owner, createdAt: m.created_at, lastLoginAt: m.last_login_at
});

module.exports = function teamRoutes({ db, config, mailer }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);
  const members = (trx, companyId) => trx('company_memberships as m')
    .join('users as u', 'u.id', 'm.user_id').join('roles as r', 'r.id', 'm.role_id')
    .where('m.company_id', companyId);
  const actorIsOwner = req => Boolean(req.membership?.is_owner);

  async function getMember(trx, req, id) {
    const m = await members(trx, req.company.id).where('m.id', v.uuid(id)).first(MEMBER_FIELDS);
    if (!m) throw notFound('team.not_found', 'Team member not found');
    return m;
  }
  async function getRole(trx, req, roleId) {
    const role = await trx('roles').where({ id: v.uuid(roleId, { field: 'roleId' }), company_id: req.company.id }).first();
    if (!role) throw badRequest('team.invalid_role', 'Role not found', { field: 'roleId' });
    if (role.is_owner && !actorIsOwner(req)) throw forbidden('team.owner_only', 'Only owners can assign the owner role');
    return role;
  }
  async function activeOwnerCount(trx, companyId) {
    const r = await trx('company_memberships as m').join('roles as r', 'r.id', 'm.role_id')
      .where({ 'm.company_id': companyId, 'm.status': 'active', 'r.is_owner': true }).count('* as n').first();
    return Number(r.n);
  }
  /** A tenant admin may only change credentials/identity of accounts that belong solely to this tenant. */
  async function assertAccountManageable(trx, req, member) {
    if (member.is_owner && !actorIsOwner(req)) throw forbidden('team.owner_only', 'Only owners can manage an owner');
    const shared = (await trx.raw('SELECT app_user_external_membership_count(?, ?) AS n', [member.user_id, req.company.id])).rows[0].n;
    const platform = (await trx.raw('SELECT app_user_is_platform_admin(?) AS p', [member.user_id])).rows[0].p;
    if (shared > 0 || platform) throw forbidden('team.shared_account', 'This account is shared with another workspace and can only be changed by its owner');
  }

  /** Plan seat limit: active + invited members count against max_employees (null = unlimited). */
  async function assertSeatAvailable(trx, req) {
    const max = req.subscription?.plan?.max_employees;
    if (!max) return;
    const r = await trx('company_memberships').where({ company_id: req.company.id, status: 'active' }).count('* as n').first();
    if (Number(r.n) >= max) throw conflict('team.plan_limit', `Your plan allows up to ${max} team members`);
  }

  /** Email the one-time link if email is configured; otherwise return it once to the admin to share. */
  async function deliverLink(req, member, purpose, token) {
    const link = linkFor(config, purpose, token);
    let emailSent = false;
    if (mailer.enabled) {
      const app = (await db.withContext({}, trx => trx('platform_settings').where({ id: 1 }).first('app_name'))).app_name;
      emailSent = (await mailer.send({ to: member.email, ...compose(purpose, req.company.default_locale, app, req.company.name, link) })).delivered;
    }
    return { emailSent, link: emailSent ? undefined : link };
  }

  router.get('/', requirePermission('users.view', 'users.manage'), async (req, res) => {
    const rows = await tenant(req, trx => members(trx, req.company.id).orderBy('m.created_at').select(MEMBER_FIELDS));
    res.json({ members: rows.map(out) });
  });

  router.post('/', requirePermission('users.manage'), async (req, res) => {
    const b = req.body || {};
    const name = v.str(b.name, { field: 'name', required: true, max: 120 });
    const email = v.email(b.email);
    const phone = v.str(b.phone, { field: 'phone', max: 40 });
    const jobTitle = v.str(b.jobTitle, { field: 'jobTitle', max: 120 });
    const status = v.oneOf(b.status || 'active', ['active', 'inactive'], { field: 'status' });
    // No password → the member receives a one-time invitation link and chooses their own password.
    const invite = b.password === undefined || b.password === null || b.password === '';
    if (!invite && !validatePassword(b.password)) throw badRequest('validation.password', `Password must be at least ${MIN_LENGTH} characters`, { field: 'password' });
    const passwordHash = invite ? null : await hashPassword(b.password);
    let inviteToken = null;

    const member = await tenant(req, async trx => {
      const role = await getRole(trx, req, b.roleId);
      await assertSeatAvailable(trx, req);
      const existing = (await trx.raw('SELECT app_user_id_by_email(?) AS id', [email])).rows[0].id;
      // Linking existing accounts across workspaces needs an invitation flow (Phase 2).
      if (existing) throw conflict('team.email_taken', 'An account with this email already exists');
      const userId = crypto.randomUUID();
      await trx('users').insert({
        id: userId, email, name, phone, password_hash: passwordHash, password_changed_at: invite ? null : trx.fn.now(),
        status: invite ? 'invited' : 'active' // locale left NULL so device-language detection applies
      });
      const id = crypto.randomUUID();
      await trx('company_memberships').insert({ id, company_id: req.company.id, user_id: userId, role_id: role.id, status, job_title: jobTitle });
      const m = await getMember(trx, req, id);
      if (invite) inviteToken = await issueToken(trx, { purpose: 'invite', userId, companyId: req.company.id, createdBy: req.user.id });
      await audit(trx, req, { action: invite ? 'team.member_invited' : 'team.member_added', companyId: req.company.id, entityType: 'membership', entityId: id, after: out(m) });
      return m;
    });
    if (!inviteToken) return res.status(201).json({ member: out(member) });
    const delivery = await deliverLink(req, member, 'invite', inviteToken);
    res.status(201).json({ member: out(member), ...delivery });
  });

  router.patch('/:id', requirePermission('users.manage'), async (req, res) => {
    const b = req.body || {};
    const member = await tenant(req, async trx => {
      const before = await getMember(trx, req, req.params.id);
      const isSelf = before.user_id === req.user.id;
      const membershipPatch = v.compact({
        status: v.oneOf(b.status, ['active', 'inactive'], { field: 'status' }) ?? undefined,
        job_title: v.str(b.jobTitle, { field: 'jobTitle', max: 120 })
      });
      if (b.roleId !== undefined) {
        const role = await getRole(trx, req, b.roleId);
        if (isSelf && role.id !== before.role_id) throw forbidden('team.self_role', 'You cannot change your own role');
        membershipPatch.role_id = role.id;
      }
      if (isSelf && membershipPatch.status === 'inactive') throw forbidden('team.self_deactivate', 'You cannot deactivate yourself');
      if (membershipPatch.status === 'active' && before.status !== 'active') await assertSeatAvailable(trx, req);
      if (before.is_owner && (membershipPatch.role_id || membershipPatch.status) && !actorIsOwner(req)) throw forbidden('team.owner_only', 'Only owners can manage an owner');

      const userPatch = v.compact({
        name: v.str(b.name, { field: 'name', max: 120, min: 1 }) ?? undefined,
        phone: v.str(b.phone, { field: 'phone', max: 40 })
      });
      if (Object.keys(userPatch).length && !isSelf) await assertAccountManageable(trx, req, before);

      if (Object.keys(membershipPatch).length) {
        await trx('company_memberships').where({ id: before.id, company_id: req.company.id }).update({ ...membershipPatch, updated_at: trx.fn.now() });
      }
      if (Object.keys(userPatch).length) await trx('users').where({ id: before.user_id }).update(userPatch);
      if (before.is_owner && await activeOwnerCount(trx, req.company.id) === 0) throw conflict('team.last_owner', 'The workspace must keep at least one active owner');

      const after = await getMember(trx, req, before.id);
      await audit(trx, req, { action: 'team.member_updated', companyId: req.company.id, entityType: 'membership', entityId: before.id, before: out(before), after: out(after) });
      return after;
    });
    if (member.status !== 'active') {
      await db.knex('sessions').where({ user_id: member.userId ?? member.user_id, company_id: req.company.id }).del();
    }
    res.json({ member: out(member) });
  });

  router.post('/:id/password', requirePermission('users.manage'), async (req, res) => {
    if (!validatePassword(req.body?.password)) throw badRequest('validation.password', `Password must be at least ${MIN_LENGTH} characters`, { field: 'password' });
    const hash = await hashPassword(req.body.password);
    const member = await tenant(req, async trx => {
      const m = await getMember(trx, req, req.params.id);
      if (m.user_id === req.user.id) throw badRequest('team.use_account_page', 'Change your own password from your account page');
      await assertAccountManageable(trx, req, m);
      await trx('users').where({ id: m.user_id }).update({ password_hash: hash, password_changed_at: trx.fn.now() });
      await audit(trx, req, { action: 'team.password_reset', companyId: req.company.id, entityType: 'membership', entityId: m.id });
      return m;
    });
    await db.knex('sessions').where({ user_id: member.user_id }).del();
    res.json({ ok: true });
  });

  /** New invitation link (pending invites) or password-reset link (active accounts). Previous links stop working. */
  router.post('/:id/link', requirePermission('users.manage'), async (req, res) => {
    const { member, token, purpose } = await tenant(req, async trx => {
      const m = await getMember(trx, req, req.params.id);
      if (m.user_id === req.user.id) throw badRequest('team.use_account_page', 'Change your own password from your account page');
      await assertAccountManageable(trx, req, m);
      if (m.user_status === 'disabled') throw badRequest('team.account_disabled', 'This account is disabled');
      const kind = m.user_status === 'invited' ? 'invite' : 'password_reset';
      const t = await issueToken(trx, { purpose: kind, userId: m.user_id, companyId: req.company.id, createdBy: req.user.id });
      await audit(trx, req, { action: kind === 'invite' ? 'team.invite_resent' : 'team.reset_link_created', companyId: req.company.id, entityType: 'membership', entityId: m.id });
      return { member: m, token: t, purpose: kind };
    });
    res.json({ ok: true, purpose, ...(await deliverLink(req, member, purpose, token)) });
  });

  router.delete('/:id', requirePermission('users.manage'), async (req, res) => {
    const member = await tenant(req, async trx => {
      const m = await getMember(trx, req, req.params.id);
      if (m.user_id === req.user.id) throw forbidden('team.self_remove', 'You cannot remove yourself');
      if (m.is_owner && !actorIsOwner(req)) throw forbidden('team.owner_only', 'Only owners can manage an owner');
      const shared = (await trx.raw('SELECT app_user_external_membership_count(?, ?) AS n', [m.user_id, req.company.id])).rows[0].n;
      const platform = (await trx.raw('SELECT app_user_is_platform_admin(?) AS p', [m.user_id])).rows[0].p;
      // Accounts that only belonged to this workspace are disabled (not deleted) so audit history keeps its references.
      if (!shared && !platform) await trx('users').where({ id: m.user_id }).update({ status: 'disabled' });
      await trx('company_memberships').where({ id: m.id, company_id: req.company.id }).del();
      if (m.is_owner && await activeOwnerCount(trx, req.company.id) === 0) throw conflict('team.last_owner', 'The workspace must keep at least one active owner');
      await audit(trx, req, { action: 'team.member_removed', companyId: req.company.id, entityType: 'membership', entityId: m.id, before: out(m) });
      return m;
    });
    await db.knex('sessions').where({ user_id: member.user_id, company_id: req.company.id }).del();
    res.json({ ok: true });
  });

  return router;
};
