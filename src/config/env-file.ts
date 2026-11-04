import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let explicitEnvFile: string | null = null;

/**
 * Load a dotenv file named on the command line (`--env-file`). Variables that
 * are already set in the process environment win over the file. Once an
 * explicit file is loaded, the implicit `.env` / `.env.apikeys` lookup in the
 * working directory is skipped, so an unrelated `.env` cannot leak in.
 *
 * This module has no side effects on import; call it before the config module
 * (`./env.js`) is first imported.
 */
export function loadExplicitEnvFile(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`env file not found: ${absolute}`);
  }
  process.loadEnvFile(absolute);
  explicitEnvFile = absolute;
  return absolute;
}

export function explicitEnvFileLoaded(): string | null {
  return explicitEnvFile;
}
