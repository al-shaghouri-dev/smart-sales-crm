/**
 * Two-factor authentication (TOTP, RFC 6238).
 *  user_mfa        one row per user: encrypted secret, enabled flag, hashed recovery codes,
 *                  last accepted time step (replay protection).
 *  mfa_challenges  short-lived "password OK, code pending" tickets created at sign-in.
 * Both are readable only by the user themself (app.user_id) or a platform admin.
 */
const TABLES = ['user_mfa', 'mfa_challenges'];

exports.up = async knex => {
  await knex.schema.createTable('user_mfa', t => {
    t.uuid('user_id').primary().references('users.id').onDelete('CASCADE');
    t.text('secret_ciphertext').notNullable();
    t.text('key_id').notNullable();
    t.timestamp('enabled_at', { useTz: true });
    t.specificType('recovery_hashes', 'text[]').notNullable().defaultTo('{}');
    t.bigInteger('last_step').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('mfa_challenges', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('users.id').onDelete('CASCADE');
    t.text('token_hash').notNullable().unique();
    t.text('kind').notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("ALTER TABLE mfa_challenges ADD CONSTRAINT mfa_challenges_kind_chk CHECK (kind IN ('workspace','platform'))");
  for (const table of TABLES) {
    await knex.raw('ALTER TABLE ?? ENABLE ROW LEVEL SECURITY', [table]);
    await knex.raw('ALTER TABLE ?? FORCE ROW LEVEL SECURITY', [table]);
    await knex.raw(`CREATE POLICY own_rows ON ?? USING (user_id = app_current_user_id() OR app_is_platform_admin())
      WITH CHECK (user_id = app_current_user_id() OR app_is_platform_admin())`, [table]);
  }
  if (process.env.APP_DB_ROLE) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLES.join(', ')} TO ??`, [process.env.APP_DB_ROLE]);
  }
};

exports.down = async knex => {
  await knex.schema.dropTableIfExists('mfa_challenges');
  await knex.schema.dropTableIfExists('user_mfa');
};
