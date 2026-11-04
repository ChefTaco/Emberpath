// Source-checkout entry for the API key CLI (`npm run cli -- create-key ...`).
// The installed package exposes the same command as `hive-router create-key`.
import { runApiKeyCli } from './commands/create-key.js';

process.exitCode = await runApiKeyCli(process.argv.slice(2));
