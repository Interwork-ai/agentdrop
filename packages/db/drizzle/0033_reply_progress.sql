CREATE TYPE "public"."reply_progress" AS ENUM('started', 'done', 'declined', 'needs_info');--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "progress" "reply_progress";