/**
 * Migration script: Single-tenant → Multi-cabinet architecture
 *
 * 1. Creates accounts, user_accounts, cabinets, allowed_users tables
 * 2. Adds cabinet_id column to all 20 data tables
 * 3. Creates default account + cabinet from WB_API_KEY env
 * 4. Backfills cabinet_id=1 on all existing rows
 * 5. Sets tNeymik role='admin'
 *
 * Usage: docker exec wb-analytics-app bun run src/cli/migrate-multi-cabinet.ts
 */
import { query, execute } from '../db/connection';

function log(msg: string) {
  console.log(`[migrate] ${msg}`);
}

async function run() {
  log('Starting multi-cabinet migration...');

  // 1. Create new tables
  log('Creating new tables...');

  await execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS user_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      account_id INT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'member',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      UNIQUE KEY unique_user_account (user_id, account_id),
      INDEX idx_user_id (user_id),
      INDEX idx_account_id (account_id)
    )
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS cabinets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      wb_api_key TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      last_sync_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      INDEX idx_account_id (account_id),
      INDEX idx_active (is_active)
    )
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS allowed_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      added_by VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_username (username)
    )
  `);

  // Seed allowed_users
  log('Seeding allowed_users...');
  const whitelist = ['tNeymik', 'Ropejamp', 'Valentina_09876', 'pauluzumuz'];
  for (const username of whitelist) {
    await execute(
      `INSERT IGNORE INTO allowed_users (username, added_by) VALUES (?, 'system')`,
      [username]
    );
  }

  // 2. Add cabinet_id column to all 20 data tables
  const tables = [
    'campaigns', 'bids', 'campaign_stats', 'products', 'product_analytics',
    'keyword_positions', 'import_history', 'keyword_collections', 'product_costs',
    'sales_reports', 'bid_rules', 'bid_history', 'orders', 'stock_snapshots',
    'traffic_source_analytics', 'marketing_events', 'promotion_participation',
    'campaign_products', 'search_query_analytics', 'search_cluster_stats',
  ];

  for (const table of tables) {
    log(`Adding cabinet_id to ${table}...`);
    try {
      // Check if column exists first
      const cols = await query<any[]>(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'cabinet_id'`,
        [table]
      );
      if (cols.length === 0) {
        await execute(`ALTER TABLE ${table} ADD COLUMN cabinet_id INT AFTER id`);
        await execute(`ALTER TABLE ${table} ADD INDEX idx_cabinet_id (cabinet_id)`);
      } else {
        log(`  ${table} already has cabinet_id, skipping`);
      }
    } catch (err: any) {
      log(`  Warning: ${table} - ${err.message}`);
    }
  }

  // 3. Update unique constraints to include cabinet_id
  log('Updating unique constraints...');
  const constraintUpdates: { table: string; oldKey: string; newKey: string; columns: string }[] = [
    { table: 'campaigns', oldKey: 'campaign_id', newKey: 'unique_cabinet_campaign', columns: 'cabinet_id, campaign_id' },
    { table: 'products', oldKey: 'nm_id', newKey: 'unique_cabinet_nm', columns: 'cabinet_id, nm_id' },
    { table: 'campaign_stats', oldKey: 'unique_campaign_date', newKey: 'unique_cabinet_campaign_date', columns: 'cabinet_id, campaign_id, date' },
    { table: 'product_analytics', oldKey: 'unique_product_date', newKey: 'unique_cabinet_product_date', columns: 'cabinet_id, nm_id, date' },
    { table: 'keyword_collections', oldKey: 'unique_product_keyword', newKey: 'unique_cabinet_product_keyword', columns: 'cabinet_id, nm_id, keyword(255)' },
    { table: 'product_costs', oldKey: 'unique_product_cost', newKey: 'unique_cabinet_product_cost', columns: 'cabinet_id, nm_id' },
    { table: 'sales_reports', oldKey: 'unique_sales_date', newKey: 'unique_cabinet_sales_date', columns: 'cabinet_id, nm_id, date' },
    { table: 'orders', oldKey: 'order_id', newKey: 'unique_cabinet_order', columns: 'cabinet_id, order_id' },
    { table: 'stock_snapshots', oldKey: 'unique_stock_snapshot', newKey: 'unique_cabinet_stock_snapshot', columns: 'cabinet_id, nm_id, tech_size, warehouse_name, snapshot_date' },
    { table: 'traffic_source_analytics', oldKey: 'unique_traffic_source', newKey: 'unique_cabinet_traffic_source', columns: 'cabinet_id, nm_id, date, source_name' },
    { table: 'promotion_participation', oldKey: 'unique_nm_promo', newKey: 'unique_cabinet_nm_promo', columns: 'cabinet_id, nm_id, promo_id' },
    { table: 'campaign_products', oldKey: 'unique_campaign_nm', newKey: 'unique_cabinet_campaign_nm', columns: 'cabinet_id, campaign_id, nm_id' },
    { table: 'search_query_analytics', oldKey: 'unique_nm_kw_date', newKey: 'unique_cabinet_nm_kw_date', columns: 'cabinet_id, nm_id, keyword(255), date' },
    { table: 'search_cluster_stats', oldKey: 'unique_campaign_cluster_date', newKey: 'unique_cabinet_campaign_cluster_date', columns: 'cabinet_id, campaign_id, cluster_name(255), date' },
  ];

  for (const { table, oldKey, newKey, columns } of constraintUpdates) {
    try {
      // Check if new key already exists
      const existing = await query<any[]>(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, newKey]
      );
      if (existing.length > 0) {
        log(`  ${table}: ${newKey} already exists, skipping`);
        continue;
      }
      // Drop old unique key
      await execute(`ALTER TABLE ${table} DROP INDEX ${oldKey}`).catch(() => {});
      // Create new unique key with cabinet_id
      await execute(`ALTER TABLE ${table} ADD UNIQUE KEY ${newKey} (${columns})`);
      log(`  ${table}: ${oldKey} → ${newKey}`);
    } catch (err: any) {
      log(`  Warning: ${table} constraint update - ${err.message}`);
    }
  }

  // 4. Drop foreign keys that prevent cabinet-scoped data
  log('Dropping old foreign keys...');
  const fkDrops: { table: string; fk: string }[] = [
    { table: 'bids', fk: 'bids_ibfk_1' },
    { table: 'campaign_stats', fk: 'campaign_stats_ibfk_1' },
    { table: 'product_analytics', fk: 'product_analytics_ibfk_1' },
    { table: 'keyword_positions', fk: 'keyword_positions_ibfk_1' },
    { table: 'keyword_collections', fk: 'keyword_collections_ibfk_1' },
    { table: 'product_costs', fk: 'product_costs_ibfk_1' },
    { table: 'sales_reports', fk: 'sales_reports_ibfk_1' },
    { table: 'bid_rules', fk: 'bid_rules_ibfk_1' },
    { table: 'bid_history', fk: 'bid_history_ibfk_1' },
    { table: 'campaign_products', fk: 'campaign_products_ibfk_1' },
    { table: 'search_cluster_stats', fk: 'search_cluster_stats_ibfk_1' },
  ];
  for (const { table, fk } of fkDrops) {
    try {
      await execute(`ALTER TABLE ${table} DROP FOREIGN KEY ${fk}`);
      log(`  Dropped FK ${fk} from ${table}`);
    } catch {
      // Already dropped or doesn't exist
    }
  }

  // 5. Drop and recreate views
  log('Recreating views...');
  await execute('DROP VIEW IF EXISTS daily_summary');
  await execute('DROP VIEW IF EXISTS pnl_summary');

  // 6. Create default account + cabinet from env
  log('Creating default account and cabinet...');
  const apiKey = process.env.WB_API_KEY || '';
  if (!apiKey) {
    log('WARNING: WB_API_KEY not set in env, creating cabinet with empty key');
  }

  // Check if default account already exists
  const existingAccounts = await query<any[]>('SELECT id FROM accounts LIMIT 1');
  let accountId: number;
  let cabinetId: number;

  if (existingAccounts.length > 0) {
    accountId = existingAccounts[0].id;
    const existingCabinets = await query<any[]>('SELECT id FROM cabinets WHERE account_id = ? LIMIT 1', [accountId]);
    cabinetId = existingCabinets[0]?.id || 1;
    log(`Using existing account ${accountId}, cabinet ${cabinetId}`);
  } else {
    const accountResult = await execute(
      `INSERT INTO accounts (name) VALUES ('Основной аккаунт')`
    );
    accountId = accountResult.insertId;

    const cabinetResult = await execute(
      `INSERT INTO cabinets (account_id, name, wb_api_key) VALUES (?, 'Основной кабинет', ?)`,
      [accountId, apiKey]
    );
    cabinetId = cabinetResult.insertId;
    log(`Created account ${accountId}, cabinet ${cabinetId}`);
  }

  // 7. Link all existing users to the default account
  log('Linking users to default account...');
  const users = await query<any[]>('SELECT id, username FROM users');
  for (const user of users) {
    try {
      const role = user.username === 'tNeymik' ? 'admin' : 'member';
      await execute(
        `INSERT IGNORE INTO user_accounts (user_id, account_id, role) VALUES (?, ?, ?)`,
        [user.id, accountId, role]
      );
    } catch {}
  }

  // 8. Set tNeymik as admin
  log('Setting tNeymik as admin...');
  await execute(`UPDATE users SET role = 'admin' WHERE username = 'tNeymik'`);

  // 9. Backfill cabinet_id on all existing rows
  log('Backfilling cabinet_id on existing data...');
  for (const table of tables) {
    try {
      const result = await execute(
        `UPDATE ${table} SET cabinet_id = ? WHERE cabinet_id IS NULL`,
        [cabinetId]
      );
      log(`  ${table}: ${result.affectedRows ?? 0} rows updated`);
    } catch (err: any) {
      log(`  Warning: ${table} backfill - ${err.message}`);
    }
  }

  log('Migration complete!');
  log(`Account ID: ${accountId}`);
  log(`Cabinet ID: ${cabinetId}`);
  log(`Users linked: ${users.length}`);
  process.exit(0);
}

run().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
