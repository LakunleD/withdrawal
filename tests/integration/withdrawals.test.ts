import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AUTHORISATION_CODE_PATTERN } from '../../src/modules/withdrawals/authorisation-code';
import { ExchangeRateUnavailableError } from '../../src/services/exchange-rate/exchange-rate.provider';
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

describe('withdrawals', () => {
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
    await fundAccount(ctx.pool, user.accountId, '500.00');
  });

  describe('POST /v1/accounts/:accountId/withdrawals', () => {
    it('authorises a withdrawal, converts it and debits the USD balance', async () => {
      const res = await withdraw(ctx, user, { amount: '125.50', target_currency: 'EUR' });

      assert.equal(res.status, 201);
      assert.equal(res.body.account_id, user.accountId);
      assert.equal(res.body.status, 'authorised');
      assert.equal(res.body.amount_usd, '125.50');
      assert.equal(res.body.target_currency, 'EUR');
      assert.equal(res.body.exchange_rate, '0.92');
      assert.equal(res.body.converted_amount, '115.46');
      assert.match(res.body.authorisation_code, AUTHORISATION_CODE_PATTERN);
      assert.notEqual(res.body.authorisation_code, res.body.id);
      assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
      assert.equal(res.headers.get('location'), `/v1/accounts/${user.accountId}/withdrawals/${res.body.id}`);
      assert.equal(res.headers.get('idempotent-replayed'), 'false');

      assert.equal(await getBalance(ctx.pool, user.accountId), '374.50');
      assert.deepEqual(ctx.provider.calls, ['EUR']);
    });

    it('rounds to the target currency minor units (JPY has none)', async () => {
      const res = await withdraw(ctx, user, { amount: '10.00', target_currency: 'jpy' });
      assert.equal(res.status, 201);
      assert.equal(res.body.target_currency, 'JPY');
      assert.equal(res.body.exchange_rate, '149.523');
      assert.equal(res.body.converted_amount, '1495');
    });

    it('uses a rate of 1 for USD without calling the provider', async () => {
      ctx.provider.failure = new Error('must not be called');
      const res = await withdraw(ctx, user, { amount: '100', target_currency: 'USD' });
      assert.equal(res.status, 201);
      assert.equal(res.body.exchange_rate, '1');
      assert.equal(res.body.converted_amount, '100.00');
      assert.equal(res.body.amount_usd, '100.00');
      assert.deepEqual(ctx.provider.calls, []);
    });

    it('allows withdrawing the exact balance', async () => {
      const res = await withdraw(ctx, user, { amount: '500.00', target_currency: 'USD' });
      assert.equal(res.status, 201);
      assert.equal(await getBalance(ctx.pool, user.accountId), '0.00');
    });

    it('rejects insufficient funds with 422 and changes nothing', async () => {
      const res = await withdraw(ctx, user, { amount: '500.01', target_currency: 'EUR' });
      assert.equal(res.status, 422);
      assert.deepEqual(res.body, { error: { code: 'INSUFFICIENT_FUNDS', message: 'The account has insufficient funds.' } });
      assert.equal(await getBalance(ctx.pool, user.accountId), '500.00');
      assert.equal(await countWithdrawals(ctx.pool, user.accountId), 0);
    });

    for (const body of [
      { amount: '0', target_currency: 'EUR' },
      { amount: '-5.00', target_currency: 'EUR' },
      { amount: '10.001', target_currency: 'EUR' },
      { amount: 10.5, target_currency: 'EUR' },
      { amount: '1e2', target_currency: 'EUR' },
      { target_currency: 'EUR' },
      { amount: '10.00', target_currency: 'XYZ' },
      { amount: '10.00', target_currency: 'EURO' },
      { amount: '10.00' },
    ]) {
      it(`rejects invalid input ${JSON.stringify(body)} with 400`, async () => {
        const res = await withdraw(ctx, user, body);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
        assert.deepEqual(ctx.provider.calls, []);
        assert.equal(await getBalance(ctx.pool, user.accountId), '500.00');
      });
    }

    it('rejects a missing Idempotency-Key with 400', async () => {
      const res = await withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' }, null);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
      assert.equal(await countWithdrawals(ctx.pool, user.accountId), 0);
    });

    it('rejects a non-JSON content type with 415', async () => {
      const res = await api(ctx, 'POST', `/v1/accounts/${user.accountId}/withdrawals`, {
        token: user.token,
        body: 'amount=10&target_currency=EUR',
        headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(res.status, 415);
    });

    it('returns 503 when the exchange rate provider fails, without debiting', async () => {
      ctx.provider.failure = new ExchangeRateUnavailableError('timed out after 3000ms');
      const key = randomUUID();
      const res = await withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' }, key);

      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'EXCHANGE_RATE_UNAVAILABLE');
      assert.ok(!JSON.stringify(res.body).includes('3000ms'), 'internal reason must not leak');
      assert.equal(await getBalance(ctx.pool, user.accountId), '500.00');
      assert.equal(await countWithdrawals(ctx.pool, user.accountId), 0);

      // The key was not consumed, so the client can safely retry once the provider recovers.
      ctx.provider.failure = null;
      const retry = await withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' }, key);
      assert.equal(retry.status, 201);
      assert.equal(await getBalance(ctx.pool, user.accountId), '490.00');
    });

    it('does not leak internals for unexpected provider errors', async () => {
      ctx.provider.failure = new Error('secret internal detail');
      const res = await withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' });
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
    });

    it('rejects withdrawals from a suspended account', async () => {
      await ctx.pool.query(`UPDATE accounts SET status = 'suspended' WHERE id = $1`, [user.accountId]);
      const res = await withdraw(ctx, user, { amount: '10.00', target_currency: 'EUR' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'ACCOUNT_NOT_ACTIVE');
      assert.equal(await getBalance(ctx.pool, user.accountId), '500.00');
    });

    it('enforces the non-negative balance constraint in the database', async () => {
      await assert.rejects(
        ctx.pool.query('UPDATE accounts SET balance_usd = -0.01 WHERE id = $1', [user.accountId]),
        /accounts_balance_nonnegative/,
      );
    });
  });

  describe('transaction rollback', () => {
    it('rolls back the debit when the withdrawal cannot be recorded', async () => {
      // Every generated code collides, so after the bounded retries the insert fails mid-transaction.
      const collidingCtx = await startTestApp({ generateAuthorisationCode: () => 'AAAA-AAAA', pool: ctx.pool });
      try {
        const first = await withdraw(collidingCtx, user, { amount: '100.00', target_currency: 'USD' });
        assert.equal(first.status, 201);
        assert.equal(first.body.authorisation_code, 'AAAA-AAAA');

        const second = await withdraw(collidingCtx, user, { amount: '50.00', target_currency: 'USD' });
        assert.equal(second.status, 500);
        assert.equal(second.body.error.code, 'INTERNAL_ERROR');

        assert.equal(await getBalance(ctx.pool, user.accountId), '400.00');
        assert.equal(await countWithdrawals(ctx.pool, user.accountId), 1);
      } finally {
        await collidingCtx.close();
      }
    });

    it('retries authorisation code collisions with a fresh code', async () => {
      const codes = ['AAAA-AAAA', 'AAAA-AAAA', 'BBBB-BBBB'];
      const retryCtx = await startTestApp({ generateAuthorisationCode: () => codes.shift() ?? 'CCCC-CCCC', pool: ctx.pool });
      try {
        const first = await withdraw(retryCtx, user, { amount: '1.00', target_currency: 'USD' });
        const second = await withdraw(retryCtx, user, { amount: '1.00', target_currency: 'USD' });
        assert.equal(first.body.authorisation_code, 'AAAA-AAAA');
        assert.equal(second.status, 201);
        assert.equal(second.body.authorisation_code, 'BBBB-BBBB');
        assert.equal(await getBalance(ctx.pool, user.accountId), '498.00');
      } finally {
        await retryCtx.close();
      }
    });
  });

  describe('GET /v1/accounts/:accountId/withdrawals/:withdrawalId', () => {
    it('returns the stored withdrawal with its original rate', async () => {
      const created = await withdraw(ctx, user, { amount: '125.50', target_currency: 'EUR' });
      ctx.provider.rates.EUR = '0.50'; // the market moves; history must not

      const res = await api(ctx, 'GET', `/v1/accounts/${user.accountId}/withdrawals/${created.body.id}`, { token: user.token });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, created.body);
      assert.equal(res.body.exchange_rate, '0.92');
      assert.equal(res.body.converted_amount, '115.46');
    });

    it("returns 404 for unknown IDs and for another account's withdrawal", async () => {
      const other = await registerAndLogin(ctx);
      await fundAccount(ctx.pool, other.accountId, '10.00');
      const otherWithdrawal = await withdraw(ctx, other, { amount: '1.00', target_currency: 'USD' });

      for (const id of [randomUUID(), 'nope', otherWithdrawal.body.id]) {
        const res = await api(ctx, 'GET', `/v1/accounts/${user.accountId}/withdrawals/${id}`, { token: user.token });
        assert.equal(res.status, 404);
        assert.equal(res.body.error.code, 'WITHDRAWAL_NOT_FOUND');
      }
    });
  });

  describe('GET /v1/accounts/:accountId/withdrawals', () => {
    it('returns an empty page for a new account', async () => {
      const res = await api(ctx, 'GET', `/v1/accounts/${user.accountId}/withdrawals`, { token: user.token });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { data: [], next_cursor: null });
    });

    it('paginates newest first with a cursor and no duplicates', async () => {
      const created: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const res = await withdraw(ctx, user, { amount: `${i}.00`, target_currency: 'USD' });
        created.push(res.body.id);
      }
      // Two withdrawals in the same instant exercise the id tie-breaker.
      await ctx.pool.query('UPDATE withdrawals SET created_at = $1 WHERE id = ANY($2)', [
        '2026-10-19T10:00:00.000001Z',
        [created[1], created[2]],
      ]);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
        const res = await api(ctx, 'GET', `/v1/accounts/${user.accountId}/withdrawals${query}`, { token: user.token });
        assert.equal(res.status, 200);
        assert.ok(res.body.data.length <= 2);
        seen.push(...res.body.data.map((w: { id: string }) => w.id));
        cursor = res.body.next_cursor;
        pages++;
      } while (cursor);

      assert.equal(pages, 3);
      assert.equal(new Set(seen).size, 5);
      assert.deepEqual([...seen].sort(), [...created].sort());

      const { rows } = await ctx.pool.query(
        'SELECT id FROM withdrawals WHERE account_id = $1 ORDER BY created_at DESC, id DESC',
        [user.accountId],
      );
      assert.deepEqual(seen, rows.map((r) => r.id));
    });

    it('only lists the requested account', async () => {
      const other = await registerAndLogin(ctx);
      await fundAccount(ctx.pool, other.accountId, '10.00');
      await withdraw(ctx, other, { amount: '1.00', target_currency: 'USD' });
      await withdraw(ctx, user, { amount: '2.00', target_currency: 'USD' });

      const res = await api(ctx, 'GET', `/v1/accounts/${user.accountId}/withdrawals`, { token: user.token });
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].account_id, user.accountId);
    });

    it('validates limit and cursor', async () => {
      for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?cursor=garbage']) {
        const res = await api(ctx, 'GET', `/v1/accounts/${user.accountId}/withdrawals${query}`, { token: user.token });
        assert.equal(res.status, 400, query);
      }
    });
  });
});
