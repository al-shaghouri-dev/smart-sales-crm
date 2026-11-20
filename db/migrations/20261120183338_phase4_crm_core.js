/**
 * Phase 4 — CRM core: customers (contacts) details, notes, sales pipeline, orders, tasks.
 * Every table is tenant-owned with FORCE ROW LEVEL SECURITY (same policy as the rest of the schema).
 */
const TABLES = ['contact_notes', 'pipeline_stages', 'deals', 'orders', 'order_items', 'tasks'];

exports.up = async knex => {
  await knex.schema.alterTable('contacts', t => {
    t.text('company_name');                      // the customer's own company (B2B)
    t.text('source');                            // channel / manual / import …
    t.uuid('owner_membership_id').references('company_memberships.id').onDelete('SET NULL');
  });
  await knex.raw(`
    UPDATE contacts SET status = 'new' WHERE status NOT IN ('new','lead','customer','inactive');
    ALTER TABLE contacts ADD CONSTRAINT contacts_status_chk CHECK (status IN ('new','lead','customer','inactive'));
    CREATE INDEX contacts_company_name_idx ON contacts (company_id, lower(display_name));
  `);

  await knex.schema.createTable('contact_notes', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.uuid('contact_id').notNullable();
    t.uuid('author_membership_id').references('company_memberships.id').onDelete('SET NULL');
    t.text('body').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.foreign(['company_id', 'contact_id']).references(['company_id', 'id']).inTable('contacts').onDelete('CASCADE');
    t.index(['contact_id', 'created_at']);
  });

  await knex.schema.createTable('pipeline_stages', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.text('name').notNullable();
    t.integer('position').notNullable().defaultTo(0);
    t.text('kind').notNullable().defaultTo('open');   // open | won | lost
    t.timestamps(true, true);
    t.unique(['company_id', 'id']);
    t.index(['company_id', 'position']);
  });
  await knex.raw(`ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_kind_chk CHECK (kind IN ('open','won','lost'))`);

  await knex.schema.createTable('deals', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.uuid('stage_id').notNullable();
    t.uuid('contact_id');
    t.text('title').notNullable();
    t.decimal('value', 14, 2).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable();
    t.uuid('owner_membership_id').references('company_memberships.id').onDelete('SET NULL');
    t.date('expected_close');
    t.text('status').notNullable().defaultTo('open');  // follows the stage kind
    t.timestamp('closed_at', { useTz: true });
    t.double('position').notNullable().defaultTo(0);
    t.uuid('created_by_user_id');
    t.timestamps(true, true);
    t.unique(['company_id', 'id']);
    t.foreign(['company_id', 'stage_id']).references(['company_id', 'id']).inTable('pipeline_stages').onDelete('RESTRICT');
    t.foreign(['company_id', 'contact_id']).references(['company_id', 'id']).inTable('contacts').onDelete('SET NULL');
    t.index(['company_id', 'stage_id', 'position']);
    t.index(['company_id', 'status', 'closed_at']);
  });
  await knex.raw(`ALTER TABLE deals ADD CONSTRAINT deals_status_chk CHECK (status IN ('open','won','lost'))`);

  await knex.schema.createTable('orders', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.integer('number').notNullable();
    t.uuid('contact_id');
    t.uuid('deal_id');
    t.text('status').notNullable().defaultTo('new');
    t.string('currency', 3).notNullable();
    t.decimal('subtotal', 14, 2).notNullable().defaultTo(0);
    t.decimal('tax', 14, 2).notNullable().defaultTo(0);
    t.decimal('shipping', 14, 2).notNullable().defaultTo(0);
    t.decimal('discount', 14, 2).notNullable().defaultTo(0);
    t.decimal('total', 14, 2).notNullable().defaultTo(0);
    t.text('notes');
    t.text('shipping_address');
    t.uuid('created_by_user_id');
    t.timestamps(true, true);
    t.unique(['company_id', 'id']);
    t.unique(['company_id', 'number']);
    t.foreign(['company_id', 'contact_id']).references(['company_id', 'id']).inTable('contacts').onDelete('SET NULL');
    t.foreign(['company_id', 'deal_id']).references(['company_id', 'id']).inTable('deals').onDelete('SET NULL');
    t.index(['company_id', 'status', 'created_at']);
  });
  await knex.raw(`ALTER TABLE orders ADD CONSTRAINT orders_status_chk CHECK (status IN ('new','confirmed','shipped','delivered','cancelled'))`);

  await knex.schema.createTable('order_items', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.uuid('order_id').notNullable();
    t.text('name').notNullable();
    t.decimal('quantity', 12, 3).notNullable().defaultTo(1);
    t.decimal('unit_price', 14, 2).notNullable().defaultTo(0);
    t.decimal('line_total', 14, 2).notNullable().defaultTo(0);
    t.integer('position').notNullable().defaultTo(0);
    t.foreign(['company_id', 'order_id']).references(['company_id', 'id']).inTable('orders').onDelete('CASCADE');
    t.index(['order_id', 'position']);
  });

  await knex.schema.createTable('tasks', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable().references('companies.id').onDelete('CASCADE');
    t.text('title').notNullable();
    t.text('notes');
    t.timestamp('due_at', { useTz: true });
    t.timestamp('done_at', { useTz: true });
    t.uuid('assignee_membership_id').references('company_memberships.id').onDelete('SET NULL');
    t.uuid('contact_id');
    t.uuid('deal_id');
    t.uuid('created_by_user_id');
    t.timestamps(true, true);
    t.foreign(['company_id', 'contact_id']).references(['company_id', 'id']).inTable('contacts').onDelete('CASCADE');
    t.foreign(['company_id', 'deal_id']).references(['company_id', 'id']).inTable('deals').onDelete('CASCADE');
    t.index(['company_id', 'assignee_membership_id', 'done_at', 'due_at']);
  });

  for (const table of TABLES) {
    await knex.raw(`
      ALTER TABLE ?? ENABLE ROW LEVEL SECURITY; ALTER TABLE ?? FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ?? USING (company_id = app_current_company() OR app_is_platform_admin())
        WITH CHECK (company_id = app_current_company() OR app_is_platform_admin());
    `, [table, table, table]);
  }
  if (process.env.APP_DB_ROLE) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLES.join(', ')} TO ??`, [process.env.APP_DB_ROLE]);
  }
};

exports.down = async knex => {
  for (const table of ['tasks', 'order_items', 'orders', 'deals', 'pipeline_stages', 'contact_notes']) await knex.schema.dropTableIfExists(table);
  await knex.raw(`
    ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_status_chk;
    DROP INDEX IF EXISTS contacts_company_name_idx;
  `);
  await knex.schema.alterTable('contacts', t => { t.dropColumn('company_name'); t.dropColumn('source'); t.dropColumn('owner_membership_id'); });
};
