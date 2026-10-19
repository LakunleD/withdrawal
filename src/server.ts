import { createApp } from './app';
import { loadConfig } from './config';
import { runMigrations } from './db/migrate';
import { createPool } from './db/pool';
import { FrankfurterExchangeRateProvider } from './services/exchange-rate/frankfurter.provider';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.dbPoolMax);

  await runMigrations(pool, config.migrationsDir);

  const app = createApp({
    pool,
    config,
    exchangeRateProvider: new FrankfurterExchangeRateProvider(config.exchangeRate),
  });

  const server = app.listen(config.port, () => logger.info('server_listening', { port: config.port }));

  const shutdown = (signal: string) => {
    logger.info('server_shutting_down', { signal });
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // Don't hang forever on stuck connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('server_start_failed', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
