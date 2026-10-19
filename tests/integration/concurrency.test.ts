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

describe('concurrency', () => {
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
    // Widen the race window: all requests pass the pre-checks before any takes the lock.
    ctx.provider.delayMs = 25;
    user = await registerAndLogin(ctx);
  });

  it('never overspends under concurrent withdrawals with different keys', async () => {
    await fundAccount(ctx.pool, user.accountId, '100.00');

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => withdraw(ctx, user, { amount: '30.00', target_currency: 'EUR' })),
    );

    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 422, 422, 422, 422, 422, 422, 422]);
    assert.equal(await getBalance(ctx.pool, user.accountId), '10.00');
    assert.equal(await countWithdrawals(ctx.pool, user.accountId), 3);

    const codes = responses.filter((r) => r.status === 201).map((r) => r.body.authorisation_code);
    assert.equal(new Set(codes).size, 3);
  });

  it('processes concurrent requests with the same key exactly once', async () => {
    await fundAccount(ctx.pool, user.accountId, '100.00');
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => withdraw(ctx, user, { amount: '40.00', target_currency: 'EUR' }, key)),
    );

    for (const res of responses) assert.equal(res.status, 201);
    assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
    assert.equal(new Set(responses.map((r) => r.body.authorisation_code)).size, 1);
    assert.equal(responses.filter((r) => r.headers.get('idempotent-replayed') === 'false').length, 1);
    assert.equal(await getBalance(ctx.pool, user.accountId), '60.00');
    assert.equal(await countWithdrawals(ctx.pool, user.accountId), 1);
  });

  it('rejects a concurrent same-key request with different parameters', async () => {
    await fundAccount(ctx.pool, user.accountId, '100.00');
    const key = randomUUID();

    const [a, b] = await Promise.all([
      withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' }, key),
      withdraw(ctx, user, { amount: '20.00', target_currency: 'EUR' }, key),
    ]);

    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(await countWithdrawals(ctx.pool, user.accountId), 1);
    const winner = a.status === 201 ? a : b;
    assert.equal(await getBalance(ctx.pool, user.accountId), winner.body.amount_usd === '10.00' ? '90.00' : '80.00');
  });

  it('keeps accounts independent under concurrent load', async () => {
    const other = await registerAndLogin(ctx);
    await fundAccount(ctx.pool, user.accountId, '50.00');
    await fundAccount(ctx.pool, other.accountId, '50.00');

    await Promise.all([
      ...Array.from({ length: 5 }, () => withdraw(ctx, user, { amount: '10.00', target_currency: 'USD' })),
      ...Array.from({ length: 5 }, () => withdraw(ctx, other, { amount: '10.00', target_currency: 'USD' })),
    ]);

    assert.equal(await getBalance(ctx.pool, user.accountId), '0.00');
    assert.equal(await getBalance(ctx.pool, other.accountId), '0.00');
  });
});
