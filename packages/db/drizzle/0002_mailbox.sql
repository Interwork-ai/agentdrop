CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'consumed');--> statement-breakpoint
CREATE TYPE "public"."attachment_status" AS ENUM('staging', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('invited', 'requested', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."grant_kind" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'left', 'removed');--> statement-breakpoint
CREATE TYPE "public"."origin_kind" AS ENUM('mcp', 'web');--> statement-breakpoint
CREATE TYPE "public"."send_outcome" AS ENUM('delivered', 'needs_approval', 'not_sent');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"origin_h_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"target_snapshot" jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploaded_by_h_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"safe_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"status" "attachment_status" DEFAULT 'staging' NOT NULL,
	"review_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"peer_user_id" uuid NOT NULL,
	"status" "contact_status" NOT NULL,
	"blocked_at" timestamp with time zone,
	"remark" text,
	"preferred_route_id" uuid,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drop_id" uuid NOT NULL,
	"h_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"starred_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"state_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"kind" "grant_kind" NOT NULL,
	"route_id" uuid,
	"group_id" uuid,
	"membership_id" uuid,
	"binding_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drop_attachments" (
	"drop_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "drop_attachments_drop_id_attachment_id_pk" PRIMARY KEY("drop_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" uuid NOT NULL,
	"origin_h_id" uuid NOT NULL,
	"origin_kind" "origin_kind" NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_chars" integer NOT NULL,
	"extensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"author_snapshot" jsonb NOT NULL,
	"target_snapshot" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"h_id" uuid NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"status" "membership_status" DEFAULT 'invited' NOT NULL,
	"nickname" text,
	"invited_by_user_id" uuid,
	"muted" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"avatar_attachment_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"h_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"type" text NOT NULL,
	"drop_id" uuid,
	"delivery_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_heads" (
	"h_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "send_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origin_h_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"outcome" "send_outcome" NOT NULL,
	"result_drop_id" uuid,
	"approval_id" uuid,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_origin_h_id_harness_endpoints_id_fk" FOREIGN KEY ("origin_h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_h_id_harness_endpoints_id_fk" FOREIGN KEY ("uploaded_by_h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_peer_user_id_app_users_id_fk" FOREIGN KEY ("peer_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_preferred_route_id_recipient_routes_id_fk" FOREIGN KEY ("preferred_route_id") REFERENCES "public"."recipient_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_h_id_harness_endpoints_id_fk" FOREIGN KEY ("h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_grants" ADD CONSTRAINT "delivery_grants_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_grants" ADD CONSTRAINT "delivery_grants_route_id_recipient_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."recipient_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_grants" ADD CONSTRAINT "delivery_grants_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_grants" ADD CONSTRAINT "delivery_grants_membership_id_group_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."group_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_grants" ADD CONSTRAINT "delivery_grants_binding_id_group_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."group_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_attachments" ADD CONSTRAINT "drop_attachments_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_attachments" ADD CONSTRAINT "drop_attachments_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drops" ADD CONSTRAINT "drops_author_user_id_app_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drops" ADD CONSTRAINT "drops_origin_h_id_harness_endpoints_id_fk" FOREIGN KEY ("origin_h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bindings" ADD CONSTRAINT "group_bindings_membership_id_group_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."group_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bindings" ADD CONSTRAINT "group_bindings_h_id_harness_endpoints_id_fk" FOREIGN KEY ("h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_invited_by_user_id_app_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_events" ADD CONSTRAINT "mailbox_events_h_id_harness_endpoints_id_fk" FOREIGN KEY ("h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_heads" ADD CONSTRAINT "mailbox_heads_h_id_harness_endpoints_id_fk" FOREIGN KEY ("h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_requests" ADD CONSTRAINT "send_requests_origin_h_id_harness_endpoints_id_fk" FOREIGN KEY ("origin_h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_requests" ADD CONSTRAINT "send_requests_result_drop_id_drops_id_fk" FOREIGN KEY ("result_drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_actor_idx" ON "approvals" USING btree ("actor_user_id","status");--> statement-breakpoint
CREATE INDEX "attachments_h_idx" ON "attachments" USING btree ("uploaded_by_h_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key_uq" ON "attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_owner_peer_uq" ON "contacts" USING btree ("owner_user_id","peer_user_id");--> statement-breakpoint
CREATE INDEX "contacts_peer_idx" ON "contacts" USING btree ("peer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_drop_h_uq" ON "deliveries" USING btree ("drop_id","h_id");--> statement-breakpoint
CREATE INDEX "deliveries_h_received_idx" ON "deliveries" USING btree ("h_id","received_at","id");--> statement-breakpoint
CREATE INDEX "delivery_grants_delivery_idx" ON "delivery_grants" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "delivery_grants_membership_idx" ON "delivery_grants" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "delivery_grants_binding_idx" ON "delivery_grants" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "drops_origin_idx" ON "drops" USING btree ("origin_h_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "group_bindings_live_uq" ON "group_bindings" USING btree ("membership_id","h_id") WHERE "group_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "group_bindings_h_idx" ON "group_bindings" USING btree ("h_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_live_uq" ON "group_memberships" USING btree ("group_id","user_id") WHERE "group_memberships"."status" in ('invited', 'active');--> statement-breakpoint
CREATE INDEX "group_memberships_user_idx" ON "group_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_slug_uq" ON "groups" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_events_h_revision_uq" ON "mailbox_events" USING btree ("h_id","revision");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."delivered_at" is null and "outbox_events"."dead_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "send_requests_origin_request_uq" ON "send_requests" USING btree ("origin_h_id","request_id");