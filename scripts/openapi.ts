import { buildRouterOpenApiDocument } from '../src/openapi/spec.js';
import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../docs/openapi.json', import.meta.url);
const document = buildRouterOpenApiDocument('https://models.example.com');
const expected =
  JSON.stringify(
    document,
    (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
    2,
  ) + '\n';
if (process.argv.includes('--write')) writeFileSync(file, expected);
else if (readFileSync(file, 'utf8') !== expected)
  throw new Error('OpenAPI drift: run npm run generate:openapi');
else console.log('Owned OpenAPI baseline is current');
