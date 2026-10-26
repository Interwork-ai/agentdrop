-- Index for the event retention sweep (ADR 0040). The migrator runs each file inside a transaction
-- (packages/db/src/migrate.ts), so this cannot be CREATE INDEX CONCURRENTLY, and a plain build blocks inserts into
-- mailbox_events (every send, state change and group change) while it runs. mailbox_events was never swept before
-- this release, so on a server with a long history build the same index by hand first, without blocking writes
-- (docs/DEPLOY.md, "Upgrades / rollback"):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "mailbox_events_created_idx" ON "mailbox_events" USING btree ("created_at");
-- IF NOT EXISTS then makes this statement do nothing. Keep the name and definition in step with the schema.
CREATE INDEX IF NOT EXISTS "mailbox_events_created_idx" ON "mailbox_events" USING btree ("created_at");
