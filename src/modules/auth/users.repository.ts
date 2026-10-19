import type { PoolClient } from 'pg';
import type { Queryable } from '../../db/pool';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export interface UserWithAccountRow extends UserRow {
  account_id: string;
}

export async function insertUser(client: PoolClient, email: string, passwordHash: string): Promise<UserRow> {
  const result = await client.query<UserRow>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, password_hash, created_at',
    [email, passwordHash],
  );
  return result.rows[0];
}

export async function findUserWithAccountByEmail(db: Queryable, email: string): Promise<UserWithAccountRow | null> {
  const result = await db.query<UserWithAccountRow>(
    `SELECT u.id, u.email, u.password_hash, u.created_at, a.id AS account_id
       FROM users u
       JOIN accounts a ON a.user_id = u.id
      WHERE u.email = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}
