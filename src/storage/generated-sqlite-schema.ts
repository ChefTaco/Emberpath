// Generated from prisma/schema.prisma by scripts/generate-sqlite-bootstrap.ts.
// Do not edit by hand; run npm run db:generate-bootstrap in services/hive-router.

export const sqliteSchemaSource = "prisma/schema.prisma" as const;

export const schemaStatements = [
  "CREATE TABLE IF NOT EXISTS \"Provider\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"slug\" TEXT NOT NULL,\n  \"name\" TEXT NOT NULL,\n  \"kind\" TEXT NOT NULL,\n  \"baseUrl\" TEXT NOT NULL,\n  \"authMode\" TEXT NOT NULL DEFAULT 'BEARER',\n  \"authHeaderName\" TEXT NOT NULL DEFAULT 'Authorization',\n  \"encryptedAuthSecret\" TEXT,\n  \"defaultHeadersJson\" TEXT,\n  \"capabilityJson\" TEXT,\n  \"passthroughJson\" TEXT,\n  \"tlsInsecure\" BOOLEAN NOT NULL DEFAULT false,\n  \"timeoutMs\" INTEGER NOT NULL DEFAULT 120000,\n  \"maxRetries\" INTEGER NOT NULL DEFAULT 1,\n  \"concurrency\" INTEGER NOT NULL DEFAULT 16,\n  \"priority\" INTEGER NOT NULL DEFAULT 100,\n  \"weight\" INTEGER NOT NULL DEFAULT 100,\n  \"failoverGroup\" TEXT,\n  \"enabled\" BOOLEAN NOT NULL DEFAULT true,\n  \"lastHealthStatus\" TEXT,\n  \"lastHealthError\" TEXT,\n  \"lastHealthAt\" DATETIME,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"Provider_slug_key\" ON \"Provider\" (\"slug\")",
  "CREATE TABLE IF NOT EXISTS \"ProviderModel\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"providerId\" TEXT NOT NULL,\n  \"model\" TEXT NOT NULL,\n  \"displayName\" TEXT,\n  \"enabled\" BOOLEAN NOT NULL DEFAULT true,\n  \"maxContextWindow\" INTEGER,\n  \"capabilityJson\" TEXT,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL,\n  CONSTRAINT \"ProviderModel_providerId_fkey\" FOREIGN KEY (\"providerId\") REFERENCES \"Provider\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"ProviderModel_providerId_model_key\" ON \"ProviderModel\" (\"providerId\", \"model\")",
  "CREATE TABLE IF NOT EXISTS \"ModelAlias\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"alias\" TEXT NOT NULL,\n  \"providerId\" TEXT,\n  \"upstreamModel\" TEXT NOT NULL,\n  \"enabled\" BOOLEAN NOT NULL DEFAULT true,\n  \"description\" TEXT,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL,\n  CONSTRAINT \"ModelAlias_providerId_fkey\" FOREIGN KEY (\"providerId\") REFERENCES \"Provider\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"ModelAlias_alias_key\" ON \"ModelAlias\" (\"alias\")",
  "CREATE TABLE IF NOT EXISTS \"RouteRule\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"name\" TEXT NOT NULL,\n  \"kind\" TEXT NOT NULL,\n  \"priority\" INTEGER NOT NULL DEFAULT 100,\n  \"enabled\" BOOLEAN NOT NULL DEFAULT true,\n  \"matchJson\" TEXT NOT NULL,\n  \"actionJson\" TEXT NOT NULL,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"RouteRule_name_key\" ON \"RouteRule\" (\"name\")",
  "CREATE TABLE IF NOT EXISTS \"HeuristicRule\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"name\" TEXT NOT NULL,\n  \"category\" TEXT NOT NULL,\n  \"pattern\" TEXT NOT NULL,\n  \"score\" INTEGER NOT NULL DEFAULT 10,\n  \"enabled\" BOOLEAN NOT NULL DEFAULT true,\n  \"actionJson\" TEXT NOT NULL,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"HeuristicRule_name_key\" ON \"HeuristicRule\" (\"name\")",
  "CREATE TABLE IF NOT EXISTS \"ClientApiKey\" (\n  \"expiresAt\" DATETIME,\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"name\" TEXT NOT NULL,\n  \"keyPrefix\" TEXT NOT NULL,\n  \"keyHash\" TEXT NOT NULL,\n  \"enabled\" BOOLEAN NOT NULL DEFAULT true,\n  \"metadataJson\" TEXT,\n  \"lastUsedAt\" DATETIME,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS \"AdminUser\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"username\" TEXT NOT NULL,\n  \"displayName\" TEXT,\n  \"passwordHash\" TEXT NOT NULL,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"AdminUser_username_key\" ON \"AdminUser\" (\"username\")",
  "CREATE TABLE IF NOT EXISTS \"AdminSession\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"sessionId\" TEXT NOT NULL,\n  \"userId\" TEXT NOT NULL,\n  \"expiresAt\" DATETIME NOT NULL,\n  \"revokedAt\" DATETIME,\n  \"ipAddress\" TEXT,\n  \"userAgent\" TEXT,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  CONSTRAINT \"AdminSession_userId_fkey\" FOREIGN KEY (\"userId\") REFERENCES \"AdminUser\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"AdminSession_sessionId_key\" ON \"AdminSession\" (\"sessionId\")",
  "CREATE TABLE IF NOT EXISTS \"Trace\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"requestId\" TEXT NOT NULL,\n  \"method\" TEXT NOT NULL,\n  \"path\" TEXT NOT NULL,\n  \"endpointKind\" TEXT NOT NULL,\n  \"routeKey\" TEXT NOT NULL,\n  \"statusCode\" INTEGER,\n  \"outcome\" TEXT NOT NULL DEFAULT 'SUCCEEDED',\n  \"estimatedUsage\" BOOLEAN NOT NULL DEFAULT false,\n  \"providerId\" TEXT,\n  \"providerKind\" TEXT,\n  \"providerModel\" TEXT,\n  \"clientApiKeyId\" TEXT,\n  \"decisionJson\" TEXT NOT NULL,\n  \"requestHeadersJson\" TEXT,\n  \"responseHeadersJson\" TEXT,\n  \"requestMetaJson\" TEXT,\n  \"responseMetaJson\" TEXT,\n  \"usageJson\" TEXT,\n  \"retentionJson\" TEXT,\n  \"requestBodyPath\" TEXT,\n  \"responseBodyPath\" TEXT,\n  \"reasoningBodyPath\" TEXT,\n  \"startedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"endedAt\" DATETIME,\n  \"durationMs\" INTEGER,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  CONSTRAINT \"Trace_providerId_fkey\" FOREIGN KEY (\"providerId\") REFERENCES \"Provider\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE,\n  CONSTRAINT \"Trace_clientApiKeyId_fkey\" FOREIGN KEY (\"clientApiKeyId\") REFERENCES \"ClientApiKey\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"Trace_requestId_key\" ON \"Trace\" (\"requestId\")",
  "CREATE TABLE IF NOT EXISTS \"TraceEvent\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"traceId\" TEXT NOT NULL,\n  \"type\" TEXT NOT NULL,\n  \"phase\" TEXT,\n  \"message\" TEXT,\n  \"dataJson\" TEXT,\n  \"occurredAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  CONSTRAINT \"TraceEvent_traceId_fkey\" FOREIGN KEY (\"traceId\") REFERENCES \"Trace\" (\"id\") ON DELETE CASCADE ON UPDATE CASCADE\n)",
  "CREATE TABLE IF NOT EXISTS \"ApiDocEntry\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"providerId\" TEXT,\n  \"route\" TEXT NOT NULL,\n  \"method\" TEXT NOT NULL,\n  \"scope\" TEXT NOT NULL,\n  \"implemented\" BOOLEAN NOT NULL DEFAULT true,\n  \"title\" TEXT NOT NULL,\n  \"summary\" TEXT,\n  \"rationale\" TEXT,\n  \"docJson\" TEXT NOT NULL,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL,\n  CONSTRAINT \"ApiDocEntry_providerId_fkey\" FOREIGN KEY (\"providerId\") REFERENCES \"Provider\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE\n)",
  "CREATE TABLE IF NOT EXISTS \"AuditEvent\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"actorType\" TEXT NOT NULL,\n  \"adminUserId\" TEXT,\n  \"action\" TEXT NOT NULL,\n  \"entityType\" TEXT NOT NULL,\n  \"entityId\" TEXT,\n  \"metadataJson\" TEXT,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  CONSTRAINT \"AuditEvent_adminUserId_fkey\" FOREIGN KEY (\"adminUserId\") REFERENCES \"AdminUser\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE\n)",
  "CREATE INDEX IF NOT EXISTS \"AuditEvent_action_id_idx\" ON \"AuditEvent\" (\"action\", \"id\")",
  "CREATE TABLE IF NOT EXISTS \"RuntimeSetting\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"key\" TEXT NOT NULL,\n  \"valueJson\" TEXT NOT NULL,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"RuntimeSetting_key_key\" ON \"RuntimeSetting\" (\"key\")",
  "CREATE TABLE IF NOT EXISTS \"QuotaBucket\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"requests\" INTEGER NOT NULL DEFAULT 0,\n  \"tokens\" INTEGER NOT NULL DEFAULT 0\n)",
  "CREATE TABLE IF NOT EXISTS \"QuotaReservation\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"clientApiKeyId\" TEXT NOT NULL,\n  \"traceId\" TEXT,\n  \"dayKey\" TEXT NOT NULL,\n  \"monthKey\" TEXT NOT NULL,\n  \"reservedTokens\" INTEGER NOT NULL,\n  \"actualTokens\" INTEGER,\n  \"costUsd\" REAL,\n  \"priceSource\" TEXT,\n  \"estimated\" BOOLEAN NOT NULL DEFAULT true,\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"QuotaReservation_traceId_key\" ON \"QuotaReservation\" (\"traceId\")",
  "CREATE INDEX IF NOT EXISTS \"QuotaReservation_clientApiKeyId_createdAt_idx\" ON \"QuotaReservation\" (\"clientApiKeyId\", \"createdAt\")",
  "CREATE TABLE IF NOT EXISTS \"ActorEnrollment\" (\n  \"actorId\" TEXT NOT NULL PRIMARY KEY,\n  \"ownerId\" TEXT NOT NULL,\n  \"requestHash\" TEXT NOT NULL,\n  \"requestJson\" TEXT NOT NULL,\n  \"credentialExpiresAt\" DATETIME,\n  \"iamId\" TEXT,\n  \"routerKeyId\" TEXT,\n  \"memoryId\" TEXT,\n  \"encryptedSecrets\" TEXT,\n  \"receiptExpiresAt\" DATETIME,\n  \"leaseUntil\" DATETIME,\n  \"status\" TEXT NOT NULL DEFAULT 'pending',\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS \"ActorLifecycleOperation\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"bindingKey\" TEXT NOT NULL,\n  \"actorId\" TEXT NOT NULL,\n  \"ownerId\" TEXT NOT NULL,\n  \"action\" TEXT NOT NULL,\n  \"identifiersJson\" TEXT NOT NULL,\n  \"stepsJson\" TEXT NOT NULL DEFAULT '{}',\n  \"encryptedSecrets\" TEXT,\n  \"receiptExpiresAt\" DATETIME,\n  \"status\" TEXT NOT NULL DEFAULT 'pending',\n  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \"updatedAt\" DATETIME NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS \"ActorLifecycleOperation_bindingKey_status_idx\" ON \"ActorLifecycleOperation\" (\"bindingKey\", \"status\")",
  "CREATE TABLE IF NOT EXISTS \"ActorLifecycleLease\" (\n  \"bindingKey\" TEXT NOT NULL PRIMARY KEY,\n  \"token\" TEXT NOT NULL,\n  \"leaseUntil\" DATETIME NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS \"QuotaLedgerState\" (\n  \"id\" TEXT NOT NULL PRIMARY KEY,\n  \"cutoverAt\" DATETIME NOT NULL,\n  \"historicalCoverage\" TEXT NOT NULL\n)"
] as const;

export interface ColumnMigration {
  table: string;
  column: string;
  sql: string;
}

export const columnMigrations: ColumnMigration[] = [
  {
    "table": "Provider",
    "column": "authMode",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"authMode\" TEXT NOT NULL DEFAULT 'BEARER'"
  },
  {
    "table": "Provider",
    "column": "authHeaderName",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"authHeaderName\" TEXT NOT NULL DEFAULT 'Authorization'"
  },
  {
    "table": "Provider",
    "column": "encryptedAuthSecret",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"encryptedAuthSecret\" TEXT"
  },
  {
    "table": "Provider",
    "column": "defaultHeadersJson",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"defaultHeadersJson\" TEXT"
  },
  {
    "table": "Provider",
    "column": "capabilityJson",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"capabilityJson\" TEXT"
  },
  {
    "table": "Provider",
    "column": "passthroughJson",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"passthroughJson\" TEXT"
  },
  {
    "table": "Provider",
    "column": "tlsInsecure",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"tlsInsecure\" BOOLEAN NOT NULL DEFAULT false"
  },
  {
    "table": "Provider",
    "column": "timeoutMs",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"timeoutMs\" INTEGER NOT NULL DEFAULT 120000"
  },
  {
    "table": "Provider",
    "column": "maxRetries",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"maxRetries\" INTEGER NOT NULL DEFAULT 1"
  },
  {
    "table": "Provider",
    "column": "concurrency",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"concurrency\" INTEGER NOT NULL DEFAULT 16"
  },
  {
    "table": "Provider",
    "column": "priority",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"priority\" INTEGER NOT NULL DEFAULT 100"
  },
  {
    "table": "Provider",
    "column": "weight",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"weight\" INTEGER NOT NULL DEFAULT 100"
  },
  {
    "table": "Provider",
    "column": "failoverGroup",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"failoverGroup\" TEXT"
  },
  {
    "table": "Provider",
    "column": "enabled",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"enabled\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "Provider",
    "column": "lastHealthStatus",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"lastHealthStatus\" TEXT"
  },
  {
    "table": "Provider",
    "column": "lastHealthError",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"lastHealthError\" TEXT"
  },
  {
    "table": "Provider",
    "column": "lastHealthAt",
    "sql": "ALTER TABLE \"Provider\" ADD COLUMN \"lastHealthAt\" DATETIME"
  },
  {
    "table": "ProviderModel",
    "column": "displayName",
    "sql": "ALTER TABLE \"ProviderModel\" ADD COLUMN \"displayName\" TEXT"
  },
  {
    "table": "ProviderModel",
    "column": "enabled",
    "sql": "ALTER TABLE \"ProviderModel\" ADD COLUMN \"enabled\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "ProviderModel",
    "column": "maxContextWindow",
    "sql": "ALTER TABLE \"ProviderModel\" ADD COLUMN \"maxContextWindow\" INTEGER"
  },
  {
    "table": "ProviderModel",
    "column": "capabilityJson",
    "sql": "ALTER TABLE \"ProviderModel\" ADD COLUMN \"capabilityJson\" TEXT"
  },
  {
    "table": "ModelAlias",
    "column": "providerId",
    "sql": "ALTER TABLE \"ModelAlias\" ADD COLUMN \"providerId\" TEXT"
  },
  {
    "table": "ModelAlias",
    "column": "enabled",
    "sql": "ALTER TABLE \"ModelAlias\" ADD COLUMN \"enabled\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "ModelAlias",
    "column": "description",
    "sql": "ALTER TABLE \"ModelAlias\" ADD COLUMN \"description\" TEXT"
  },
  {
    "table": "RouteRule",
    "column": "priority",
    "sql": "ALTER TABLE \"RouteRule\" ADD COLUMN \"priority\" INTEGER NOT NULL DEFAULT 100"
  },
  {
    "table": "RouteRule",
    "column": "enabled",
    "sql": "ALTER TABLE \"RouteRule\" ADD COLUMN \"enabled\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "HeuristicRule",
    "column": "score",
    "sql": "ALTER TABLE \"HeuristicRule\" ADD COLUMN \"score\" INTEGER NOT NULL DEFAULT 10"
  },
  {
    "table": "HeuristicRule",
    "column": "enabled",
    "sql": "ALTER TABLE \"HeuristicRule\" ADD COLUMN \"enabled\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "ClientApiKey",
    "column": "expiresAt",
    "sql": "ALTER TABLE \"ClientApiKey\" ADD COLUMN \"expiresAt\" DATETIME"
  },
  {
    "table": "ClientApiKey",
    "column": "enabled",
    "sql": "ALTER TABLE \"ClientApiKey\" ADD COLUMN \"enabled\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "ClientApiKey",
    "column": "metadataJson",
    "sql": "ALTER TABLE \"ClientApiKey\" ADD COLUMN \"metadataJson\" TEXT"
  },
  {
    "table": "ClientApiKey",
    "column": "lastUsedAt",
    "sql": "ALTER TABLE \"ClientApiKey\" ADD COLUMN \"lastUsedAt\" DATETIME"
  },
  {
    "table": "AdminUser",
    "column": "displayName",
    "sql": "ALTER TABLE \"AdminUser\" ADD COLUMN \"displayName\" TEXT"
  },
  {
    "table": "AdminSession",
    "column": "revokedAt",
    "sql": "ALTER TABLE \"AdminSession\" ADD COLUMN \"revokedAt\" DATETIME"
  },
  {
    "table": "AdminSession",
    "column": "ipAddress",
    "sql": "ALTER TABLE \"AdminSession\" ADD COLUMN \"ipAddress\" TEXT"
  },
  {
    "table": "AdminSession",
    "column": "userAgent",
    "sql": "ALTER TABLE \"AdminSession\" ADD COLUMN \"userAgent\" TEXT"
  },
  {
    "table": "Trace",
    "column": "statusCode",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"statusCode\" INTEGER"
  },
  {
    "table": "Trace",
    "column": "outcome",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"outcome\" TEXT NOT NULL DEFAULT 'SUCCEEDED'"
  },
  {
    "table": "Trace",
    "column": "estimatedUsage",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"estimatedUsage\" BOOLEAN NOT NULL DEFAULT false"
  },
  {
    "table": "Trace",
    "column": "providerId",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"providerId\" TEXT"
  },
  {
    "table": "Trace",
    "column": "providerKind",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"providerKind\" TEXT"
  },
  {
    "table": "Trace",
    "column": "providerModel",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"providerModel\" TEXT"
  },
  {
    "table": "Trace",
    "column": "clientApiKeyId",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"clientApiKeyId\" TEXT"
  },
  {
    "table": "Trace",
    "column": "requestHeadersJson",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"requestHeadersJson\" TEXT"
  },
  {
    "table": "Trace",
    "column": "responseHeadersJson",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"responseHeadersJson\" TEXT"
  },
  {
    "table": "Trace",
    "column": "requestMetaJson",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"requestMetaJson\" TEXT"
  },
  {
    "table": "Trace",
    "column": "responseMetaJson",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"responseMetaJson\" TEXT"
  },
  {
    "table": "Trace",
    "column": "usageJson",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"usageJson\" TEXT"
  },
  {
    "table": "Trace",
    "column": "retentionJson",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"retentionJson\" TEXT"
  },
  {
    "table": "Trace",
    "column": "requestBodyPath",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"requestBodyPath\" TEXT"
  },
  {
    "table": "Trace",
    "column": "responseBodyPath",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"responseBodyPath\" TEXT"
  },
  {
    "table": "Trace",
    "column": "reasoningBodyPath",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"reasoningBodyPath\" TEXT"
  },
  {
    "table": "Trace",
    "column": "endedAt",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"endedAt\" DATETIME"
  },
  {
    "table": "Trace",
    "column": "durationMs",
    "sql": "ALTER TABLE \"Trace\" ADD COLUMN \"durationMs\" INTEGER"
  },
  {
    "table": "TraceEvent",
    "column": "phase",
    "sql": "ALTER TABLE \"TraceEvent\" ADD COLUMN \"phase\" TEXT"
  },
  {
    "table": "TraceEvent",
    "column": "message",
    "sql": "ALTER TABLE \"TraceEvent\" ADD COLUMN \"message\" TEXT"
  },
  {
    "table": "TraceEvent",
    "column": "dataJson",
    "sql": "ALTER TABLE \"TraceEvent\" ADD COLUMN \"dataJson\" TEXT"
  },
  {
    "table": "ApiDocEntry",
    "column": "providerId",
    "sql": "ALTER TABLE \"ApiDocEntry\" ADD COLUMN \"providerId\" TEXT"
  },
  {
    "table": "ApiDocEntry",
    "column": "implemented",
    "sql": "ALTER TABLE \"ApiDocEntry\" ADD COLUMN \"implemented\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "ApiDocEntry",
    "column": "summary",
    "sql": "ALTER TABLE \"ApiDocEntry\" ADD COLUMN \"summary\" TEXT"
  },
  {
    "table": "ApiDocEntry",
    "column": "rationale",
    "sql": "ALTER TABLE \"ApiDocEntry\" ADD COLUMN \"rationale\" TEXT"
  },
  {
    "table": "AuditEvent",
    "column": "adminUserId",
    "sql": "ALTER TABLE \"AuditEvent\" ADD COLUMN \"adminUserId\" TEXT"
  },
  {
    "table": "AuditEvent",
    "column": "entityId",
    "sql": "ALTER TABLE \"AuditEvent\" ADD COLUMN \"entityId\" TEXT"
  },
  {
    "table": "AuditEvent",
    "column": "metadataJson",
    "sql": "ALTER TABLE \"AuditEvent\" ADD COLUMN \"metadataJson\" TEXT"
  },
  {
    "table": "QuotaBucket",
    "column": "requests",
    "sql": "ALTER TABLE \"QuotaBucket\" ADD COLUMN \"requests\" INTEGER NOT NULL DEFAULT 0"
  },
  {
    "table": "QuotaBucket",
    "column": "tokens",
    "sql": "ALTER TABLE \"QuotaBucket\" ADD COLUMN \"tokens\" INTEGER NOT NULL DEFAULT 0"
  },
  {
    "table": "QuotaReservation",
    "column": "traceId",
    "sql": "ALTER TABLE \"QuotaReservation\" ADD COLUMN \"traceId\" TEXT"
  },
  {
    "table": "QuotaReservation",
    "column": "actualTokens",
    "sql": "ALTER TABLE \"QuotaReservation\" ADD COLUMN \"actualTokens\" INTEGER"
  },
  {
    "table": "QuotaReservation",
    "column": "costUsd",
    "sql": "ALTER TABLE \"QuotaReservation\" ADD COLUMN \"costUsd\" REAL"
  },
  {
    "table": "QuotaReservation",
    "column": "priceSource",
    "sql": "ALTER TABLE \"QuotaReservation\" ADD COLUMN \"priceSource\" TEXT"
  },
  {
    "table": "QuotaReservation",
    "column": "estimated",
    "sql": "ALTER TABLE \"QuotaReservation\" ADD COLUMN \"estimated\" BOOLEAN NOT NULL DEFAULT true"
  },
  {
    "table": "ActorEnrollment",
    "column": "credentialExpiresAt",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"credentialExpiresAt\" DATETIME"
  },
  {
    "table": "ActorEnrollment",
    "column": "iamId",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"iamId\" TEXT"
  },
  {
    "table": "ActorEnrollment",
    "column": "routerKeyId",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"routerKeyId\" TEXT"
  },
  {
    "table": "ActorEnrollment",
    "column": "memoryId",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"memoryId\" TEXT"
  },
  {
    "table": "ActorEnrollment",
    "column": "encryptedSecrets",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"encryptedSecrets\" TEXT"
  },
  {
    "table": "ActorEnrollment",
    "column": "receiptExpiresAt",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"receiptExpiresAt\" DATETIME"
  },
  {
    "table": "ActorEnrollment",
    "column": "leaseUntil",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"leaseUntil\" DATETIME"
  },
  {
    "table": "ActorEnrollment",
    "column": "status",
    "sql": "ALTER TABLE \"ActorEnrollment\" ADD COLUMN \"status\" TEXT NOT NULL DEFAULT 'pending'"
  },
  {
    "table": "ActorLifecycleOperation",
    "column": "stepsJson",
    "sql": "ALTER TABLE \"ActorLifecycleOperation\" ADD COLUMN \"stepsJson\" TEXT NOT NULL DEFAULT '{}'"
  },
  {
    "table": "ActorLifecycleOperation",
    "column": "encryptedSecrets",
    "sql": "ALTER TABLE \"ActorLifecycleOperation\" ADD COLUMN \"encryptedSecrets\" TEXT"
  },
  {
    "table": "ActorLifecycleOperation",
    "column": "receiptExpiresAt",
    "sql": "ALTER TABLE \"ActorLifecycleOperation\" ADD COLUMN \"receiptExpiresAt\" DATETIME"
  },
  {
    "table": "ActorLifecycleOperation",
    "column": "status",
    "sql": "ALTER TABLE \"ActorLifecycleOperation\" ADD COLUMN \"status\" TEXT NOT NULL DEFAULT 'pending'"
  }
];
