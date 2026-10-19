import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCursor, encodeCursor, parsePageSize } from '../../src/modules/withdrawals/pagination';
import { parseCreateWithdrawalRequest } from '../../src/modules/withdrawals/withdrawals.validation';
import { AppError } from '../../src/utils/errors';

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError);
    return err.code;
  }
  assert.fail('expected an error');
}

describe('parseCreateWithdrawalRequest', () => {
  it('accepts valid input and normalises the currency', () => {
    const input = parseCreateWithdrawalRequest({ amount: '125.50', target_currency: 'eur' }, 'key-1');
    assert.equal(input.amount.toFixed(2), '125.50');
    assert.equal(input.targetCurrency, 'EUR');
    assert.equal(input.idempotencyKey, 'key-1');
  });

  it('accepts whole and one-decimal amounts', () => {
    assert.equal(parseCreateWithdrawalRequest({ amount: '10', target_currency: 'USD' }, 'k').amount.toFixed(2), '10.00');
    assert.equal(parseCreateWithdrawalRequest({ amount: '0.5', target_currency: 'USD' }, 'k').amount.toFixed(2), '0.50');
  });

  for (const amount of ['0', '0.00', '-1', '1.234', 'abc', '', '1e3', ' 10', '10.', '.5', '+5', '01.00', '123456789012345678', 12.5, null, undefined]) {
    it(`rejects amount ${JSON.stringify(amount)}`, () => {
      assert.equal(errorCode(() => parseCreateWithdrawalRequest({ amount, target_currency: 'EUR' }, 'k')), 'VALIDATION_ERROR');
    });
  }

  for (const currency of ['XYZ', 'EU', 'EURO', 'BTC', 123, null, undefined, '']) {
    it(`rejects target_currency ${JSON.stringify(currency)}`, () => {
      assert.equal(errorCode(() => parseCreateWithdrawalRequest({ amount: '1', target_currency: currency }, 'k')), 'VALIDATION_ERROR');
    });
  }

  it('rejects non-object bodies', () => {
    assert.equal(errorCode(() => parseCreateWithdrawalRequest(undefined, 'k')), 'VALIDATION_ERROR');
    assert.equal(errorCode(() => parseCreateWithdrawalRequest(['1'], 'k')), 'VALIDATION_ERROR');
  });

  it('requires an idempotency key', () => {
    assert.equal(errorCode(() => parseCreateWithdrawalRequest({ amount: '1', target_currency: 'EUR' }, undefined)), 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(errorCode(() => parseCreateWithdrawalRequest({ amount: '1', target_currency: 'EUR' }, '  ')), 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects malformed idempotency keys', () => {
    assert.equal(errorCode(() => parseCreateWithdrawalRequest({}, 'has space')), 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(errorCode(() => parseCreateWithdrawalRequest({}, 'x'.repeat(256))), 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(errorCode(() => parseCreateWithdrawalRequest({}, 'ключ')), 'INVALID_IDEMPOTENCY_KEY');
  });
});

describe('pagination helpers', () => {
  it('round-trips a cursor', () => {
    const cursor = { createdAt: '2026-10-19 08:24:00.123456+00', id: '6f1c1e9e-6a3f-4d8e-9b8e-1f0f6f4b8a11' };
    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  });

  it('rejects tampered cursors', () => {
    assert.equal(errorCode(() => decodeCursor('not-a-cursor')), 'INVALID_CURSOR');
    const bad = Buffer.from(JSON.stringify({ t: "'; DROP TABLE withdrawals; --", id: 'x' })).toString('base64url');
    assert.equal(errorCode(() => decodeCursor(bad)), 'INVALID_CURSOR');
  });

  it('validates the page size', () => {
    assert.equal(parsePageSize(undefined), 20);
    assert.equal(parsePageSize('100'), 100);
    for (const bad of ['0', '101', '-1', 'abc', '1.5', ['1', '2']]) {
      assert.equal(errorCode(() => parsePageSize(bad)), 'VALIDATION_ERROR');
    }
  });
});
