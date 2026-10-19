import path from 'node:path';

export interface AuthConfig {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSeconds: number;
  bcryptRounds: number;
}

export interface ExchangeRateConfig {
  baseUrl: string;
  timeoutMs: number;
  retries: number;
  maxAgeDays: number;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  migrationsDir: string;
  auth: AuthConfig;
  exchangeRate: ExchangeRateConfig;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Environment variable ${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`Environment variable ${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const jwtSecret = required(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  return {
    port: integer(env, 'PORT', 3000, 0, 65535),
    databaseUrl: required(env, 'DATABASE_URL'),
    dbPoolMax: integer(env, 'DB_POOL_MAX', 10, 1, 100),
    migrationsDir: env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'sql'),
    auth: {
      jwtSecret,
      jwtIssuer: env.JWT_ISSUER ?? 'withdrawal-service',
      jwtAudience: env.JWT_AUDIENCE ?? 'withdrawal-api',
      accessTokenTtlSeconds: integer(env, 'JWT_EXPIRES_IN_SECONDS', 900, 60, 86400),
      bcryptRounds: integer(env, 'BCRYPT_ROUNDS', 12, 4, 15),
    },
    exchangeRate: {
      baseUrl: env.FRANKFURTER_BASE_URL ?? 'https://api.frankfurter.dev/v1',
      timeoutMs: integer(env, 'EXCHANGE_RATE_TIMEOUT_MS', 3000, 100, 30000),
      retries: integer(env, 'EXCHANGE_RATE_RETRIES', 1, 0, 3),
      maxAgeDays: integer(env, 'EXCHANGE_RATE_MAX_AGE_DAYS', 4, 0, 30),
    },
  };
}
