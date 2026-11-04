import { describe, expect, it } from 'vitest';
import {
  parseAccountLinks,
  linkedLocalId,
} from '../../src/security/account-links.js';
describe('explicit product identity links', () => {
  const identity = {
    issuer: 'https://identity.example.com',
    subject: 'fake-user',
  };
  it('retains the reviewed existing ID and rejects unlinked subjects or issuers', () => {
    const links = parseAccountLinks(
      JSON.stringify([{ ...identity, localId: 'existing-product-id' }]),
    );
    expect(linkedLocalId(links, identity)).toBe('existing-product-id');
    expect(() =>
      linkedLocalId(links, { ...identity, subject: 'other-user' }),
    ).toThrow();
    expect(() =>
      linkedLocalId(links, {
        ...identity,
        issuer: 'https://other.example.com',
      }),
    ).toThrow();
    expect(() => linkedLocalId([], identity)).toThrow();
  });
  it('rejects duplicate links and email-based mapping fields', () => {
    const row = { ...identity, localId: 'existing-product-id' };
    expect(() =>
      parseAccountLinks(JSON.stringify([row, { ...row, localId: 'other-id' }])),
    ).toThrow();
    expect(() =>
      parseAccountLinks(
        JSON.stringify([{ ...row, email: 'alice@example.com' }]),
      ),
    ).toThrow();
  });
});
