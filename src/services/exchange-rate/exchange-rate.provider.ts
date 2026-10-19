import type Decimal from 'decimal.js';
import { AppError } from '../../utils/errors';

export interface ExchangeRateQuote {
  base: 'USD';
  target: string;
  /** Units of `target` per 1 USD. Always finite and > 0. */
  rate: Decimal;
  /** Reference date of the rate as published by the provider (YYYY-MM-DD). */
  date: string;
}

export interface ExchangeRateProvider {
  /** Returns a validated, non-stale USD -> target rate or throws ExchangeRateUnavailableError. */
  getUsdRate(targetCurrency: string): Promise<ExchangeRateQuote>;
}

/** Surfaced to clients as HTTP 503. `reason` is for logs only. */
export class ExchangeRateUnavailableError extends AppError {
  readonly reason: string;

  constructor(reason: string) {
    super(503, 'EXCHANGE_RATE_UNAVAILABLE', 'The exchange rate provider is currently unavailable. Please retry later.');
    this.name = 'ExchangeRateUnavailableError';
    this.reason = reason;
  }
}
