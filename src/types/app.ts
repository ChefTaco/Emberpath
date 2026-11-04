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
  clientApiKey?: ClientApiKey;
  traceContext?: TraceRuntimeContext;
}
