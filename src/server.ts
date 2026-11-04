import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { serve, type ServerType } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { prisma } from './storage/client.js';
import { routerMigration } from './upgrade.js';
import { bootstrapStorage } from './storage/bootstrap.js';
import { syncBuiltinApiDocs } from './storage/api-docs.js';
import { createApiApp } from './api/app.js';
import { createAdminApp } from './admin/app.js';
import { runProviderHealthSweep } from './providers/health.js';
import { log } from './telemetry/logger.js';
import { startTraceRetention } from './telemetry/retention.js';

/** A listener failure the operator can fix (port in use, privileged port). */
export class ListenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListenError';
  }
}

function describeListenError(plane: string, variable: string, host: string, port: number, error: NodeJS.ErrnoException): string {
  if (error.code === 'EADDRINUSE') {
    return `${plane} port ${port} on ${host} is already in use. Stop the other process or set ${variable} to a free port.`;
  }
  if (error.code === 'EACCES') {
    return `${plane} cannot listen on ${host}:${port}: permission denied. Ports below 1024 need root or CAP_NET_BIND_SERVICE; set ${variable} to a port of 1024 or above.`;
  }
  if (error.code === 'EADDRNOTAVAIL') {
    return `${plane} cannot listen on ${host}:${port}: the address is not available on this machine. Fix the bind address (HOST, API_HOST or ADMIN_HOST).`;
  }
  return `${plane} failed to listen on ${host}:${port}: ${error.message}`;
}

function listen(
  plane: string,
  variable: string,
  options: Parameters<typeof serve>[0],
  host: string,
  port: number,
  onListening: (port: number) => void,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve(options, (info) => {
      onListening(info.port);
      resolve(server);
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(new ListenError(describeListenError(plane, variable, host, port, error)));
    });
  });
}

export async function startServer(): Promise<void> {
  (await import('./release/runtime.js')).startUpdateChecks((await import('./config/paths.js')).packageInfo().version);
  const env = loadEnv();

  await routerMigration([], true);
  await prisma.$connect();
  await bootstrapStorage();
  await syncBuiltinApiDocs(env.PUBLIC_ADMIN_URL);

  const apiApp = createApiApp();
  const adminApp = createAdminApp();

  // loadEnv() has already verified that both files exist when either is set.
  const useTls = Boolean(env.TLS_CERT_PATH && env.TLS_KEY_PATH);

  const tlsOptions = useTls
    ? {
        createServer,
        serverOptions: {
          cert: readFileSync(env.TLS_CERT_PATH!),
          key: readFileSync(env.TLS_KEY_PATH!),
        },
      }
    : {};

  const apiServer = await listen(
    'API plane',
    'API_PORT',
    { fetch: apiApp.fetch, hostname: env.API_HOST, port: env.API_PORT, ...tlsOptions },
    env.API_HOST,
    env.API_PORT,
    (port) => {
      log('info', 'API plane listening', useTls
        ? { host: env.API_HOST, url: `${env.PUBLIC_API_URL}`, port, tls: true }
        : { host: env.API_HOST, url: `http://${env.API_HOST}:${port}`, port, tls: false });
    },
  );

  const adminServer = await listen(
    'Admin plane',
    'ADMIN_PORT',
    { fetch: adminApp.fetch, hostname: env.ADMIN_HOST, port: env.ADMIN_PORT, ...tlsOptions },
    env.ADMIN_HOST,
    env.ADMIN_PORT,
    (port) => {
      log('info', 'Admin plane listening', useTls
        ? { host: env.ADMIN_HOST, url: `${env.PUBLIC_ADMIN_URL}`, port, tls: true }
        : { host: env.ADMIN_HOST, url: `http://${env.ADMIN_HOST}:${port}`, port, tls: false });
    },
  ).catch((error: unknown) => {
    apiServer.close();
    throw error;
  });

  await runProviderHealthSweep();
  const healthInterval = setInterval(() => {
    void runProviderHealthSweep().catch((error) => {
      log('error', 'Provider health sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 30_000);
  const traceRetentionInterval = startTraceRetention();

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(healthInterval);
    clearInterval(traceRetentionInterval);
    log('info', 'Shutting down hive-router', { signal });
    await Promise.all([apiServer, adminServer].map((server) => new Promise<void>((done) => server.close(() => done()))));
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
