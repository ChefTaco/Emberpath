import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const buildOpenApiSpec = () => JSON.parse(readFileSync(new URL('../contracts/oathweave.openapi.json', import.meta.url), 'utf8'));

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
};

type Operation = {
  operationId?: string;
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: JsonSchema;
      };
    };
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(__dirname, '../src/contracts/ui-api.generated.ts');
const checkOnly = process.argv.includes('--check');

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
}

function pascal(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function schemaRefName(ref: string): string {
  const name = ref.split('/').pop();
  assert.ok(name, `Invalid schema ref: ${ref}`);
  return `Iam${name}`;
}

function schemaToType(schema: JsonSchema | undefined): string {
  if (!schema) return 'JsonRequestBody';
  if (schema.$ref) return schemaRefName(schema.$ref);

  if (schema.anyOf) return schema.anyOf.map(schemaToType).join(' | ');
  if (schema.oneOf) return schema.oneOf.map(schemaToType).join(' | ');
  if (schema.allOf) return schema.allOf.map(schemaToType).join(' & ');

  if (schema.enum) {
    const base = schema.enum.map(literal).join(' | ') || 'never';
    return schema.nullable ? `${base} | null` : base;
  }

  const rawType = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = schema.nullable || rawType.includes('null');
  const concreteTypes = rawType.filter((type) => type !== 'null');
  const type = concreteTypes[0];

  let result: string;
  if (type === 'string') {
    result = 'string';
  } else if (type === 'integer' || type === 'number') {
    result = 'number';
  } else if (type === 'boolean') {
    result = 'boolean';
  } else if (type === 'array') {
    const itemType = schemaToType(schema.items);
    result = `${itemType.includes(' | ') || itemType.includes(' & ') ? `(${itemType})` : itemType}[]`;
  } else if (type === 'object' || schema.properties || schema.additionalProperties) {
    const fields = Object.entries(schema.properties ?? {}).map(([key, child]) => {
      const optional = schema.required?.includes(key) ? '' : '?';
      return `  ${JSON.stringify(key)}${optional}: ${schemaToType(child)};`;
    });
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      fields.push(`  [key: string]: ${schemaToType(schema.additionalProperties)};`);
    } else if (schema.additionalProperties === true) {
      fields.push('  [key: string]: JsonRequestBody;');
    }
    result = fields.length > 0 ? `{\n${fields.join('\n')}\n}` : 'JsonRequestObject';
  } else {
    result = 'JsonRequestBody';
  }

  return nullable ? `${result} | null` : result;
}

function requestSchemaFromOperation(operation: Operation): JsonSchema | null {
  return operation.requestBody?.content?.['application/json']?.schema ?? null;
}

function proxiedIamPath(path: string): string {
  return path.replace(/^\/api\/v1\//, '/api/iam/');
}

function render(): string {
  const spec = buildOpenApiSpec();
  assertRecord(spec, 'OpenAPI spec');
  assertRecord(spec.components, 'OpenAPI components');
  assertRecord(spec.components.schemas, 'OpenAPI component schemas');
  assertRecord(spec.paths, 'OpenAPI paths');

  const schemas = spec.components.schemas as Record<string, JsonSchema>;
  const schemaEntries = Object.entries(schemas)
    .filter(([name]) => name.endsWith('Request'))
    .sort(([left], [right]) => left.localeCompare(right));

  const operations: Array<{ key: string; method: string; path: string; typeName: string }> = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    assertRecord(pathItem, `OpenAPI path ${path}`);
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
      assertRecord(rawOperation, `${method.toUpperCase()} ${path}`);
      const operation = rawOperation as Operation;
      const schema = requestSchemaFromOperation(operation);
      if (!schema) continue;
      const operationId = operation.operationId ?? `${method}${pascal(path)}`;
      const typeName = schema.$ref ? schemaRefName(schema.$ref) : `Iam${pascal(operationId)}Request`;
      operations.push({ key: operationId, method: method.toUpperCase(), path, typeName });
      if (!schema.$ref && !schemas[typeName.replace(/^Iam/, '')]) {
        schemas[typeName.replace(/^Iam/, '')] = schema;
      }
    }
  }

  const inlineSchemaEntries = Object.entries(schemas)
    .filter(([name]) => name.endsWith('Request') || name.startsWith('UpdatePasswordPolicy') || name.startsWith('CheckPasswordStrength'))
    .sort(([left], [right]) => left.localeCompare(right));

  const declarations = inlineSchemaEntries.map(([name, schema]) => `export type Iam${name} = ${schemaToType(schema)};`);
  const operationRows = operations
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((operation) => `  ${JSON.stringify(operation.key)}: ${operation.typeName};`);
  const routeRows = operations
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`))
    .map((operation) => `  ${JSON.stringify(`${operation.method} ${proxiedIamPath(operation.path)}`)}: ${operation.typeName};`);

  return `// Generated by services/hive-router/scripts/generate-ui-contracts.ts.\n// Do not edit by hand.\n\nexport type JsonRequestPrimitive = string | number | boolean | null;\nexport type JsonRequestBody = JsonRequestPrimitive | JsonRequestBody[] | object;\nexport interface JsonRequestObject {\n  [key: string]: JsonRequestBody | undefined;\n}\n\n${declarations.join('\n\n')}\n\nexport interface IamRequestBodyByOperation {\n${operationRows.join('\n')}\n}\n\nexport interface IamProxyRequestBodyByRoute {\n${routeRows.join('\n')}\n}\n`;
}

const rendered = render();
if (checkOnly) {
  const current = readFileSync(outFile, 'utf8');
  assert.equal(current, rendered, `${outFile} is stale. Run npm --prefix services/hive-router run contracts:generate.`);
} else {
  writeFileSync(outFile, rendered);
}
