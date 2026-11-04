import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const schemaPath = resolve(repoRoot, 'prisma/schema.prisma');
const outputPath = resolve(repoRoot, 'src/storage/generated-sqlite-schema.ts');

const scalarTypes = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime']);

type PrismaField = {
  name: string;
  rawType: string;
  type: string;
  optional: boolean;
  list: boolean;
  line: string;
};

type ForeignKey = {
  fieldNames: string[];
  referenceModel: string;
  referenceFields: string[];
  onDelete: string | null;
  onUpdate: string | null;
};

type PrismaModel = {
  name: string;
  fields: PrismaField[];
  uniqueIndexes: string[][];
  indexes: string[][];
  foreignKeys: ForeignKey[];
};

function trimComment(line: string): string {
  const commentIndex = line.indexOf('//');
  return commentIndex >= 0 ? line.slice(0, commentIndex).trim() : line.trim();
}

function parseBracketList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRelation(line: string, referenceModel: string): ForeignKey | null {
  const relationMatch = /@relation\(([^)]*)\)/.exec(line);
  if (!relationMatch) return null;
  const relation = relationMatch[1] ?? '';
  const fieldsMatch = /fields:\s*\[([^\]]+)\]/.exec(relation);
  const referencesMatch = /references:\s*\[([^\]]+)\]/.exec(relation);
  if (!fieldsMatch || !referencesMatch) return null;
  const onDeleteMatch = /onDelete:\s*(\w+)/.exec(relation);
  const onUpdateMatch = /onUpdate:\s*(\w+)/.exec(relation);
  return {
    fieldNames: parseBracketList(fieldsMatch[1] ?? ''),
    referenceModel,
    referenceFields: parseBracketList(referencesMatch[1] ?? ''),
    onDelete: onDeleteMatch?.[1] ?? null,
    onUpdate: onUpdateMatch?.[1] ?? null,
  };
}

function parsePrismaSchema(schema: string): { enumNames: Set<string>; models: PrismaModel[] } {
  const enumNames = new Set<string>();
  for (const match of schema.matchAll(/^enum\s+(\w+)\s*{/gm)) {
    enumNames.add(match[1] ?? '');
  }

  const models: PrismaModel[] = [];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*{([\s\S]*?)^}/gm)) {
    const name = match[1] ?? '';
    const body = match[2] ?? '';
    const fields: PrismaField[] = [];
    const uniqueIndexes: string[][] = [];
    const indexes: string[][] = [];
    const foreignKeys: ForeignKey[] = [];

    for (const rawLine of body.split('\n')) {
      const line = trimComment(rawLine);
      if (!line) continue;

      const uniqueMatch = /^@@unique\(\[([^\]]+)\]\)/.exec(line);
      if (uniqueMatch) {
        uniqueIndexes.push(parseBracketList(uniqueMatch[1] ?? ''));
        continue;
      }
      const indexMatch = /^@@index\(\[([^\]]+)\]\)/.exec(line);
      if (indexMatch) {
        indexes.push(parseBracketList(indexMatch[1] ?? ''));
        continue;
      }

      if (line.startsWith('@@')) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;

      const fieldName = parts[0] ?? '';
      const rawType = parts[1] ?? '';
      const list = rawType.endsWith('[]');
      const withoutList = list ? rawType.slice(0, -2) : rawType;
      const optional = withoutList.endsWith('?');
      const type = optional ? withoutList.slice(0, -1) : withoutList;

      const field: PrismaField = { name: fieldName, rawType, type, optional, list, line };
      fields.push(field);

      if (!scalarTypes.has(type) && !enumNames.has(type)) {
        const foreignKey = parseRelation(line, type);
        if (foreignKey) foreignKeys.push(foreignKey);
      }
    }

    models.push({ name, fields, uniqueIndexes, indexes, foreignKeys });
  }

  return { enumNames, models };
}

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replaceAll('"', '""') + '"';
}

function quoteString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function sqliteTypeFor(field: PrismaField, enumNames: Set<string>): string | null {
  if (enumNames.has(field.type)) return 'TEXT';
  switch (field.type) {
    case 'String': return 'TEXT';
    case 'Int': return 'INTEGER';
    case 'Float': return 'REAL';
    case 'Boolean': return 'BOOLEAN';
    case 'DateTime': return 'DATETIME';
    default: return null;
  }
}

function defaultSql(line: string): string | null {
  const match = /@default\((cuid\(\)|uuid\(\)|now\(\)|true|false|-?\d+|"[^"]*"|\w+)\)/.exec(line);
  if (!match) return null;
  const rawValue = (match[1] ?? '').trim();
  if (rawValue === 'cuid()' || rawValue === 'uuid()') return null;
  if (rawValue === 'now()') return 'CURRENT_TIMESTAMP';
  if (rawValue === 'true' || rawValue === 'false') return rawValue;
  if (/^-?\d+$/.test(rawValue)) return rawValue;
  const quoted = /^"([\s\S]*)"$/.exec(rawValue);
  if (quoted) return quoteString(quoted[1] ?? '');
  return quoteString(rawValue);
}

function referentialActionSql(action: string | null, fallback: string): string {
  const normalized = action ?? fallback;
  switch (normalized) {
    case 'Cascade': return 'CASCADE';
    case 'SetNull': return 'SET NULL';
    case 'Restrict': return 'RESTRICT';
    case 'NoAction': return 'NO ACTION';
    default: throw new Error('Unsupported referential action: ' + normalized);
  }
}

function columnSql(field: PrismaField, enumNames: Set<string>): string | null {
  if (field.list) return null;
  const type = sqliteTypeFor(field, enumNames);
  if (!type) return null;

  const parts = [quoteIdentifier(field.name), type];
  if (!field.optional) parts.push('NOT NULL');
  if (field.line.includes('@id')) parts.push('PRIMARY KEY');
  const defaultValue = defaultSql(field.line);
  if (defaultValue) parts.push('DEFAULT ' + defaultValue);
  return parts.join(' ');
}

/**
 * Build the column fragment used by `ALTER TABLE ... ADD COLUMN` for additive
 * migrations against an already-populated database. Returns null when the
 * column cannot be safely added to an existing table, which SQLite disallows
 * for a primary key, a NOT NULL column without a constant default, or a NOT
 * NULL column whose default is non-constant (for example CURRENT_TIMESTAMP).
 * Such columns only ever exist at table-creation time.
 */
function addColumnFragment(field: PrismaField, enumNames: Set<string>): string | null {
  if (field.list) return null;
  if (field.line.includes('@id')) return null;
  const type = sqliteTypeFor(field, enumNames);
  if (!type) return null;

  const defaultValue = defaultSql(field.line);
  const hasConstantDefault = defaultValue !== null && defaultValue !== 'CURRENT_TIMESTAMP';
  if (!field.optional && !hasConstantDefault) {
    return null;
  }

  const parts = [quoteIdentifier(field.name), type];
  if (!field.optional) parts.push('NOT NULL');
  if (defaultValue) parts.push('DEFAULT ' + defaultValue);
  return parts.join(' ');
}

function uniqueIndexName(modelName: string, fields: string[]): string {
  return modelName + '_' + fields.join('_') + '_key';
}

function buildCreateTableStatement(model: PrismaModel, enumNames: Set<string>): string {
  const entries = model.fields
    .map((field) => columnSql(field, enumNames))
    .filter((entry): entry is string => Boolean(entry));

  for (const foreignKey of model.foreignKeys) {
    const fields = foreignKey.fieldNames.map(quoteIdentifier).join(', ');
    const references = foreignKey.referenceFields.map(quoteIdentifier).join(', ');
    entries.push(
      'CONSTRAINT ' + quoteIdentifier(model.name + '_' + foreignKey.fieldNames.join('_') + '_fkey')
      + ' FOREIGN KEY (' + fields + ') REFERENCES ' + quoteIdentifier(foreignKey.referenceModel)
      + ' (' + references + ') ON DELETE ' + referentialActionSql(foreignKey.onDelete, 'Restrict')
      + ' ON UPDATE ' + referentialActionSql(foreignKey.onUpdate, 'Cascade'),
    );
  }

  return 'CREATE TABLE IF NOT EXISTS ' + quoteIdentifier(model.name) + ' (\n  '
    + entries.join(',\n  ')
    + '\n)';
}

function buildUniqueIndexStatement(modelName: string, fields: string[]): string {
  return 'CREATE UNIQUE INDEX IF NOT EXISTS ' + quoteIdentifier(uniqueIndexName(modelName, fields))
    + ' ON ' + quoteIdentifier(modelName)
    + ' (' + fields.map(quoteIdentifier).join(', ') + ')';
}

function buildIndexStatement(modelName: string, fields: string[]): string {
  return 'CREATE INDEX IF NOT EXISTS ' + quoteIdentifier(modelName + '_' + fields.join('_') + '_idx')
    + ' ON ' + quoteIdentifier(modelName)
    + ' (' + fields.map(quoteIdentifier).join(', ') + ')';
}

export function buildSqliteSchemaStatements(schema: string): string[] {
  const parsed = parsePrismaSchema(schema);
  const statements: string[] = [];
  for (const model of parsed.models) {
    statements.push(buildCreateTableStatement(model, parsed.enumNames));
    for (const field of model.fields) {
      if (field.line.includes('@unique') && !field.line.includes('@id')) {
        statements.push(buildUniqueIndexStatement(model.name, [field.name]));
      }
    }
    for (const indexFields of model.uniqueIndexes) {
      statements.push(buildUniqueIndexStatement(model.name, indexFields));
    }
    for (const indexFields of model.indexes) {
      statements.push(buildIndexStatement(model.name, indexFields));
    }
  }
  return statements;
}

export type ColumnMigration = {
  table: string;
  column: string;
  sql: string;
};

/**
 * Build additive `ALTER TABLE ... ADD COLUMN` migrations for every column that
 * can be safely added to an existing database. The startup reconciler compares
 * these against the live table shape and applies only the missing ones, so a
 * new nullable or constant-default column defined in prisma/schema.prisma
 * reaches production databases without a destructive rebuild.
 */
export function buildColumnMigrations(schema: string): ColumnMigration[] {
  const parsed = parsePrismaSchema(schema);
  const migrations: ColumnMigration[] = [];
  for (const model of parsed.models) {
    for (const field of model.fields) {
      const fragment = addColumnFragment(field, parsed.enumNames);
      if (!fragment) continue;
      migrations.push({
        table: model.name,
        column: field.name,
        sql: 'ALTER TABLE ' + quoteIdentifier(model.name) + ' ADD COLUMN ' + fragment,
      });
    }
  }
  return migrations;
}

export function buildGeneratedModule(schema: string): string {
  const statements = buildSqliteSchemaStatements(schema);
  const columnMigrations = buildColumnMigrations(schema);
  const relativeSchemaPath = relative(repoRoot, schemaPath).replaceAll('\\\\', '/');
  return [
    '// Generated from ' + relativeSchemaPath + ' by scripts/generate-sqlite-bootstrap.ts.',
    '// Do not edit by hand; run npm run db:generate-bootstrap in services/hive-router.',
    '',
    'export const sqliteSchemaSource = ' + JSON.stringify(relativeSchemaPath) + ' as const;',
    '',
    'export const schemaStatements = ' + JSON.stringify(statements, null, 2) + ' as const;',
    '',
    'export interface ColumnMigration {',
    '  table: string;',
    '  column: string;',
    '  sql: string;',
    '}',
    '',
    'export const columnMigrations: ColumnMigration[] = ' + JSON.stringify(columnMigrations, null, 2) + ';',
    '',
  ].join('\n');
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const schema = readFileSync(schemaPath, 'utf8');
  const generated = buildGeneratedModule(schema);

  if (checkOnly) {
    const current = readFileSync(outputPath, 'utf8');
    if (current !== generated) {
      throw new Error('SQLite bootstrap schema is stale. Run npm run db:generate-bootstrap.');
    }
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generated);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}
