import type { DropSummary } from '@agentdrop/contracts';

/**
 * One origin for prompt context, notices and the live band. Direct delivery wins even when a group also carried
 * the drop. Older servers may omit labels or sources: preserve a known group origin without inventing an address,
 * and leave completely unknown origins unclassified. Presentation and whether to group rows stay with the caller.
 */
export function dropNoticeSource(drop: Partial<Pick<DropSummary, 'sources' | 'group_labels'>>) {
  const sources = drop.sources ?? [];
  const direct = sources.includes('direct');
  const group = direct
    ? null
    : (drop.group_labels?.[0] ??
      (sources.includes('group') ? { group_id: '', slug: '', display_name: '' } : null));
  return { direct, group };
}
