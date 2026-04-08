/**
 * Read-only access to the WBPartners-Auto phone scraping SQLite DB.
 *
 * The phone scraping bot (`WBPartners-Auto/`) running on the ostapLace server
 * is the authoritative source for order data — WB API is too unreliable. This
 * module reads the phone's `orders.db` directly via a read-only bind mount.
 *
 * Fields in the phone's orders table (from WBPartners-Auto/db.py):
 *   - article       — WB article number (nmId as string)
 *   - vendor_code   — supplier SKU, e.g. "БркФтр2Чрн"  (from "Артикул продавца")
 *   - date_parsed   — ISO datetime parsed from the app UI (MSK wall-clock)
 *   - date_raw      — original Russian-formatted string from the UI
 *   - price_cents   — integer (rubles × 100)
 *   - first_seen    — when the phone first detected the order (UTC)
 *
 * `date_parsed` is the actual time the order was placed (MSK, from WB's own
 * display). That's the field we use for "from Moscow midnight" windows.
 */

import { Database } from 'bun:sqlite';

const DB_PATH = process.env.WBPARTNERS_DB_PATH || '/mnt/wbpartners/orders.db';

let db: Database | null = null;

function getDb(): Database | null {
  if (db) return db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    return db;
  } catch (e: any) {
    console.error(`[wbpartners-phone] cannot open ${DB_PATH}: ${e.message}`);
    return null;
  }
}

export interface PhoneArticleTotals {
  article: string;       // WB nmId (string in phone DB)
  vendorCode: string;    // supplier SKU
  orders: number;        // count of orders
}

/**
 * Get per-vendor-code order counts for a time window (MSK wall-clock).
 * Uses `date_parsed` (actual order time from the app UI).
 *
 * @param fromIso  MSK wall-clock start, format "YYYY-MM-DDTHH:MM:SS"
 * @param toIso    MSK wall-clock end (exclusive), same format
 */
export function getPhoneTotalsByArticle(fromIso: string, toIso: string): PhoneArticleTotals[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const rows = handle
      .query(
        `SELECT article,
                COALESCE(vendor_code, '') as vendor_code,
                COUNT(*) as cnt
         FROM orders
         WHERE date_parsed >= ? AND date_parsed < ?
         GROUP BY article, vendor_code
         ORDER BY cnt DESC`
      )
      .all(fromIso, toIso) as Array<{ article: string; vendor_code: string; cnt: number }>;
    return rows.map(r => ({
      article: r.article,
      vendorCode: r.vendor_code || r.article,
      orders: Number(r.cnt),
    }));
  } catch (e: any) {
    console.error(`[wbpartners-phone] query failed: ${e.message}`);
    return [];
  }
}
