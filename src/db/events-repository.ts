import { query, execute } from './connection';
import type { DBMarketingEvent } from '../types';

export async function createEvent(data: {
  nm_id: number;
  event_type: string;
  description?: string;
  event_date: string;
  created_by?: number;
}): Promise<number> {
  const result = await execute(
    `INSERT INTO marketing_events (nm_id, event_type, description, event_date, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [data.nm_id, data.event_type, data.description || null, data.event_date, data.created_by || null]
  );
  return result.insertId;
}

export async function getEventsByNmId(
  nmId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBMarketingEvent[]> {
  let sql = 'SELECT * FROM marketing_events WHERE nm_id = ?';
  const params: any[] = [nmId];

  if (dateFrom) {
    sql += ' AND event_date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND event_date <= ?';
    params.push(dateTo);
  }

  sql += ' ORDER BY event_date DESC, created_at DESC';
  return query<DBMarketingEvent[]>(sql, params);
}

export async function getAllEvents(
  dateFrom?: string,
  dateTo?: string
): Promise<DBMarketingEvent[]> {
  let sql = 'SELECT * FROM marketing_events WHERE 1=1';
  const params: any[] = [];

  if (dateFrom) {
    sql += ' AND event_date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND event_date <= ?';
    params.push(dateTo);
  }

  sql += ' ORDER BY event_date DESC, created_at DESC';
  return query<DBMarketingEvent[]>(sql, params);
}

export async function deleteEvent(id: number): Promise<void> {
  await execute('DELETE FROM marketing_events WHERE id = ?', [id]);
}

export async function updateEvent(
  id: number,
  data: { event_type?: string; description?: string; event_date?: string }
): Promise<void> {
  const fields: string[] = [];
  const params: any[] = [];

  if (data.event_type) {
    fields.push('event_type = ?');
    params.push(data.event_type);
  }
  if (data.description !== undefined) {
    fields.push('description = ?');
    params.push(data.description);
  }
  if (data.event_date) {
    fields.push('event_date = ?');
    params.push(data.event_date);
  }

  if (fields.length === 0) return;

  params.push(id);
  await execute(`UPDATE marketing_events SET ${fields.join(', ')} WHERE id = ?`, params);
}
