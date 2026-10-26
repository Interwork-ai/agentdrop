-- Index for the worker's sweep of ended rate-limit windows (rate_limits is small and short-lived, so the build is quick).
CREATE INDEX "rate_limits_reset_at_idx" ON "rate_limits" USING btree ("reset_at");
