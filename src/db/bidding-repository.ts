import { query, execute } from './connection';
import type { DBBidRule, DBBidHistory, BidRuleInput } from '../types';

// === BID RULES ===

export async function getBidRules(campaignId: number): Promise<DBBidRule[]> {
  return query<DBBidRule[]>(
    'SELECT * FROM bid_rules WHERE campaign_id = ? ORDER BY created_at DESC',
    [campaignId]
  );
}

export async function getActiveBidRules(): Promise<DBBidRule[]> {
  return query<DBBidRule[]>(
    'SELECT * FROM bid_rules WHERE is_active = TRUE ORDER BY campaign_id'
  );
}

export async function getBidRuleById(ruleId: number): Promise<DBBidRule | null> {
  const rows = await query<DBBidRule[]>('SELECT * FROM bid_rules WHERE id = ?', [ruleId]);
  return rows[0] || null;
}

export async function createBidRule(input: BidRuleInput): Promise<number> {
  const result = await execute(
    `INSERT INTO bid_rules (campaign_id, keyword, strategy, target_value, min_bid, max_bid, step)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.campaign_id, input.keyword || null, input.strategy, input.target_value, input.min_bid ?? 50, input.max_bid ?? 1000, input.step ?? 10]
  );
  return result.insertId;
}

export async function updateBidRule(ruleId: number, updates: Partial<BidRuleInput> & { is_active?: boolean }): Promise<void> {
  const fields: string[] = [];
  const params: any[] = [];

  if (updates.strategy !== undefined) { fields.push('strategy = ?'); params.push(updates.strategy); }
  if (updates.target_value !== undefined) { fields.push('target_value = ?'); params.push(updates.target_value); }
  if (updates.min_bid !== undefined) { fields.push('min_bid = ?'); params.push(updates.min_bid); }
  if (updates.max_bid !== undefined) { fields.push('max_bid = ?'); params.push(updates.max_bid); }
  if (updates.step !== undefined) { fields.push('step = ?'); params.push(updates.step); }
  if (updates.is_active !== undefined) { fields.push('is_active = ?'); params.push(updates.is_active); }
  if (updates.keyword !== undefined) { fields.push('keyword = ?'); params.push(updates.keyword); }

  if (fields.length === 0) return;

  params.push(ruleId);
  await execute(`UPDATE bid_rules SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function deleteBidRule(ruleId: number): Promise<void> {
  await execute('DELETE FROM bid_rules WHERE id = ?', [ruleId]);
}

// === BID HISTORY ===

export async function addBidHistoryEntry(entry: {
  campaign_id: number;
  keyword?: string;
  old_bid: number;
  new_bid: number;
  reason: string;
  rule_id?: number;
}): Promise<void> {
  await execute(
    'INSERT INTO bid_history (campaign_id, keyword, old_bid, new_bid, reason, rule_id) VALUES (?, ?, ?, ?, ?, ?)',
    [entry.campaign_id, entry.keyword || null, entry.old_bid, entry.new_bid, entry.reason, entry.rule_id || null]
  );
}

export async function getBidHistory(campaignId: number, limit = 100): Promise<DBBidHistory[]> {
  return query<DBBidHistory[]>(
    'SELECT * FROM bid_history WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?',
    [campaignId, limit]
  );
}
