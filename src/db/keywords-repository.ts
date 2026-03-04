import { query, execute } from './connection';
import type { DBKeywordCollection, DBKeywordPosition } from '../types';

// Get all tracked keywords for a product
export async function getKeywords(cabinetId: number, nmId: number): Promise<DBKeywordCollection[]> {
  return query<DBKeywordCollection[]>(
    'SELECT * FROM keyword_collections WHERE cabinet_id = ? AND nm_id = ? ORDER BY frequency DESC',
    [cabinetId, nmId]
  );
}

// Add keyword to track for a product
export async function addKeyword(cabinetId: number, nmId: number, keyword: string, frequency?: number, source?: string): Promise<void> {
  await execute(
    `INSERT INTO keyword_collections (cabinet_id, nm_id, keyword, frequency, source)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE frequency = COALESCE(VALUES(frequency), frequency), updated_at = NOW()`,
    [cabinetId, nmId, keyword, frequency || 0, source || 'manual']
  );
}

// Add multiple keywords in batch
export async function addKeywordsBatch(cabinetId: number, nmId: number, keywords: { keyword: string; frequency?: number; source?: string }[]): Promise<number> {
  let count = 0;
  for (const kw of keywords) {
    await addKeyword(cabinetId, nmId, kw.keyword, kw.frequency, kw.source);
    count++;
  }
  return count;
}

// Remove keyword from tracking
export async function removeKeyword(cabinetId: number, nmId: number, keyword: string): Promise<void> {
  await execute(
    'DELETE FROM keyword_collections WHERE cabinet_id = ? AND nm_id = ? AND keyword = ?',
    [cabinetId, nmId, keyword]
  );
}

// Toggle tracking for a keyword
export async function toggleKeywordTracking(cabinetId: number, nmId: number, keyword: string, isTracked: boolean): Promise<void> {
  await execute(
    'UPDATE keyword_collections SET is_tracked = ? WHERE cabinet_id = ? AND nm_id = ? AND keyword = ?',
    [isTracked, cabinetId, nmId, keyword]
  );
}

// Save a keyword position check result
export async function saveKeywordPosition(cabinetId: number, nmId: number, keyword: string, position: number, page: number, frequency: number): Promise<void> {
  await execute(
    'INSERT INTO keyword_positions (cabinet_id, nm_id, keyword, position, page, frequency) VALUES (?, ?, ?, ?, ?, ?)',
    [cabinetId, nmId, keyword, position, page, frequency]
  );
}

// Get position history for a keyword
export async function getKeywordPositions(cabinetId: number, nmId: number, keyword: string, limit = 30): Promise<DBKeywordPosition[]> {
  return query<DBKeywordPosition[]>(
    'SELECT * FROM keyword_positions WHERE cabinet_id = ? AND nm_id = ? AND keyword = ? ORDER BY checked_at DESC LIMIT ?',
    [cabinetId, nmId, keyword, limit]
  );
}

// Get all tracked keywords (for a cabinet)
export async function getAllTrackedKeywords(cabinetId: number): Promise<DBKeywordCollection[]> {
  return query<DBKeywordCollection[]>(
    'SELECT * FROM keyword_collections WHERE cabinet_id = ? AND is_tracked = TRUE ORDER BY nm_id, frequency DESC',
    [cabinetId]
  );
}

// Search keywords by query string
export async function searchKeywords(cabinetId: number, q: string): Promise<DBKeywordCollection[]> {
  return query<DBKeywordCollection[]>(
    'SELECT * FROM keyword_collections WHERE cabinet_id = ? AND keyword LIKE ? ORDER BY frequency DESC LIMIT 50',
    [cabinetId, `%${q}%`]
  );
}
