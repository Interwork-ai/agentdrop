CREATE TABLE "account_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_recovery_codes" ADD CONSTRAINT "account_recovery_codes_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_recovery_codes_hash_uq" ON "account_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "account_recovery_codes_user_idx" ON "account_recovery_codes" USING btree ("user_id");