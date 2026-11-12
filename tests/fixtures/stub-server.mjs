// Starts two built Emberpath servers with throwaway state for the Playwright checks:
// one without HIVEXUI_URL (stub page) and, once that one is live, one with it (redirect).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const servers = [
  { adminPort: '19443', apiPort: '15020', hiveXuiUrl: '' },
  { adminPort: '19444', apiPort: '15021', hiveXuiUrl: 'https://hivexui.example.test/' },
];
const children = [];
let closing = false;

function start({ adminPort, apiPort, hiveXuiUrl }) {
  const state = mkdtempSync(join(tmpdir(), 'emberpath-e2e-'));
  const child = spawn(process.execPath, ['dist/src/index.js'], { stdio: ['ignore', 'inherit', 'inherit'], env: {
    ...process.env, NODE_ENV: 'test', HIVE_AUTO_MIGRATE: 'true', HIVE_UPDATE_CHECK: 'false', HIVE_HOME: state,
    API_HOST: '127.0.0.1', ADMIN_HOST: '127.0.0.1', API_PORT: apiPort, ADMIN_PORT: adminPort,
    PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`, PUBLIC_ADMIN_URL: `http://127.0.0.1:${adminPort}`,
    DATABASE_URL: `file:${join(state, 'router.db')}`, DATA_DIR: state, TRACE_DIR: join(state, 'traces'),
    HIVE_ROUTER_SECRET: randomBytes(32).toString('hex'), HIVE_ROUTER_AUTH_MODE: 'os', HIVE_ROUTER_ADMIN_USERS: 'admin',
    HIVEXUI_URL: hiveXuiUrl,
  } });
  child.once('exit', (code) => { rmSync(state, { recursive: true, force: true }); if (!closing) { close(); process.exit(code ?? 1); } });
  children.push(child);
}

async function live(adminPort) {
  for (let attempt = 0; attempt < 400; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${adminPort}/health/live`)).ok) return; } catch {}
    await delay(100);
  }
  throw Error(`Server on ${adminPort} did not become live`);
}

function close() { if (closing) return; closing = true; for (const child of children) child.kill('SIGTERM'); }
process.on('SIGTERM', () => { close(); process.exit(0); });
process.on('SIGINT', () => { close(); process.exit(0); });

// Playwright waits on the last server, so start them in order.
start(servers[0]);
await live(servers[0].adminPort);
start(servers[1]);
