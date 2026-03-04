import * as keywordRepo from '../db/keywords-repository';
import type { WBApiClient } from '../api/wb-client';
import type { DBKeywordCollection, DBKeywordPosition } from '../types';

export async function getKeywordsForProduct(cabinetId: number, nmId: number): Promise<DBKeywordCollection[]> {
  return keywordRepo.getKeywords(cabinetId, nmId);
}

export async function addKeyword(cabinetId: number, wbClient: WBApiClient, nmId: number, keyword: string, source = 'manual'): Promise<void> {
  // Try to get frequency from WB
  try {
    const stats = await wbClient.getKeywordStats(keyword);
    const freq = stats[0]?.freq || 0;
    await keywordRepo.addKeyword(cabinetId, nmId, keyword, freq, source);
  } catch {
    await keywordRepo.addKeyword(cabinetId, nmId, keyword, 0, source);
  }
}

export async function removeKeyword(cabinetId: number, nmId: number, keyword: string): Promise<void> {
  return keywordRepo.removeKeyword(cabinetId, nmId, keyword);
}

export async function fetchRecommendedKeywords(wbClient: WBApiClient, nmId: number): Promise<string[]> {
  const keywords = await wbClient.getRecommendedKeywords(nmId);
  return keywords;
}

export async function addRecommendedKeywords(cabinetId: number, wbClient: WBApiClient, nmId: number): Promise<number> {
  const keywords = await fetchRecommendedKeywords(wbClient, nmId);
  const items = keywords.map(kw => ({ keyword: kw, source: 'recommended' }));
  return keywordRepo.addKeywordsBatch(cabinetId, nmId, items);
}

export async function checkPositions(cabinetId: number, wbClient: WBApiClient, nmId: number): Promise<void> {
  const keywords = await keywordRepo.getKeywords(cabinetId, nmId);
  const tracked = keywords.filter(k => k.is_tracked);

  for (const kw of tracked) {
    try {
      const stats = await wbClient.getKeywordStats(kw.keyword);
      const stat = stats[0];
      if (stat) {
        // Use frequency as a proxy - actual position tracking would need search API
        await keywordRepo.saveKeywordPosition(cabinetId, nmId, kw.keyword, 0, 0, stat.freq);
      }
    } catch (error) {
      console.error(`Failed to check position for "${kw.keyword}":`, error);
    }
  }
}

export async function checkAllPositions(cabinetId: number, wbClient: WBApiClient): Promise<{ checked: number; errors: number }> {
  const allKeywords = await keywordRepo.getAllTrackedKeywords(cabinetId);
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
      await checkPositions(cabinetId, wbClient, nmId);
      checked++;
    } catch {
      errors++;
    }
  }

  return { checked, errors };
}

export async function getPositionHistory(cabinetId: number, nmId: number, keyword: string): Promise<DBKeywordPosition[]> {
  return keywordRepo.getKeywordPositions(cabinetId, nmId, keyword);
}

export async function searchKeywords(cabinetId: number, q: string): Promise<DBKeywordCollection[]> {
  return keywordRepo.searchKeywords(cabinetId, q);
}
