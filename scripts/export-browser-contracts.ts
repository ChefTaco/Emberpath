import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportModelAdminContract} from './lib/browser-contract-export.js';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw Error('--output NEW_DIRECTORY is required');
exportModelAdminContract(fileURLToPath(new URL('../', import.meta.url)), resolve(args[1]));
