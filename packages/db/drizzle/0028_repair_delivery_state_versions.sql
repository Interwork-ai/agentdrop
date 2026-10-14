-- Repair the version differences left by 0017, which changed only rows whose flags differed.
-- Only live deliveries carry state (ADR 0022). Converge every live row of an affected person/drop,
-- including the rows that already had the merged flags, and invalidate all older client versions.
WITH live AS (
  SELECT d.*, h.user_id
  FROM deliveries d
  JOIN harness_endpoints h ON h.id = d.h_id
  WHERE EXISTS (
    SELECT 1 FROM delivery_grants g WHERE g.delivery_id = d.id AND g.revoked_at IS NULL
  )
), per_person AS (
  SELECT drop_id, user_id,
         min(read_at) AS read_at,
         min(starred_at) AS starred_at,
         min(archived_at) AS archived_at,
         max(state_version) AS max_version
  FROM live
  GROUP BY drop_id, user_id
  HAVING count(*) > 1
), affected AS (
  SELECT p.* FROM per_person p
  WHERE EXISTS (
    SELECT 1 FROM live d
    WHERE d.drop_id = p.drop_id AND d.user_id = p.user_id
      AND (d.state_version <> p.max_version
        OR d.read_at IS DISTINCT FROM p.read_at
        OR d.starred_at IS DISTINCT FROM p.starred_at
        OR d.archived_at IS DISTINCT FROM p.archived_at)
  )
)
UPDATE deliveries d
SET read_at = p.read_at,
    starred_at = p.starred_at,
    archived_at = p.archived_at,
    state_version = p.max_version + 1
FROM live l, affected p
WHERE d.id = l.id AND l.drop_id = p.drop_id AND l.user_id = p.user_id;
