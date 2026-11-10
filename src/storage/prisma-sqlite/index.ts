// Adapted from Prisma 7.8.0 (Apache-2.0). See LICENSE in this directory.
// https://github.com/prisma/prisma/tree/7.8.0/packages/adapter-better-sqlite3
// Uses patched Node-API SQLite with native parameter/error conversion.
import type {
  IsolationLevel,
  SqlDriverAdapter,
  SqlMigrationAwareDriverAdapterFactory,
  SqlQuery,
  SqlQueryable,
  SqlResultSet,
  Transaction,
  TransactionOptions,
} from '@prisma/driver-adapter-utils'
import { Debug, DriverAdapterError } from '@prisma/driver-adapter-utils'
import { Mutex } from 'async-mutex'
import { DatabaseSync } from '@photostructure/sqlite'
import { assertPatchedSqliteVersion } from '../sqlite.js'

const packageName = 'prisma-sqlite-photostructure'
import { getColumnTypes, mapArg, mapRow, Row } from './conversion.js'
import { convertDriverError } from './errors.js'

const debug = Debug('prisma:driver-adapter:better-sqlite3')

type StdClient = DatabaseSync
type BetterSQLite3Options = { readonly?: boolean; timeout?: number }

type BetterSQLite3ResultSet = {
  declaredTypes: Array<string | null>
  columnNames: string[]
  values: unknown[][]
}

type BetterSQLite3Meta = {
  /**
   * the total number of rows that were inserted, updated, or deleted by an operation.
   */
  changes: number

  /**
   * The rowid of the last row inserted into the database.
   */
  lastInsertRowid: number | bigint
}

class BetterSQLite3Queryable<ClientT extends StdClient> implements SqlQueryable {
  readonly provider = 'sqlite'
  readonly adapterName = packageName

  constructor(
    protected readonly client: ClientT,
    protected readonly adapterOptions?: PrismaBetterSqlite3Options,
  ) {}

  /**
   * Execute a query given as SQL, interpolating the given parameters.
   */
  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const tag = '[js::queryRaw]'
    debug(`${tag} %O`, query)

    const { columnNames, declaredTypes, values } = await this.performIO(query)
    const rows = values as Array<Row>

    const columnTypes = getColumnTypes(declaredTypes, rows)

    return {
      columnNames,
      columnTypes,
      rows: rows.map((row) => mapRow(row, columnTypes)),
    }
  }

  /**
   * Execute a query given as SQL, interpolating the given parameters and
   * returning the number of affected rows.
   * Note: Queryable expects a u64, but napi.rs only supports u32.
   */
  async executeRaw(query: SqlQuery): Promise<number> {
    const tag = '[js::executeRaw]'
    debug(`${tag} %O`, query)

    return (await this.executeIO(query)).changes
  }

  /**
   * Run a query against the database, returning the result set.
   * Should the query fail due to a connection error, the connection is
   * marked as unhealthy.
   */
  private executeIO(query: SqlQuery): Promise<BetterSQLite3Meta> {
    try {
      const args = query.args.map((arg, i) => mapArg(arg, query.argTypes[i]!, this.adapterOptions))
      const stmt = this.client.prepare(query.sql)
      const result = stmt.run(...args)

      const changes = Number(result.changes)
      if (!Number.isSafeInteger(changes) || changes < 0) throw new RangeError('SQLite change count exceeds the supported range')
      return Promise.resolve({ ...result, changes })
    } catch (e) {
      this.onError(e)
    }
  }

  /**
   * Run a query against the database, returning the result set.
   * Should the query fail due to a connection error, the connection is
   * marked as unhealthy.
   */
  private performIO(query: SqlQuery): Promise<BetterSQLite3ResultSet> {
    try {
      const args = query.args.map((arg, i) => mapArg(arg, query.argTypes[i]!, this.adapterOptions))
      const stmt = this.client.prepare(query.sql)

      // Queries that do not return data (e.g. inserts) cannot call stmt.raw()/stmt.columns(). => Use stmt.run() instead.
      const columns = stmt.columns()
      if (columns.length === 0) {
        stmt.run(...args)
        return Promise.resolve({
          columnNames: [],
          declaredTypes: [],
          values: [],
        })
      }

      stmt.setReturnArrays(true)

      const resultSet = {
        declaredTypes: columns.map((column) => column.type),
        columnNames: columns.map((column) => column.name),
        values: stmt.all(...args) as unknown[][],
      }

      return Promise.resolve(resultSet)
    } catch (e) {
      this.onError(e)
    }
  }

  protected onError(error: unknown): never {
    debug('Error in performIO: %O', error)
    throw new DriverAdapterError(convertDriverError(error))
  }
}

class BetterSQLite3Transaction extends BetterSQLite3Queryable<StdClient> implements Transaction {
  readonly #unlockParent: () => void

  constructor(
    client: StdClient,
    readonly options: TransactionOptions,
    adapterOptions: PrismaBetterSqlite3Options | undefined,
    unlockParent: () => void,
  ) {
    super(client, adapterOptions)
    this.#unlockParent = unlockParent
  }

  commit(): Promise<void> {
    debug(`[js::commit]`)
    this.#unlockParent()
    return Promise.resolve()
  }

  rollback(): Promise<void> {
    debug(`[js::rollback]`)
    this.#unlockParent()
    return Promise.resolve()
  }

  async createSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `SAVEPOINT ${name}`, args: [], argTypes: [] })
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `ROLLBACK TO ${name}`, args: [], argTypes: [] })
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `RELEASE SAVEPOINT ${name}`, args: [], argTypes: [] })
  }
}

export class PrismaBetterSqlite3Adapter extends BetterSQLite3Queryable<StdClient> implements SqlDriverAdapter {
  #mutex = new Mutex()

  constructor(client: StdClient, adapterOptions?: PrismaBetterSqlite3Options) {
    super(client, adapterOptions)
  }

  executeScript(script: string): Promise<void> {
    try {
      this.client.exec(script)
    } catch (e) {
      this.onError(e)
    }
    return Promise.resolve()
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (isolationLevel && isolationLevel !== 'SERIALIZABLE') {
      throw new DriverAdapterError({
        kind: 'InvalidIsolationLevel',
        level: isolationLevel,
      })
    }

    const options: TransactionOptions = {
      usePhantomQuery: false,
    }

    const tag = '[js::startTransaction]'
    debug('%s options: %O', tag, options)

    let release: (() => void) | undefined
    try {
      release = await this.#mutex.acquire()

      this.client.prepare('BEGIN').run()

      return new BetterSQLite3Transaction(this.client, options, this.adapterOptions, release)
    } catch (e) {
      // A failed BEGIN owns no new transaction, but must release its queue slot.
      release?.()
      this.onError(e)
    }
  }

  dispose(): Promise<void> {
    this.client.close()
    return Promise.resolve()
  }
}

type BetterSQLite3InputParams = BetterSQLite3Options & {
  url: ':memory:' | (string & {})
}

export type PrismaBetterSqlite3Options = {
  shadowDatabaseUrl?: string
  timestampFormat?: 'iso8601' | 'unixepoch-ms'
}

export class PrismaSqlite implements SqlMigrationAwareDriverAdapterFactory {
  readonly provider = 'sqlite'
  readonly adapterName = packageName

  readonly #config: BetterSQLite3InputParams
  readonly #options: PrismaBetterSqlite3Options | undefined

  constructor(config: BetterSQLite3InputParams, options?: PrismaBetterSqlite3Options) {
    this.#config = config
    this.#options = options
  }

  connect(): Promise<SqlDriverAdapter> {
    return Promise.resolve(new PrismaBetterSqlite3Adapter(createBetterSQLite3Client(this.#config), this.#options))
  }

  connectToShadowDb(): Promise<SqlDriverAdapter> {
    const url = this.#options?.shadowDatabaseUrl ?? ':memory:'
    return Promise.resolve(
      new PrismaBetterSqlite3Adapter(createBetterSQLite3Client({ ...this.#config, url }), this.#options),
    )
  }
}

function createBetterSQLite3Client(input: BetterSQLite3InputParams): StdClient {
  const { url, ...config } = input
  const dbPath = url.replace(/^file:/, '')
  const db = new DatabaseSync(dbPath, { readOnly: config.readonly ?? false, timeout: config.timeout ?? 5000, readBigInts: true })
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: unknown }
    assertPatchedSqliteVersion(row.version)
    return db
  } catch (error) { db.close(); throw error }
}
