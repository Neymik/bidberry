import { query, execute } from './connection';

export interface DBAccount {
  id: number;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface DBUserAccount {
  id: number;
  user_id: number;
  account_id: number;
  role: string;
  created_at: Date;
}

export interface DBCabinet {
  id: number;
  account_id: number;
  name: string;
  wb_api_key: string;
  is_active: boolean;
  last_sync_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DBAllowedUser {
  id: number;
  username: string;
  telegram_id: number | null;
  added_by: string | null;
  created_at: Date;
}

// === ACCOUNTS ===

export async function getAccountsForUser(userId: number): Promise<(DBAccount & { role: string })[]> {
  return query<(DBAccount & { role: string })[]>(
    `SELECT a.*, ua.role FROM accounts a
     JOIN user_accounts ua ON a.id = ua.account_id
     WHERE ua.user_id = ?
     ORDER BY a.name`,
    [userId]
  );
}

export async function getAccountById(accountId: number): Promise<DBAccount | null> {
  const rows = await query<DBAccount[]>('SELECT * FROM accounts WHERE id = ?', [accountId]);
  return rows[0] || null;
}

export async function createAccount(name: string): Promise<number> {
  const result = await execute('INSERT INTO accounts (name) VALUES (?)', [name]);
  return result.insertId;
}

export async function getAllAccounts(): Promise<DBAccount[]> {
  return query<DBAccount[]>('SELECT * FROM accounts ORDER BY id');
}

export async function deleteAccount(accountId: number): Promise<void> {
  await execute('DELETE FROM accounts WHERE id = ?', [accountId]);
}

// === USER ACCOUNTS ===

export async function addUserToAccount(userId: number, accountId: number, role = 'member'): Promise<void> {
  await execute(
    `INSERT INTO user_accounts (user_id, account_id, role) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [userId, accountId, role]
  );
}

export async function removeUserFromAccount(userId: number, accountId: number): Promise<void> {
  await execute('DELETE FROM user_accounts WHERE user_id = ? AND account_id = ?', [userId, accountId]);
}

export async function getUserAccountRole(userId: number, accountId: number): Promise<string | null> {
  const rows = await query<{ role: string }[]>(
    'SELECT role FROM user_accounts WHERE user_id = ? AND account_id = ?',
    [userId, accountId]
  );
  return rows[0]?.role || null;
}

// === CABINETS ===

export async function getCabinetsForUser(userId: number): Promise<DBCabinet[]> {
  return query<DBCabinet[]>(
    `SELECT c.* FROM cabinets c
     JOIN user_accounts ua ON c.account_id = ua.account_id
     WHERE ua.user_id = ? AND c.is_active = TRUE
     ORDER BY c.name`,
    [userId]
  );
}

export async function getCabinetById(id: number): Promise<DBCabinet | null> {
  const rows = await query<DBCabinet[]>('SELECT * FROM cabinets WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function getActiveCabinets(): Promise<DBCabinet[]> {
  return query<DBCabinet[]>('SELECT * FROM cabinets WHERE is_active = TRUE ORDER BY id');
}

export async function getAllCabinets(): Promise<DBCabinet[]> {
  return query<DBCabinet[]>(
    `SELECT c.*, a.name as account_name FROM cabinets c
     JOIN accounts a ON c.account_id = a.id
     ORDER BY c.id`
  );
}

export async function createCabinet(accountId: number, name: string, apiKey: string): Promise<number> {
  const result = await execute(
    'INSERT INTO cabinets (account_id, name, wb_api_key) VALUES (?, ?, ?)',
    [accountId, name, apiKey]
  );
  return result.insertId;
}

export async function updateCabinet(id: number, updates: {
  name?: string;
  wb_api_key?: string;
  is_active?: boolean;
}): Promise<void> {
  const fields: string[] = [];
  const params: any[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); params.push(updates.name); }
  if (updates.wb_api_key !== undefined) { fields.push('wb_api_key = ?'); params.push(updates.wb_api_key); }
  if (updates.is_active !== undefined) { fields.push('is_active = ?'); params.push(updates.is_active); }

  if (fields.length === 0) return;

  params.push(id);
  await execute(`UPDATE cabinets SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function deleteCabinet(id: number): Promise<void> {
  await execute('DELETE FROM cabinets WHERE id = ?', [id]);
}

export async function updateCabinetLastSync(id: number): Promise<void> {
  await execute('UPDATE cabinets SET last_sync_at = NOW() WHERE id = ?', [id]);
}

export async function userHasAccessToCabinet(userId: number, cabinetId: number): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM cabinets c
     JOIN user_accounts ua ON c.account_id = ua.account_id
     WHERE ua.user_id = ? AND c.id = ?
     LIMIT 1`,
    [userId, cabinetId]
  );
  return rows.length > 0;
}

// === WHITELIST ===
//
// Migration story: the original table keyed access on `username`, which is
// mutable on Telegram's side and reusable by anyone after release. The new
// model keys on `telegram_id` (immutable, unique). To keep existing seeded
// rows working without a flag-day data migration, we run in dual mode:
//
//   - rows with telegram_id IS NULL → "pending claim", any user with the
//     matching username can log in once and the row gets locked to their id
//   - rows with telegram_id IS NOT NULL → only that id can use the row
//
// `migrateAllowedUsersAddTelegramId` is idempotent and runs at startup.

export async function migrateAllowedUsersAddTelegramId(): Promise<void> {
  // Add the column if missing.
  const cols = await query<any[]>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allowed_users'
       AND COLUMN_NAME = 'telegram_id'`
  );
  if (cols.length === 0) {
    await execute('ALTER TABLE allowed_users ADD COLUMN telegram_id BIGINT NULL');
    await execute('CREATE UNIQUE INDEX uq_allowed_users_telegram_id ON allowed_users (telegram_id)');
    console.log('[migration] allowed_users.telegram_id column added');
  }
}

export async function isUserAllowedByTelegramId(telegramId: number): Promise<boolean> {
  const rows = await query<any[]>(
    'SELECT 1 FROM allowed_users WHERE telegram_id = ? LIMIT 1',
    [telegramId]
  );
  return rows.length > 0;
}

export async function isUserAllowed(username: string): Promise<boolean> {
  // Username-only path: only matches PENDING rows (telegram_id IS NULL).
  // A row that has already been claimed by some telegram_id is no longer
  // a valid entry for a different account that happens to share the username.
  const rows = await query<any[]>(
    'SELECT 1 FROM allowed_users WHERE username = ? AND telegram_id IS NULL LIMIT 1',
    [username]
  );
  return rows.length > 0;
}

export async function lockAllowedUserToTelegramId(
  username: string,
  telegramId: number
): Promise<void> {
  // Bind the pending row to this telegram_id. The unique index prevents
  // double-binding to the same telegram_id (if the user already has another
  // row, this UPDATE will fail loud and we keep the existing row).
  try {
    await execute(
      'UPDATE allowed_users SET telegram_id = ? WHERE username = ? AND telegram_id IS NULL',
      [telegramId, username]
    );
  } catch (err: any) {
    console.error(`[whitelist] could not lock ${username} → ${telegramId}: ${err.message}`);
  }
}

export async function addAllowedUser(username: string, addedBy?: string): Promise<void> {
  await execute(
    'INSERT IGNORE INTO allowed_users (username, added_by) VALUES (?, ?)',
    [username, addedBy || null]
  );
}

export async function removeAllowedUser(username: string): Promise<void> {
  await execute('DELETE FROM allowed_users WHERE username = ?', [username]);
}

export async function getAllowedUsers(): Promise<DBAllowedUser[]> {
  return query<DBAllowedUser[]>('SELECT * FROM allowed_users ORDER BY username');
}

// === ADMIN HELPERS ===

export async function getAllUsers(): Promise<any[]> {
  return query<any[]>(
    `SELECT u.*, GROUP_CONCAT(DISTINCT ua.account_id) as account_ids,
            GROUP_CONCAT(DISTINCT ua.role) as account_roles
     FROM users u
     LEFT JOIN user_accounts ua ON u.id = ua.user_id
     GROUP BY u.id
     ORDER BY u.id`
  );
}

export async function getAllAccountsWithCabinets(): Promise<any[]> {
  const accounts = await query<any[]>('SELECT * FROM accounts ORDER BY id');
  const cabinets = await query<any[]>(
    `SELECT c.id, c.account_id, c.name, c.is_active, c.last_sync_at, c.created_at
     FROM cabinets c ORDER BY c.id`
  );
  const users = await query<any[]>(
    `SELECT ua.account_id, u.id as user_id, u.username, u.first_name, ua.role
     FROM user_accounts ua JOIN users u ON ua.user_id = u.id
     ORDER BY ua.account_id`
  );

  return accounts.map(a => ({
    ...a,
    cabinets: cabinets.filter(c => c.account_id === a.id),
    users: users.filter(u => u.account_id === a.id),
  }));
}
