export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatusCodes?: number[];
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

// Status codes that should never be retried
const NON_RETRYABLE_STATUS_CODES = [400, 401, 403, 404];

function getStatusCode(error: Error): number | null {
  const match = error.message.match(/WB API Error: (\d+)/);
  return match && match[1] ? parseInt(match[1], 10) : null;
}

function getRetryAfterMs(error: Error): number | null {
  const match = error.message.match(/Retry-After:\s*(\d+)/i);
  return match && match[1] ? parseInt(match[1], 10) * 1000 : null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on non-retryable status codes
      const statusCode = getStatusCode(lastError);
      if (statusCode !== null && NON_RETRYABLE_STATUS_CODES.includes(statusCode)) {
        throw lastError;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= opts.maxRetries) {
        break;
      }

      // Check if it's a retryable error
      const isRetryable = statusCode === null || // network errors, timeouts
        opts.retryableStatusCodes.includes(statusCode);

      if (!isRetryable) {
        throw lastError;
      }

      // Calculate delay
      let delayMs: number;
      if (statusCode === 429) {
        // Rate limited — use Retry-After or default 60s
        delayMs = getRetryAfterMs(lastError) ?? 60000;
      } else {
        // Exponential backoff: 1s, 2s, 4s, ...
        delayMs = Math.min(opts.baseDelayMs * Math.pow(2, attempt), opts.maxDelayMs);
      }

      const nextAttempt = attempt + 1;
      if (opts.onRetry) {
        opts.onRetry(lastError, nextAttempt, delayMs);
      } else {
        console.warn(
          `[retry] Attempt ${nextAttempt}/${opts.maxRetries} failed: ${lastError.message}. Retrying in ${delayMs}ms...`
        );
      }

      await Bun.sleep(delayMs);
    }
  }

  throw lastError!;
}
