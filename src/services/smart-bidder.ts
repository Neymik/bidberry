import { getWBClient } from '../api/wb-client';
import * as biddingRepo from '../db/bidding-repository';
import * as repo from '../db/repository';
import type { DBBidRule, BidRuleInput } from '../types';

export async function createRule(input: BidRuleInput): Promise<number> {
  return biddingRepo.createBidRule(input);
}

export async function updateRule(ruleId: number, updates: Partial<BidRuleInput> & { is_active?: boolean }): Promise<void> {
  return biddingRepo.updateBidRule(ruleId, updates);
}

export async function deleteRule(ruleId: number): Promise<void> {
  return biddingRepo.deleteBidRule(ruleId);
}

export async function getRules(campaignId: number): Promise<DBBidRule[]> {
  return biddingRepo.getBidRules(campaignId);
}

export async function getBidHistory(campaignId: number): Promise<any[]> {
  return biddingRepo.getBidHistory(campaignId);
}

export async function adjustBidsForCampaign(campaignId: number): Promise<{ adjusted: number; errors: number }> {
  const rules = await biddingRepo.getBidRules(campaignId);
  const activeRules = rules.filter(r => r.is_active);
  const wbClient = getWBClient();

  let adjusted = 0;
  let errors = 0;

  // Get current bids
  const currentBids = await wbClient.getBids(campaignId);
  const bidMap = new Map(currentBids.map(b => [b.keyword, b]));

  // Get campaign stats for DRR calculations
  const stats = await repo.getCampaignStats(campaignId);
  const latestStats = stats[0];

  for (const rule of activeRules) {
    try {
      const newBid = calculateNewBid(rule, bidMap, latestStats);
      if (newBid === null) continue;

      const keyword = rule.keyword || currentBids[0]?.keyword;
      if (!keyword) continue;

      const currentBid = bidMap.get(keyword)?.bid || 0;
      if (Math.abs(currentBid - newBid) < 1) continue; // Skip if difference is negligible

      await wbClient.setBid(campaignId, keyword, newBid);
      await biddingRepo.addBidHistoryEntry({
        campaign_id: campaignId,
        keyword,
        old_bid: currentBid,
        new_bid: newBid,
        reason: `Strategy: ${rule.strategy}, target: ${rule.target_value}`,
        rule_id: rule.id,
      });
      adjusted++;
    } catch (error) {
      console.error(`Failed to adjust bid for rule ${rule.id}:`, error);
      errors++;
    }
  }

  return { adjusted, errors };
}

function calculateNewBid(
  rule: DBBidRule,
  bidMap: Map<string, { keyword: string; bid: number; position: number; cpm: number }>,
  stats: any
): number | null {
  const currentBid = rule.keyword ? (bidMap.get(rule.keyword)?.bid || 0) : 0;
  let newBid = currentBid;

  switch (rule.strategy) {
    case 'target_position': {
      const currentPos = rule.keyword ? (bidMap.get(rule.keyword)?.position || 0) : 0;
      if (currentPos > rule.target_value) {
        newBid = currentBid + rule.step;
      } else if (currentPos < rule.target_value && currentPos > 0) {
        newBid = currentBid - rule.step;
      }
      break;
    }
    case 'target_cpc': {
      const currentCpc = stats?.cpc || 0;
      if (currentCpc > rule.target_value) {
        newBid = currentBid - rule.step;
      } else if (currentCpc < rule.target_value * 0.8) {
        newBid = currentBid + rule.step;
      }
      break;
    }
    case 'max_bid': {
      newBid = Math.min(currentBid, rule.target_value);
      break;
    }
    case 'drr_target': {
      if (!stats) break;
      const currentDrr = stats.spend > 0 && stats.order_sum > 0
        ? (stats.spend / stats.order_sum) * 100
        : 0;
      if (currentDrr > rule.target_value) {
        newBid = currentBid - rule.step;
      } else if (currentDrr < rule.target_value * 0.8) {
        newBid = currentBid + rule.step;
      }
      break;
    }
    default:
      return null;
  }

  // Clamp to min/max
  newBid = Math.max(rule.min_bid, Math.min(rule.max_bid, newBid));
  return Math.round(newBid);
}

export async function runAllRules(): Promise<{ campaigns: number; adjusted: number; errors: number }> {
  const allRules = await biddingRepo.getActiveBidRules();

  // Group by campaign
  const campaignIds = [...new Set(allRules.map(r => r.campaign_id))];

  let totalAdjusted = 0;
  let totalErrors = 0;

  for (const campaignId of campaignIds) {
    const result = await adjustBidsForCampaign(campaignId);
    totalAdjusted += result.adjusted;
    totalErrors += result.errors;
  }

  return { campaigns: campaignIds.length, adjusted: totalAdjusted, errors: totalErrors };
}
