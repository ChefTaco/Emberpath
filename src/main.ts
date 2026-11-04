import { loadExplicitEnvFile } from './config/env-file.js';
import { packageInfo } from './config/paths.js';

// Keep this module free of imports that read configuration: `--env-file` must
// be loaded before the config module (./config/env.js) is first evaluated, so
// every command below is imported lazily.

const USAGE = `Hive Router: OpenAI-compatible model gateway, admin API and the Hive console.

Usage:
  hive-router [start] [--env-file <path>]    Start the API and admin listeners (default)
  hive-router check [--json] [--env-file <path>]
                                             Validate configuration without starting
  hive-router env-schema                     Print the configuration schema as JSON
  hive-router migrate --plan [--json]         Inspect pending migrations without writing
  hive-router migrate [--backup-dir DIR]      Back up and apply pending migrations
  hive-router upgrade [Hive options]         Upgrade the complete managed bundle
  hive-router rollback [Hive options]        Delegate rollback to the managed engine
  hive-router create-key --name <name> [...] Create a client API key (see create-key --help)
  hive-router --help | --version

Options:
  --env-file <path>  Load environment variables from a dotenv file first.
                     Variables already set in the environment win. Without it,
                     ./.env and ./.env.apikeys in the working directory are read.
  -h, --help         Show this help.
  -v, --version      Print the version.

Minimal configuration:
  HIVE_ROUTER_SECRET       required, at least 32 characters (openssl rand -hex 32)
  HIVE_ROUTER_ADMIN_USERS  accounts allowed to sign in to the console
  TLS_CERT_PATH, TLS_KEY_PATH  required when NODE_ENV=production

Defaults: API on 127.0.0.1:4020, console on 127.0.0.1:9443, data in
\${HIVE_HOME:-~/.hive}/router. Run "hive-router env-schema" for every setting.`;

interface ParsedCli {
  command: string;
  rest: string[];
  envFile?: string;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseCli(argv: string[]): ParsedCli {
  const parsed: ParsedCli = { command: 'start', rest: [], help: false, version: false };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      const value = arg === '--env-file' ? argv[++index] : arg.slice('--env-file='.length);
      if (!value) throw new UsageError('--env-file needs a path');
      parsed.envFile = value;
      continue;
    }
    if (!commandSeen) {
      if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
      if (arg === '--version' || arg === '-v' || arg === '-V') { parsed.version = true; continue; }
      if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
      parsed.command = arg;
      commandSeen = true;
      continue;
    }
    parsed.rest.push(arg);
  }
  return parsed;
}

function fail(message: string): number {
  for (const line of message.split('\n')) console.error(`hive-router: ${line}`);
  return 1;
}

function isNamedError(error: unknown, ...names: string[]): error is Error {
  return error instanceof Error && names.includes(error.name);
}

async function start(rest: string[]): Promise<number | null> {
  if (rest.length > 0) return fail(`unexpected argument for start: ${rest[0]}. Run "hive-router --help".`);
  try {
    const { startServer } = await import('./server.js');
    await startServer();
    return null;
  } catch (error) {
    if (isNamedError(error, 'ConfigError', 'ListenError')) return fail(error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (process.env['LOG_LEVEL'] === 'debug' && error instanceof Error && error.stack) console.error(error.stack);
    return fail(`failed to start: ${message}`);
  }
}

/**
 * Runs the CLI. Returns the exit code, or null when the server keeps running.
 */
export async function main(argv: string[]): Promise<number | null> {
  let cli: ParsedCli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    return fail(`${(error as Error).message}. Run "hive-router --help".`);
  }

  if (cli.version) {
    console.log(packageInfo().version);
    return 0;
  }
  if (cli.help || cli.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (cli.command === 'version') {
    console.log(packageInfo().version);
    return 0;
  }

  if (cli.envFile) {
    try {
      loadExplicitEnvFile(cli.envFile);
    } catch (error) {
      return fail(`${(error as Error).message}. Fix the --env-file path.`);
    }
  }

  try {
    return await runCommand(cli);
  } catch (error) {
    if (isNamedError(error, 'ConfigError')) return fail(error.message);
    throw error;
  }
}

async function runCommand(cli: ParsedCli): Promise<number | null> {
  switch (cli.command) {
    case 'upgrade':
    case 'rollback': {
      const { delegate } = await import('./release/runtime.js');
      return delegate([cli.command, ...cli.rest]);
    }
    case 'migrate': {
      const { routerMigration } = await import('./upgrade.js');
      await routerMigration(cli.rest);
      return 0;
    }
    case 'start':
      return start(cli.rest);
    case 'env-schema': {
      const { buildEnvSchemaDocument } = await import('./config/env-catalog.js');
      console.log(JSON.stringify(buildEnvSchemaDocument(), null, 2));
      return 0;
    }
    case 'check': {
      const json = cli.rest.includes('--json');
      const unknown = cli.rest.find((arg) => arg !== '--json' && arg !== '--offline');
      if (unknown) return fail(`unexpected argument for check: ${unknown}`);
      const { runChecks, formatReport } = await import('./commands/check.js');
      const report = await runChecks({ offline:cli.rest.includes('--offline') });
      if (!json) await (await import('./release/runtime.js')).printUpdateNotice(packageInfo().version);
      console.log(json ? JSON.stringify({...report,updates:await (await import('./release/runtime.js')).updateStatus(packageInfo().version)}, null, 2) : formatReport(report));
      return report.ok ? 0 : 1;
    }
    case 'create-key': {
      const { runApiKeyCli } = await import('./commands/create-key.js');
      return runApiKeyCli(['create-key', ...cli.rest]);
    }
    default:
      return fail(`unknown command: ${cli.command}. Run "hive-router --help".`);
  }
}
