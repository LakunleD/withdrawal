import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExchangeRateUnavailableError } from '../../src/services/exchange-rate/exchange-rate.provider';
import { FrankfurterExchangeRateProvider, type FrankfurterOptions } from '../../src/services/exchange-rate/frankfurter.provider';

const NOW = new Date('2026-10-19T12:00:00Z');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function provider(fetchFn: (url: URL, init: RequestInit) => Promise<Response>, overrides: Partial<FrankfurterOptions> = {}) {
  return new FrankfurterExchangeRateProvider({
    baseUrl: 'https://frankfurter.test/v1',
    timeoutMs: 200,
    retries: 1,
    maxAgeDays: 4,
    now: () => NOW,
    fetchFn: fetchFn as unknown as typeof fetch,
    ...overrides,
  });
}

const valid = { amount: 1, base: 'USD', date: '2026-10-17', rates: { EUR: 0.92 } };

describe('FrankfurterExchangeRateProvider', () => {
  it('requests USD -> target and returns a decimal rate', async () => {
    let requested: URL | undefined;
    const quote = await provider(async (url) => {
      requested = url;
      return jsonResponse(valid);
    }).getUsdRate('EUR');

    assert.equal(requested?.toString(), 'https://frankfurter.test/v1/latest?base=USD&symbols=EUR');
    assert.equal(quote.rate.toFixed(), '0.92');
    assert.equal(quote.target, 'EUR');
    assert.equal(quote.date, '2026-10-17');
  });

  it('retries a transient 5xx once and then succeeds', async () => {
    let calls = 0;
    const quote = await provider(async () => (++calls === 1 ? jsonResponse({}, 502) : jsonResponse(valid))).getUsdRate('EUR');
    assert.equal(calls, 2);
    assert.equal(quote.rate.toFixed(), '0.92');
  });

  it('gives up after the retry budget on repeated 5xx', async () => {
    let calls = 0;
    await assert.rejects(
      provider(async () => {
        calls++;
        return jsonResponse({}, 503);
      }).getUsdRate('EUR'),
      ExchangeRateUnavailableError,
    );
    assert.equal(calls, 2);
  });

  it('does not retry a 4xx', async () => {
    let calls = 0;
    await assert.rejects(
      provider(async () => {
        calls++;
        return jsonResponse({ message: 'not found' }, 404);
      }).getUsdRate('EUR'),
      ExchangeRateUnavailableError,
    );
    assert.equal(calls, 1);
  });

  it('times out a hanging request', async () => {
    // Holds a ref'd timer like a real open socket would (AbortSignal.timeout's own timer is unref'd).
    const hanging = (_url: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('mock never aborted')), 5000);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      });
    const started = Date.now();
    await assert.rejects(provider(hanging, { timeoutMs: 50, retries: 0 }).getUsdRate('EUR'), (err) => {
      assert.ok(err instanceof ExchangeRateUnavailableError);
      assert.match(err.reason, /timed out/);
      return true;
    });
    assert.ok(Date.now() - started < 1000);
  });

  it('wraps network errors', async () => {
    await assert.rejects(
      provider(async () => {
        throw new TypeError('fetch failed');
      }, { retries: 0 }).getUsdRate('EUR'),
      ExchangeRateUnavailableError,
    );
  });

  const invalidBodies: Array<[string, unknown]> = [
    ['missing rate', { ...valid, rates: {} }],
    ['zero rate', { ...valid, rates: { EUR: 0 } }],
    ['negative rate', { ...valid, rates: { EUR: -0.9 } }],
    ['string rate', { ...valid, rates: { EUR: '0.92' } }],
    ['wrong base', { ...valid, base: 'EUR' }],
    ['missing date', { ...valid, date: undefined }],
    ['future date', { ...valid, date: '2026-10-25' }],
    ['not an object', [1, 2, 3]],
  ];
  for (const [name, body] of invalidBodies) {
    it(`rejects an invalid response (${name})`, async () => {
      await assert.rejects(provider(async () => jsonResponse(body)).getUsdRate('EUR'), ExchangeRateUnavailableError);
    });
  }

  it('rejects non-JSON bodies', async () => {
    await assert.rejects(
      provider(async () => new Response('<html>oops</html>', { status: 200 })).getUsdRate('EUR'),
      ExchangeRateUnavailableError,
    );
  });

  it('rejects stale rates instead of using them silently', async () => {
    await assert.rejects(
      provider(async () => jsonResponse({ ...valid, date: '2026-10-01' })).getUsdRate('EUR'),
      (err) => err instanceof ExchangeRateUnavailableError && /stale/.test(err.reason),
    );
  });

  it('accepts weekend-aged rates within the max age', async () => {
    const quote = await provider(async () => jsonResponse({ ...valid, date: '2026-10-16' })).getUsdRate('EUR');
    assert.equal(quote.date, '2026-10-16');
  });
});
