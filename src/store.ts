import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ResearchTask, Settings } from './types.js';
export class Store {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'spawner.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS handled (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);');
  }
  settings(defaults: Settings): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string } | undefined;
    const saved = row ? JSON.parse(row.value) : {};
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, saved[key] ?? value])) as unknown as Settings;
  }
  saveSettings(settings: Settings): void { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(1,?)').run(JSON.stringify(settings)); }
  tasks(): ResearchTask[] {
    return (this.db.prepare('SELECT value FROM tasks ORDER BY created_at DESC LIMIT 100').all() as { value: string }[]).map(r => JSON.parse(r.value));
  }
  saveTask(task: ResearchTask): void { this.db.prepare('INSERT OR REPLACE INTO tasks VALUES(?,?,?)').run(task.id, task.createdAt, JSON.stringify(task)); }
  claim(id: string): boolean { return this.db.prepare('INSERT OR IGNORE INTO handled VALUES(?,?)').run(id, Date.now()).changes === 1; }
  deleteTask(id: string): void { this.db.prepare('DELETE FROM tasks WHERE id=?').run(id); }
  close(): void { this.db.close(); }
}
