import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeRequestFingerprint } from '../../src/modules/withdrawals/fingerprint';
import { Money, convertAmount } from '../../src/utils/money';

describe('convertAmount', () => {
  it('rounds half-up to two minor units', () => {
    assert.equal(convertAmount(new Money('125.50'), new Money('0.92'), 2).toFixed(2), '115.46');
    assert.equal(convertAmount(new Money('0.05'), new Money('0.9'), 2).toFixed(2), '0.05'); // 0.045 -> 0.05
    assert.equal(convertAmount(new Money('10.00'), new Money('0.12344'), 2).toFixed(2), '1.23'); // 1.2344
  });

  it('rounds to zero decimal places for JPY-style currencies', () => {
    assert.equal(convertAmount(new Money('10.00'), new Money('149.523'), 0).toFixed(0), '1495');
    assert.equal(convertAmount(new Money('0.01'), new Money('150'), 0).toFixed(0), '2'); // 1.5 -> 2
  });

  it('avoids floating point errors', () => {
    assert.notEqual(0.1 + 0.2, 0.3);
    assert.equal(new Money('0.10').plus('0.20').toFixed(2), '0.30');
    assert.equal(convertAmount(new Money('0.10'), new Money('3'), 2).toFixed(2), '0.30');
  });

  it('keeps full precision for the largest storable amount', () => {
    const max = new Money('99999999999999999.99');
    assert.equal(convertAmount(max, new Money('0.92345'), 2).toFixed(2), '92344999999999999.99');
  });

  it('a USD rate of 1 is the identity', () => {
    assert.equal(convertAmount(new Money('42.07'), new Money(1), 2).toFixed(2), '42.07');
  });
});

describe('computeRequestFingerprint', () => {
  const account = '6f1c1e9e-6a3f-4d8e-9b8e-1f0f6f4b8a11';

  it('is stable and normalises the amount', () => {
    const a = computeRequestFingerprint(account, new Money('10'), 'EUR');
    const b = computeRequestFingerprint(account, new Money('10.00'), 'eur');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('differs when any parameter differs', () => {
    const base = computeRequestFingerprint(account, new Money('10'), 'EUR');
    assert.notEqual(base, computeRequestFingerprint(account, new Money('10.01'), 'EUR'));
    assert.notEqual(base, computeRequestFingerprint(account, new Money('10'), 'GBP'));
    assert.notEqual(base, computeRequestFingerprint('7f1c1e9e-6a3f-4d8e-9b8e-1f0f6f4b8a11', new Money('10'), 'EUR'));
  });
});
