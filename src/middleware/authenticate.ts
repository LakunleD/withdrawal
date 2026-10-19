import type { NextFunction, Request, Response } from 'express';
import type { TokenService } from '../modules/auth/token.service';
import { AppError } from '../utils/errors';

/** Requires `Authorization: Bearer <JWT>` and sets `req.auth.userId`. */
export function createAuthenticate(tokens: TokenService) {
  return function authenticate(req: Request, _res: Response, next: NextFunction): void {
    const header = req.get('authorization');
    const match = header?.match(/^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)$/);
    if (!match) {
      throw new AppError(401, 'UNAUTHENTICATED', 'A valid Bearer access token is required.');
    }
    req.auth = tokens.verify(match[1]);
    next();
  };
}
