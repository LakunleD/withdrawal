import { randomInt } from 'node:crypto';

/** Uppercase letters and digits without the visually ambiguous 0/O, 1/I/L. */
export const AUTHORISATION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const AUTHORISATION_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

/**
 * Generates a human-readable code such as `A7Q2-9WXK` using a CSPRNG
 * (crypto.randomInt is unbiased). 31^8 ≈ 8.5e11 possibilities; uniqueness is
 * still enforced by a database constraint with bounded retries on collision.
 */
export function generateAuthorisationCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += AUTHORISATION_CODE_ALPHABET[randomInt(AUTHORISATION_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
