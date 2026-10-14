CREATE TYPE "public"."group_invite_policy" AS ENUM('open', 'admin_approval');--> statement-breakpoint
CREATE TYPE "public"."group_join_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "group_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"invitee_user_id" uuid NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"status" "group_join_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "member_invite_policy" "group_invite_policy" DEFAULT 'open' NOT NULL;--> statement-breakpoint
-- New groups default to 'open'. Groups that already existed were created under "admins invite, contacts only",
-- so they keep the tighter rule until an owner opts in: a migration must not silently widen authorization.
UPDATE "groups" SET "member_invite_policy" = 'admin_approval';--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_invitee_user_id_app_users_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_invited_by_user_id_app_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_decided_by_user_id_app_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_join_requests_live_uq" ON "group_join_requests" USING btree ("group_id","invitee_user_id") WHERE "group_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "group_join_requests_group_idx" ON "group_join_requests" USING btree ("group_id","status");