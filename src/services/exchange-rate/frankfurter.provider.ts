import { Money } from '../../utils/money';
import { logger } from '../../utils/logger';
import { isPlainObject } from '../../utils/validation';
import {
  ExchangeRateUnavailableError,
  type ExchangeRateProvider,
  type ExchangeRateQuote,
} from './exchange-rate.provider';

export interface FrankfurterOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Extra attempts after the first one, only for transient failures (network, timeout, 5xx, 429). */
  retries: number;
  /** Rates whose reference date is older than this many days are rejected as stale. */
  maxAgeDays: number;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

class ProviderFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export class FrankfurterExchangeRateProvider implements ExchangeRateProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: FrankfurterOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getUsdRate(targetCurrency: string): Promise<ExchangeRateQuote> {
    const attempts = this.options.retries + 1;
    let lastFailure: ProviderFailure | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.fetchRate(targetCurrency);
      } catch (err) {
        lastFailure = err instanceof ProviderFailure ? err : new ProviderFailure(String(err), false);
        logger.warn('exchange_rate_fetch_failed', {
          target: targetCurrency,
          attempt,
          reason: lastFailure.message,
        });
        if (!lastFailure.retryable) break;
      }
    }

    throw new ExchangeRateUnavailableError(lastFailure?.message ?? 'unknown failure');
  }

  private async fetchRate(target: string): Promise<ExchangeRateQuote> {
    const url = new URL(`${this.options.baseUrl.replace(/\/+$/, '')}/latest`);
    url.searchParams.set('base', 'USD');
    url.searchParams.set('symbols', target);

    // One signal covers both the request and reading the body.
    const signal = AbortSignal.timeout(this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal });
    } catch (err) {
      throw new ProviderFailure(
        isTimeout(err) ? `timed out after ${this.options.timeoutMs}ms` : `request failed: ${(err as Error).message}`,
        true,
      );
    }

    if (!response.ok) {
      throw new ProviderFailure(`unexpected HTTP status ${response.status}`, response.status >= 500 || response.status === 429);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (isTimeout(err)) throw new ProviderFailure(`timed out after ${this.options.timeoutMs}ms`, true);
      throw new ProviderFailure('response body is not valid JSON', false);
    }

    return this.parse(body, target);
  }

  private parse(body: unknown, target: string): ExchangeRateQuote {
    const invalid = (why: string) => new ProviderFailure(`invalid response: ${why}`, false);

    if (!isPlainObject(body)) throw invalid('body is not an object');
    if (body.base !== 'USD') throw invalid(`unexpected base currency ${String(body.base)}`);
    if (!isPlainObject(body.rates)) throw invalid('missing rates');

    const raw = body.rates[target];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      throw invalid(`missing or non-positive rate for ${target}`);
    }

    const date = body.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('missing or malformed date');
    const rateDay = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(rateDay)) throw invalid('unparseable date');

    const now = this.now();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const ageDays = Math.round((today - rateDay) / DAY_MS);
    if (ageDays < -1) throw invalid(`rate date ${date} is in the future`);
    // ECB rates are not published on weekends/holidays, so a few days of age is normal.
    if (ageDays > this.options.maxAgeDays) {
      throw new ProviderFailure(`stale rate dated ${date} (${ageDays} days old)`, false);
    }

    // Number#toString gives the shortest round-trip representation, i.e. the JSON literal.
    return { base: 'USD', target, rate: new Money(raw.toString()), date };
  }
}
