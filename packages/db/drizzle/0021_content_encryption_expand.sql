CREATE TABLE "content_key_checks" (
	"kid" text PRIMARY KEY NOT NULL,
	"check" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"plaintext_reads" boolean DEFAULT true NOT NULL,
	"backfill" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "safe_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "content_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drops" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drops" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drops" ALTER COLUMN "extensions" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "hash_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "dek" "bytea";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "payload_enc" "bytea";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "dek" "bytea";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "meta_enc" "bytea";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "blob_format" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "legacy_storage_key" text;--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "dek" "bytea";--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "title_enc" "bytea";--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "body_enc" "bytea";--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "extensions_enc" "bytea";--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "hash_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "send_requests" ADD COLUMN "hash_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
INSERT INTO "content_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;