import type { AdminUser, ClientApiKey } from '../generated/prisma/client.js';

export interface TraceRuntimeContext {
  traceId: string;
  requestId: string;
}

export interface AppVariables {
  requestId: string;
  adminUser?: AdminUser;
  adminRoles?: string[];
  adminPermissions?: string[];
  /** The verified admin principal of this request, set by the admin API's auth middleware. */
  adminPrincipal?: import('../security/admin-auth.js').AuthenticatedAdmin;
  clientApiKey?: ClientApiKey;
  traceContext?: TraceRuntimeContext;
}
