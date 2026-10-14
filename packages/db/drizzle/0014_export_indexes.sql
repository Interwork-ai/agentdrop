-- Indexes for date-ranged export. All three are plain CREATE INDEX, which takes a lock that blocks inserts
-- (i.e. all sends) for the duration; CONCURRENTLY is not available because the migrator runs each file inside a
-- transaction (packages/db/src/migrate.ts). On a small table this is milliseconds — treat it as a migration
-- window rather than as free.
CREATE INDEX "delivery_grants_group_idx" ON "delivery_grants" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "drops_author_created_idx" ON "drops" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "drops_targets_idx" ON "drops" USING gin ("target_snapshot");