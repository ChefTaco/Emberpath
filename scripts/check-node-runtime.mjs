// Dependency-free deployment preflight, also streamed over SSH before any writes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertNodeVersion(version, range) {
  const actual = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!actual || typeof range !== 'string') throw Error('A stable Node.js version and package engines range are required');
  const allowed = range.split('||').map(part => {
    const match = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(part.trim());
    if (!match || Number(match[1]) < 1) throw Error('Unsupported package Node.js engines range');
    return match.slice(1).map(Number);
  });
  const current = actual.slice(1).map(Number);
  if (![...current, ...allowed.flat()].every(Number.isSafeInteger)) throw Error('Invalid Node.js version');
  if (!allowed.some(minimum => current[0] === minimum[0] &&
    (current[1] > minimum[1] || current[1] === minimum[1] && current[2] >= minimum[2]))) {
    throw Error(`Node.js ${range} is required; found ${version}`);
  }
}

export function packageNodeRange() {
  const range = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines?.node;
  // Validate syntax before using the value in a remote shell argument.
  if (typeof range !== 'string' || range !== range.trim() || range.length > 200 || !/^\^\d+\.\d+\.\d+(?: *\|\| *\^\d+\.\d+\.\d+)*$/.test(range)) {
    throw Error('Package must declare a bounded Node.js engines range');
  }
  return range;
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--print-range') console.log(packageNodeRange());
    else {
      if (args.length && (args.length !== 2 || args[0] !== '--engines')) throw Error('Use --print-range or --engines RANGE');
      assertNodeVersion(process.versions.node, args.length ? args[1] : packageNodeRange());
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
