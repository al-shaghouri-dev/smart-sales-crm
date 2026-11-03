const knexFactory = require('knex');

/**
 * The app connects as a non-owner role without BYPASSRLS, so PostgreSQL Row Level Security
 * applies to every query. Tenant context is set per transaction with SET LOCAL semantics
 * (set_config(..., true)), so it can never leak between pooled connections.
 */
function createDb(databaseUrl) {
  const knex = knexFactory({
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 0, max: Number(process.env.DB_POOL_MAX || 10) }
  });

  /**
   * Run `fn(trx)` inside a transaction with the given security context.
   * ctx.companyId     – tenant whose rows are visible (RLS)
   * ctx.userId        – acting user (lets users see their own identity rows)
   * ctx.platformAdmin – only set by /api/platform routes; widens RLS to all tenants
   */
  async function withContext(ctx, fn) {
    return knex.transaction(async trx => {
      await trx.raw(
        `SELECT set_config('app.company_id', ?, true), set_config('app.user_id', ?, true), set_config('app.platform_admin', ?, true)`,
        [ctx.companyId || '', ctx.userId || '', ctx.platformAdmin ? 'on' : 'off']
      );
      return fn(trx);
    });
  }

  return { knex, withContext };
}

module.exports = { createDb };
