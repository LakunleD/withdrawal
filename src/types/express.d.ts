import type { AccountRow } from '../modules/accounts/accounts.repository';

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware from a verified JWT. */
      auth?: { userId: string };
      /** Set by the account-access middleware once ownership is verified. */
      account?: AccountRow;
    }
  }
}

export {};
