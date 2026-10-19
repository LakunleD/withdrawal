import { validationError } from '../../utils/errors';
import { isPlainObject } from '../../utils/validation';

export interface Credentials {
  email: string;
  password: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt silently ignores input beyond 72 bytes, so longer passwords are rejected outright.
const MAX_PASSWORD_BYTES = 72;

function parseShape(body: unknown): { email: string; password: string } {
  if (!isPlainObject(body)) throw validationError('Request body must be a JSON object.');
  const { email, password } = body;
  if (typeof email !== 'string' || email.trim() === '') throw validationError('email is required.');
  if (typeof password !== 'string' || password === '') throw validationError('password is required.');
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw validationError(`password must be at most ${MAX_PASSWORD_BYTES} bytes.`);
  }
  return { email: email.trim().toLowerCase(), password };
}

export function parseRegisterRequest(body: unknown): Credentials {
  const credentials = parseShape(body);
  if (credentials.email.length > 254 || !EMAIL_PATTERN.test(credentials.email)) {
    throw validationError('email must be a valid email address.');
  }
  if (credentials.password.length < MIN_PASSWORD_LENGTH) {
    throw validationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return credentials;
}

export function parseLoginRequest(body: unknown): Credentials {
  return parseShape(body);
}
