import { describe, expect, it } from 'vitest';
import {
  decryptText,
  digestText,
  encryptText,
  generateOpenAiStyleApiKey,
  hashValue,
  maskSecret,
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

  it('generates OpenAI-style API keys', () => {
    const key = generateOpenAiStyleApiKey();
    expect(key).toMatch(/^sk-[A-Za-z0-9_-]+$/);
    expect(key.length).toBeGreaterThan(40);
    expect(key.slice(0, 3)).toBe('sk-');
  });
});
