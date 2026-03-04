import { query, execute } from './connection';
import type { DBBidRule, DBBidHistory, BidRuleInput } from '../types';

// === BID RULES ===

export async function getBidRules(cabinetId: number, campaignId: number): Promise<DBBidRule[]> {
  return query<DBBidRule[]>(
    'SELECT * FROM bid_rules WHERE cabinet_id = ? AND campaign_id = ? ORDER BY created_at DESC',
    [cabinetId, campaignId]
  );
}

export async function getActiveBidRules(cabinetId: number): Promise<DBBidRule[]> {
  return query<DBBidRule[]>(
    'SELECT * FROM bid_rules WHERE cabinet_id = ? AND is_active = TRUE ORDER BY campaign_id',
    [cabinetId]
  );
}

export async function getBidRuleById(cabinetId: number, ruleId: number): Promise<DBBidRule | null> {
  const rows = await query<DBBidRule[]>('SELECT * FROM bid_rules WHERE cabinet_id = ? AND id = ?', [cabinetId, ruleId]);
  return rows[0] || null;
}

export async function createBidRule(cabinetId: number, input: BidRuleInput): Promise<number> {
  const result = await execute(
    `INSERT INTO bid_rules (cabinet_id, campaign_id, keyword, strategy, target_value, min_bid, max_bid, step)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [cabinetId, input.campaign_id, input.keyword || null, input.strategy, input.target_value, input.min_bid ?? 50, input.max_bid ?? 1000, input.step ?? 10]
  );
  return result.insertId;
}

export async function updateBidRule(cabinetId: number, ruleId: number, updates: Partial<BidRuleInput> & { is_active?: boolean }): Promise<void> {
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

  params.push(cabinetId, ruleId);
  await execute(`UPDATE bid_rules SET ${fields.join(', ')} WHERE cabinet_id = ? AND id = ?`, params);
}

export async function deleteBidRule(cabinetId: number, ruleId: number): Promise<void> {
  await execute('DELETE FROM bid_rules WHERE cabinet_id = ? AND id = ?', [cabinetId, ruleId]);
}

// === BID HISTORY ===

export async function addBidHistoryEntry(cabinetId: number, entry: {
  campaign_id: number;
  keyword?: string;
  old_bid: number;
  new_bid: number;
  reason: string;
  rule_id?: number;
}): Promise<void> {
  await execute(
    'INSERT INTO bid_history (cabinet_id, campaign_id, keyword, old_bid, new_bid, reason, rule_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [cabinetId, entry.campaign_id, entry.keyword || null, entry.old_bid, entry.new_bid, entry.reason, entry.rule_id || null]
  );
}

export async function getBidHistory(cabinetId: number, campaignId: number, limit = 100): Promise<DBBidHistory[]> {
  return query<DBBidHistory[]>(
    'SELECT * FROM bid_history WHERE cabinet_id = ? AND campaign_id = ? ORDER BY created_at DESC LIMIT ?',
    [cabinetId, campaignId, limit]
  );
}
