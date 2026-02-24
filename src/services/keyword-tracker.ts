import { getWBClient } from '../api/wb-client';
import * as keywordRepo from '../db/keywords-repository';
import type { DBKeywordCollection, DBKeywordPosition } from '../types';

export async function getKeywordsForProduct(nmId: number): Promise<DBKeywordCollection[]> {
  return keywordRepo.getKeywords(nmId);
}

export async function addKeyword(nmId: number, keyword: string, source = 'manual'): Promise<void> {
  // Try to get frequency from WB
  try {
    const wbClient = getWBClient();
    const stats = await wbClient.getKeywordStats(keyword);
    const freq = stats[0]?.freq || 0;
    await keywordRepo.addKeyword(nmId, keyword, freq, source);
  } catch {
    await keywordRepo.addKeyword(nmId, keyword, 0, source);
  }
}

export async function removeKeyword(nmId: number, keyword: string): Promise<void> {
  return keywordRepo.removeKeyword(nmId, keyword);
}

export async function fetchRecommendedKeywords(nmId: number): Promise<string[]> {
  const wbClient = getWBClient();
  const keywords = await wbClient.getRecommendedKeywords(nmId);
  return keywords;
}

export async function addRecommendedKeywords(nmId: number): Promise<number> {
  const keywords = await fetchRecommendedKeywords(nmId);
  const items = keywords.map(kw => ({ keyword: kw, source: 'recommended' }));
  return keywordRepo.addKeywordsBatch(nmId, items);
}

export async function checkPositions(nmId: number): Promise<void> {
  const keywords = await keywordRepo.getKeywords(nmId);
  const tracked = keywords.filter(k => k.is_tracked);
  const wbClient = getWBClient();

  for (const kw of tracked) {
    try {
      const stats = await wbClient.getKeywordStats(kw.keyword);
      const stat = stats[0];
      if (stat) {
        // Use frequency as a proxy - actual position tracking would need search API
        await keywordRepo.saveKeywordPosition(nmId, kw.keyword, 0, 0, stat.freq);
      }
    } catch (error) {
      console.error(`Failed to check position for "${kw.keyword}":`, error);
    }
  }
}

export async function checkAllPositions(): Promise<{ checked: number; errors: number }> {
  const allKeywords = await keywordRepo.getAllTrackedKeywords();
  let checked = 0;
  let errors = 0;

  // Group by nm_id
  const byProduct = new Map<number, DBKeywordCollection[]>();
  for (const kw of allKeywords) {
    const list = byProduct.get(kw.nm_id) || [];
    list.push(kw);
    byProduct.set(kw.nm_id, list);
  }

  for (const [nmId] of byProduct) {
    try {
      await checkPositions(nmId);
      checked++;
    } catch {
      errors++;
    }
  }

  return { checked, errors };
}

export async function getPositionHistory(nmId: number, keyword: string): Promise<DBKeywordPosition[]> {
  return keywordRepo.getKeywordPositions(nmId, keyword);
}

export async function searchKeywords(q: string): Promise<DBKeywordCollection[]> {
  return keywordRepo.searchKeywords(q);
}
