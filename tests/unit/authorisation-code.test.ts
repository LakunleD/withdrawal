import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTHORISATION_CODE_ALPHABET,
  AUTHORISATION_CODE_PATTERN,
  generateAuthorisationCode,
} from '../../src/modules/withdrawals/authorisation-code';

describe('generateAuthorisationCode', () => {
  it('produces XXXX-XXXX codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateAuthorisationCode();
      assert.match(code, AUTHORISATION_CODE_PATTERN);
      assert.doesNotMatch(code, /[01OIL]/);
    }
  });

  it('alphabet excludes visually ambiguous characters', () => {
    for (const ch of '01OIL') assert.ok(!AUTHORISATION_CODE_ALPHABET.includes(ch), `alphabet contains ${ch}`);
    assert.equal(new Set(AUTHORISATION_CODE_ALPHABET).size, AUTHORISATION_CODE_ALPHABET.length);
  });

  it('does not use Math.random', (t) => {
    t.mock.method(Math, 'random', () => {
      throw new Error('Math.random must not be used');
    });
    assert.match(generateAuthorisationCode(), AUTHORISATION_CODE_PATTERN);
  });

  it('is effectively unique across many generations', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20000; i++) codes.add(generateAuthorisationCode());
    // 31^8 possibilities: a collision in 20k draws has probability ~2e-4.
    assert.ok(codes.size >= 19999);
  });

  it('uses every alphabet character (no obvious bias)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const ch of generateAuthorisationCode().replace('-', '')) seen.add(ch);
    assert.equal(seen.size, AUTHORISATION_CODE_ALPHABET.length);
  });
});
