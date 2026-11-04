import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { activeDirectory, installedPackage, readProject } from './project.js';
import { hash, json, privateDir, writeJson } from './files.js';
import {
  planUpgrade,
  upgrade,
  rollback,
  upgradeOptionsSchema,
  type Transaction,
} from './engine.js';
import { scheduledUpgrade, startUpdateChecks, updateStatus } from './updates.js';
import { ComposeController } from './compose.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { atomic } from './files.js';
import { durableUpgradeStatus } from './status.js';

export async function coordinatorRequest(
  root: string,
  action: 'plan' | 'apply' | 'status' | 'admit' | 'local',
  body: unknown = {},
): Promise<unknown> {
  return new Promise((yes, no) => {
    const req = httpRequest(
      {
        socketPath: process.env.HIVE_COORDINATOR_SOCKET || join(root, 'run/coordinator.sock'),
        path: `/${action}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(action === 'local'
            ? {
                authorization: `Bearer ${readFileSync(join(root, 'config/owner-upgrade.key'), 'utf8').trim()}`,
              }
            : {}),
        },
        timeout: action === 'local' ? 3_720_000 : 20_000,
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c;
          if (text.length > 2 * 1024 * 1024) res.destroy();
        });
        res.once('end', () => {
          try {
            const value = JSON.parse(text);
            if (res.statusCode !== 200 && res.statusCode !== 202)
              throw new Error(value.error || 'Coordinator refused request');
            yes(value);
          } catch (e) {
            no(e);
          }
        });
      },
    );
    req.once('error', no);
    req.once('timeout', () => req.destroy(new Error('Coordinator request timed out')));
    req.end(JSON.stringify(body));
  });
}
export async function serveCoordinator(root: string): Promise<void> {
  if (
    process.env.HIVE_AUTO_UPGRADE === 'true' &&
    (!process.env.HIVE_AUTO_UPGRADE_WINDOW || !process.env.HIVE_AUTO_UPGRADE_TIMEZONE)
  )
    throw new Error('Unattended upgrades require an explicit daily window and IANA timezone');
  const project = readProject(root);
  const socket = join(root, 'run/coordinator.sock');
  privateDir(join(root, 'run'));
  if (existsSync(socket)) {
    try {
      await coordinatorRequest(root, 'status');
      throw new Error('Coordinator is already running');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw e;
      unlinkSync(socket);
    }
  }
  const compose = project.manager === 'compose' ? new ComposeController(root) : undefined;
  const ownerKeyFile = join(root, 'config/owner-upgrade.key');
  if (!existsSync(ownerKeyFile)) atomic(ownerKeyFile, randomBytes(32).toString('hex'));
  const ownerKey = readFileSync(ownerKeyFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(ownerKey)) throw new Error('Invalid owner coordinator capability');
  const stopUpdateChecks = startUpdateChecks(
    installedPackage(activeDirectory(root), '@hivemagnus/hive').version,
    root,
    true,
  );
  let busy = false;
  let last: unknown = existsSync(join(root, 'run/coordinator-result.json'))
    ? json(join(root, 'run/coordinator-result.json'))
    : { state: 'idle' };
  const plans = new Map<string, { to: string; expires: number }>();
  const server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (
        req.method !== 'POST' ||
        !['/plan', '/apply', '/status', '/admit', '/local'].includes(req.url || '')
      )
        return send(404, { error: 'Unknown operation' });
      let bytes = '';
      for await (const chunk of req) {
        bytes += chunk;
        if (bytes.length > 8192) return send(413, { error: 'Request too large' });
      }
      const input: unknown = JSON.parse(bytes || '{}');
      if (req.url === '/admit') {
        if (!compose) return send(403, { error: 'Not a managed Compose installation' });
        return send(200, await compose.admit(input));
      }
      if (req.url === '/local') {
        const authorization = Buffer.from(req.headers.authorization || '');
        const expected = Buffer.from(`Bearer ${ownerKey}`);
        if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected))
          return send(403, { error: 'Owner CLI capability required' });
        if (!compose) return send(403, { error: 'Local Compose control is unavailable' });
        if (busy || compose.busy()) return send(409, { error: 'An upgrade is already running' });
        const body = z
          .object({
            command: z.enum(['upgrade', 'rollback']),
            options: z.record(z.string(), z.unknown()),
          })
          .strict()
          .parse(input);
        busy = true;
        try {
          if (body.command === 'upgrade') {
            const options = upgradeOptionsSchema.parse(body.options);
            return send(200, await upgrade(root, options, compose.adapter()));
          }
          const options = z
            .object({
              to: z.string().optional(),
              transaction: z.uuid().optional(),
              restoreData: z.boolean().optional(),
              confirmRestore: z.string().optional(),
              containmentReviewed: z.string().optional(),
            })
            .strict()
            .parse(body.options);
          return send(200, await rollback(root, options, compose.adapter()));
        } finally {
          busy = false;
        }
      }
      if (req.url === '/status') {
        z.object({}).strict().parse(input);
        const unfinished = readdirSync(join(root, 'run'))
          .filter((f) => /^transaction-.*\.json$/.test(f))
          .map((f) => json<Transaction>(join(root, 'run', f)))
          .find((t) => !t.completedAt);
        return send(200, {
          busy: Boolean(busy || compose?.busy()),
          result: unfinished
            ? {
                state: unfinished.phase,
                transaction: unfinished.id,
                version: unfinished.to,
                from: unfinished.from,
                to: unfinished.to,
                error: unfinished.error,
                restoreCommand: unfinished.restoreCommand,
              }
            : compose?.busy()
              ? compose.status()
              : busy
                ? last
                : durableUpgradeStatus(root),
          updates: await updateStatus(
            installedPackage(activeDirectory(root), '@hivemagnus/hive').version,
            root,
          ),
        });
      }
      if (process.env.HIVE_UI_UPGRADE !== 'true')
        return send(403, { error: 'HIVE_UI_UPGRADE is disabled; use hive upgrade locally' });
      if (req.url === '/plan') {
        const { to } = z
          .object({
            to: z
              .string()
              .regex(/^\d+\.\d+\.\d+$/)
              .optional(),
          })
          .strict()
          .parse(input);
        const plan = await planUpgrade(root, { ...(to ? { to } : {}), dryRun: true });
        plans.set(plan.hash, { to: plan.target.version, expires: Date.now() + 300_000 });
        return send(200, plan);
      }
      const { planHash } = z
        .object({ planHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(input);
      const saved = plans.get(planHash);
      if (busy || !saved || saved.expires < Date.now())
        return send(409, { error: 'Busy, expired or unknown plan; prepare a new plan' });
      const current = await planUpgrade(root, { to: saved.to, dryRun: true });
      if (current.hash !== planHash) return send(409, { error: 'Plan changed; review it again' });
      plans.delete(planHash);
      busy = true;
      last = { state: 'running', planHash };
      send(202, last);
      void upgrade(root, { to: saved.to, confirmPlan: planHash }, compose?.adapter())
        .then(
          (result) => {
            last = { state: 'completed', result };
          },
          (error) => {
            last = {
              state: 'failed',
              error: error instanceof Error ? error.message : 'Upgrade failed',
            };
          },
        )
        .finally(() => {
          busy = false;
          writeJson(join(root, 'run/coordinator-result.json'), last);
        });
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : 'Invalid request' });
    }
  });
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(socket, () => {
      chmodSync(socket, 0o600);
      yes();
    });
  });
  const timer = setInterval(() => {
    if (!busy && !compose?.busy()) {
      busy = true;
      void scheduledUpgrade(root, new Date(), compose?.adapter())
        .catch((error) => {
          last = {
            state: 'failed',
            error: error instanceof Error ? error.message : 'Scheduled upgrade failed',
          };
          writeJson(join(root, 'run/coordinator-result.json'), last);
        })
        .finally(() => {
          busy = false;
        });
    }
  }, 60_000);
  timer.unref();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (busy || compose?.busy()) return;
      clearInterval(timer);
      stopUpdateChecks();
      server.close();
      if (existsSync(socket)) unlinkSync(socket);
    });
  console.log('Hive coordinator ready');
}
