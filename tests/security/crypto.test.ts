import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptText,
  digestText,
  encryptText,
  generateOpenAiStyleApiKey,
  hashValue,
  maskSecret,
  safeEqualText,
  verifyHash,
} from '../../src/security/crypto.js';

describe('security/crypto', () => {
  it('hashes values and verifies the original input', () => {
    const hash = hashValue('router-key');

    expect(hash).toContain(':');
    expect(verifyHash('router-key', hash)).toBe(true);
    expect(verifyHash('wrong-key', hash)).toBe(false);
  });

  it('encrypts and decrypts provider secrets', () => {
    const cipherText = encryptText('sk-test-secret');

    expect(cipherText).not.toContain('sk-test-secret');
    expect(decryptText(cipherText)).toBe('sk-test-secret');
  });

  it('masks secrets without losing the edges', () => {
    expect(maskSecret('abcdefgh12345678')).toBe('abcd********5678');
    expect(maskSecret('short')).toBe('*****');
    expect(maskSecret(null)).toBeNull();
  });

  it('produces stable digests', () => {
    expect(digestText('same-value')).toBe(digestText('same-value'));
    expect(digestText('same-value')).not.toBe(digestText('different-value'));
  });

  it('keeps the digest format through the shared helper: SHA-256 of UTF-8 text as lowercase hex', () => {
    // Stored request hashes, operation IDs and routing revisions depend on these exact bytes.
    expect(digestText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(digestText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digestText('é')).toBe(createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex'));
    expect(digestText(JSON.stringify({ b: 1, a: [2] }))).toBe(createHash('sha256').update('{"b":1,"a":[2]}').digest('hex'));
  });

  it('compares secrets as before: equal only for the same bytes, unequal for any other length', () => {
    expect(safeEqualText('metrics-token', 'metrics-token')).toBe(true);
    expect(safeEqualText('metrics-token', 'metrics-tokeN')).toBe(false);
    expect(safeEqualText('metrics-token', 'metrics-token-longer')).toBe(false);
    expect(safeEqualText('metrics-token', 'metrics-toke')).toBe(false);
    expect(safeEqualText('', '')).toBe(true);
    expect(safeEqualText('', 'x')).toBe(false);
    // Byte length, not string length: 'é' is two bytes in UTF-8.
    expect(safeEqualText('é', 'e')).toBe(false);
    expect(safeEqualText('é', 'é')).toBe(true);
  });

  it('generates OpenAI-style API keys', () => {
    const key = generateOpenAiStyleApiKey();
    expect(key).toMatch(/^sk-[A-Za-z0-9_-]+$/);
    expect(key.length).toBeGreaterThan(40);
    expect(key.slice(0, 3)).toBe('sk-');
  });
});
