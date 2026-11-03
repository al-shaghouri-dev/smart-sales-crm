const express = require('express');
const crypto = require('crypto');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { PERMISSIONS, PERMISSION_KEYS } = require('../permissions');
const { badRequest, conflict, forbidden, notFound } = require('../errors');
const { audit } = require('../services/audit');

module.exports = function roleRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);

  async function listRoles(trx, companyId) {
    const roles = await trx('roles').where({ company_id: companyId }).orderBy([{ column: 'is_system', order: 'desc' }, 'created_at']);
    const perms = await trx('role_permissions').where({ company_id: companyId }).select('role_id', 'permission_key');
    const counts = await trx('company_memberships').where({ company_id: companyId }).groupBy('role_id').select('role_id').count('* as n');
    return roles.map(r => ({
      id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.is_system, isOwner: r.is_owner,
      permissions: perms.filter(p => p.role_id === r.id).map(p => p.permission_key),
      memberCount: Number(counts.find(c => c.role_id === r.id)?.n || 0)
    }));
  }

  /** Validate a permission list and stop members from granting permissions they do not hold themselves. */
  function checkPermissions(req, list) {
    if (!Array.isArray(list)) throw badRequest('validation.invalid', 'permissions must be a list', { field: 'permissions' });
    const unique = [...new Set(list.map(String))];
    if (unique.some(k => !PERMISSION_KEYS.includes(k))) throw badRequest('validation.invalid', 'Unknown permission', { field: 'permissions' });
    if (!req.membership?.is_owner && unique.some(k => !req.permissions.has(k))) {
      throw forbidden('roles.escalation', 'You cannot grant permissions you do not have');
    }
    return unique;
  }

  router.get('/permissions', requirePermission('users.view', 'roles.manage'), (_req, res) => res.json({ permissions: PERMISSIONS }));

  router.get('/', requirePermission('users.view', 'users.manage', 'roles.manage'), async (req, res) => {
    res.json({ roles: await tenant(req, trx => listRoles(trx, req.company.id)) });
  });

  router.post('/', requirePermission('roles.manage'), async (req, res) => {
    const name = v.str(req.body?.name, { field: 'name', required: true, max: 60 });
    const description = v.str(req.body?.description, { field: 'description', max: 300 });
    const permissions = checkPermissions(req, req.body?.permissions || []);
    const roles = await tenant(req, async trx => {
      const id = crypto.randomUUID();
      await trx('roles').insert({ id, company_id: req.company.id, key: `custom-${crypto.randomBytes(4).toString('hex')}`, name, description });
      if (permissions.length) await trx('role_permissions').insert(permissions.map(p => ({ company_id: req.company.id, role_id: id, permission_key: p })));
      await audit(trx, req, { action: 'role.created', companyId: req.company.id, entityType: 'role', entityId: id, after: { name, permissions } });
      return listRoles(trx, req.company.id);
    });
    res.status(201).json({ roles });
  });

  router.patch('/:id', requirePermission('roles.manage'), async (req, res) => {
    const roles = await tenant(req, async trx => {
      const role = await trx('roles').where({ id: v.uuid(req.params.id), company_id: req.company.id }).first();
      if (!role) throw notFound('roles.not_found', 'Role not found');
      if (role.is_owner) throw forbidden('roles.owner_locked', 'The owner role cannot be changed');
      if (role.id === req.membership.role_id && !req.membership.is_owner) throw forbidden('roles.own_role', 'You cannot edit your own role');
      const before = (await listRoles(trx, req.company.id)).find(r => r.id === role.id);
      const patch = v.compact({
        name: v.str(req.body?.name, { field: 'name', max: 60 }),
        description: v.str(req.body?.description, { field: 'description', max: 300 })
      });
      if (Object.keys(patch).length) await trx('roles').where({ id: role.id, company_id: req.company.id }).update({ ...patch, updated_at: trx.fn.now() });
      if (req.body?.permissions !== undefined) {
        const permissions = checkPermissions(req, req.body.permissions);
        // Removing permissions you do not hold is also blocked (would be the inverse escalation for peers).
        if (!req.membership.is_owner && before.permissions.some(k => !permissions.includes(k) && !req.permissions.has(k))) {
          throw forbidden('roles.escalation', 'You cannot change permissions you do not have');
        }
        await trx('role_permissions').where({ role_id: role.id, company_id: req.company.id }).del();
        if (permissions.length) await trx('role_permissions').insert(permissions.map(p => ({ company_id: req.company.id, role_id: role.id, permission_key: p })));
      }
      const list = await listRoles(trx, req.company.id);
      await audit(trx, req, { action: 'role.updated', companyId: req.company.id, entityType: 'role', entityId: role.id, before, after: list.find(r => r.id === role.id) });
      return list;
    });
    res.json({ roles });
  });

  router.delete('/:id', requirePermission('roles.manage'), async (req, res) => {
    const roles = await tenant(req, async trx => {
      const role = await trx('roles').where({ id: v.uuid(req.params.id), company_id: req.company.id }).first();
      if (!role) throw notFound('roles.not_found', 'Role not found');
      if (role.is_system) throw forbidden('roles.system_locked', 'Built-in roles cannot be deleted');
      const inUse = await trx('company_memberships').where({ role_id: role.id, company_id: req.company.id }).first('id');
      if (inUse) throw conflict('roles.in_use', 'Reassign members before deleting this role');
      await trx('roles').where({ id: role.id, company_id: req.company.id }).del();
      await audit(trx, req, { action: 'role.deleted', companyId: req.company.id, entityType: 'role', entityId: role.id, before: { name: role.name } });
      return listRoles(trx, req.company.id);
    });
    res.json({ roles });
  });

  return router;
};
