/**
 * Dev task board — a shared, server-backed coordination list for developers
 * (and Claude Code agents) working in this repo.
 *
 * Lives in the same MySQL the app uses, so every developer working on
 * `ostapLase` sees one authoritative list. NOT tenant data: tasks are global,
 * not scoped by cabinet_id.
 *
 * Read endpoints are open; mutations require the shared secret (see
 * dev-tasks-routes.ts). The CLI (`src/cli/tasks.ts`) talks to this repo
 * directly for low-friction agent/developer use.
 */
import { query, execute } from './connection';

export type DevTaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked';

export const DEV_TASK_STATUSES: DevTaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
];

export type DevTaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export const DEV_TASK_PRIORITIES: DevTaskPriority[] = ['low', 'medium', 'high', 'urgent'];

export interface DevTask {
  id: number;
  title: string;
  description: string | null;
  status: DevTaskStatus;
  priority: DevTaskPriority;
  assignee: string | null;
  tags: string | null;
  branch: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DevTaskEvent {
  id: number;
  task_id: number;
  author: string | null;
  kind: string; // 'created' | 'status' | 'assign' | 'comment' | 'update'
  body: string | null;
  created_at: string;
}

/**
 * Idempotent schema bootstrap. Safe to call on every startup — mirrors the
 * `migrateAllowedUsersAddTelegramId` pattern. Also defined in docker/init.sql
 * for fresh installs.
 */
export async function ensureDevTasksSchema(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS dev_tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'backlog',
      priority VARCHAR(10) NOT NULL DEFAULT 'medium',
      assignee VARCHAR(100),
      tags VARCHAR(255),
      branch VARCHAR(200),
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_assignee (assignee)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await execute(`
    CREATE TABLE IF NOT EXISTS dev_task_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task_id INT NOT NULL,
      author VARCHAR(100),
      kind VARCHAR(20) NOT NULL DEFAULT 'comment',
      body TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_task (task_id),
      FOREIGN KEY (task_id) REFERENCES dev_tasks(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export interface ListFilter {
  status?: DevTaskStatus;
  assignee?: string;
  q?: string;
}

export async function listTasks(filter: ListFilter = {}): Promise<DevTask[]> {
  let sql = 'SELECT * FROM dev_tasks WHERE 1=1';
  const params: any[] = [];
  if (filter.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter.assignee) {
    sql += ' AND assignee = ?';
    params.push(filter.assignee);
  }
  if (filter.q) {
    sql += ' AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)';
    const like = `%${filter.q}%`;
    params.push(like, like, like);
  }
  // Order: active work first, then by priority, then newest.
  sql += `
    ORDER BY
      FIELD(status, 'in_progress','review','blocked','todo','backlog','done'),
      FIELD(priority, 'urgent','high','medium','low'),
      updated_at DESC`;
  return query<DevTask[]>(sql, params);
}

export async function getTask(id: number): Promise<DevTask | null> {
  const rows = await query<DevTask[]>('SELECT * FROM dev_tasks WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function getTaskEvents(taskId: number): Promise<DevTaskEvent[]> {
  return query<DevTaskEvent[]>(
    'SELECT * FROM dev_task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC',
    [taskId]
  );
}

async function logEvent(
  taskId: number,
  kind: string,
  body: string | null,
  author: string | null
): Promise<void> {
  await execute(
    'INSERT INTO dev_task_events (task_id, author, kind, body) VALUES (?, ?, ?, ?)',
    [taskId, author || null, kind, body || null]
  );
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: DevTaskStatus;
  priority?: DevTaskPriority;
  assignee?: string;
  tags?: string;
  branch?: string;
  author?: string;
}

export async function createTask(input: CreateTaskInput): Promise<DevTask> {
  const result = await execute(
    `INSERT INTO dev_tasks (title, description, status, priority, assignee, tags, branch, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title,
      input.description || null,
      input.status || 'backlog',
      input.priority || 'medium',
      input.assignee || null,
      input.tags || null,
      input.branch || null,
      input.author || null,
    ]
  );
  const id = result.insertId;
  await logEvent(id, 'created', input.title, input.author || null);
  return (await getTask(id))!;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: DevTaskStatus;
  priority?: DevTaskPriority;
  assignee?: string | null;
  tags?: string;
  branch?: string;
  author?: string;
}

export async function updateTask(id: number, input: UpdateTaskInput): Promise<DevTask | null> {
  const before = await getTask(id);
  if (!before) return null;

  const fields: string[] = [];
  const params: any[] = [];
  const set = (col: string, val: any) => {
    fields.push(`${col} = ?`);
    params.push(val);
  };

  if (input.title !== undefined) set('title', input.title);
  if (input.description !== undefined) set('description', input.description || null);
  if (input.status !== undefined) set('status', input.status);
  if (input.priority !== undefined) set('priority', input.priority);
  if (input.assignee !== undefined) set('assignee', input.assignee || null);
  if (input.tags !== undefined) set('tags', input.tags || null);
  if (input.branch !== undefined) set('branch', input.branch || null);

  if (fields.length > 0) {
    params.push(id);
    await execute(`UPDATE dev_tasks SET ${fields.join(', ')} WHERE id = ?`, params);
  }

  // Record meaningful transitions in the activity log for coordination.
  if (input.status !== undefined && input.status !== before.status) {
    await logEvent(id, 'status', `${before.status} → ${input.status}`, input.author || null);
  }
  if (input.assignee !== undefined && (input.assignee || null) !== before.assignee) {
    await logEvent(id, 'assign', input.assignee || '(unassigned)', input.author || null);
  }

  return getTask(id);
}

export async function addComment(
  id: number,
  body: string,
  author?: string
): Promise<DevTaskEvent | null> {
  const task = await getTask(id);
  if (!task) return null;
  await logEvent(id, 'comment', body, author || null);
  const events = await getTaskEvents(id);
  return events[events.length - 1] ?? null;
}

export async function deleteTask(id: number): Promise<boolean> {
  const result = await execute('DELETE FROM dev_tasks WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

export async function getStats(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }[]>(
    'SELECT status, COUNT(*) AS n FROM dev_tasks GROUP BY status'
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
