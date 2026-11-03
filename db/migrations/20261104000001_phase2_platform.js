/**
 * Phase 2: plans, subscriptions, manual payments, self-registration requests,
 * invitation / password-reset tokens, notifications, separate platform sessions.
 * Builds on 20261103000001_foundation (RLS helpers app_current_company(), app_is_platform_admin(), ...).
 */
exports.up = async knex => {
  // ---- Separate Super Admin sessions ----
  await knex.schema.alterTable('sessions', t => { t.text('kind').notNullable().defaultTo('company'); });
  await knex.raw(`ALTER TABLE sessions ADD CONSTRAINT sessions_kind_chk CHECK (kind IN ('company','platform'))`);

  // ---- Invited users have no password until they accept ----
  await knex.raw(`
    ALTER TABLE users DROP CONSTRAINT users_status_chk;
    ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('active','disabled','invited'));
  `);

  // ---- Platform policy settings ----
  await knex.schema.alterTable('platform_settings', t => {
    t.text('expired_access_policy').notNullable().defaultTo('read_only');
    t.boolean('registration_enabled').notNullable().defaultTo(true);
  });
  await knex.raw(`ALTER TABLE platform_settings ADD CONSTRAINT platform_expired_policy_chk CHECK (expired_access_policy IN ('read_only','block'))`);

  // ---- Plans (platform catalogue) ----
  await knex.schema.createTable('plans', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('key').notNullable().unique();
    t.jsonb('name').notNullable();                 // { ar, en }
    t.jsonb('description').notNullable().defaultTo('{}');
    t.text('billing_interval').notNullable();      // month | year | custom
    t.integer('duration_days');                    // required for custom
    t.decimal('price', 12, 2).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable().defaultTo('USD');
    t.integer('trial_days').notNullable().defaultTo(0);
    t.integer('max_employees');                    // null = unlimited
    t.integer('max_channels');                     // null = unlimited
    t.jsonb('features').notNullable().defaultTo('[]');
    t.boolean('is_active').notNullable().defaultTo(false);
    t.boolean('is_public').notNullable().defaultTo(true); // shown on the registration page
    t.integer('sort').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE plans
      ADD CONSTRAINT plans_interval_chk CHECK (billing_interval IN ('month','year','custom')),
      ADD CONSTRAINT plans_custom_duration_chk CHECK (billing_interval <> 'custom' OR duration_days > 0),
      ADD CONSTRAINT plans_price_chk CHECK (price >= 0),
      ADD CONSTRAINT plans_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
      ADD CONSTRAINT plans_limits_chk CHECK ((max_employees IS NULL OR max_employees > 0) AND (max_channels IS NULL OR max_channels >= 0) AND trial_days >= 0);
  `);

  // ---- One subscription per company (history lives in payments + audit log) ----
  await knex.schema.createTable('subscriptions', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().unique().references('companies.id').onDelete('CASCADE');
    t.uuid('plan_id').notNullable().references('plans.id');
    t.text('status').notNullable().defaultTo('pending');
    t.text('billing_interval').notNullable();
    t.decimal('price', 12, 2).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable();
    t.boolean('is_trial').notNullable().defaultTo(false);
    t.timestamp('starts_at', { useTz: true });
    t.timestamp('ends_at', { useTz: true });
    t.timestamp('cancelled_at', { useTz: true });
    t.text('notes');
    t.uuid('updated_by');
    t.timestamps(true, true);
    t.index(['status', 'ends_at']);
  });
  await knex.raw(`
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_status_chk CHECK (status IN ('pending','active','expired','suspended','cancelled')),
      ADD CONSTRAINT subscriptions_interval_chk CHECK (billing_interval IN ('month','year','custom')),
      ADD CONSTRAINT subscriptions_dates_chk CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
      ADD CONSTRAINT subscriptions_active_dates_chk CHECK (status <> 'active' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL));
  `);

  // ---- Manual payments (provider column keeps the door open for gateways) ----
  await knex.schema.createTable('payments', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.uuid('subscription_id').references('subscriptions.id').onDelete('SET NULL');
    t.decimal('amount', 12, 2).notNullable();
    t.string('currency', 3).notNullable();
    t.timestamp('paid_at', { useTz: true }).notNullable();
    t.text('method').notNullable();
    t.text('reference');
    t.text('notes');
    t.text('provider').notNullable().defaultTo('manual');
    t.text('provider_reference');
    t.timestamp('period_start', { useTz: true });
    t.timestamp('period_end', { useTz: true });
    t.uuid('recorded_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['company_id', 'paid_at']);
  });
  await knex.raw(`
    ALTER TABLE payments
      ADD CONSTRAINT payments_amount_chk CHECK (amount > 0),
      ADD CONSTRAINT payments_method_chk CHECK (method IN ('cash','bank_transfer','card','mobile_wallet','other'));
  `);

  // ---- Self-service registration requests ----
  await knex.schema.createTable('registration_requests', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('company_name').notNullable();
    t.text('business_type');
    t.text('country');
    t.text('company_phone');
    t.text('owner_name').notNullable();
    t.specificType('owner_email', 'citext').notNullable();
    t.text('owner_phone');
    t.uuid('plan_id').references('plans.id').onDelete('SET NULL');
    t.text('locale').notNullable().defaultTo('en');
    t.text('status').notNullable().defaultTo('pending');
    t.text('message_to_applicant');
    t.text('internal_note');
    t.uuid('reviewed_by');
    t.timestamp('reviewed_at', { useTz: true });
    t.uuid('company_id').references('companies.id').onDelete('SET NULL');
    t.text('ip');
    t.timestamps(true, true);
    t.index(['status', 'created_at']);
  });
  await knex.raw(`
    ALTER TABLE registration_requests
      ADD CONSTRAINT registration_status_chk CHECK (status IN ('pending','info_requested','approved','rejected')),
      ADD CONSTRAINT registration_locale_chk CHECK (locale IN ('ar','en'));
  `);

  // ---- One-time tokens: invitations and password resets (hash stored, never the token) ----
  await knex.schema.createTable('auth_tokens', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('token_hash').notNullable().unique();
    t.text('purpose').notNullable();
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.uuid('company_id').references('companies.id').onDelete('CASCADE');
    t.uuid('created_by');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'purpose']);
  });
  await knex.raw(`ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_chk CHECK (purpose IN ('invite','password_reset'))`);

  // ---- In-app notifications (per user, inside a company) ----
  await knex.schema.createTable('notifications', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').references('companies.id').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.text('type').notNullable();
    t.jsonb('data').notNullable().defaultTo('{}');
    t.text('dedupe_key');
    t.timestamp('read_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'dedupe_key']);
    t.index(['user_id', 'created_at']);
  });

  // ---- billing.view permission for owner/admin roles ----
  await knex('permissions').insert({ key: 'billing.view', category: 'company', sort: 3 }).onConflict('key').ignore();
  await knex.raw(`SELECT set_config('app.platform_admin', 'on', true)`); // RLS: touch every tenant's roles in this migration transaction
  await knex.raw(`
    INSERT INTO role_permissions (company_id, role_id, permission_key)
    SELECT r.company_id, r.id, 'billing.view' FROM roles r WHERE r.key IN ('owner','admin')
    ON CONFLICT DO NOTHING
  `);

  // ---- Row Level Security ----
  for (const table of ['plans', 'subscriptions', 'payments', 'registration_requests', 'notifications']) {
    await knex.raw('ALTER TABLE ?? ENABLE ROW LEVEL SECURITY; ALTER TABLE ?? FORCE ROW LEVEL SECURITY;', [table, table]);
  }
  await knex.raw(`
    -- Plans are a public catalogue; only platform admins change them.
    CREATE POLICY plans_read ON plans FOR SELECT USING (true);
    CREATE POLICY plans_write ON plans FOR ALL USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

    -- Companies can read their own subscription and payments; only the platform writes them.
    CREATE POLICY subscriptions_read ON subscriptions FOR SELECT USING (company_id = app_current_company() OR app_is_platform_admin());
    CREATE POLICY subscriptions_write ON subscriptions FOR ALL USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
    CREATE POLICY payments_read ON payments FOR SELECT USING (company_id = app_current_company() OR app_is_platform_admin());
    CREATE POLICY payments_write ON payments FOR INSERT WITH CHECK (app_is_platform_admin());

    -- Anyone may submit a registration request; only the platform can read or review them.
    CREATE POLICY registration_submit ON registration_requests FOR INSERT
      WITH CHECK (app_is_platform_admin() OR (status = 'pending' AND company_id IS NULL AND reviewed_by IS NULL));
    CREATE POLICY registration_read ON registration_requests FOR SELECT USING (app_is_platform_admin());
    CREATE POLICY registration_update ON registration_requests FOR UPDATE USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

    -- Users see only their own notifications in the current company.
    CREATE POLICY notifications_read ON notifications FOR SELECT
      USING (app_is_platform_admin() OR (user_id = app_current_user_id() AND company_id = app_current_company()));
    CREATE POLICY notifications_update ON notifications FOR UPDATE
      USING (user_id = app_current_user_id() AND company_id = app_current_company())
      WITH CHECK (user_id = app_current_user_id() AND company_id = app_current_company());
    CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (app_is_platform_admin());
  `);

  const appRole = process.env.APP_DB_ROLE;
  if (appRole) {
    await knex.raw(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON plans, subscriptions, registration_requests, auth_tokens, notifications TO ??;
      GRANT SELECT, INSERT ON payments TO ??;
    `, [appRole, appRole]);
  }
};

exports.down = async knex => {
  await knex.raw(`SELECT set_config('app.platform_admin', 'on', true)`);
  await knex('role_permissions').where({ permission_key: 'billing.view' }).del();
  await knex('permissions').where({ key: 'billing.view' }).del();
  for (const table of ['notifications', 'auth_tokens', 'registration_requests', 'payments', 'subscriptions', 'plans']) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw(`
    ALTER TABLE platform_settings DROP CONSTRAINT platform_expired_policy_chk;
    ALTER TABLE platform_settings DROP COLUMN expired_access_policy, DROP COLUMN registration_enabled;
    UPDATE users SET status = 'disabled' WHERE status = 'invited';
    ALTER TABLE users DROP CONSTRAINT users_status_chk;
    ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('active','disabled'));
    DELETE FROM sessions WHERE kind = 'platform';
    ALTER TABLE sessions DROP CONSTRAINT sessions_kind_chk;
    ALTER TABLE sessions DROP COLUMN kind;
  `);
};
