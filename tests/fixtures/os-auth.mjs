#!/usr/bin/env node

const username = process.argv[2] ?? '';
let password = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  password += chunk;
});

process.stdin.on('end', () => {
  const ok = username === 'admin' && password.trimEnd() === 'playwright-secret';
  process.exit(ok ? 0 : 1);
});
