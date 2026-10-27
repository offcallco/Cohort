import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { schema };

export type Db = BetterSQLite3Database<typeof schema>;

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// Opens (or creates) the SQLite database at `file` and applies pending migrations.
// Pass ":memory:" for a throwaway database in tests.
export function openDb(file: string): { db: Db; close: () => void } {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return { db, close: () => sqlite.close() };
}
