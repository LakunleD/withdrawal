import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import {
  api,
  countWithdrawals,
  fundAccount,
  getBalance,
  registerAndLogin,
  resetDatabase,
  startTestApp,
  type TestContext,
  type TestUser,
} from '../helpers/test-app';

describe('account access', () => {
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
    alice = await registerAndLogin(ctx);
    bob = await registerAndLogin(ctx);
  });

  it('GET /health reports the database status', async () => {
    const res = await api(ctx, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', database: 'ok' });
  });

  it('returns the account and its USD balance to its owner', async () => {
    await fundAccount(ctx.pool, alice.accountId, '250.75');
    const res = await api(ctx, 'GET', `/v1/accounts/${alice.accountId}`, { token: alice.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, alice.accountId);
    assert.equal(res.body.user_id, alice.userId);
    assert.equal(res.body.balance_usd, '250.75');
    assert.equal(res.body.currency, 'USD');
  });

  describe('authentication', () => {
    const path = () => `/v1/accounts/${alice.accountId}`;

    it('requires a token', async () => {
      const res = await api(ctx, 'GET', path());
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    });

    it('rejects non-Bearer schemes and garbage tokens', async () => {
      for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer not.a.jwt!', alice.token]) {
        const res = await api(ctx, 'GET', path(), { headers: { authorization } });
        assert.equal(res.status, 401, authorization);
      }
    });

    it('rejects an expired token', async () => {
      const expired = jwt.sign(
        { exp: Math.floor(Date.now() / 1000) - 1 },
        ctx.config.auth.jwtSecret,
        { subject: alice.userId, issuer: ctx.config.auth.jwtIssuer, audience: ctx.config.auth.jwtAudience },
      );
      const res = await api(ctx, 'GET', path(), { token: expired });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'TOKEN_EXPIRED');
    });

    it('rejects tokens signed with another secret, issuer or audience', async () => {
      const base = { subject: alice.userId, expiresIn: 60 };
      const tokens = [
        jwt.sign({}, 'some-other-secret-some-other-secret-012345', { ...base, issuer: ctx.config.auth.jwtIssuer, audience: ctx.config.auth.jwtAudience }),
        jwt.sign({}, ctx.config.auth.jwtSecret, { ...base, issuer: 'evil', audience: ctx.config.auth.jwtAudience }),
        jwt.sign({}, ctx.config.auth.jwtSecret, { ...base, issuer: ctx.config.auth.jwtIssuer, audience: 'other' }),
      ];
      for (const token of tokens) {
        const res = await api(ctx, 'GET', path(), { token });
        assert.equal(res.status, 401);
        assert.equal(res.body.error.code, 'INVALID_TOKEN');
      }
    });
  });

  describe('ownership', () => {
    it("denies access to another user's account on every endpoint", async () => {
      await fundAccount(ctx.pool, alice.accountId, '100.00');
      const base = `/v1/accounts/${alice.accountId}`;

      const responses = await Promise.all([
        api(ctx, 'GET', base, { token: bob.token }),
        api(ctx, 'GET', `${base}/withdrawals`, { token: bob.token }),
        api(ctx, 'GET', `${base}/withdrawals/${randomUUID()}`, { token: bob.token }),
        api(ctx, 'POST', `${base}/withdrawals`, {
          token: bob.token,
          body: { amount: '10.00', target_currency: 'USD' },
          headers: { 'idempotency-key': randomUUID() },
        }),
      ]);

      for (const res of responses) {
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'ACCOUNT_ACCESS_DENIED');
      }
      assert.equal(await getBalance(ctx.pool, alice.accountId), '100.00');
      assert.equal(await countWithdrawals(ctx.pool, alice.accountId), 0);
    });

    it('returns 404 for unknown or malformed account IDs', async () => {
      for (const id of [randomUUID(), 'not-a-uuid', "1' OR '1'='1"]) {
        const res = await api(ctx, 'GET', `/v1/accounts/${encodeURIComponent(id)}`, { token: alice.token });
        assert.equal(res.status, 404);
        assert.equal(res.body.error.code, 'ACCOUNT_NOT_FOUND');
      }
    });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await api(ctx, 'GET', '/v1/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
