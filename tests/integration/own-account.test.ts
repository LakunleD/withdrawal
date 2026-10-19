import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  api,
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

/** Routes that resolve the account from the JWT instead of the URL. */
describe('token-scoped account routes (/v1/accounts)', () => {
  let ctx: TestContext;
  let alice: TestUser;
  let bob: TestUser;

  before(async () => {
    ctx = await startTestApp();
  });
  after(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    ctx.provider.reset();
    alice = await registerAndLogin(ctx);
    bob = await registerAndLogin(ctx);
    await fundAccount(ctx.pool, alice.accountId, '200.00');
    await fundAccount(ctx.pool, bob.accountId, '50.00');
  });

  const createOwn = (user: TestUser, body: unknown, key: string = randomUUID()) =>
    api(ctx, 'POST', '/v1/accounts/withdrawals', { token: user.token, body, headers: { 'idempotency-key': key } });

  it('GET /v1/accounts returns the caller’s own account', async () => {
    const a = await api(ctx, 'GET', '/v1/accounts', { token: alice.token });
    const b = await api(ctx, 'GET', '/v1/accounts', { token: bob.token });
    assert.equal(a.status, 200);
    assert.equal(a.body.id, alice.accountId);
    assert.equal(a.body.balance_usd, '200.00');
    assert.equal(b.body.id, bob.accountId);
    assert.equal(b.body.balance_usd, '50.00');
  });

  it('requires authentication', async () => {
    for (const [method, path] of [
      ['GET', '/v1/accounts'],
      ['GET', '/v1/accounts/withdrawals'],
      ['POST', '/v1/accounts/withdrawals'],
      ['GET', `/v1/accounts/withdrawals/${randomUUID()}`],
    ]) {
      const res = await api(ctx, method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    }
  });

  it('creates a withdrawal on the caller’s account only', async () => {
    const res = await createOwn(alice, { amount: '125.50', target_currency: 'EUR' });

    assert.equal(res.status, 201);
    assert.equal(res.body.account_id, alice.accountId);
    assert.equal(res.body.converted_amount, '115.46');
    assert.equal(res.headers.get('location'), `/v1/accounts/withdrawals/${res.body.id}`);
    assert.equal(await getBalance(ctx.pool, alice.accountId), '74.50');
    assert.equal(await getBalance(ctx.pool, bob.accountId), '50.00');
  });

  it('shares idempotency with the account-ID routes', async () => {
    const key = randomUUID();
    const first = await createOwn(alice, { amount: '10.00', target_currency: 'USD' }, key);
    const viaId = await withdraw(ctx, alice, { amount: '10.00', target_currency: 'USD' }, key);
    const conflict = await createOwn(alice, { amount: '11.00', target_currency: 'USD' }, key);

    assert.equal(viaId.status, 201);
    assert.equal(viaId.body.id, first.body.id);
    assert.equal(viaId.headers.get('idempotent-replayed'), 'true');
    assert.equal(conflict.status, 409);
    assert.equal(await countWithdrawals(ctx.pool, alice.accountId), 1);
    assert.equal(await getBalance(ctx.pool, alice.accountId), '190.00');
  });

  it('applies the same validation and funds checks', async () => {
    const missingKey = await api(ctx, 'POST', '/v1/accounts/withdrawals', {
      token: alice.token,
      body: { amount: '10.00', target_currency: 'EUR' },
    });
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const tooMuch = await createOwn(bob, { amount: '50.01', target_currency: 'USD' });
    assert.equal(tooMuch.status, 422);
    assert.equal(await getBalance(ctx.pool, bob.accountId), '50.00');
  });

  it('lists and fetches only the caller’s withdrawals', async () => {
    const mine = await createOwn(alice, { amount: '1.00', target_currency: 'USD' });
    await createOwn(alice, { amount: '2.00', target_currency: 'USD' });
    await createOwn(alice, { amount: '3.00', target_currency: 'USD' });
    const bobs = await createOwn(bob, { amount: '5.00', target_currency: 'USD' });

    const page1 = await api(ctx, 'GET', '/v1/accounts/withdrawals?limit=2', { token: alice.token });
    assert.equal(page1.status, 200);
    assert.deepEqual(page1.body.data.map((w: { amount_usd: string }) => w.amount_usd), ['3.00', '2.00']);
    const page2 = await api(ctx, 'GET', `/v1/accounts/withdrawals?limit=2&cursor=${page1.body.next_cursor}`, {
      token: alice.token,
    });
    assert.deepEqual(page2.body.data.map((w: { amount_usd: string }) => w.amount_usd), ['1.00']);
    assert.equal(page2.body.next_cursor, null);

    const own = await api(ctx, 'GET', `/v1/accounts/withdrawals/${mine.body.id}`, { token: alice.token });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body, mine.body);

    const other = await api(ctx, 'GET', `/v1/accounts/withdrawals/${bobs.body.id}`, { token: alice.token });
    assert.equal(other.status, 404);
    assert.equal(other.body.error.code, 'WITHDRAWAL_NOT_FOUND');
  });

  it('keeps the account-ID routes working alongside', async () => {
    const byId = await api(ctx, 'GET', `/v1/accounts/${alice.accountId}`, { token: alice.token });
    assert.equal(byId.status, 200);
    const denied = await api(ctx, 'GET', `/v1/accounts/${alice.accountId}`, { token: bob.token });
    assert.equal(denied.status, 403);
    const res = await withdraw(ctx, alice, { amount: '1.00', target_currency: 'USD' });
    assert.equal(res.headers.get('location'), `/v1/accounts/${alice.accountId}/withdrawals/${res.body.id}`);
  });

  it('returns 404 if the user has no account', async () => {
    await ctx.pool.query('DELETE FROM accounts WHERE id = $1', [bob.accountId]);
    const res = await api(ctx, 'GET', '/v1/accounts', { token: bob.token });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ACCOUNT_NOT_FOUND');
  });
});
