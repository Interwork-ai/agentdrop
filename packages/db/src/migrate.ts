/**
 * One-shot migration runner. Run as a separate job before starting API instances
 * (never let every API replica race on migrations).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

export async function runMigrations(connectionString: string): Promise<void> {
  const db = createDatabase(connectionString, { max: 1 });
  try {
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    await migrate(db.drizzle, { migrationsFolder });
  } finally {
    await db.close();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[agentdrop-db] DATABASE_URL is required');
    process.exit(2);
  }
  runMigrations(url)
    .then(() => {
      console.log('[agentdrop-db] migrations applied');
    })
    .catch((err) => {
      console.error('[agentdrop-db] migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
