import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  countWithdrawals,
  fundAccount,
  getBalance,
  registerAndLogin,
  resetDatabase,
  startTestApp,
  withdraw,
  type TestContext,
  type TestUser,
} from '../helpers/test-app';

describe('idempotency', () => {
  let ctx: TestContext;
  let user: TestUser;

  before(async () => {
    ctx = await startTestApp();
  });
  after(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    ctx.provider.reset();
    user = await registerAndLogin(ctx);
    await fundAccount(ctx.pool, user.accountId, '100.00');
  });

  it('returns the original authorisation for an identical retry without debiting again', async () => {
    const key = randomUUID();
    const first = await withdraw(ctx, user, { amount: '25.00', target_currency: 'EUR' }, key);
    ctx.provider.rates.EUR = '0.50'; // a retry must not re-quote
    const second = await withdraw(ctx, user, { amount: '25.00', target_currency: 'EUR' }, key);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(await getBalance(ctx.pool, user.accountId), '75.00');
    assert.equal(await countWithdrawals(ctx.pool, user.accountId), 1);
    assert.deepEqual(ctx.provider.calls, ['EUR']);
  });

  it('treats equivalent amount representations as the same request', async () => {
    const key = randomUUID();
    const first = await withdraw(ctx, user, { amount: '10', target_currency: 'eur' }, key);
    const second = await withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' }, key);
    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id);
    assert.equal(await getBalance(ctx.pool, user.accountId), '90.00');
  });

  it('returns 409 when the key is reused with a different amount or currency', async () => {
    const key = randomUUID();
    await withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' }, key);

    for (const body of [
      { amount: '10.01', target_currency: 'EUR' },
      { amount: '10.00', target_currency: 'GBP' },
    ]) {
      const res = await withdraw(ctx, user, body, key);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
    }
    assert.equal(await getBalance(ctx.pool, user.accountId), '90.00');
    assert.equal(await countWithdrawals(ctx.pool, user.accountId), 1);
  });

  it('replays the original result even if funds have since run out', async () => {
    const key = randomUUID();
    const first = await withdraw(ctx, user, { amount: '100.00', target_currency: 'USD' }, key);
    const retry = await withdraw(ctx, user, { amount: '100.00', target_currency: 'USD' }, key);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.id, first.body.id);
    assert.equal(await getBalance(ctx.pool, user.accountId), '0.00');
  });

  it('does not store failed attempts against the key', async () => {
    const key = randomUUID();
    const failed = await withdraw(ctx, user, { amount: '1000.00', target_currency: 'USD' }, key);
    assert.equal(failed.status, 422);
    const ok = await withdraw(ctx, user, { amount: '1000.00', target_currency: 'USD' }, key);
    assert.equal(ok.status, 422);
    await fundAccount(ctx.pool, user.accountId, '1000.00');
    const funded = await withdraw(ctx, user, { amount: '1000.00', target_currency: 'USD' }, key);
    assert.equal(funded.status, 201);
  });

  it('scopes keys to the account', async () => {
    const other = await registerAndLogin(ctx);
    await fundAccount(ctx.pool, other.accountId, '100.00');
    const key = 'shared-client-key';

    const a = await withdraw(ctx, user, { amount: '10.00', target_currency: 'USD' }, key);
    const b = await withdraw(ctx, other, { amount: '20.00', target_currency: 'USD' }, key);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);
  });

  it('rejects malformed keys', async () => {
    for (const key of ['has spaces', 'x'.repeat(256)]) {
      const res = await withdraw(ctx, user, { amount: '1.00', target_currency: 'USD' }, key);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
    }
  });

  it('enforces (account_id, idempotency_key) uniqueness in the database', async () => {
    const key = randomUUID();
    await withdraw(ctx, user, { amount: '1.00', target_currency: 'USD' }, key);
    await assert.rejects(
      ctx.pool.query(
        `INSERT INTO withdrawals (account_id, amount_usd, target_currency, converted_amount, exchange_rate,
                                  authorisation_code, idempotency_key, request_fingerprint)
         VALUES ($1, 1, 'USD', 1, 1, 'ZZZZ-ZZZZ', $2, 'x')`,
        [user.accountId, key],
      ),
      /withdrawals_account_idempotency_key/,
    );
  });
});
