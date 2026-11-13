import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  database: vi.fn(async () => [{value: 1}]), count: vi.fn(async () => 1),
  providers: vi.fn(async () => [{id:'synthetic-provider',slug:'synthetic-provider',kind:'OPENAI',provider:{id:'synthetic-provider'}}]),
  health: vi.fn(async () => ({healthy:false})), update: vi.fn(async () => {}), gauge: vi.fn(),
  pruneReceipts: vi.fn(async () => ({})), pruneOperations: vi.fn(async () => 0), traces: vi.fn(async () => []), deleteTraces: vi.fn(async () => ({})),
}));
vi.mock('../../src/config/env.js',()=>({loadEnv:()=>({HIVE_REHEARSAL: process.env.HIVE_REHEARSAL==='true',HIVE_ROUTER_IAM_JWKS_MAX_AGE_MS:900_000,DEFAULT_TRACE_RETENTION_DAYS:7,TRACE_DIR:'/tmp/synthetic-traces'})}));
vi.mock('../../src/storage/client.js',()=>({prisma:{$queryRawUnsafe:mocks.database,provider:{count:mocks.count},actorEnrollment:{updateMany:mocks.pruneReceipts},$executeRaw:mocks.pruneOperations,trace:{findMany:mocks.traces,deleteMany:mocks.deleteTraces}}}));
vi.mock('../../src/providers/index.js',()=>({listProviderRuntimes:mocks.providers,getProviderAdapter:()=>({healthCheck:mocks.health}),updateProviderHealth:mocks.update}));
vi.mock('../../src/telemetry/metrics.js',()=>({providerHealthGauge:{set:mocks.gauge}}));
vi.mock('../../src/release/runtime.js',()=>({metadata:()=>({version:'synthetic',release:'synthetic',protocol:1})}));
vi.mock('../../src/security/security-exporter-jwks-status.js',()=>({getSecurityExporterJwksStatus:()=>({state:'uninitialized',remainingMs:0})}));
import {buildRouterDependencyReport,resetProviderHealthSweepReuse} from '../../src/status/router-health.js';
import {runProviderHealthSweep} from '../../src/providers/health.js';
import {pruneExpiredTraces,startTraceRetention} from '../../src/telemetry/retention.js';
beforeEach(()=>{vi.clearAllMocks();resetProviderHealthSweepReuse();});
afterEach(()=>vi.unstubAllEnvs());
it('restored provider configuration is never probed or changed in isolation and is not reported healthy',async()=>{
  vi.stubEnv('HIVE_REHEARSAL','true');
  expect(await runProviderHealthSweep()).toEqual([]);
  const report=await buildRouterDependencyReport();
  expect(report.status).toBe('ready');
  expect(report.providers).toEqual({configured:1,healthy:0,checked:false});
  expect(report.checks.find(check=>check.name==='providers')?.status).toBe('warn');
  expect(mocks.database).toHaveBeenCalled();
  expect(mocks.providers).not.toHaveBeenCalled();expect(mocks.health).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();expect(mocks.gauge).not.toHaveBeenCalled();
});
it('rehearsal does not expire historical credentials, receipts or traces',async()=>{
  vi.stubEnv('HIVE_REHEARSAL','true');
  expect(startTraceRetention()).toBeUndefined();expect(await pruneExpiredTraces()).toBe(0);
  expect(mocks.pruneReceipts).not.toHaveBeenCalled();expect(mocks.pruneOperations).not.toHaveBeenCalled();expect(mocks.traces).not.toHaveBeenCalled();expect(mocks.deleteTraces).not.toHaveBeenCalled();
});
it('normal readiness still requires an available configured provider',async()=>{
  vi.stubEnv('HIVE_REHEARSAL','false');
  const report=await buildRouterDependencyReport();
  expect(report.status).toBe('degraded');expect(report.providers.checked).toBe(true);
  expect(mocks.health).toHaveBeenCalledTimes(1);expect(mocks.update).toHaveBeenCalledTimes(1);
});
it('reports requested in quick succession share one provider sweep',async()=>{
  vi.stubEnv('HIVE_REHEARSAL','false');
  const reports=await Promise.all([buildRouterDependencyReport(),buildRouterDependencyReport()]);
  reports.push(await buildRouterDependencyReport());
  expect(reports.map(report=>report.status)).toEqual(['degraded','degraded','degraded']);
  expect(mocks.health).toHaveBeenCalledTimes(1);expect(mocks.update).toHaveBeenCalledTimes(1);
  // Each report still checks the database itself.
  expect(mocks.database).toHaveBeenCalledTimes(3);
  vi.useFakeTimers({toFake:['Date'],now:Date.now()+6_000});
  try{await buildRouterDependencyReport();}finally{vi.useRealTimers();}
  expect(mocks.health).toHaveBeenCalledTimes(2);
});
