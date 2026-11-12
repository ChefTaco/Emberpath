/**
 * Oathweave bearer access to the admin API, through the suite's shared verifier.
 *
 * Emberpath accepts people only (user tokens with audience `emberpath`), confirms the
 * identity session online on every request, and maps each identity to an existing admin
 * account through an explicit link in EMBERPATH_OATHWEAVE_IDENTITIES_JSON.
 */
import {
  createOathweaveVerifier as createSharedOathweaveVerifier,
  OathweaveError,
  parseIdentityLinks,
  requireIdentityLink,
  type OathweaveIdentityLink,
  type OathweaveVerifierOptions,
} from '@hivemagnus/hive-common/oathweave';

export interface OathweaveOptions {
  issuer: string;
  jwksUrl: string;
  userinfoUrl: string;
  audience: string;
}
export interface OathweaveIdentity {
  subject: string;
  issuer: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  displayName: string;
  /** Epoch milliseconds, as before. */
  authenticatedAt?: number;
}
export type OathweaveVerify = (token: string) => Promise<OathweaveIdentity>;

/** Resource JWT validation plus online session revocation. Failure is closed. */
export function createOathweaveVerifier(
  options: OathweaveOptions,
  overrides: Pick<OathweaveVerifierOptions, 'keys' | 'fetch' | 'now'> = {},
): OathweaveVerify {
  const verifier = createSharedOathweaveVerifier({
    issuer: options.issuer,
    audience: options.audience,
    jwksUrl: options.jwksUrl,
    userinfoUrl: options.userinfoUrl,
    accept: 'user',
    // Emberpath has never tolerated clock skew on resource tokens.
    clockToleranceSec: 0,
    // Confirm the identity session online on every request, so sign-out is immediate.
    sessionCacheTtlMs: 0,
    ...overrides,
  });
  return async (token) => {
    const principal = await verifier.verifyUser(token);
    // Emberpath requires the Oathweave `clientId` and `roles` claims to be present.
    if (typeof principal.claims['clientId'] !== 'string' || !Array.isArray(principal.claims['roles']))
      throw new OathweaveError('invalid_claims');
    return {
      subject: principal.subject,
      issuer: principal.issuer,
      sessionId: principal.sessionId,
      permissions: [...principal.permissions],
      roles: [...principal.roles],
      displayName: principal.displayName,
      ...(principal.authTime !== undefined ? { authenticatedAt: principal.authTime * 1000 } : {}),
    };
  };
}

let verifier: OathweaveVerify | undefined;
export function configuredOathweaveVerifier(): OathweaveVerify | undefined {
  if (!process.env.OATHWEAVE_ISSUER && !process.env.OATHWEAVE_JWKS_URL && !process.env.OATHWEAVE_USERINFO_URL)
    return undefined;
  if (!verifier) {
    if (!process.env.OATHWEAVE_ISSUER || !process.env.OATHWEAVE_JWKS_URL || !process.env.OATHWEAVE_USERINFO_URL)
      throw new Error('Oathweave configuration is incomplete');
    verifier = createOathweaveVerifier({
      issuer: process.env.OATHWEAVE_ISSUER,
      jwksUrl: process.env.OATHWEAVE_JWKS_URL,
      userinfoUrl: process.env.OATHWEAVE_USERINFO_URL,
      audience: 'emberpath',
    });
  }
  return verifier;
}

const LINK_FIELDS = new Set(['issuer', 'subject', 'localId']);

/**
 * Parse EMBERPATH_OATHWEAVE_IDENTITIES_JSON: `[{ issuer, subject, localId }]`, where `localId`
 * is the existing admin account ID. Unknown fields and duplicate identities are refused.
 */
export function parseAccountLinks(raw: string): OathweaveIdentityLink[] {
  const json: unknown = JSON.parse(raw);
  if (!Array.isArray(json)) throw new Error('Account links must be a JSON array');
  const renamed = json.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each account link must be an object');
    const { localId, ...rest } = item as Record<string, unknown>;
    for (const key of Object.keys(item)) if (!LINK_FIELDS.has(key)) throw new Error('Account links accept only issuer, subject and localId');
    return { ...rest, localUserId: localId };
  });
  return parseIdentityLinks(renamed);
}

/** The admin account ID linked to a verified identity. Throws unless exactly one link matches. */
export function linkedLocalId(links: readonly OathweaveIdentityLink[], identity: { issuer: string; subject: string }): string {
  return requireIdentityLink(links, identity).localUserId;
}
