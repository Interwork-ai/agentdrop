CREATE TABLE "feishu_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"open_id" text NOT NULL,
	"union_id" text,
	"tenant_key" text,
	"language" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_cards" (
	"user_id" uuid NOT NULL,
	"drop_id" uuid NOT NULL,
	"h_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"shown_read" boolean DEFAULT false NOT NULL,
	"shown_starred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_link_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_link_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"open_id" text NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feishu_accounts" ADD CONSTRAINT "feishu_accounts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_cards" ADD CONSTRAINT "feishu_cards_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_link_codes" ADD CONSTRAINT "feishu_link_codes_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_accounts_app_open_id_uq" ON "feishu_accounts" USING btree ("app_id","open_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_cards_user_drop_uq" ON "feishu_cards" USING btree ("user_id","drop_id");--> statement-breakpoint
CREATE INDEX "feishu_cards_created_idx" ON "feishu_cards" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feishu_link_codes_user_idx" ON "feishu_link_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feishu_link_failures_open_id_idx" ON "feishu_link_failures" USING btree ("app_id","open_id","failed_at");