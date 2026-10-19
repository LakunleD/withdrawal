import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { withTransaction } from './pool';
import { logger } from '../utils/logger';

// Arbitrary constant; serialises migration runs across processes (API + test runner).
const MIGRATION_LOCK_ID = 727274;

/** Applies every not-yet-applied `sql/*.sql` file in filename order, each in its own transaction. */
export async function runMigrations(pool: Pool, migrationsDir: string): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const applied = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const done = new Set(applied.rows.map((r) => r.filename));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      logger.info('migration_applied', { file });
    }
  });
}
