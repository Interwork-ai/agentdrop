-- Index for the event retention sweep (ADR 0040). It is plain CREATE INDEX, which takes a lock that blocks inserts
-- into mailbox_events (i.e. every send, state change and group change) for the duration; CONCURRENTLY is not
-- available because the migrator runs each file inside a transaction (packages/db/src/migrate.ts). mailbox_events
-- has never been swept before this release, so on a server with a long history the build can take a while — treat
-- it as a migration window rather than as free.
CREATE INDEX "mailbox_events_created_idx" ON "mailbox_events" USING btree ("created_at");