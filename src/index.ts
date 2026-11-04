#!/usr/bin/env node
// Entry point for `hive-router` (npm bin) and `node dist/src/index.js`
// (systemd, Docker). With no arguments it starts the server.
import { main } from './main.js';

const exitCode = await main(process.argv.slice(2));
if (exitCode !== null) process.exitCode = exitCode;
