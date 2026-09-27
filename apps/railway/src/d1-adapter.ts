import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

type Value = string | number | bigint | Uint8Array | null

function values(args: unknown[]): Value[] {
  return args.map((value) => value === undefined ? null : value instanceof ArrayBuffer ? new Uint8Array(value) : value) as Value[]
}

export class SQLiteStatement {
  constructor(private readonly db: DatabaseSync, readonly query: string, readonly params: Value[] = []) {}

  bind(...params: unknown[]): SQLiteStatement {
    return new SQLiteStatement(this.db, this.query, values(params))
  }

  private statement(): StatementSync { return this.db.prepare(this.query) }

  hasRows(): boolean { return this.statement().columns().length > 0 }

  first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.statement().get(...this.params) as Record<string, unknown> | undefined
    return Promise.resolve((column === undefined ? row : row?.[column]) as T ?? null)
  }

  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, number> }> {
    return Promise.resolve(this.allSync<T>())
  }

  allSync<T = Record<string, unknown>>() {
    return { results: this.statement().all(...this.params) as T[], success: true as const, meta: { changes: 0 } }
  }

  raw<T = unknown[]>(): Promise<T[]> {
    const statement = this.statement()
    statement.setReturnArrays(true)
    return Promise.resolve(statement.all(...this.params) as T[])
  }

  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    return Promise.resolve(this.runSync())
  }

  runSync() {
    const result = this.statement().run(...this.params)
    return { success: true as const, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }
  }
}

export class SQLiteD1 {
  readonly sqlite: DatabaseSync

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.sqlite = new DatabaseSync(path, { timeout: 30_000 })
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON;')
  }

  prepare(query: string): SQLiteStatement { return new SQLiteStatement(this.sqlite, query) }

  async batch(statements: SQLiteStatement[]) {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => statement.hasRows() ? statement.allSync() : statement.runSync())
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  async exec(query: string) {
    this.sqlite.exec(query)
    return { count: 1, duration: 0 }
  }

  ping(): boolean { return this.sqlite.prepare('SELECT 1').get() !== undefined }
  close(): void { this.sqlite.close() }
}
