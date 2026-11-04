import { routerMigration } from '../upgrade.js';
import { bootstrapStorage } from '../storage/bootstrap.js';
import { prisma } from '../storage/client.js';
import { generateOpenAiStyleApiKey, hashValue } from '../security/crypto.js';
import { loadEnv } from '../config/env.js';

interface ParsedArgs {
  help: boolean;
  json: boolean;
  name?: string;
  metadata?: string;
  enabled: boolean;
  token?: string;
}

interface GeneratedKey {
  id: string;
  name: string;
  keyPrefix: string;
  apiKey: string;
  enabled: boolean;
  createdAt: string;
}

function showUsage(): void {
  console.log(`Hive Router API key CLI

Usage:
  hive-router create-key --name <name> [--metadata '<json>'] [--token <token>] [--json]
  npm run cli -- create-key ...   (from a source checkout)

Options:
  --name <name>         Human-readable key name (required)
  --metadata '<json>'    Optional JSON metadata object
  --token <token>       Optional shared token (requires HIVE_ROUTER_CLI_TOKEN when set)
  --json                Output JSON instead of human text
  --help                Show this help message

Environment:
  HIVE_ROUTER_SECRET     Required
  HIVE_ROUTER_CLI_TOKEN  Optional shared token; if set, --token must match`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, json: false, enabled: true };
  if (argv.length === 0) {
    parsed.help = true;
    return parsed;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '--enabled') {
      parsed.enabled = true;
      continue;
    }

    if (arg === '--disabled') {
      parsed.enabled = false;
      continue;
    }

    if (arg === '--name' || arg === '--token' || arg === '--metadata') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;

      if (arg === '--name') parsed.name = value;
      if (arg === '--token') parsed.token = value;
      if (arg === '--metadata') parsed.metadata = value;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function parseMetadata(raw?: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function ensureAuthorized(tokenFromCli?: string): void {
  const configuredToken = process.env.HIVE_ROUTER_CLI_TOKEN;
  if (!configuredToken) {
    return;
  }

  if (!tokenFromCli) {
    throw new Error('Missing --token (required when HIVE_ROUTER_CLI_TOKEN is configured)');
  }

  if (tokenFromCli !== configuredToken) {
    throw new Error('Invalid --token for CLI key generation');
  }
}

async function createClientKey(args: ParsedArgs): Promise<GeneratedKey> {
  ensureAuthorized(args.token);

  const name = args.name?.trim();
  if (!name) {
    throw new Error('--name is required');
  }

  const metadata = parseMetadata(args.metadata);
  const rawKey = generateOpenAiStyleApiKey();

  const record = await prisma.clientApiKey.create({
    data: {
      name,
      keyPrefix: rawKey.slice(0, 8),
      keyHash: hashValue(rawKey),
      enabled: args.enabled,
      metadataJson: JSON.stringify(metadata),
    },
  });

  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    apiKey: rawKey,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
  };
}

async function bootstrapRouter(): Promise<void> {
  loadEnv();
  await routerMigration([], true);
  await prisma.$connect();
  await bootstrapStorage();
}

function printGeneratedKey(result: GeneratedKey, asJson: boolean): void {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          id: result.id,
          name: result.name,
          keyPrefix: result.keyPrefix,
          enabled: result.enabled,
          apiKey: result.apiKey,
          createdAt: result.createdAt,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Created API key "${result.name}" (${result.id})`);
  console.log(`ID: ${result.id}`);
  console.log(`Prefix: ${result.keyPrefix}`);
  console.log(`Enabled: ${result.enabled}`);
  console.log(`Created: ${result.createdAt}`);
  console.log('API key (server will only show this once):');
  console.log(result.apiKey);
}

function createFailurePrompt(message: string): number {
  console.error(`Error: ${message}`);
  return 1;
}

/** Runs `<command> [options]`; returns the process exit code. */
export async function runApiKeyCli(argv: string[]): Promise<number> {
  const command = argv[0];
  let args: ParsedArgs;
  try {
    args = parseArgs(argv.slice(1));
  } catch (error) {
    return createFailurePrompt(error instanceof Error ? error.message : String(error));
  }
  if (args.help || !command || command.startsWith('--') || command === 'help') {
    showUsage();
    return 0;
  }

  if (command !== 'create-key') {
    return createFailurePrompt(`Unknown command: ${command}`);
  }

  try {
    await bootstrapRouter();
    const created = await createClientKey(args);
    printGeneratedKey(created, args.json);
    return 0;
  } catch (error) {
    return createFailurePrompt(error instanceof Error ? error.message : 'Failed to create key');
  } finally {
    await prisma.$disconnect();
  }
}
