import { setTimeout as sleep } from 'node:timers/promises';
import {
  ExchangeRateUnavailableError,
  type ExchangeRateProvider,
  type ExchangeRateQuote,
} from '../../src/services/exchange-rate/exchange-rate.provider';
import { Money } from '../../src/utils/money';

const DEFAULT_RATES: Record<string, string> = { EUR: '0.92', GBP: '0.79', JPY: '149.523' };

/** In-memory provider so tests never touch the network. */
export class MockExchangeRateProvider implements ExchangeRateProvider {
  rates: Record<string, string> = { ...DEFAULT_RATES };
  calls: string[] = [];
  failure: Error | null = null;
  delayMs = 0;

  async getUsdRate(target: string): Promise<ExchangeRateQuote> {
    this.calls.push(target);
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (this.failure) throw this.failure;
    const rate = this.rates[target];
    if (!rate) throw new ExchangeRateUnavailableError(`no mock rate for ${target}`);
    return { base: 'USD', target, rate: new Money(rate), date: new Date().toISOString().slice(0, 10) };
  }

  reset(): void {
    this.rates = { ...DEFAULT_RATES };
    this.calls = [];
    this.failure = null;
    this.delayMs = 0;
  }
}
