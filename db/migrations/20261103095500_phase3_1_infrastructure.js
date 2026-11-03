/**
 * Phase 3.1 infrastructure:
 *  - "system" security context for background processing (webhook ingestion/processing)
 *  - webhook_events: durable inbox for provider webhooks (persist → dedupe → async processing)
 *  - pgboss schema: pg-boss creates and migrates its own tables inside it at start-up, as the
 *    application role. The app role gets USAGE + CREATE on THIS schema only (not on the database).
 *  - socket_io_attachments: table used by @socket.io/postgres-adapter for large broadcasts
 *    when several app instances run (optional; harmless otherwise).
 */
exports.up = async knex => {
  await knex.raw(`
    CREATE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT COALESCE(current_setting('app.system', true), '') = 'on' $$;
  `);

  await knex.schema.createTable('webhook_events', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('provider').notNullable();
    t.text('endpoint_key');                 // e.g. a channel id for per-channel endpoints
    t.text('event_key').notNullable();      // provider-level unique id used for de-duplication
    t.text('event_type');
    t.text('external_account_id');          // page id / phone number id / bot … (routing input)
    t.jsonb('payload').notNullable();
    t.text('status').notNullable().defaultTo('received');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.uuid('company_id');                   // set after routing; no FK so history survives deletion
    t.uuid('channel_id');
    t.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('processing_started_at', { useTz: true });
    t.timestamp('processed_at', { useTz: true });
    t.unique(['provider', 'event_key']);
    t.index(['status', 'received_at']);
    t.index(['company_id', 'received_at']);
  });
  await knex.raw(`
    ALTER TABLE webhook_events
      ADD CONSTRAINT webhook_events_status_chk CHECK (status IN ('received','processing','processed','ignored','failed')),
      ADD CONSTRAINT webhook_events_key_len_chk CHECK (char_length(event_key) BETWEEN 1 AND 300);
    ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
    -- Only background/system code and platform admins can see or change raw provider events.
    -- Tenant contexts (company sessions) can never read them.
    CREATE POLICY webhook_events_system ON webhook_events FOR ALL
      USING (app_is_system() OR app_is_platform_admin())
      WITH CHECK (app_is_system() OR app_is_platform_admin());
  `);

  await knex.raw(`CREATE SCHEMA IF NOT EXISTS pgboss`);

  await knex.schema.createTable('socket_io_attachments', t => {
    t.bigIncrements('id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.binary('payload');
  });

  const appRole = process.env.APP_DB_ROLE;
  if (appRole) {
    await knex.raw(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_events TO ??;
      GRANT SELECT, INSERT, DELETE ON socket_io_attachments TO ??;
      GRANT USAGE, SELECT ON SEQUENCE socket_io_attachments_id_seq TO ??;
      GRANT USAGE, CREATE ON SCHEMA pgboss TO ??;
    `, [appRole, appRole, appRole, appRole]);
  }
};

exports.down = async knex => {
  await knex.schema.dropTableIfExists('socket_io_attachments');
  // pg-boss objects may be owned by the app role; CASCADE removes them with the schema.
  await knex.raw('DROP SCHEMA IF EXISTS pgboss CASCADE');
  await knex.schema.dropTableIfExists('webhook_events');
  await knex.raw('DROP FUNCTION IF EXISTS app_is_system()');
};
