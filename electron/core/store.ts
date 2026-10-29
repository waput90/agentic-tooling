import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const tables = [
  'agents',
  'plans',
  'approvals',
  'runs',
  'attempts',
  'context',
  'mcp',
  'events',
  'usage',
  'settings',
  'secrets',
] as const;
export type Table = (typeof tables)[number];
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));',
    );
    for (const table of tables)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id), data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX IF NOT EXISTS ${table}_workspace ON ${table}(workspace_id);`,
      );
    this.db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS events_attempt ON events(workspace_id, json_extract(data,'$.attemptId'));",
    );
  }
  put<T>(table: Table | 'workspaces', id: string, data: T, workspaceId?: string) {
    if (table === 'workspaces')
      this.db
        .prepare(
          'INSERT INTO workspaces VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(id, JSON.stringify(data));
    else {
      const existing = this.db.prepare(`SELECT workspace_id FROM ${table} WHERE id=?`).get(id);
      if (existing && existing.workspace_id !== (workspaceId ?? null))
        throw new Error('Cross-workspace ownership rejected');
      this.db
        .prepare(
          `INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
        )
        .run(id, workspaceId ?? null, JSON.stringify(data));
    }
  }
  get<T>(table: Table | 'workspaces', id: string, workspaceId?: string): T {
    const row =
      table === 'workspaces'
        ? this.db.prepare('SELECT data FROM workspaces WHERE id=?').get(id)
        : this.db
            .prepare(`SELECT data FROM ${table} WHERE id=? AND workspace_id IS ?`)
            .get(id, workspaceId ?? null);
    if (!row) throw new Error('Record not found in this workspace');
    return JSON.parse(row.data as string) as T;
  }
  list<T>(table: Table | 'workspaces', workspaceId?: string): T[] {
    const rows =
      table === 'workspaces' || workspaceId === undefined
        ? this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all()
        : this.db
            .prepare(`SELECT data FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
            .all(workspaceId);
    return rows.map((row) => JSON.parse(row.data as string) as T);
  }
  remove(table: Table, id: string, workspaceId?: string) {
    this.db
      .prepare(`DELETE FROM ${table} WHERE id=? AND workspace_id IS ?`)
      .run(id, workspaceId ?? null);
  }
  events(workspaceId: string, attemptId: string, offset: number) {
    return this.db
      .prepare(
        "SELECT data FROM events WHERE workspace_id=? AND json_extract(data,'$.attemptId')=? ORDER BY rowid LIMIT 100 OFFSET ?",
      )
      .all(workspaceId, attemptId, offset)
      .map((row) => JSON.parse(row.data as string));
  }
  has(table: Table, id: string) {
    return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async backup(path: string) {
    await backup(this.db, path);
  }
  close() {
    this.db.close();
  }
}
