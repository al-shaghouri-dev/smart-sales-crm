/**
 * Phase 3.2 — messaging core.
 *  channels, channel_credentials (encrypted), contacts, contact_identities (no automatic merging),
 *  conversations, conversation_assignments (history), messages.
 *  plans.allowed_providers: optional per-plan provider restriction (NULL = all providers).
 *
 * Every table is tenant-owned with FORCE ROW LEVEL SECURITY. Background processing never gets
 * blanket access: webhook routing uses two narrow SECURITY DEFINER lookups that return only
 * (channel id, company id, provider, status); all reads/writes then run in that company's context.
 */
const TENANT_TABLES = ['channels', 'channel_credentials', 'contacts', 'contact_identities', 'conversations', 'conversation_assignments', 'messages'];

exports.up = async knex => {
  await knex.schema.alterTable('plans', t => { t.jsonb('allowed_providers'); }); // NULL = all providers
  // Per-company outbound controls (Super Admin only): kill switch + optional daily send cap.
  await knex.schema.alterTable('companies', t => {
    t.boolean('outbound_paused').notNullable().defaultTo(false);
    t.integer('outbound_daily_limit');
  });

  await knex.schema.createTable('channels', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.text('provider').notNullable();
    t.text('status').notNullable().defaultTo('connecting');
    t.text('display_name').notNullable();
    t.text('external_account_id');
    t.jsonb('external_meta').notNullable().defaultTo('{}');
    t.uuid('connected_by');
    t.timestamp('connected_at', { useTz: true });
    t.timestamp('disconnected_at', { useTz: true });
    t.timestamp('last_inbound_at', { useTz: true });
    t.timestamp('last_outbound_at', { useTz: true });
    t.timestamp('last_health_check_at', { useTz: true });
    t.text('last_error');
    t.timestamp('last_error_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['company_id', 'id']);
    t.index(['company_id', 'status']);
  });
  await knex.raw(`
    ALTER TABLE channels
      ADD CONSTRAINT channels_status_chk CHECK (status IN ('connecting','active','needs_reconnect','error','disconnected')),
      ADD CONSTRAINT channels_provider_chk CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$');
    -- One live connection per provider account across the whole platform (two companies can never
    -- claim the same page/bot/number). Disconnected rows are kept for history and allow reconnecting.
    CREATE UNIQUE INDEX channels_live_account_uq ON channels (provider, external_account_id)
      WHERE status <> 'disconnected' AND external_account_id IS NOT NULL;
  `);

  await knex.schema.createTable('channel_credentials', t => {
    t.uuid('channel_id').primary();
    t.uuid('company_id').notNullable();
    t.text('ciphertext').notNullable();          // credential encryption v2 (AAD = purpose|company|channel)
    t.text('key_id');
    t.jsonb('scopes');
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('refreshed_at', { useTz: true });
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.foreign(['company_id', 'channel_id']).references(['company_id', 'id']).inTable('channels').onDelete('CASCADE');
  });

  await knex.schema.createTable('contacts', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.text('display_name').notNullable();
    t.text('phone');
    t.text('email');
    t.text('notes');
    t.jsonb('tags').notNullable().defaultTo('[]');
    t.text('status').notNullable().defaultTo('new');
    t.timestamp('first_contact_at', { useTz: true });
    t.timestamp('last_contact_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['company_id', 'id']);
    t.index(['company_id', 'last_contact_at']);
  });

  await knex.schema.createTable('contact_identities', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.uuid('contact_id').notNullable();
    t.uuid('channel_id').notNullable();
    t.text('provider').notNullable();
    t.text('external_user_id').notNullable();
    t.jsonb('profile').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['channel_id', 'external_user_id']);
    t.unique(['company_id', 'id']);
    t.foreign(['company_id', 'contact_id']).references(['company_id', 'id']).inTable('contacts').onDelete('CASCADE');
    t.foreign(['company_id', 'channel_id']).references(['company_id', 'id']).inTable('channels').onDelete('CASCADE');
  });

  await knex.schema.createTable('conversations', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.uuid('channel_id').notNullable();
    t.uuid('contact_id').notNullable();
    t.uuid('identity_id').notNullable();
    t.text('status').notNullable().defaultTo('open');
    t.text('priority').notNullable().defaultTo('normal');
    t.uuid('assigned_membership_id');
    t.integer('unread_count').notNullable().defaultTo(0);
    t.text('last_message_preview');
    t.timestamp('last_message_at', { useTz: true });
    t.timestamp('last_inbound_at', { useTz: true });   // drives provider reply windows
    t.timestamp('last_outbound_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['channel_id', 'identity_id']);
    t.unique(['company_id', 'id']);
    t.foreign(['company_id', 'channel_id']).references(['company_id', 'id']).inTable('channels').onDelete('CASCADE');
    t.foreign(['company_id', 'contact_id']).references(['company_id', 'id']).inTable('contacts').onDelete('CASCADE');
    t.foreign(['company_id', 'identity_id']).references(['company_id', 'id']).inTable('contact_identities').onDelete('CASCADE');
    t.foreign('assigned_membership_id').references('company_memberships.id').onDelete('SET NULL');
    t.index(['company_id', 'status', 'last_message_at']);
    t.index(['company_id', 'assigned_membership_id']);
  });
  await knex.raw(`
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_status_chk CHECK (status IN ('open','pending','closed')),
      ADD CONSTRAINT conversations_priority_chk CHECK (priority IN ('low','normal','high','urgent'));
  `);

  await knex.schema.createTable('conversation_assignments', t => {
    t.bigIncrements('id');
    t.uuid('company_id').notNullable();
    t.uuid('conversation_id').notNullable();
    t.uuid('from_membership_id');
    t.uuid('to_membership_id');
    t.uuid('assigned_by_user_id');
    t.text('reason');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.foreign(['company_id', 'conversation_id']).references(['company_id', 'id']).inTable('conversations').onDelete('CASCADE');
    t.index(['conversation_id', 'created_at']);
  });

  await knex.schema.createTable('messages', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.uuid('conversation_id').notNullable();
    t.uuid('channel_id').notNullable();
    t.text('direction').notNullable();                // in | out
    t.text('sender_type').notNullable();              // contact | member | system
    t.uuid('sender_membership_id');
    t.text('type').notNullable().defaultTo('text');
    t.text('body');
    t.jsonb('attachments').notNullable().defaultTo('[]');
    t.text('external_message_id');
    t.text('client_message_id');                      // idempotency key from the composer
    t.text('status').notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('error_code');
    t.text('error_message');
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('delivered_at', { useTz: true });
    t.timestamp('read_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['company_id', 'id']);
    t.foreign(['company_id', 'conversation_id']).references(['company_id', 'id']).inTable('conversations').onDelete('CASCADE');
    t.foreign(['company_id', 'channel_id']).references(['company_id', 'id']).inTable('channels').onDelete('CASCADE');
    t.index(['conversation_id', 'created_at']);
  });
  await knex.raw(`
    ALTER TABLE messages
      ADD CONSTRAINT messages_direction_chk CHECK (direction IN ('in','out')),
      ADD CONSTRAINT messages_sender_chk CHECK (sender_type IN ('contact','member','system')),
      ADD CONSTRAINT messages_type_chk CHECK (type IN ('text','image','file','audio','video','sticker','location','template','unsupported')),
      ADD CONSTRAINT messages_status_chk CHECK (status IN ('received','queued','sending','sent','delivered','read','failed'));
    -- De-duplication of provider deliveries and of composer retries.
    CREATE UNIQUE INDEX messages_external_uq ON messages (channel_id, external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE INDEX messages_outbox_idx ON messages (status, created_at) WHERE direction = 'out' AND status IN ('queued','sending');
    CREATE UNIQUE INDEX messages_client_uq ON messages (conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
  `);

  for (const table of TENANT_TABLES) {
    await knex.raw(`
      ALTER TABLE ?? ENABLE ROW LEVEL SECURITY; ALTER TABLE ?? FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ?? USING (company_id = app_current_company() OR app_is_platform_admin())
        WITH CHECK (company_id = app_current_company() OR app_is_platform_admin());
    `, [table, table, table]);
  }

  // SECURITY DEFINER helpers below run as the schema owner, which FORCE RLS also binds. These
  // policies let ONLY those narrow functions (app_in_definer()) read channels and maintain the
  // outbox; normal application queries never match them.
  await knex.raw(`
    CREATE POLICY channels_definer_read ON channels FOR SELECT USING (app_in_definer());
    CREATE POLICY messages_definer_read ON messages FOR SELECT USING (app_in_definer());
    CREATE POLICY messages_definer_update ON messages FOR UPDATE USING (app_in_definer()) WITH CHECK (app_in_definer());
  `);

  // Narrow routing lookups for webhook processing (no tenant context exists yet at that point).
  await knex.raw(`
    CREATE FUNCTION app_channel_route(p_provider text, p_external text)
    RETURNS TABLE (channel_id uuid, company_id uuid, provider text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT c.id, c.company_id, c.provider, c.status FROM channels c
      WHERE c.provider = p_provider AND c.external_account_id = p_external AND c.status <> 'disconnected'
    $$;
    CREATE FUNCTION app_channel_lookup(p_id uuid)
    RETURNS TABLE (channel_id uuid, company_id uuid, provider text, status text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT c.id, c.company_id, c.provider, c.status FROM channels c WHERE c.id = p_id
    $$;
    -- Outbox maintenance (sweeper): ids only, never message content.
    CREATE FUNCTION app_outbox_stale(p_limit integer)
    RETURNS TABLE (message_id uuid, company_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT m.id, m.company_id FROM messages m
      -- Retries back off for at most 4 minutes (message.send retryDelayMax), so a queued row untouched
      -- for 5 minutes has lost its job. Re-sending is safe: the worker claims only "queued" rows.
      WHERE m.direction = 'out' AND m.status = 'queued' AND m.updated_at < now() - interval '5 minutes'
      ORDER BY m.updated_at LIMIT LEAST(GREATEST(p_limit, 1), 1000)
    $$;
    -- A send that stayed "sending" for 10 minutes has an unknown outcome (the worker died during the
    -- provider call). It is marked failed instead of retried, so a customer never gets a duplicate.
    CREATE FUNCTION app_outbox_fail_stuck()
    RETURNS integer
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      WITH s AS (
        UPDATE messages SET status = 'failed', error_code = 'send.unknown_outcome'
        WHERE direction = 'out' AND status = 'sending' AND updated_at < now() - interval '10 minutes'
        RETURNING 1
      ) SELECT count(*)::int FROM s
    $$;
    REVOKE ALL ON FUNCTION app_channel_route(text, text), app_channel_lookup(uuid), app_outbox_stale(integer), app_outbox_fail_stuck() FROM PUBLIC;
  `);

  const appRole = process.env.APP_DB_ROLE;
  if (appRole) {
    await knex.raw(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON channels, channel_credentials, contacts, contact_identities, conversations, messages TO ??;
      GRANT SELECT, INSERT ON conversation_assignments TO ??;
      GRANT USAGE, SELECT ON SEQUENCE conversation_assignments_id_seq TO ??;
      GRANT EXECUTE ON FUNCTION app_channel_route(text, text), app_channel_lookup(uuid), app_outbox_stale(integer), app_outbox_fail_stuck() TO ??;
    `, [appRole, appRole, appRole, appRole]);
  }
};

exports.down = async knex => {
  await knex.raw('DROP FUNCTION IF EXISTS app_channel_route(text, text), app_channel_lookup(uuid), app_outbox_stale(integer), app_outbox_fail_stuck()');
  for (const table of ['messages', 'conversation_assignments', 'conversations', 'contact_identities', 'contacts', 'channel_credentials', 'channels']) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.schema.alterTable('plans', t => { t.dropColumn('allowed_providers'); });
  await knex.schema.alterTable('companies', t => { t.dropColumn('outbound_paused'); t.dropColumn('outbound_daily_limit'); });
};
