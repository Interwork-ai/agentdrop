CREATE TYPE "public"."harness_key" AS ENUM('codex', 'claude-code', 'other');--> statement-breakpoint
CREATE TYPE "public"."pairing_status" AS ENUM('pending', 'approved', 'denied', 'consumed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."route_visibility" AS ENUM('private', 'contacts');--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_attachment_id" uuid,
	"profile_version" integer DEFAULT 1 NOT NULL,
	"directory_revision" integer DEFAULT 0 NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"h_id" uuid,
	"action" text NOT NULL,
	"target_id" text,
	"result" text NOT NULL,
	"request_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"h_id" uuid NOT NULL,
	"client_name" text,
	"client_version" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bridge_version" text,
	"toolset" text,
	"label" text,
	"last_tool" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"label" text NOT NULL,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "h_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"h_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "harness_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"harness_key" "harness_key" NOT NULL,
	"profile_key" text DEFAULT 'default' NOT NULL,
	"label" text NOT NULL,
	"public_name" text,
	"name_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pairing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"device_label" text NOT NULL,
	"harness_key" "harness_key" NOT NULL,
	"profile_key" text NOT NULL,
	"endpoint_label" text NOT NULL,
	"bridge_version" text NOT NULL,
	"platform" text NOT NULL,
	"status" "pairing_status" DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" uuid,
	"h_id" uuid,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recipient_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"alias" text,
	"label" text NOT NULL,
	"destination_h_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"visibility" "route_visibility" DEFAULT 'private' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_auth_user_id_auth_users_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_h_id_harness_endpoints_id_fk" FOREIGN KEY ("h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "h_credentials" ADD CONSTRAINT "h_credentials_h_id_harness_endpoints_id_fk" FOREIGN KEY ("h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_endpoints" ADD CONSTRAINT "harness_endpoints_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_endpoints" ADD CONSTRAINT "harness_endpoints_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_requests" ADD CONSTRAINT "pairing_requests_approved_by_user_id_app_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_requests" ADD CONSTRAINT "pairing_requests_h_id_harness_endpoints_id_fk" FOREIGN KEY ("h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_routes" ADD CONSTRAINT "recipient_routes_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_routes" ADD CONSTRAINT "recipient_routes_destination_h_id_harness_endpoints_id_fk" FOREIGN KEY ("destination_h_id") REFERENCES "public"."harness_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_handle_uq" ON "app_users" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_auth_user_uq" ON "app_users" USING btree ("auth_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "connections_h_idx" ON "connections" USING btree ("h_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_installation_uq" ON "devices" USING btree ("user_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "h_credentials_token_hash_uq" ON "h_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "h_credentials_h_idx" ON "h_credentials" USING btree ("h_id");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_endpoints_identity_uq" ON "harness_endpoints" USING btree ("user_id","device_id","harness_key","profile_key");--> statement-breakpoint
CREATE INDEX "harness_endpoints_user_idx" ON "harness_endpoints" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_requests_user_code_uq" ON "pairing_requests" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_requests_device_code_uq" ON "pairing_requests" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "recipient_routes_default_uq" ON "recipient_routes" USING btree ("user_id") WHERE "recipient_routes"."is_default" = true and "recipient_routes"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "recipient_routes_alias_uq" ON "recipient_routes" USING btree ("user_id","alias") WHERE "recipient_routes"."alias" is not null and "recipient_routes"."revoked_at" is null;