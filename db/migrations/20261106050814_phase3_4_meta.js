/**
 * Phase 3.4–3.6 — Meta integrations (Messenger, Instagram, WhatsApp).
 *  channel_oauth_sessions  short-lived, encrypted results of an OAuth login (e.g. the list of
 *                          Facebook Pages the user can connect), until the user picks accounts.
 *  meta_data_deletions     Meta "Data Deletion Request" callbacks: confirmation code + status.
 *  app_channels_for_meta_user(provider, user)  narrow lookup for Deauthorize / Data Deletion
 *                          callbacks, which arrive without any tenant context.
 */
exports.up = async knex => {
  await knex.schema.createTable('channel_oauth_sessions', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.uuid('user_id').notNullable();
    t.text('provider').notNullable();
    t.text('ciphertext').notNullable();      // encrypted { accounts: [...] } incl. tokens
    t.jsonb('accounts').notNullable().defaultTo('[]'); // public part: [{ externalAccountId, displayName }]
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // WhatsApp approved-template messages: { name, language, params } (sent outside the 24h window).
  await knex.schema.alterTable('messages', t => { t.jsonb('template'); });
  await knex.schema.createTable('meta_data_deletions', t => {
    t.text('code').primary();                // confirmation code returned to Meta
    t.text('provider').notNullable();
    t.text('status').notNullable().defaultTo('completed');
    t.integer('channels_affected').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE channel_oauth_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE channel_oauth_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON channel_oauth_sessions USING (company_id = app_current_company() AND user_id = app_current_user_id())
      WITH CHECK (company_id = app_current_company() AND user_id = app_current_user_id());
    -- Platform-level (no tenant data): readable by status-page lookups in system context only.
    ALTER TABLE meta_data_deletions ENABLE ROW LEVEL SECURITY; ALTER TABLE meta_data_deletions FORCE ROW LEVEL SECURITY;
    CREATE POLICY system_only ON meta_data_deletions USING (current_setting('app.system', true) = 'on' OR app_is_platform_admin())
      WITH CHECK (current_setting('app.system', true) = 'on' OR app_is_platform_admin());

    CREATE FUNCTION app_channels_for_meta_user(p_provider text, p_user text)
    RETURNS TABLE (channel_id uuid, company_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT c.id, c.company_id FROM channels c
      WHERE c.provider = p_provider AND c.status <> 'disconnected'
        AND (c.external_meta->>'metaUserId' = p_user OR (p_provider = 'instagram' AND c.external_account_id = p_user))
    $$;
    REVOKE ALL ON FUNCTION app_channels_for_meta_user(text, text) FROM PUBLIC;
  `);
  const appRole = process.env.APP_DB_ROLE;
  if (appRole) {
    await knex.raw(`
      GRANT SELECT, INSERT, DELETE ON channel_oauth_sessions TO ??;
      GRANT SELECT, INSERT ON meta_data_deletions TO ??;
      GRANT EXECUTE ON FUNCTION app_channels_for_meta_user(text, text) TO ??;
    `, [appRole, appRole, appRole]);
  }
};

exports.down = async knex => {
  await knex.raw('DROP FUNCTION IF EXISTS app_channels_for_meta_user(text, text)');
  await knex.schema.dropTableIfExists('meta_data_deletions');
  await knex.schema.dropTableIfExists('channel_oauth_sessions');
  await knex.schema.alterTable('messages', t => { t.dropColumn('template'); });
};
