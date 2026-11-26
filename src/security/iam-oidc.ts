import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { loadEnv } from '../config/env.js';
import { iamTlsOptions } from './iam-tls.js';

const iamLoginSchema = z.object({
  accessToken: z.string().optional(),
  requiresMfa: z.boolean().optional(),
  mfaToken: z.string().optional(),
  methods: z.array(z.string()).optional(),
  passwordExpired: z.boolean().optional(),
  user: z.object({
    roles: z.array(z.string()).optional(),
    permissions: z.array(z.string()).optional(),
  }).optional(),
});

const oauthTokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const userInfoSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
  name: z.string().optional(),
  roles: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
});

export interface IamOidcUser {
  subject: string;
  username: string;
  email?: string;
  displayName: string;
  roles: string[];
  permissions: string[];
}

/** Oathweave accepted the password but the account needs a second factor. */
export interface IamMfaRequired {
  mfaRequired: true;
  /** Second factors the account has, as Oathweave reports them (`totp`, `webauthn`). */
  methods: string[];
}

export interface IamSignInOptions {
  /** A TOTP or recovery code, for accounts with multi-factor authentication. */
  mfaCode?: string | undefined;
  /**
   * The signing-in client's address. It is sent as `X-Forwarded-For`, which Oathweave only
   * honours when Emberpath's address is in its `TRUSTED_PROXY_IPS`; then Oathweave's per-address
   * sign-in limits apply to each client instead of to Emberpath as a whole.
   */
  clientIp?: string | undefined;
}

interface HttpResult {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ''), `${baseUrl.replace(/\/$/, '')}/`);
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function readBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      if (raw.length < 1024 * 1024) raw += chunk;
    });
    response.on('end', () => resolve(raw));
  });
}

function requestUrl(url: URL, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  env: Env;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const handleResponse = async (response: IncomingMessage) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: await readBody(response),
      });
    };

    const request = url.protocol === 'https:'
      ? httpsRequest(url, {
          method: options.method ?? 'GET',
          headers: options.headers,
          ...iamTlsOptions(url, options.env),
        }, handleResponse)
      : httpRequest(url, { method: options.method ?? 'GET', headers: options.headers }, handleResponse);

    request.setTimeout(15_000, () => request.destroy(new Error('IAM OIDC request timed out')));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function parseJson<T>(schema: z.ZodType<T>, response: HttpResult): T | null {
  if (response.status < 200 || response.status >= 300 || !response.body) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function forwardedFor(clientIp: string | undefined): Record<string, string> {
  const address = clientIp?.startsWith('::ffff:') && isIP(clientIp.slice(7)) === 4 ? clientIp.slice(7) : clientIp;
  return address && isIP(address) ? { 'x-forwarded-for': address } : {};
}

/**
 * End an Oathweave session this sign-in opened. Emberpath keeps its own admin session, so
 * leaving the Oathweave ones open would only leave long-lived sessions nobody uses.
 */
async function revokeIamSession(accessToken: string, env: Env): Promise<void> {
  try {
    await requestUrl(endpoint(env.HIVE_IAM_INTERNAL_URL, '/api/v1/auth/logout'), {
      method: 'POST',
      env,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // Best effort: the session still expires on its own.
  }
}

export async function authenticateIamOidcUser(
  username: string,
  password: string,
  env: Env = loadEnv(),
  options: IamSignInOptions = {},
): Promise<IamOidcUser | IamMfaRequired | null> {
  const clientSecret = env.HIVE_ROUTER_IAM_CLIENT_SECRET;
  if (!username || !password || !clientSecret) return null;

  const clientHeaders = forwardedFor(options.clientIp);
  const login = await requestUrl(endpoint(env.HIVE_IAM_INTERNAL_URL, '/api/v1/auth/login'), {
    method: 'POST',
    env,
    headers: { 'content-type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ username, password }),
  });
  if (login.status === 401 || login.status === 403) return null;
  let loginBody = parseJson(iamLoginSchema, login);
  if (loginBody?.requiresMfa) {
    if (!loginBody.mfaToken) return null;
    if (!options.mfaCode) return { mfaRequired: true, methods: loginBody.methods ?? [] };
    const challenge = await requestUrl(endpoint(env.HIVE_IAM_INTERNAL_URL, '/api/v1/auth/mfa/challenge'), {
      method: 'POST',
      env,
      headers: { 'content-type': 'application/json', ...clientHeaders },
      body: JSON.stringify({ mfaToken: loginBody.mfaToken, code: options.mfaCode }),
    });
    loginBody = parseJson(iamLoginSchema, challenge);
  }
  if (!loginBody?.accessToken || loginBody.requiresMfa || loginBody.passwordExpired) return null;

  const loginAccessToken = loginBody.accessToken;
  try {
    return await completeCodeFlow(loginAccessToken, clientSecret, username, loginBody, env);
  } finally {
    await revokeIamSession(loginAccessToken, env);
  }
}

async function completeCodeFlow(
  loginAccessToken: string,
  clientSecret: string,
  username: string,
  loginBody: z.infer<typeof iamLoginSchema>,
  env: Env,
): Promise<IamOidcUser | null> {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const authorizeUrl = endpoint(env.HIVE_IAM_INTERNAL_URL, '/api/v1/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', env.HIVE_ROUTER_IAM_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', env.HIVE_ROUTER_IAM_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', env.HIVE_ROUTER_IAM_SCOPES);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challengeFor(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const authorize = await requestUrl(authorizeUrl, {
    env,
    headers: { authorization: `Bearer ${loginAccessToken}` },
  });

  if (authorize.status !== 302 || !authorize.headers.location) return null;
  const redirect = new URL(authorize.headers.location, env.HIVE_ROUTER_IAM_REDIRECT_URI);
  if (redirect.searchParams.get('state') !== state) return null;
  const code = redirect.searchParams.get('code');
  if (!code) return null;

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.HIVE_ROUTER_IAM_REDIRECT_URI,
    client_id: env.HIVE_ROUTER_IAM_CLIENT_ID,
    client_secret: clientSecret,
    code_verifier: verifier,
  });
  const token = await requestUrl(endpoint(env.HIVE_IAM_INTERNAL_URL, '/api/v1/oauth/token'), {
    method: 'POST',
    env,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const tokenBody = parseJson(oauthTokenSchema, token);
  if (!tokenBody?.access_token) return null;

  const userInfo = await requestUrl(endpoint(env.HIVE_IAM_INTERNAL_URL, '/api/v1/oauth/userinfo'), {
    env,
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  });
  await revokeIamSession(tokenBody.access_token, env);
  const user = parseJson(userInfoSchema, userInfo);
  if (!user) return null;

  const iamUsername = user.preferred_username ?? user.email ?? username;
  return {
    subject: user.sub,
    username: iamUsername,
    displayName: user.name ?? iamUsername,
    roles: user.roles ?? loginBody.user?.roles ?? [],
    permissions: user.permissions ?? loginBody.user?.permissions ?? [],
    ...(user.email ? { email: user.email } : {}),
  };
}
