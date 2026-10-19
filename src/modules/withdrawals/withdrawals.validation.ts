import type Decimal from 'decimal.js';
import { isSupportedCurrency } from '../../services/exchange-rate/currencies';
import { AppError, validationError } from '../../utils/errors';
import { Money } from '../../utils/money';
import { isPlainObject } from '../../utils/validation';

export interface CreateWithdrawalInput {
  amount: Decimal;
  targetCurrency: string;
  idempotencyKey: string;
}

// Positive decimal string, max 2dp, max 17 integer digits to fit NUMERIC(19,2). No exponents or signs.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
// Printable ASCII without spaces; fits UUIDs, ULIDs and most client-generated keys.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

export function parseIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header.trim() === '') {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required.');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 1-255 printable ASCII characters without spaces.',
    );
  }
  return header;
}

export function parseCreateWithdrawalRequest(body: unknown, idempotencyKeyHeader: string | undefined): CreateWithdrawalInput {
  const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);

  if (!isPlainObject(body)) throw validationError('Request body must be a JSON object.');
  const { amount, target_currency: targetCurrency } = body;

  if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
    throw validationError('amount must be a positive USD decimal string with at most two decimal places, e.g. "125.50".');
  }
  const parsedAmount = new Money(amount);
  if (parsedAmount.lte(0)) throw validationError('amount must be greater than zero.');

  if (typeof targetCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(targetCurrency)) {
    throw validationError('target_currency must be a three-letter ISO 4217 currency code.');
  }
  const currency = targetCurrency.toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw validationError(`target_currency ${currency} is not supported.`);
  }

  return { amount: parsedAmount, targetCurrency: currency, idempotencyKey };
}
