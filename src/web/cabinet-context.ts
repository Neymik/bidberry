import type { Context } from 'hono';
import { getWBClientForCabinet } from '../api/wb-client';
import type { WBApiClient } from '../api/wb-client';

/**
 * Extract cabinetId from Hono context. Throws 400 if missing.
 */
export function getCabinetId(c: Context): number {
  const cabinetId = c.get('cabinetId' as never) as number | undefined;
  if (!cabinetId) {
    throw new Error('Cabinet ID is required');
  }
  return cabinetId;
}

/**
 * Get a per-cabinet WB API client from context.
 */
export function getWBClientFromContext(c: Context): WBApiClient {
  const cabinetId = getCabinetId(c);
  const apiKey = c.get('cabinetApiKey' as never) as string;
  if (!apiKey) {
    throw new Error('Cabinet API key not available');
  }
  return getWBClientForCabinet(cabinetId, apiKey);
}
