import type { PoolClient } from 'pg';
import type { Queryable } from '../../db/pool';

export interface AccountRow {
  id: string;
  user_id: string;
  /** NUMERIC(19,2) as returned by pg: a decimal string, never a float. */
  balance_usd: string;
  status: 'active' | 'suspended';
  created_at: Date;
}

const COLUMNS = 'id, user_id, balance_usd, status, created_at';

export async function createAccountForUser(client: PoolClient, userId: string): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    `INSERT INTO accounts (user_id, balance_usd, status) VALUES ($1, 0, 'active') RETURNING ${COLUMNS}`,
    [userId],
  );
  return result.rows[0];
}

export async function findAccountById(db: Queryable, accountId: string): Promise<AccountRow | null> {
  const result = await db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [accountId]);
  return result.rows[0] ?? null;
}

export async function findAccountByUserId(db: Queryable, userId: string): Promise<AccountRow | null> {
  const result = await db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE user_id = $1`, [userId]);
  return result.rows[0] ?? null;
}

/** Locks the account row until the surrounding transaction ends, serialising withdrawals per account. */
export async function lockAccountForUpdate(client: PoolClient, accountId: string): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1 FOR UPDATE`, [
    accountId,
  ]);
  return result.rows[0] ?? null;
}

/**
 * Deducts `amountUsd` (a 2dp decimal string). The `balance_usd >= $1` guard and the
 * non-negative CHECK constraint are defence in depth behind the application check.
 * Returns false when funds are insufficient.
 */
export async function debitAccount(client: PoolClient, accountId: string, amountUsd: string): Promise<boolean> {
  const result = await client.query(
    'UPDATE accounts SET balance_usd = balance_usd - $1::numeric WHERE id = $2 AND balance_usd >= $1::numeric',
    [amountUsd, accountId],
  );
  return result.rowCount === 1;
}

export function toAccountResponse(account: AccountRow) {
  return {
    id: account.id,
    user_id: account.user_id,
    status: account.status,
    currency: 'USD',
    balance_usd: account.balance_usd,
    created_at: account.created_at.toISOString(),
  };
}
