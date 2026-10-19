import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { createApp } from '../../src/app';
import { loadConfig, type AppConfig } from '../../src/config';
import { runMigrations } from '../../src/db/migrate';
import { createPool } from '../../src/db/pool';
import { MockExchangeRateProvider } from './mock-exchange-rate-provider';

export interface TestContext {
  pool: Pool;
  config: AppConfig;
  provider: MockExchangeRateProvider;
  baseUrl: string;
  close(): Promise<void>;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  // Parsed JSON; loosely typed so tests can assert on arbitrary fields.
  body: any;
}

export interface TestUser {
  userId: string;
  accountId: string;
  email: string;
  password: string;
  token: string;
}

/** Boots the real app against the test database with a mocked exchange rate provider. */
export async function startTestApp(options: { generateAuthorisationCode?: () => string; pool?: Pool } = {}): Promise<TestContext> {
  const config = loadConfig();
  if (!/test/.test(config.databaseUrl)) {
    throw new Error('Refusing to run tests against a non-test database');
  }
  const ownsPool = !options.pool;
  const pool = options.pool ?? createPool(config.databaseUrl, 20);
  await runMigrations(pool, config.migrationsDir);

  const provider = new MockExchangeRateProvider();
  const app = createApp({
    pool,
    config,
    exchangeRateProvider: provider,
    generateAuthorisationCode: options.generateAuthorisationCode,
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    pool,
    config,
    provider,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      if (ownsPool) await pool.end();
    },
  };
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE withdrawals, accounts, users CASCADE');
}

export async function api(
  ctx: TestContext,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

export async function registerAndLogin(ctx: TestContext, email = `user-${randomUUID()}@example.com`): Promise<TestUser> {
  const password = 'correct-horse-battery';
  const reg = await api(ctx, 'POST', '/v1/auth/register', { body: { email, password } });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const login = await api(ctx, 'POST', '/v1/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return {
    userId: reg.body.user.id,
    accountId: reg.body.account.id,
    email,
    password,
    token: login.body.access_token,
  };
}

/** Development/test funding: there is intentionally no deposit API. */
export async function fundAccount(pool: Pool, accountId: string, balanceUsd: string): Promise<void> {
  await pool.query('UPDATE accounts SET balance_usd = $1 WHERE id = $2', [balanceUsd, accountId]);
}

export async function getBalance(pool: Pool, accountId: string): Promise<string> {
  const result = await pool.query<{ balance_usd: string }>('SELECT balance_usd FROM accounts WHERE id = $1', [accountId]);
  return result.rows[0].balance_usd;
}

export async function countWithdrawals(pool: Pool, accountId: string): Promise<number> {
  const result = await pool.query<{ n: string }>('SELECT count(*) AS n FROM withdrawals WHERE account_id = $1', [accountId]);
  return Number(result.rows[0].n);
}

export function withdraw(
  ctx: TestContext,
  user: TestUser,
  body: unknown,
  idempotencyKey: string | null = randomUUID(),
): Promise<ApiResponse> {
  return api(ctx, 'POST', `/v1/accounts/${user.accountId}/withdrawals`, {
    token: user.token,
    body,
    headers: idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey },
  });
}
