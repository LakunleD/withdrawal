import { createHash } from 'node:crypto';
import type Decimal from 'decimal.js';

/**
 * Stable SHA-256 fingerprint of the normalised request parameters, so "10" and
 * "10.00" are the same request but a different amount or currency is not.
 */
export function computeRequestFingerprint(accountId: string, amountUsd: Decimal, targetCurrency: string): string {
  const canonical = JSON.stringify({
    account_id: accountId.toLowerCase(),
    amount_usd: amountUsd.toFixed(2),
    target_currency: targetCurrency.toUpperCase(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
