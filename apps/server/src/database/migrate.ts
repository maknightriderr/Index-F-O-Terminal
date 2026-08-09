// ============================================================
// DATABASE MIGRATION RUNNER
// ============================================================
// Applies database/init/*.sql against DATABASE_URL, in order.
// Locally, Docker's postgres image runs these same files
// automatically via docker-entrypoint-initdb.d; this script is
// for every other target (Railway, Render, Timescale Cloud, CI)
// where nothing runs them for you.
//
// 001_extensions.sql and 003_timescale.sql are applied
// statement-by-statement and BEST-EFFORT: a statement that fails
// (e.g. `CREATE EXTENSION timescaledb` when the extension isn't
// installed on this Postgres) is logged and skipped rather than
// aborting the run, so the exact same files work against both a
// real TimescaleDB instance and a plain managed Postgres.
// 002_schema.sql (the core tables) is required — any failure
// there aborts the migration, since those tables aren't optional.
// ============================================================

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import postgres from 'postgres';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INIT_DIR = path.resolve(__dirname, '../../../../database/init');

const BEST_EFFORT_FILES = new Set(['001_extensions.sql', '003_timescale.sql']);

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function run(): Promise<void> {
  const sql = postgres(config.database.url, { max: 1 });
  const files = readdirSync(INIT_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  logger.info({ files }, 'Running database migrations');

  try {
    for (const file of files) {
      const bestEffort = BEST_EFFORT_FILES.has(file);
      const statements = splitStatements(readFileSync(path.join(INIT_DIR, file), 'utf-8'));
      let applied = 0;
      let skipped = 0;

      for (const statement of statements) {
        try {
          await sql.unsafe(statement);
          applied++;
        } catch (err: any) {
          if (bestEffort) {
            skipped++;
            logger.warn(
              { file, error: err.message, statement: statement.slice(0, 100) },
              'Migration statement skipped (best-effort)'
            );
          } else {
            logger.error(
              { file, error: err.message, statement: statement.slice(0, 100) },
              'Migration failed'
            );
            throw err;
          }
        }
      }

      logger.info({ file, applied, skipped }, 'Migration file processed');
    }

    logger.info('Migrations complete');
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  logger.error({ error: err.message }, 'Migration run failed');
  process.exit(1);
});
