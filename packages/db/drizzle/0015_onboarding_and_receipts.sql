CREATE TABLE "contact_invite_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_users" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_invite_links" ADD CONSTRAINT "contact_invite_links_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_invite_links_token_uq" ON "contact_invite_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "contact_invite_links_owner_idx" ON "contact_invite_links" USING btree ("owner_user_id");