import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import type { AuthConfig } from '../../src/config';
import { TokenService } from '../../src/modules/auth/token.service';
import { AppError } from '../../src/utils/errors';

const config: AuthConfig = {
  jwtSecret: 'unit-test-secret-unit-test-secret-0123456789',
  jwtIssuer: 'withdrawal-service',
  jwtAudience: 'withdrawal-api',
  accessTokenTtlSeconds: 900,
  bcryptRounds: 4,
};
const userId = '6f1c1e9e-6a3f-4d8e-9b8e-1f0f6f4b8a11';
const tokens = new TokenService(config);

function verifyCode(token: string): string {
  try {
    tokens.verify(token);
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 401);
    return err.code;
  }
  assert.fail('expected verification to fail');
}

/** Signs with valid defaults; pass an option as `undefined` to omit it. */
function sign(payload: object, options: jwt.SignOptions = {}, secret = config.jwtSecret): string {
  const merged: Record<string, unknown> = {
    algorithm: 'HS256',
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    subject: userId,
    expiresIn: 900,
    ...options,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return jwt.sign(payload, secret, merged as jwt.SignOptions);
}

describe('TokenService', () => {
  it('issues tokens with sub, iss, aud and a 15 minute expiry', () => {
    const { accessToken, expiresIn } = tokens.issue(userId);
    const decoded = jwt.decode(accessToken) as jwt.JwtPayload;
    assert.equal(expiresIn, 900);
    assert.equal(decoded.sub, userId);
    assert.equal(decoded.iss, config.jwtIssuer);
    assert.equal(decoded.aud, config.jwtAudience);
    assert.equal(decoded.exp! - decoded.iat!, 900);
    assert.deepEqual(tokens.verify(accessToken), { userId });
  });

  it('rejects expired tokens', () => {
    const expired = sign({ exp: Math.floor(Date.now() / 1000) - 10 }, { expiresIn: undefined });
    assert.equal(verifyCode(expired), 'TOKEN_EXPIRED');
  });

  it('rejects a wrong signature', () => {
    assert.equal(verifyCode(sign({}, {}, 'another-secret-another-secret-0123456789')), 'INVALID_TOKEN');
  });

  it('rejects a tampered payload', () => {
    const [header, , signature] = tokens.issue(userId).accessToken.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', exp: 9999999999 })).toString('base64url');
    assert.equal(verifyCode(`${header}.${forged}.${signature}`), 'INVALID_TOKEN');
  });

  it('rejects the wrong issuer or audience', () => {
    assert.equal(verifyCode(sign({}, { issuer: 'someone-else' })), 'INVALID_TOKEN');
    assert.equal(verifyCode(sign({}, { audience: 'other-api' })), 'INVALID_TOKEN');
  });

  it('rejects unsigned (alg=none) tokens', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, iss: config.jwtIssuer, aud: config.jwtAudience, exp: 9999999999 }),
    ).toString('base64url');
    assert.equal(verifyCode(`${header}.${payload}.`), 'INVALID_TOKEN');
  });

  it('rejects tokens without exp or with a non-UUID subject', () => {
    assert.equal(verifyCode(sign({}, { expiresIn: undefined })), 'INVALID_TOKEN');
    assert.equal(verifyCode(sign({}, { subject: 'admin' })), 'INVALID_TOKEN');
  });
});
