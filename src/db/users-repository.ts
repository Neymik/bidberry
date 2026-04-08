import { query, execute } from './connection';

export interface DBUser {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  photo_url: string | null;
  role: string;
  created_at: Date;
  updated_at: Date;
}

export async function getUserByTelegramId(telegramId: number): Promise<DBUser | null> {
  const rows = await query<DBUser[]>(
    'SELECT * FROM users WHERE telegram_id = ?',
    [telegramId]
  );
  return rows[0] || null;
}

export async function getUserById(id: number): Promise<DBUser | null> {
  const rows = await query<DBUser[]>(
    'SELECT * FROM users WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

export async function createUser(user: {
  telegram_id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
}): Promise<DBUser> {
  const result = await execute(
    `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
     VALUES (?, ?, ?, ?, ?)`,
    [
      user.telegram_id,
      user.username || null,
      user.first_name || null,
      user.last_name || null,
      user.photo_url || null,
    ]
  );
  return (await getUserById(result.insertId))!;
}

export async function updateUser(
  telegramId: number,
  data: { username?: string; first_name?: string; last_name?: string; photo_url?: string }
): Promise<void> {
  await execute(
    `UPDATE users SET username = COALESCE(?, username), first_name = COALESCE(?, first_name),
     last_name = COALESCE(?, last_name), photo_url = COALESCE(?, photo_url)
     WHERE telegram_id = ?`,
    [data.username || null, data.first_name || null, data.last_name || null, data.photo_url || null, telegramId]
  );
}

export async function getRoleById(id: number): Promise<string | null> {
  const rows = await query<{ role: string }[]>(
    'SELECT role FROM users WHERE id = ?',
    [id]
  );
  return rows[0]?.role || null;
}
