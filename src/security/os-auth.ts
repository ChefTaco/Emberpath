import { spawn } from 'node:child_process';
import { loadEnv } from '../config/env.js';

const AUTH_TIMEOUT_MS = 10_000;

function allowedUsers(): Set<string> {
  return new Set(
    loadEnv().HIVE_ROUTER_ADMIN_USERS
      .split(',')
      .map((user) => user.trim())
      .filter(Boolean),
  );
}

export const EXTERNALLY_MANAGED_PASSWORD_HASH = '!externally-managed';

export function isAllowedAdminUser(username: string): boolean {
  return allowedUsers().has(username);
}

function authCommand(username: string): { command: string; args: string[] } {
  const configured = loadEnv().HIVE_ROUTER_OS_AUTH_COMMAND?.trim();
  if (configured) {
    return { command: configured, args: [username] };
  }

  return {
    command: 'pamtester',
    args: ['login', username, 'authenticate'],
  };
}

export async function authenticateOsUser(username: string, password: string): Promise<boolean> {
  if (!username || !password || !isAllowedAdminUser(username)) {
    return false;
  }

  const { command, args } = authCommand(username);

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, AUTH_TIMEOUT_MS);

    child.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });

    child.stdin.end(`${password}\n`);
  });
}
