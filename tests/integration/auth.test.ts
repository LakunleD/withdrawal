import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { api, resetDatabase, startTestApp, type TestContext } from '../helpers/test-app';

describe('auth', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestApp();
  });
  after(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.pool);
  });

  describe('POST /v1/auth/register', () => {
    it('creates a user and a zero-balance account', async () => {
      const res = await api(ctx, 'POST', '/v1/auth/register', {
        body: { email: '  Alice@Example.com ', password: 'correct-horse-battery' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.user.email, 'alice@example.com');
      assert.equal(res.body.account.user_id, res.body.user.id);
      assert.equal(res.body.account.balance_usd, '0.00');
      assert.equal(res.body.account.status, 'active');
      assert.equal(res.body.user.password_hash, undefined);

      const { rows } = await ctx.pool.query('SELECT password_hash FROM users WHERE id = $1', [res.body.user.id]);
      assert.match(rows[0].password_hash, /^\$2[aby]\$/);
      assert.notEqual(rows[0].password_hash, 'correct-horse-battery');
    });

    it('rejects a duplicate email (case-insensitively)', async () => {
      await api(ctx, 'POST', '/v1/auth/register', { body: { email: 'bob@example.com', password: 'correct-horse-battery' } });
      const res = await api(ctx, 'POST', '/v1/auth/register', { body: { email: 'BOB@example.com', password: 'another-password' } });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'EMAIL_ALREADY_REGISTERED');

      const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM accounts');
      assert.equal(rows[0].n, 1);
    });

    for (const [name, body] of [
      ['invalid email', { email: 'not-an-email', password: 'correct-horse-battery' }],
      ['short password', { email: 'c@example.com', password: 'short' }],
      ['password over 72 bytes', { email: 'c@example.com', password: 'x'.repeat(73) }],
      ['missing fields', {}],
      ['non-string email', { email: 42, password: 'correct-horse-battery' }],
    ] as const) {
      it(`rejects ${name}`, async () => {
        const res = await api(ctx, 'POST', '/v1/auth/register', { body });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      });
    }

    it('rejects malformed JSON', async () => {
      const res = await api(ctx, 'POST', '/v1/auth/register', { body: '{"email": ' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_JSON');
    });
  });

  describe('POST /v1/auth/login', () => {
    beforeEach(async () => {
      await api(ctx, 'POST', '/v1/auth/register', { body: { email: 'dana@example.com', password: 'correct-horse-battery' } });
    });

    it('returns a signed, short-lived JWT for valid credentials', async () => {
      const res = await api(ctx, 'POST', '/v1/auth/login', { body: { email: 'DANA@example.com', password: 'correct-horse-battery' } });

      assert.equal(res.status, 200);
      assert.equal(res.body.token_type, 'Bearer');
      assert.equal(res.body.expires_in, 900);

      const claims = jwt.verify(res.body.access_token, ctx.config.auth.jwtSecret, {
        issuer: ctx.config.auth.jwtIssuer,
        audience: ctx.config.auth.jwtAudience,
      }) as jwt.JwtPayload;
      const { rows } = await ctx.pool.query("SELECT id FROM users WHERE email = 'dana@example.com'");
      assert.equal(claims.sub, rows[0].id);
      assert.equal(claims.exp! - claims.iat!, 900);

      const account = await api(ctx, 'GET', `/v1/accounts/${res.body.account_id}`, { token: res.body.access_token });
      assert.equal(account.status, 200);
    });

    it('returns the same 401 for a wrong password and an unknown email', async () => {
      const wrong = await api(ctx, 'POST', '/v1/auth/login', { body: { email: 'dana@example.com', password: 'wrong-password' } });
      const unknown = await api(ctx, 'POST', '/v1/auth/login', { body: { email: 'nobody@example.com', password: 'whatever-pass' } });

      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(wrong.body, unknown.body);
      assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
    });

    it('does not store access tokens in the database', async () => {
      const res = await api(ctx, 'POST', '/v1/auth/login', { body: { email: 'dana@example.com', password: 'correct-horse-battery' } });
      const { rows } = await ctx.pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      assert.deepEqual(
        rows.map((r) => r.table_name),
        ['accounts', 'schema_migrations', 'users', 'withdrawals'],
      );
      const dump = await ctx.pool.query('SELECT u.*, a.* FROM users u JOIN accounts a ON a.user_id = u.id');
      assert.ok(!JSON.stringify(dump.rows).includes(res.body.access_token));
    });
  });
});
