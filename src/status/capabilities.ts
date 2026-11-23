/**
 * Suite service capabilities this Emberpath build provides (HiveCommon/Registry C5 names),
 * reported by `GET /health` on both planes so peers can negotiate without guessing from versions.
 *
 * - `emberpath.execution-trace.v1`: traces record `x-hive-execution` attribution and the admin
 *   `GET /api/traces` accepts execution filters and returns per-attempt `attempts[]`.
 * - `retry-signal.v1`: inference answers carry `x-hive-retry: exhausted|none`.
 */
export const SERVICE_CAPABILITIES = ['emberpath.execution-trace.v1', 'retry-signal.v1'] as const;
