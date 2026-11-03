require('dotenv').config();

// Migrations run as the schema owner; the app itself uses DATABASE_URL (a role subject to RLS).
module.exports = {
  client: 'pg',
  connection: process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL,
  migrations: { directory: './db/migrations', tableName: 'knex_migrations' }
};
