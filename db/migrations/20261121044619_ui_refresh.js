/**
 * UI refresh:
 *  - Customers created before "source" existed get it from their first channel identity.
 *  - The platform look moves to the new default (dark navy, electric blue) — only where the
 *    Super Admin never changed it (still on the original defaults). Fully reversible from
 *    Super Admin → Platform settings.
 * Tenant tables use FORCE RLS, so the backfill runs with the platform-admin flag set for this transaction only.
 */
exports.up = async knex => {
  await knex.raw("SELECT set_config('app.platform_admin', 'on', true)");
  await knex.raw(`
    UPDATE contacts c SET source = sub.provider
    FROM (
      SELECT DISTINCT ON (ci.contact_id) ci.contact_id, ci.provider
      FROM contact_identities ci ORDER BY ci.contact_id, ci.created_at
    ) sub
    WHERE sub.contact_id = c.id AND c.source IS NULL`);
  await knex.raw(`UPDATE platform_settings SET default_theme = 'dark' WHERE default_theme = 'system'`);
  await knex.raw(`UPDATE platform_settings SET primary_color = '#2563eb' WHERE lower(primary_color) = '#4f46e5'`);
};

exports.down = async knex => {
  await knex.raw(`UPDATE platform_settings SET primary_color = '#4f46e5' WHERE lower(primary_color) = '#2563eb'`);
  await knex.raw(`UPDATE platform_settings SET default_theme = 'system' WHERE default_theme = 'dark'`);
};
