import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

/** Real IAM passkey service and disposable Redis, behind the fixture IAM proxy. */
export async function passkeyFixture(directory) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const redis = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory], { stdio: 'ignore' });
  redis.on('error', () => {});
  const stop = () => redis.kill('SIGTERM');
  process.once('exit', stop);
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnSync('redis-cli', ['-h', '127.0.0.1', '-p', String(port), 'ping'], { encoding: 'utf8' }).stdout?.trim() === 'PONG') { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) { stop(); throw new Error('Disposable Redis is required for passkey acceptance'); }
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${directory}/unused-iam.db`, REDIS_URL: `redis://127.0.0.1:${port}`, REDIS_PREFIX: 'passkey-fixture', JWT_PRIVATE_KEY_PATH: directory + '/unused.key', JWT_PUBLIC_KEY_PATH: directory + '/unused.pub', COOKIE_SECRET: randomBytes(32).toString('hex'), IAM_AGENT_SECRET: randomBytes(32).toString('hex'), WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_RP_ORIGIN: 'http://localhost:19443' });
  const service = await import('../../../hive-iam/apps/iam-core/dist/services/webauthn-service.js');
  const credentials = new Map();
  // The dedicated client connects asynchronously; wait for an actual ceremony save.
  for (let attempt = 0; ; attempt++) {
    try { await service.getRegistrationOptions('readiness', 'fixture@example.test', 'fixture', [], 'readiness'); break; }
    catch (error) { if (attempt >= 30) { stop(); throw error; } await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  return {
    stop,
    async handle(request, body) {
      const operator = JSON.parse(request.headers['x-hive-operator'] ?? '{}');
      if (!operator.id || !operator.sessionId) throw new Error('Verified operator context required');
      const user = operator.id; const binding = operator.sessionId;
      const credential = credentials.get(user);
      switch (request.url) {
        case '/api/v1/webauthn/fixture-store/verify': {
          const requireIam = createRequire(new URL('../../../hive-iam/apps/iam-core/package.json', import.meta.url));
          const Redis = requireIam('ioredis');
          const client = new Redis(process.env.REDIS_URL, { commandTimeout: 1000, maxRetriesPerRequest: 0 });
          client.on('error', () => {});
          const { CeremonyStore } = await import('../../../hive-iam/apps/iam-core/dist/services/ceremony-store.js');
          const ceremonies = new CeremonyStore(client, 'expiry-proof');
          try {
            await client.ping();
            await ceremonies.save(user, 'register', binding, 'expires');
            const [key] = await client.keys('expiry-proof:webauthn:*');
            const ttl = await client.ttl(key);
            // Advance the real Redis key's expiry without a five-minute test wait.
            await client.pexpire(key, 1);
            await new Promise((resolve) => setTimeout(resolve, 25));
            let expiryRejected = false;
            try { await ceremonies.consume(user, 'register', binding, { response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: 'expires' })).toString('base64url') } }); }
            catch { expiryRejected = true; }
            client.disconnect();
            const exited = new Promise((resolve) => redis.once('exit', resolve));
            stop(); await exited;
            const started = Date.now(); let outageRejected = false;
            try { await service.getAuthenticationOptions(user, [], binding); }
            catch { outageRejected = true; }
            return { ttl, expiryRejected, outageRejected, outageMilliseconds: Date.now() - started };
          } finally { client.disconnect(); }
        }
        case '/api/v1/webauthn/fixture-register/options': return service.getRegistrationOptions(user, 'fixture@example.test', user, credential ? [credential] : [], binding);
        case '/api/v1/webauthn/fixture-register/verify': {
          const result = await service.verifyRegistration(user, body, binding);
          if (!result.verified || !result.registrationInfo) throw new Error('Attestation rejected');
          const value = result.registrationInfo.credential;
          credentials.set(user, { credentialId: value.id, publicKey: Buffer.from(value.publicKey).toString('base64url'), counter: value.counter, transports: value.transports });
          return { verified: true };
        }
        case '/api/v1/webauthn/fixture-login/options': return service.getAuthenticationOptions(user, credential ? [credential] : [], binding);
        case '/api/v1/webauthn/fixture-login/verify': {
          if (!credential) throw new Error('No registered credential');
          const result = await service.verifyAuthentication(user, body, credential, binding);
          if (result.verified) credential.counter = result.authenticationInfo.newCounter;
          return { verified: result.verified };
        }
        default: throw new Error('Unknown fixture operation');
      }
    },
  };
}
