import type { AdminUser } from '../generated/prisma/client.js';
import { SignJWT, jwtVerify } from 'jose';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { randomUUID } from 'node:crypto';
import { configuredOathweaveVerifier, linkedLocalId, parseAccountLinks } from './admin-identity.js';
import { loadEnv } from '../config/env.js';
import { expandAdminPermissions } from './admin-permissions.js';
import { authenticateIamOidcUser } from './iam-oidc.js';
import { EXTERNALLY_MANAGED_PASSWORD_HASH, authenticateOsUser, isAllowedAdminUser } from './os-auth.js';
import { prisma } from '../storage/client.js';
import type { AppVariables } from '../types/app.js';

const SESSION_COOKIE = 'hive_router_admin';
const SESSION_TTL_SECONDS = 60 * 60 * 24;

export interface AuthenticatedAdmin {
  user: AdminUser;
  roles: string[];
  permissions: string[];
  authMode: 'os' | 'iam-oidc';
  /** The IAM user id (`sub`) behind an iam-oidc session; IAM uses it to check the acting person. */
  iamSubject?: string;
  sessionId?: string;
  authenticatedAt?: number;
  /** Direct resource credentials cannot invoke retained suite proxy/coordinator APIs. */
  resourceAuthorization?: boolean;
}

function getJwtSecret(): Uint8Array {
  return new TextEncoder().encode(loadEnv().HIVE_ROUTER_SECRET);
}


export async function createAdminSession(principal: AuthenticatedAdmin, context: Context<{ Variables: AppVariables }>): Promise<void> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await prisma.adminSession.create({
    data: {
      sessionId,
      userId: principal.user.id,
      expiresAt,
      ipAddress: (() => {
        try {
          return getConnInfo(context).remote.address ?? null;
        } catch {
          return null;
        }
      })(),
      userAgent: context.req.header('user-agent') ?? null,
    },
  });

  const permissions = expandAdminPermissions(principal.authMode, principal.roles, principal.permissions);
  const token = await new SignJWT({ sid: sessionId, username: principal.user.username, roles: principal.roles, permissions, authMode: principal.authMode, ...(principal.iamSubject ? { iamSub: principal.iamSubject } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(principal.user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getJwtSecret());

  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: loadEnv().NODE_ENV !== 'development',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroyAdminSession(context: Context<{ Variables: AppVariables }>): Promise<void> {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) {
    try {
      const verified = await jwtVerify(token, getJwtSecret());
      const sessionId = typeof verified.payload.sid === 'string' ? verified.payload.sid : null;
      if (sessionId) {
        await prisma.adminSession.updateMany({
          where: { sessionId },
          data: { revokedAt: new Date() },
        });
      }
    } catch {
      // Ignore invalid cookies during logout.
    }
  }

  deleteCookie(context, SESSION_COOKIE, { path: '/' });
}

export async function authenticateAdmin(
  username: string,
  password: string,
): Promise<AuthenticatedAdmin | null> {
  const env = loadEnv();
  if (env.HIVE_ROUTER_AUTH_MODE === 'iam-oidc') {
    const iamUser = await authenticateIamOidcUser(username, password, env);
    if (!iamUser || !isAllowedAdminUser(iamUser.username)) {
      return null;
    }

    const user = await prisma.adminUser.upsert({
      where: { username: iamUser.username },
      update: {
        displayName: iamUser.displayName,
      },
      create: {
        username: iamUser.username,
        displayName: iamUser.displayName,
        passwordHash: EXTERNALLY_MANAGED_PASSWORD_HASH,
      },
    });
    return {
      user,
      roles: iamUser.roles,
      permissions: expandAdminPermissions('iam-oidc', iamUser.roles, iamUser.permissions),
      authMode: 'iam-oidc',
      iamSubject: iamUser.subject,
    };
  }

  if (!(await authenticateOsUser(username, password))) {
    return null;
  }

  const user = await prisma.adminUser.upsert({
    where: { username },
    update: {
      displayName: username,
    },
    create: {
      username,
      displayName: username,
      passwordHash: EXTERNALLY_MANAGED_PASSWORD_HASH,
    },
  });
  return {
    user,
    roles: ['router-admin'],
    permissions: ['*'],
    authMode: 'os',
  };
}

export async function requireAdminAuth(
  context: Context<{ Variables: AppVariables }>,
  next: Next,
): Promise<Response | void> {
  const user = await verifyAdminSession(context);
  if (!user) {
    return context.json({ error: 'Unauthorized' }, 401);
  }
  if (user.resourceAuthorization && context.req.path.startsWith('/api-docs/')) {
    return context.json({ error: 'PRODUCT_API_REQUIRED', message: 'Use the permission-protected /api/docs routes.' }, 403);
  }

  context.set('adminUser', user.user);
  context.set('adminRoles', user.roles);
  context.set('adminPermissions', user.permissions);
  await next();
}

export async function verifyAdminSession(
  context: Context<{ Variables: AppVariables }>,
): Promise<AuthenticatedAdmin | null> {
  const authorization = context.req.header('authorization');
  if (authorization) {
    try {
      if (!authorization.startsWith('Bearer ')) return null;
      const verify = configuredOathweaveVerifier();
      if (!verify) return null;
      const identity = await verify(authorization.slice(7));
      const localId=linkedLocalId(parseAccountLinks(process.env.EMBERPATH_OATHWEAVE_IDENTITIES_JSON??'[]'),identity);
      const user=await prisma.adminUser.findUnique({where:{id:localId}});
      if(!user)return null;
      return {user,roles:identity.roles,permissions:identity.permissions,authMode:'iam-oidc',iamSubject:identity.subject,resourceAuthorization:true,
        sessionId:identity.sessionId,...(identity.authenticatedAt!==undefined?{authenticatedAt:identity.authenticatedAt}:{})};
    } catch { return null; }
  }
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) {
    return null;
  }

  try {
    const verified = await jwtVerify(token, getJwtSecret());
    const sessionId = typeof verified.payload.sid === 'string' ? verified.payload.sid : null;
    const userId = typeof verified.payload.sub === 'string' ? verified.payload.sub : null;
    if (!sessionId || !userId) {
      return null;
    }

    const session = await prisma.adminSession.findFirst({
      where: {
        sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!session) {
      return null;
    }

    const roles = Array.isArray(verified.payload.roles) ? verified.payload.roles.filter((role): role is string => typeof role === 'string') : [];
    const permissions = Array.isArray(verified.payload.permissions) ? verified.payload.permissions.filter((permission): permission is string => typeof permission === 'string') : [];
    const authMode = verified.payload.authMode === 'iam-oidc' ? 'iam-oidc' : 'os';
    const iamSubject = authMode === 'iam-oidc' && typeof verified.payload.iamSub === 'string' ? verified.payload.iamSub : undefined;
    return {
      user: session.user,
      sessionId,
      authenticatedAt: session.createdAt.getTime(),
      roles,
      permissions: expandAdminPermissions(authMode, roles, permissions),
      authMode,
      ...(iamSubject ? { iamSubject } : {}),
    };
  } catch {
    return null;
  }
}
