import { expect, it } from 'vitest';
import { initialAdminIdentities } from '../../src/storage/initial-admins.js';
it('accepts only explicit unique identities for selected initial administrators', () => {
  expect(
    initialAdminIdentities(
      '[{"username":"admin","localId":"synthetic-new-model-admin"}]',
      ['admin'],
    ).get('admin'),
  ).toBe('synthetic-new-model-admin');
  for (const value of [
    [
      { username: 'admin', localId: 'synthetic-new-model-admin' },
      { username: 'admin', localId: 'synthetic-other-model-admin' },
    ],
    [
      { username: 'admin', localId: 'synthetic-new-model-admin' },
      { username: 'other', localId: 'synthetic-new-model-admin' },
    ],
    [{ username: 'unknown', localId: 'synthetic-new-model-admin' }],
    [
      {
        username: 'admin',
        localId: 'synthetic-new-model-admin',
        email: 'alice@example.com',
      },
    ],
  ])
    expect(() =>
      initialAdminIdentities(JSON.stringify(value), ['admin', 'other']),
    ).toThrow();
});
