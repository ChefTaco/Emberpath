import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../config/env.js';

// scrypt is deliberately slow and synchronous. Provider secrets are decrypted on
// every inference request, so the derived key is kept for the current secret
// instead of blocking the event loop once per provider per request.
let derivedKey: { secret: string; key: Buffer } | undefined;

function getEncryptionKey(): Buffer {
  const secret = loadEnv().HIVE_ROUTER_SECRET;
  if (derivedKey?.secret !== secret) {
    derivedKey = { secret, key: scryptSync(secret, 'hive-router-envelope', 32) };
  }
  return derivedKey.key;
}

export function hashValue(value: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(value, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function generateOpenAiStyleApiKey(): string {
  const random = randomBytes(36).toString('base64url');
  return `sk-${random}`;
}

export function verifyHash(value: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) {
    return false;
  }

  const derived = scryptSync(value, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** `verifyHash` with the derivation on the thread pool, for request paths. */
export async function verifyHashAsync(value: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) {
    return false;
  }

  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(value, salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
  });
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function encryptText(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptText(cipherText: string): string {
  const [ivHex, tagHex, payloadHex] = cipherText.split(':');
  if (!ivHex || !tagHex || !payloadHex) {
    throw new Error('Invalid encrypted payload');
  }

  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payloadHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }

  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

export function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
