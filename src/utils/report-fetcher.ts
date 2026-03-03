/**
 * WB Seller Analytics async report utility.
 * Pattern: POST create task → poll GET status → GET download ZIP → extract CSV → parse rows.
 *
 * Base URL: https://seller-analytics-api.wildberries.ru
 * Endpoints:
 *   POST /api/v2/nm-report/downloads          – create task
 *   GET  /api/v2/nm-report/downloads           – list/check status (filter by IDs)
 *   GET  /api/v2/nm-report/downloads/file/{id} – download ZIP (contains CSV)
 *
 * Rate limit: 3 req/min, 20 s interval.
 */

import { unzipSync } from 'fflate';
import { withRetry } from './retry';

const WB_ANALYTICS_BASE = 'https://seller-analytics-api.wildberries.ru';

// Report types supported by the API
export type ReportType =
  | 'DETAIL_HISTORY_REPORT'
  | 'GROUPED_HISTORY_REPORT'
  | 'SEARCH_QUERIES_PREMIUM_REPORT_GROUP'
  | 'SEARCH_QUERIES_PREMIUM_REPORT_PRODUCT'
  | 'SEARCH_QUERIES_PREMIUM_REPORT_TEXT'
  | 'STOCK_HISTORY_REPORT_CSV'
  | 'STOCK_HISTORY_DAILY_CSV';

export interface ReportTaskStatus {
  id: string;
  status: 'new' | 'processing' | 'done' | 'purged' | 'canceled';
  createdAt: string;
  updatedAt: string;
}

interface CreateReportParams {
  reportType: ReportType;
  userReportName?: string;
  params: Record<string, any>;
}

function getApiKey(): string {
  return process.env.WB_API_KEY || '';
}

async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${WB_ANALYTICS_BASE}${endpoint}`;
  return withRetry(
    async () => {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': getApiKey(),
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`WB Report API ${response.status}: ${err}`);
      }
      return response.json();
    },
    { onRetry: (error, attempt, delay) => {
      console.warn(`[report-fetcher] Retry ${attempt}/3 for ${endpoint}: ${error.message}. Wait ${delay}ms`);
    }}
  );
}

/**
 * Create an async report task.
 * Returns the downloadId (UUID) to track the task.
 */
export async function createReportTask(params: CreateReportParams): Promise<string> {
  const response = await apiRequest<{ data: { id: string } }>(
    '/api/v2/nm-report/downloads',
    {
      method: 'POST',
      body: JSON.stringify(params),
    }
  );
  return response.data.id;
}

/**
 * Check status of one or more report tasks.
 */
export async function getReportStatuses(downloadIds: string[]): Promise<ReportTaskStatus[]> {
  const filter = downloadIds.map(id => `filter[downloadIds]=${id}`).join('&');
  const response = await apiRequest<{ data: ReportTaskStatus[] }>(
    `/api/v2/nm-report/downloads?${filter}`
  );
  return response.data || [];
}

/**
 * Download completed report as a ZIP buffer.
 */
export async function downloadReportZip(downloadId: string): Promise<Uint8Array> {
  const url = `${WB_ANALYTICS_BASE}/api/v2/nm-report/downloads/file/${downloadId}`;
  const response = await fetch(url, {
    headers: { 'Authorization': getApiKey() },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`WB Report download ${response.status}: ${err}`);
  }
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Extract first CSV from a ZIP buffer.
 */
export function extractCSVFromZip(zipData: Uint8Array): string {
  const files = unzipSync(zipData);
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.csv')) {
      return new TextDecoder('utf-8').decode(data);
    }
  }
  throw new Error('No CSV file found in ZIP archive');
}

/**
 * Parse a CSV string into an array of objects.
 * Handles quoted fields and semicolon or comma delimiters.
 */
export function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Auto-detect delimiter (semicolon vs comma)
  const delimiter = lines[0].includes(';') ? ';' : ',';

  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseRow(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Full flow: create task → poll until done → download → extract CSV → parse.
 * Polls every 20s (API rate limit), up to maxWaitMs (default 10 min).
 */
export async function fetchReport(
  params: CreateReportParams,
  maxWaitMs = 10 * 60 * 1000
): Promise<Record<string, string>[]> {
  console.log(`[report-fetcher] Creating ${params.reportType} task...`);
  const downloadId = await createReportTask(params);
  console.log(`[report-fetcher] Task created: ${downloadId}`);

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await Bun.sleep(20_000); // respect 20s rate limit

    const statuses = await getReportStatuses([downloadId]);
    const task = statuses[0];

    if (!task) {
      console.warn(`[report-fetcher] Task ${downloadId} not found, retrying...`);
      continue;
    }

    console.log(`[report-fetcher] Task ${downloadId} status: ${task.status}`);

    if (task.status === 'done') {
      const zipData = await downloadReportZip(downloadId);
      const csv = extractCSVFromZip(zipData);
      return parseCSV(csv);
    }

    if (task.status === 'canceled' || task.status === 'purged') {
      throw new Error(`Report task ${downloadId} was ${task.status}`);
    }
  }

  throw new Error(`Report task ${downloadId} timed out after ${maxWaitMs / 1000}s`);
}
