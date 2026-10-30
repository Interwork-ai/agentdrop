-- Watch terms for updates that bots post in Feishu groups (ADR 0041); expand-only.
ALTER TABLE "app_users" ADD COLUMN "feishu_watch_terms" text[] DEFAULT '{}'::text[] NOT NULL;