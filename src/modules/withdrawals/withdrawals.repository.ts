import type { PoolClient } from 'pg';
import type { Queryable } from '../../db/pool';
import type { Cursor } from './pagination';

export interface WithdrawalRow {
  id: string;
  account_id: string;
  amount_usd: string;
  target_currency: string;
  converted_amount: string;
  exchange_rate: string;
  status: 'authorised';
  authorisation_code: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: Date;
}

export interface WithdrawalPageRow extends WithdrawalRow {
  created_at_text: string;
}

export interface NewWithdrawal {
  accountId: string;
  amountUsd: string;
  targetCurrency: string;
  convertedAmount: string;
  exchangeRate: string;
  authorisationCode: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

const COLUMNS = `id, account_id, amount_usd, target_currency, converted_amount, exchange_rate, status,
  authorisation_code, idempotency_key, request_fingerprint, created_at`;

export async function findByIdempotencyKey(
  db: Queryable,
  accountId: string,
  idempotencyKey: string,
): Promise<WithdrawalRow | null> {
  const result = await db.query<WithdrawalRow>(
    `SELECT ${COLUMNS} FROM withdrawals WHERE account_id = $1 AND idempotency_key = $2`,
    [accountId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function findWithdrawal(db: Queryable, accountId: string, withdrawalId: string): Promise<WithdrawalRow | null> {
  const result = await db.query<WithdrawalRow>(`SELECT ${COLUMNS} FROM withdrawals WHERE id = $1 AND account_id = $2`, [
    withdrawalId,
    accountId,
  ]);
  return result.rows[0] ?? null;
}

/**
 * Inserts the withdrawal, returning null if the authorisation code collides with an
 * existing one so the caller can retry with a fresh code. A duplicate idempotency key
 * is NOT swallowed: it surfaces as a unique_violation.
 */
export async function insertWithdrawal(client: PoolClient, w: NewWithdrawal): Promise<WithdrawalRow | null> {
  const result = await client.query<WithdrawalRow>(
    `INSERT INTO withdrawals (account_id, amount_usd, target_currency, converted_amount, exchange_rate, status,
                              authorisation_code, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'authorised', $6, $7, $8)
     ON CONFLICT (authorisation_code) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      w.accountId,
      w.amountUsd,
      w.targetCurrency,
      w.convertedAmount,
      w.exchangeRate,
      w.authorisationCode,
      w.idempotencyKey,
      w.requestFingerprint,
    ],
  );
  return result.rows[0] ?? null;
}

/** Newest-first keyset page using the (account_id, created_at DESC, id DESC) index. */
export async function listWithdrawals(
  db: Queryable,
  accountId: string,
  limit: number,
  after?: Cursor,
): Promise<WithdrawalPageRow[]> {
  const select = `SELECT ${COLUMNS}, created_at::text AS created_at_text FROM withdrawals`;
  const order = 'ORDER BY created_at DESC, id DESC';

  const result = after
    ? await db.query<WithdrawalPageRow>(
        `${select} WHERE account_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid) ${order} LIMIT $4`,
        [accountId, after.createdAt, after.id, limit],
      )
    : await db.query<WithdrawalPageRow>(`${select} WHERE account_id = $1 ${order} LIMIT $2`, [accountId, limit]);
  return result.rows;
}

export function toWithdrawalResponse(w: WithdrawalRow) {
  return {
    id: w.id,
    account_id: w.account_id,
    status: w.status,
    authorisation_code: w.authorisation_code,
    amount_usd: w.amount_usd,
    target_currency: w.target_currency,
    converted_amount: w.converted_amount,
    exchange_rate: w.exchange_rate,
    created_at: w.created_at.toISOString(),
  };
}
