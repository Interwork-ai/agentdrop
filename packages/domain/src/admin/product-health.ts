import type { AdminProductHealth } from '@agentdrop/contracts';
import type { Tx } from '@agentdrop/db';
import { sql } from 'drizzle-orm';

/**
 * Product health for the operator overview (ADR 0035). Metadata only: these queries read timestamps, ids, the
 * frozen target ids of a drop (`target_snapshot.user_ids / group_ids / self`) and `reply_to_drop_id`; they never
 * select a title, body, extension, file name, handle or display name, and they return nothing but counts, shares and
 * a duration.
 *
 * Every window is bounded (28 days at most) and starts from `drops.created_at`. Replies are found through
 * `drops_reply_to_idx`, deliveries through `deliveries_drop_h_uq`, a new account's agents and first sends through the
 * `(user_id, …)` / `(author_user_id, created_at)` indexes.
 */

/** A reply counts when it arrives within this long after the message it answers. */
const ANSWER_WINDOW = sql`interval '72 hours'`;
/** How long after signing up an account's first steps still count as activation. */
const FIRST_WEEK = sql`interval '7 days'`;

/**
 * Drops of the last 28 days that a person sent to other people: not from the assistant, not kept in My space, and
 * addressed to at least one group or to at least one person who is neither the author nor the assistant. `to_group`
 * marks those with a group among their targets. A drop addressed to the assistant only is `tried_assistant`, kept
 * apart in `assistant_tries`.
 */
const RECENT = sql`
  sys as materialized (select id from app_users where is_system),
  recent as (
    select d.id, d.author_user_id, d.created_at,
      case when jsonb_typeof(d.target_snapshot -> 'user_ids') = 'array'
           then d.target_snapshot -> 'user_ids' else '[]'::jsonb end as user_ids,
      case when jsonb_typeof(d.target_snapshot -> 'group_ids') = 'array'
           then jsonb_array_length(d.target_snapshot -> 'group_ids') > 0 else false end as to_group
    from drops d
    where d.created_at > now() - interval '28 days'
      and d.author_user_id not in (select id from sys)
      and not (d.target_snapshot @> '{"self":true}'::jsonb)
  ),
  classified as (
    select r.id, r.author_user_id, r.created_at, r.to_group,
      exists (
        select 1 from jsonb_array_elements_text(r.user_ids) as u(id)
        where u.id <> r.author_user_id::text and u.id not in (select id::text from sys)
      ) as to_person,
      exists (select 1 from sys where r.user_ids @> jsonb_build_array(sys.id::text)) as to_assistant
    from recent r
  ),
  handoffs as (
    select c.id, c.author_user_id, c.created_at, c.to_group,
      exists (
        select 1 from drops a
        where a.reply_to_drop_id = c.id
          and a.author_user_id <> c.author_user_id
          and a.author_user_id not in (select id from sys)
          and not (a.target_snapshot @> '{"self":true}'::jsonb)
          and a.created_at <= c.created_at + ${ANSWER_WINDOW}
      ) as answered
    from classified c
    where c.to_group or c.to_person
  ),
  assistant_tries as (
    select c.author_user_id, c.created_at from classified c
    where c.to_assistant and not c.to_group and not c.to_person
  )`;

function share(
  answered: number,
  eligible: number,
): { answered: number; eligible: number; share: number | null } {
  return { answered, eligible, share: eligible > 0 ? answered / eligible : null };
}

export async function productHealth(tx: Tx): Promise<AdminProductHealth> {
  const n = (row: Record<string, unknown> | undefined, k: string) => Number(row?.[k] ?? 0);

  // A message is eligible once it had its full 72 hours, or earlier if it is already answered (a young message
  // with an answer cannot lose it; one without may still get one, so it is left out until its time is up).
  const handoffs = await tx.execute<Record<string, string | number>>(sql`
    with ${RECENT}
    select
      count(*) filter (where created_at > now() - interval '7 days'
        and (answered or created_at <= now() - ${ANSWER_WINDOW})) as eligible_7d,
      count(*) filter (where created_at > now() - interval '7 days' and answered) as answered_7d,
      count(*) filter (where answered or created_at <= now() - ${ANSWER_WINDOW}) as eligible_28d,
      count(*) filter (where answered) as answered_28d,
      count(distinct author_user_id) filter (where created_at > now() - interval '7 days') as senders_7d,
      count(distinct author_user_id) as senders_28d,
      count(*) filter (where created_at > now() - interval '7 days' and to_group) as group_7d,
      count(*) filter (where created_at > now() - interval '7 days' and not to_group) as direct_7d
    from handoffs`);
  const h = handoffs.rows[0];

  // Every first step of an account created in the last 28 days falls inside the same 28-day drop window.
  const activation = await tx.execute<Record<string, string | number>>(sql`
    with ${RECENT}
    select
      count(*) as signups,
      count(*) filter (where u.created_at > now() - ${FIRST_WEEK}) as in_first_week,
      count(*) filter (where exists (
        select 1 from harness_endpoints e
        where e.user_id = u.id and e.created_at <= u.created_at + ${FIRST_WEEK})) as paired,
      count(*) filter (where exists (
        select 1 from assistant_tries t
        where t.author_user_id = u.id and t.created_at <= u.created_at + ${FIRST_WEEK})) as tried_assistant,
      count(*) filter (where exists (
        select 1 from handoffs t
        where t.author_user_id = u.id and t.created_at <= u.created_at + ${FIRST_WEEK})) as sent_to_people
    from app_users u
    where not u.is_system and u.created_at > now() - interval '28 days'`);
  const a = activation.rows[0];

  // Read state belongs to the person (ADR 0007): one entry per (message, recipient person), delivered when the first
  // of their agents received it, read at the earliest read mark on any of their copies. The author's own copies are
  // read on arrival and are left out, as is the assistant.
  const latency = await tx.execute<Record<string, string | number | null>>(sql`
    with ${RECENT},
    pairs as (
      select min(dl.received_at) as delivered_at, min(dl.read_at) as read_at
      from handoffs t
      join deliveries dl on dl.drop_id = t.id
      join harness_endpoints e on e.id = dl.h_id
      where t.created_at > now() - interval '7 days'
        and dl.received_at > now() - interval '7 days'
        and e.user_id <> t.author_user_id
        and e.user_id not in (select id from sys)
      group by t.id, e.user_id
    )
    select
      count(*) as delivered,
      count(read_at) as read,
      percentile_cont(0.5) within group (
        order by greatest(0, extract(epoch from (read_at - delivered_at)))
      ) filter (where read_at is not null) as median_seconds
    from pairs`);
  const l = latency.rows[0];
  const median = l?.median_seconds;

  return {
    answered_72h: {
      last_7d: share(n(h, 'answered_7d'), n(h, 'eligible_7d')),
      last_28d: share(n(h, 'answered_28d'), n(h, 'eligible_28d')),
    },
    active_senders: { last_7d: n(h, 'senders_7d'), last_28d: n(h, 'senders_28d') },
    sent_7d: { direct: n(h, 'direct_7d'), group: n(h, 'group_7d') },
    activation: {
      signups_28d: n(a, 'signups'),
      in_first_week: n(a, 'in_first_week'),
      paired_agent: n(a, 'paired'),
      tried_assistant: n(a, 'tried_assistant'),
      sent_to_people: n(a, 'sent_to_people'),
    },
    read_latency_7d: {
      delivered: n(l, 'delivered'),
      read: n(l, 'read'),
      median_seconds: median === null || median === undefined ? null : Math.round(Number(median)),
    },
  };
}
