import { query, execute } from './connection';
import type { DBKeywordCollection, DBKeywordPosition } from '../types';

// Get all tracked keywords for a product
export async function getKeywords(nmId: number): Promise<DBKeywordCollection[]> {
  return query<DBKeywordCollection[]>(
    'SELECT * FROM keyword_collections WHERE nm_id = ? ORDER BY frequency DESC',
    [nmId]
  );
}

// Add keyword to track for a product
export async function addKeyword(nmId: number, keyword: string, frequency?: number, source?: string): Promise<void> {
  await execute(
    `INSERT INTO keyword_collections (nm_id, keyword, frequency, source)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE frequency = COALESCE(VALUES(frequency), frequency), updated_at = NOW()`,
    [nmId, keyword, frequency || 0, source || 'manual']
  );
}

// Add multiple keywords in batch
export async function addKeywordsBatch(nmId: number, keywords: { keyword: string; frequency?: number; source?: string }[]): Promise<number> {
  let count = 0;
  for (const kw of keywords) {
    await addKeyword(nmId, kw.keyword, kw.frequency, kw.source);
    count++;
  }
  return count;
}

// Remove keyword from tracking
export async function removeKeyword(nmId: number, keyword: string): Promise<void> {
  await execute(
    'DELETE FROM keyword_collections WHERE nm_id = ? AND keyword = ?',
    [nmId, keyword]
  );
}

// Toggle tracking for a keyword
export async function toggleKeywordTracking(nmId: number, keyword: string, isTracked: boolean): Promise<void> {
  await execute(
    'UPDATE keyword_collections SET is_tracked = ? WHERE nm_id = ? AND keyword = ?',
    [isTracked, nmId, keyword]
  );
}

// Save a keyword position check result
export async function saveKeywordPosition(nmId: number, keyword: string, position: number, page: number, frequency: number): Promise<void> {
  await execute(
    'INSERT INTO keyword_positions (nm_id, keyword, position, page, frequency) VALUES (?, ?, ?, ?, ?)',
    [nmId, keyword, position, page, frequency]
  );
}

// Get position history for a keyword
export async function getKeywordPositions(nmId: number, keyword: string, limit = 30): Promise<DBKeywordPosition[]> {
  return query<DBKeywordPosition[]>(
    'SELECT * FROM keyword_positions WHERE nm_id = ? AND keyword = ? ORDER BY checked_at DESC LIMIT ?',
    [nmId, keyword, limit]
  );
}

// Get all tracked keywords (across all products)
export async function getAllTrackedKeywords(): Promise<DBKeywordCollection[]> {
  return query<DBKeywordCollection[]>(
    'SELECT * FROM keyword_collections WHERE is_tracked = TRUE ORDER BY nm_id, frequency DESC'
  );
}

// Search keywords by query string
export async function searchKeywords(q: string): Promise<DBKeywordCollection[]> {
  return query<DBKeywordCollection[]>(
    'SELECT * FROM keyword_collections WHERE keyword LIKE ? ORDER BY frequency DESC LIMIT 50',
    [`%${q}%`]
  );
}
