import jwt from 'jsonwebtoken';
import type { AuthConfig } from '../../config';
import { AppError } from '../../utils/errors';
import { isUuid } from '../../utils/validation';

const ALGORITHM = 'HS256';

export interface IssuedToken {
  accessToken: string;
  expiresIn: number;
}

/** Issues and verifies short-lived HS256 access tokens. Tokens are never persisted. */
export class TokenService {
  constructor(private readonly config: AuthConfig) {}

  issue(userId: string): IssuedToken {
    const accessToken = jwt.sign({}, this.config.jwtSecret, {
      algorithm: ALGORITHM,
      subject: userId,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
      expiresIn: this.config.accessTokenTtlSeconds,
    });
    return { accessToken, expiresIn: this.config.accessTokenTtlSeconds };
  }

  /** Validates signature, algorithm, expiry, issuer and audience; returns the user ID from `sub`. */
  verify(token: string): { userId: string } {
    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.config.jwtSecret, {
        algorithms: [ALGORITHM],
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      });
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError(401, 'TOKEN_EXPIRED', 'The access token has expired.');
      }
      throw new AppError(401, 'INVALID_TOKEN', 'The access token is invalid.');
    }

    if (typeof payload !== 'object' || typeof payload.exp !== 'number' || !isUuid(payload.sub)) {
      throw new AppError(401, 'INVALID_TOKEN', 'The access token is invalid.');
    }
    return { userId: payload.sub };
  }
}
