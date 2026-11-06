/**
 * Phase 3.7 — channel operations.
 *  app_channels_for_maintenance()  ids of live channels whose token expires within 10 days or that
 *                                  need attention (needs_reconnect / error). Used by the hourly
 *                                  channel.maintenance job; all work then runs in each company's context.
 *  A definer-only read policy lets that function see credential expiry dates (never ciphertext:
 *  the function does not return it).
 */
exports.up = async knex => {
  await knex.raw(`
    CREATE POLICY channel_credentials_definer_read ON channel_credentials FOR SELECT USING (app_in_definer());
    -- Background jobs (system context inside one company) may create channel alerts for that company only.
    CREATE POLICY notifications_insert_channel ON notifications FOR INSERT
      WITH CHECK (current_setting('app.system', true) = 'on' AND company_id = app_current_company() AND type IN ('channel_needs_attention', 'channel_token_expiring'));
    CREATE FUNCTION app_channels_for_maintenance()
    RETURNS TABLE (channel_id uuid, company_id uuid, provider text, status text, expires_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT c.id, c.company_id, c.provider, c.status, cc.expires_at
      FROM channels c LEFT JOIN channel_credentials cc ON cc.channel_id = c.id
      WHERE c.status <> 'disconnected'
        AND (c.status IN ('needs_reconnect', 'error') OR (cc.expires_at IS NOT NULL AND cc.expires_at < now() + interval '10 days'))
      ORDER BY c.id LIMIT 5000
    $$;
    REVOKE ALL ON FUNCTION app_channels_for_maintenance() FROM PUBLIC;
  `);
  if (process.env.APP_DB_ROLE) await knex.raw('GRANT EXECUTE ON FUNCTION app_channels_for_maintenance() TO ??', [process.env.APP_DB_ROLE]);
};

exports.down = async knex => {
  await knex.raw(`
    DROP FUNCTION IF EXISTS app_channels_for_maintenance();
    DROP POLICY IF EXISTS channel_credentials_definer_read ON channel_credentials;
    DROP POLICY IF EXISTS notifications_insert_channel ON notifications;
  `);
};
