/**
 * Permission catalog. Keys are stable identifiers stored in role_permissions;
 * labels live in the frontend locale files (permissions.<key>).
 * Adding a permission = add it here + a migration that inserts it into `permissions`.
 */
const PERMISSIONS = [
  { key: 'company.settings.view', category: 'company' },
  { key: 'company.settings.manage', category: 'company' },
  { key: 'company.branding.manage', category: 'company' },
  { key: 'billing.view', category: 'company' },
  { key: 'users.view', category: 'team' },
  { key: 'users.manage', category: 'team' },
  { key: 'roles.manage', category: 'team' },
  { key: 'shifts.manage', category: 'team' },
  { key: 'conversations.view_all', category: 'conversations' },
  { key: 'conversations.view_assigned', category: 'conversations' },
  { key: 'conversations.reply', category: 'conversations' },
  { key: 'conversations.assign', category: 'conversations' },
  { key: 'customers.view', category: 'customers' },
  { key: 'customers.manage', category: 'customers' },
  { key: 'customers.export', category: 'customers' },
  { key: 'orders.view', category: 'orders' },
  { key: 'orders.manage', category: 'orders' },
  { key: 'orders.export', category: 'orders' },
  { key: 'reports.view', category: 'reports' },
  { key: 'reports.financial', category: 'reports' },
  { key: 'channels.manage', category: 'channels' },
  { key: 'audit.view', category: 'security' }
];

const ALL = PERMISSIONS.map(p => p.key);
const without = (...keys) => ALL.filter(k => !keys.includes(k));

/** Default roles created for every new company. Companies can edit all but the owner role. */
const SYSTEM_ROLES = [
  { key: 'owner', isOwner: true, permissions: ALL },
  { key: 'admin', permissions: ALL },
  {
    key: 'manager',
    permissions: without('company.settings.manage', 'company.branding.manage', 'billing.view', 'roles.manage', 'channels.manage', 'audit.view')
  },
  {
    key: 'supervisor',
    permissions: ['users.view', 'conversations.view_all', 'conversations.view_assigned', 'conversations.reply', 'conversations.assign',
      'customers.view', 'customers.manage', 'orders.view', 'orders.manage', 'reports.view']
  },
  {
    key: 'employee',
    permissions: ['conversations.view_assigned', 'conversations.reply', 'customers.view', 'orders.view', 'orders.manage']
  }
];

/**
 * Plan feature flags. Plans store a subset of these keys; enforcement is added
 * as each feature ships (labels: frontend locales planFeatures.<key>).
 */
const PLAN_FEATURES = ['reports.advanced', 'export.excel', 'automation', 'ai.assistant', 'api.access', 'branding.custom'];

module.exports = { PERMISSIONS, PERMISSION_KEYS: ALL, SYSTEM_ROLES, PLAN_FEATURES };
