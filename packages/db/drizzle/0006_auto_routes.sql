ALTER TABLE "recipient_routes" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: every active endpoint gets its system-managed address (@handle/alias) visible to contacts.
-- Aliases are allocated one endpoint at a time against every live alias of that user (manual ones included).
DO $$
DECLARE
  ep RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR ep IN
    SELECT h.id, h.user_id, h.label, h.harness_key::text AS harness_key
    FROM harness_endpoints h
    WHERE h.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM recipient_routes a WHERE a.destination_h_id = h.id AND a.auto AND a.revoked_at IS NULL)
    ORDER BY h.user_id, h.created_at, h.id
  LOOP
    base := CASE ep.harness_key WHEN 'claude-code' THEN 'claude' WHEN 'codex' THEN 'codex' ELSE 'agent' END;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM recipient_routes r WHERE r.user_id = ep.user_id AND r.alias = candidate AND r.revoked_at IS NULL) LOOP
      n := n + 1;
      candidate := base || '-' || n;
    END LOOP;
    INSERT INTO recipient_routes (user_id, alias, label, destination_h_id, is_default, visibility, auto)
    VALUES (ep.user_id, candidate, ep.label, ep.id, false, 'contacts', true);
  END LOOP;
END $$;
