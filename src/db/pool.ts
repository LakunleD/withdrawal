import { Pool, type PoolClient } from 'pg';
import { logger } from '../utils/logger';

/** Anything that can run a query: the pool itself or a checked-out transaction client. */
export type Queryable = Pool | PoolClient;

export function createPool(connectionString: string, max = 10): Pool {
  const pool = new Pool({ connectionString, max });
  // Idle clients can error (e.g. the server restarts); without a listener this crashes the process.
  pool.on('error', (err) => logger.error('db_pool_error', { message: err.message }));
  return pool;
}

/**
 * Runs `fn` inside BEGIN/COMMIT on a dedicated client. Any thrown error rolls the
 * transaction back and is rethrown, so partial financial writes are never committed.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is in an unknown state; destroy it instead of returning it to the pool.
      releaseError = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}
