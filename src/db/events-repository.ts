import { query, execute } from './connection';
import type { DBMarketingEvent } from '../types';

export async function createEvent(cabinetId: number, data: {
  nm_id: number;
  event_type: string;
  description?: string;
  event_date: string;
  created_by?: number;
}): Promise<number> {
  const result = await execute(
    `INSERT INTO marketing_events (cabinet_id, nm_id, event_type, description, event_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [cabinetId, data.nm_id, data.event_type, data.description || null, data.event_date, data.created_by || null]
  );
  return result.insertId;
}

export async function getEventsByNmId(
  cabinetId: number,
  nmId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBMarketingEvent[]> {
  let sql = 'SELECT * FROM marketing_events WHERE cabinet_id = ? AND nm_id = ?';
  const params: any[] = [cabinetId, nmId];

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
  cabinetId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBMarketingEvent[]> {
  let sql = 'SELECT * FROM marketing_events WHERE cabinet_id = ?';
  const params: any[] = [cabinetId];

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

export async function deleteEvent(cabinetId: number, id: number): Promise<void> {
  await execute('DELETE FROM marketing_events WHERE cabinet_id = ? AND id = ?', [cabinetId, id]);
}

export async function updateEvent(
  cabinetId: number,
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

  params.push(cabinetId, id);
  await execute(`UPDATE marketing_events SET ${fields.join(', ')} WHERE cabinet_id = ? AND id = ?`, params);
}
