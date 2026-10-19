import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/pool';
import { AppError, isUniqueViolation } from '../../utils/errors';
import { createAccountForUser, toAccountResponse } from '../accounts/accounts.repository';
import type { Credentials } from './auth.validation';
import type { TokenService } from './token.service';
import { findUserWithAccountByEmail, insertUser } from './users.repository';

export class AuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly tokens: TokenService,
    private readonly bcryptRounds: number,
  ) {}

  /** Creates the user and their zero-balance account in one transaction. */
  async register({ email, password }: Credentials) {
    const passwordHash = await bcrypt.hash(password, this.bcryptRounds);

    try {
      const { user, account } = await withTransaction(this.pool, async (client) => {
        const user = await insertUser(client, email, passwordHash);
        const account = await createAccountForUser(client, user.id);
        return { user, account };
      });
      return {
        user: { id: user.id, email: user.email, created_at: user.created_at.toISOString() },
        account: toAccountResponse(account),
      };
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) {
        throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists.');
      }
      throw err;
    }
  }

  async login({ email, password }: Credentials) {
    const user = await findUserWithAccountByEmail(this.pool, email);
    // Compare against a dummy hash for unknown emails so response timing doesn't reveal which emails exist.
    const hash = user?.password_hash ?? (await this.getDummyHash());
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const { accessToken, expiresIn } = this.tokens.issue(user.id);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      account_id: user.account_id,
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= bcrypt.hash('dummy-password-for-timing', this.bcryptRounds);
    return this.dummyHash;
  }
}
