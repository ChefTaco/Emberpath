import { createServer } from 'node:http';
import { chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { run, remove } from './files.js';
import { installedPackage } from './project.js';
import type { Manager, Transaction, UpgradeOptions, UpgradePlan } from './engine.js';

/** Hand over before quiescence. The staged engine must understand the protocol and
 * reproduce the approved plan. An adapter remains in the owner coordinator process. */
export async function handoff(
  root: string,
  staged: string,
  plan: UpgradePlan,
  options: UpgradeOptions,
  adapter?: Manager,
): Promise<Transaction> {
  if (process.env.HIVE_ENGINE_HANDOFF === 'true')
    throw new Error('Staged engine cannot handle the required protocol; no migration ran');
  const runtime = pathToFileURL(
    join(staged, 'node_modules/@hivemagnus/hive/dist/src/release/runtime.js'),
  ).href;
  const supported = JSON.parse(
    await run(process.execPath, [
      '--input-type=module',
      '-e',
      `const r=await import(${JSON.stringify(runtime)});process.stdout.write(JSON.stringify({protocol:r.ENGINE_PROTOCOL||0}))`,
    ]),
  ) as { protocol: number };
  if (!Number.isInteger(supported.protocol) || supported.protocol < plan.target.engineProtocol)
    throw new Error('Staged engine does not advertise the required protocol; no migration ran');
  const socket = join(root, 'run', `engine-handoff-${randomUUID()}.sock`);
  const token = randomUUID();
  const requestSchema = z
    .object({
      token: z.literal(token),
      method: z.enum(['stop', 'start', 'health']),
      directory: z.string().optional(),
    })
    .strict();
  const server = adapter
    ? createServer(async (req, res) => {
        try {
          if (req.method !== 'POST' || req.url !== '/')
            throw new Error('Invalid handoff operation');
          let text = '';
          for await (const chunk of req) {
            text += chunk;
            if (text.length > 8192) throw new Error('Request too large');
          }
          const body = requestSchema.parse(JSON.parse(text));
          if (body.method === 'health') {
            if (
              !body.directory ||
              !realpathSync(body.directory).startsWith(realpathSync(join(root, 'versions')) + '/')
            )
              throw new Error('Invalid release directory');
            const version = installedPackage(body.directory, '@hivemagnus/hive').version;
            if (![plan.from, plan.target.version].includes(version))
              throw new Error('Unexpected handoff release');
            await adapter.health(body.directory);
          } else await adapter[body.method]();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        } catch {
          res.writeHead(409);
          res.end('{}');
        }
      })
    : undefined;
  try {
    if (server)
      await new Promise<void>((yes, no) => {
        server.once('error', no);
        server.listen(socket, () => {
          chmodSync(socket, 0o600);
          yes();
        });
      });
    const script = `
      import {request} from 'node:http';
      const r=await import(${JSON.stringify(runtime)});
      const root=${JSON.stringify(root)}, options=${JSON.stringify({ ...options, to: plan.target.version })};
      const plan=await r.planUpgrade(root,options);
      if(plan.hash!==${JSON.stringify(plan.hash)}) throw Error('Handoff plan changed; review again');
      const call=(method,directory)=>new Promise((yes,no)=>{
        const q=request({socketPath:${JSON.stringify(socket)},path:'/',method:'POST'},res=>{res.resume();res.once('end',()=>res.statusCode===200?yes():no(Error('Owner manager refused handoff')))});
        q.once('error',no);q.end(JSON.stringify({token:process.env.HIVE_ENGINE_HANDOFF_TOKEN,method,...(directory?{directory}:{})}));
      });
      const adapter=${Boolean(adapter)}?{stop:()=>call('stop'),start:()=>call('start'),health:d=>call('health',d)}:undefined;
      process.stdout.write(JSON.stringify(await r.upgrade(root,options,adapter)));
    `;
    return JSON.parse(
      await run(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        env: { ...process.env, HIVE_ENGINE_HANDOFF: 'true', HIVE_ENGINE_HANDOFF_TOKEN: token },
        timeout: 3_600_000,
      }),
    ) as Transaction;
  } finally {
    if (server) await new Promise<void>((done) => server.close(() => done()));
    remove(socket);
  }
}
