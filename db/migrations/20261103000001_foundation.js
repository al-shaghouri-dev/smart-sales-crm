/**
 * Phase 1 foundation: identity, companies (tenants), roles & permissions, sessions,
 * platform/company settings & branding, audit log — with PostgreSQL Row Level Security.
 *
 * Run migrations as the schema OWNER role. The application must connect as a separate
 * role (APP_DB_ROLE) that has NOBYPASSRLS; FORCE ROW LEVEL SECURITY also binds the owner.
 */
// Frozen copy of the permission catalog at the time of this migration. Never import live code into
// migrations: later permissions are added by their own migrations (e.g. billing.view in phase 2).
const PERMISSIONS = [
  ['company.settings.view', 'company'], ['company.settings.manage', 'company'], ['company.branding.manage', 'company'],
  ['users.view', 'team'], ['users.manage', 'team'], ['roles.manage', 'team'], ['shifts.manage', 'team'],
  ['conversations.view_all', 'conversations'], ['conversations.view_assigned', 'conversations'], ['conversations.reply', 'conversations'],
  ['conversations.assign', 'conversations'], ['customers.view', 'customers'], ['customers.manage', 'customers'], ['customers.export', 'customers'],
  ['orders.view', 'orders'], ['orders.manage', 'orders'], ['orders.export', 'orders'], ['reports.view', 'reports'],
  ['reports.financial', 'reports'], ['channels.manage', 'channels'], ['audit.view', 'security']
].map(([key, category]) => ({ key, category }));

const TENANT_TABLES = ['company_settings', 'company_branding', 'roles', 'role_permissions', 'company_memberships'];

exports.up = async knex => {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS citext');

  // ---- Security context helpers (read the per-transaction settings) ----
  await knex.raw(`
    CREATE FUNCTION app_current_company() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;
    CREATE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
    CREATE FUNCTION app_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT COALESCE(current_setting('app.platform_admin', true), '') = 'on' $$;
    -- True only while executing inside a SECURITY DEFINER function (owned by the schema owner).
    -- Lets the narrow auth_* / app_user_* helpers below read identity rows before a tenant context exists.
    CREATE FUNCTION app_in_definer() RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT current_user <> session_user $$;
  `);

  await knex.schema.createTable('platform_settings', t => {
    t.smallint('id').primary().defaultTo(1);
    t.text('app_name').notNullable().defaultTo('Smart Sales CRM');
    t.jsonb('tagline').notNullable().defaultTo('{}');
    t.text('logo_url');
    t.text('favicon_url');
    t.string('primary_color', 7).notNullable().defaultTo('#4f46e5');
    t.string('secondary_color', 7).notNullable().defaultTo('#0f172a');
    t.string('accent_color', 7).notNullable().defaultTo('#f59e0b');
    t.text('font_family').notNullable().defaultTo('Cairo');
    t.text('default_theme').notNullable().defaultTo('system');
    t.text('default_locale').notNullable().defaultTo('en');
    t.jsonb('login_heading').notNullable().defaultTo('{}');
    t.jsonb('login_subheading').notNullable().defaultTo('{}');
    t.jsonb('registration_heading').notNullable().defaultTo('{}');
    t.jsonb('registration_subheading').notNullable().defaultTo('{}');
    t.text('support_email');
    t.text('support_phone');
    t.text('website_url');
    t.uuid('updated_by');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE platform_settings
      ADD CONSTRAINT platform_settings_singleton CHECK (id = 1),
      ADD CONSTRAINT platform_theme_chk CHECK (default_theme IN ('light','dark','system')),
      ADD CONSTRAINT platform_locale_chk CHECK (default_locale IN ('ar','en'));
    INSERT INTO platform_settings (id) VALUES (1);
  `);

  await knex.schema.createTable('users', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.specificType('email', 'citext').notNullable().unique();
    t.text('name').notNullable();
    t.text('phone');
    t.text('password_hash');
    t.boolean('is_platform_admin').notNullable().defaultTo(false);
    t.text('status').notNullable().defaultTo('active');
    t.text('locale');
    t.text('theme');
    t.timestamp('last_login_at', { useTz: true });
    t.timestamp('password_changed_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE users
      ADD CONSTRAINT users_status_chk CHECK (status IN ('active','disabled')),
      ADD CONSTRAINT users_locale_chk CHECK (locale IS NULL OR locale IN ('ar','en')),
      ADD CONSTRAINT users_theme_chk CHECK (theme IS NULL OR theme IN ('light','dark','system'));
  `);

  await knex.schema.createTable('companies', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('name').notNullable();
    t.specificType('slug', 'citext').notNullable().unique();
    t.text('status').notNullable().defaultTo('pending');
    t.text('email');
    t.text('phone');
    t.text('country');
    t.text('address');
    t.text('business_type');
    t.text('timezone').notNullable().defaultTo('UTC');
    t.string('currency', 3).notNullable().defaultTo('USD');
    t.text('default_locale').notNullable().defaultTo('en');
    t.timestamp('suspended_at', { useTz: true });
    t.text('suspension_reason');
    t.uuid('created_by');
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE companies
      ADD CONSTRAINT companies_status_chk CHECK (status IN ('pending','active','suspended')),
      ADD CONSTRAINT companies_locale_chk CHECK (default_locale IN ('ar','en')),
      ADD CONSTRAINT companies_currency_chk CHECK (currency ~ '^[A-Z]{3}$');
  `);

  await knex.schema.createTable('company_settings', t => {
    t.uuid('company_id').primary().references('companies.id').onDelete('CASCADE');
    t.decimal('tax_rate', 6, 3).notNullable().defaultTo(0);
    t.decimal('shipping_fee', 12, 2).notNullable().defaultTo(0);
    t.boolean('auto_reply_enabled').notNullable().defaultTo(false);
    t.jsonb('quick_replies').notNullable().defaultTo('[]');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('company_branding', t => {
    t.uuid('company_id').primary().references('companies.id').onDelete('CASCADE');
    t.text('display_name');
    t.text('logo_url');
    t.string('primary_color', 7);
    t.string('secondary_color', 7);
    t.string('accent_color', 7);
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('permissions', t => {
    t.text('key').primary();
    t.text('category').notNullable();
    t.integer('sort').notNullable().defaultTo(0);
  });
  await knex('permissions').insert(PERMISSIONS.map((p, i) => ({ key: p.key, category: p.category, sort: i })));

  await knex.schema.createTable('roles', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.text('key').notNullable();
    t.text('name');
    t.text('description');
    t.boolean('is_system').notNullable().defaultTo(false);
    t.boolean('is_owner').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['company_id', 'key']);
    t.unique(['company_id', 'id']);
  });

  await knex.schema.createTable('role_permissions', t => {
    t.uuid('company_id').notNullable();
    t.uuid('role_id').notNullable();
    t.text('permission_key').notNullable().references('permissions.key').onDelete('CASCADE');
    t.primary(['role_id', 'permission_key']);
    // Composite FK guarantees the role belongs to the same company.
    t.foreign(['company_id', 'role_id']).references(['company_id', 'id']).inTable('roles').onDelete('CASCADE');
  });

  await knex.schema.createTable('company_memberships', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.uuid('role_id').notNullable();
    t.text('status').notNullable().defaultTo('active');
    t.text('job_title');
    t.timestamps(true, true);
    t.unique(['company_id', 'user_id']);
    // A member can only hold a role from their own company.
    t.foreign(['company_id', 'role_id']).references(['company_id', 'id']).inTable('roles');
    t.index(['user_id']);
  });
  await knex.raw(`ALTER TABLE company_memberships ADD CONSTRAINT memberships_status_chk CHECK (status IN ('active','inactive'))`);

  await knex.schema.createTable('sessions', t => {
    t.text('id').primary(); // sha256 of the cookie token; the raw token is never stored
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.uuid('company_id').references('companies.id').onDelete('SET NULL');
    t.text('csrf_token').notNullable();
    t.text('ip');
    t.text('user_agent');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.index(['user_id']);
    t.index(['expires_at']);
  });

  await knex.schema.createTable('audit_logs', t => {
    t.bigIncrements('id');
    t.uuid('company_id'); // no FK: audit entries must survive company deletion
    t.uuid('actor_user_id');
    t.text('actor_email');
    t.text('action').notNullable();
    t.text('entity_type');
    t.text('entity_id');
    t.jsonb('before');
    t.jsonb('after');
    t.text('ip');
    t.text('user_agent');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['company_id', 'created_at']);
  });

  // ---- Row Level Security ----
  for (const table of [...TENANT_TABLES, 'companies', 'users', 'audit_logs', 'platform_settings']) {
    await knex.raw(`ALTER TABLE ?? ENABLE ROW LEVEL SECURITY; ALTER TABLE ?? FORCE ROW LEVEL SECURITY;`, [table, table]);
  }

  for (const table of ['company_settings', 'company_branding', 'roles', 'role_permissions']) {
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ?? USING (company_id = app_current_company() OR app_is_platform_admin())
      WITH CHECK (company_id = app_current_company() OR app_is_platform_admin());
    `, [table]);
  }

  // Users can read their own memberships across companies (company switcher); writes stay in-tenant.
  await knex.raw(`
    CREATE POLICY memberships_select ON company_memberships FOR SELECT
      USING (company_id = app_current_company() OR user_id = app_current_user_id() OR app_is_platform_admin() OR app_in_definer());
    CREATE POLICY memberships_write ON company_memberships FOR ALL
      USING (company_id = app_current_company() OR app_is_platform_admin())
      WITH CHECK (company_id = app_current_company() OR app_is_platform_admin());

    CREATE POLICY companies_select ON companies FOR SELECT USING (
      id = app_current_company() OR app_is_platform_admin()
      OR id IN (SELECT m.company_id FROM company_memberships m WHERE m.user_id = app_current_user_id()));
    CREATE POLICY companies_update ON companies FOR UPDATE
      USING (id = app_current_company() OR app_is_platform_admin())
      WITH CHECK (id = app_current_company() OR app_is_platform_admin());
    CREATE POLICY companies_insert ON companies FOR INSERT WITH CHECK (app_is_platform_admin());
    CREATE POLICY companies_delete ON companies FOR DELETE USING (app_is_platform_admin());

    -- Identity rows: yourself, members of the current company, or platform admin.
    CREATE POLICY users_select ON users FOR SELECT USING (
      id = app_current_user_id() OR app_is_platform_admin() OR app_in_definer()
      OR id IN (SELECT m.user_id FROM company_memberships m WHERE m.company_id = app_current_company()));
    CREATE POLICY users_update ON users FOR UPDATE USING (
      id = app_current_user_id() OR app_is_platform_admin()
      OR id IN (SELECT m.user_id FROM company_memberships m WHERE m.company_id = app_current_company()));
    -- New accounts are created by company admins (invites) and platform admins.
    CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (
      (app_current_company() IS NOT NULL OR app_is_platform_admin()) AND (is_platform_admin = false OR app_is_platform_admin()));
    CREATE POLICY users_delete ON users FOR DELETE USING (app_is_platform_admin());

    CREATE POLICY audit_select ON audit_logs FOR SELECT USING (company_id = app_current_company() OR app_is_platform_admin());
    CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (
      company_id IS NULL OR company_id = app_current_company() OR app_is_platform_admin());

    -- Platform settings are readable by everyone (public branding) and writable by platform admins only.
    CREATE POLICY platform_settings_read ON platform_settings FOR SELECT USING (true);
    CREATE POLICY platform_settings_write ON platform_settings FOR UPDATE USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
  `);

  // Protect privileged columns: only platform admins may change is_platform_admin.
  await knex.raw(`
    CREATE FUNCTION users_guard_platform_flag() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin AND NOT app_is_platform_admin() THEN
        RAISE EXCEPTION 'only platform admins can change is_platform_admin' USING ERRCODE = '42501';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END $$;
    CREATE TRIGGER users_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_guard_platform_flag();
  `);

  // ---- Narrow SECURITY DEFINER helpers for flows that run before a tenant context exists ----
  await knex.raw(`
    CREATE FUNCTION auth_user_for_login(p_email citext)
    RETURNS TABLE (id uuid, password_hash text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
      $$ SELECT u.id, u.password_hash, u.status FROM users u WHERE u.email = p_email $$;

    CREATE FUNCTION app_user_id_by_email(p_email citext) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
      $$ SELECT u.id FROM users u WHERE u.email = p_email $$;

    -- Number of OTHER companies a user belongs to (used to stop one tenant's admin
    -- from changing credentials of an account that is shared with another tenant).
    CREATE FUNCTION app_user_external_membership_count(p_user uuid, p_company uuid) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
      $$ SELECT count(*)::int FROM company_memberships m WHERE m.user_id = p_user AND m.company_id <> p_company $$;

    CREATE FUNCTION app_user_is_platform_admin(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
      $$ SELECT COALESCE((SELECT u.is_platform_admin FROM users u WHERE u.id = p_user), false) $$;

    REVOKE ALL ON FUNCTION auth_user_for_login(citext), app_user_id_by_email(citext),
      app_user_external_membership_count(uuid, uuid), app_user_is_platform_admin(uuid) FROM PUBLIC;
  `);

  const appRole = process.env.APP_DB_ROLE;
  if (appRole) {
    await knex.raw(`
      GRANT USAGE ON SCHEMA public TO ??;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ??;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ??;
      REVOKE INSERT, UPDATE, DELETE ON permissions, knex_migrations, knex_migrations_lock FROM ??;
      REVOKE INSERT, DELETE ON platform_settings FROM ??;
      REVOKE UPDATE, DELETE ON audit_logs FROM ??;
      GRANT EXECUTE ON FUNCTION auth_user_for_login(citext), app_user_id_by_email(citext),
        app_user_external_membership_count(uuid, uuid), app_user_is_platform_admin(uuid) TO ??;
    `, [appRole, appRole, appRole, appRole, appRole, appRole, appRole]);
  }
};

exports.down = async knex => {
  await knex.raw(`
    DROP FUNCTION IF EXISTS auth_user_for_login(citext), app_user_id_by_email(citext),
      app_user_external_membership_count(uuid, uuid), app_user_is_platform_admin(uuid);
    DROP POLICY IF EXISTS companies_select ON companies;
    DROP POLICY IF EXISTS users_select ON users;
    DROP POLICY IF EXISTS users_update ON users;
  `);
  for (const table of ['audit_logs', 'sessions', 'company_memberships', 'role_permissions', 'roles', 'permissions',
    'company_branding', 'company_settings', 'companies', 'users', 'platform_settings']) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw(`
    DROP FUNCTION IF EXISTS users_guard_platform_flag();
    DROP FUNCTION IF EXISTS app_current_company(), app_current_user_id(), app_is_platform_admin(), app_in_definer();
  `);
};
