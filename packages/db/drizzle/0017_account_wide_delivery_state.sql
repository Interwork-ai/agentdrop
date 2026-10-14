-- ADR 0007: read, starred and archived are one state per person across all of their agents.
-- Converge deliveries of the same drop to the same account: a flag set on any of them counts for all (earliest
-- timestamp wins), and every row takes the highest state_version plus one so clients holding an older version
-- re-read before their next change. Data-only; no schema change, and the previous release keeps working.
WITH per_person AS (
  SELECT d.drop_id,
         h.user_id,
         min(d.read_at)      AS read_at,
         min(d.starred_at)   AS starred_at,
         min(d.archived_at)  AS archived_at,
         max(d.state_version) + 1 AS state_version,
         count(*)            AS n
  FROM deliveries d
  JOIN harness_endpoints h ON h.id = d.h_id
  GROUP BY d.drop_id, h.user_id
  HAVING count(*) > 1
)
UPDATE deliveries d
SET read_at = p.read_at,
    starred_at = p.starred_at,
    archived_at = p.archived_at,
    state_version = p.state_version
FROM harness_endpoints h, per_person p
WHERE h.id = d.h_id
  AND p.drop_id = d.drop_id
  AND p.user_id = h.user_id
  AND (d.read_at IS DISTINCT FROM p.read_at
       OR d.starred_at IS DISTINCT FROM p.starred_at
       OR d.archived_at IS DISTINCT FROM p.archived_at);
