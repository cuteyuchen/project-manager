import type { NodeVersion } from '../types';
import { ensureNodeRuntime, getNodeRuntimeId, normalizeRuntimeVersion } from './nodeRuntime';

const SOURCE_ORDER: Record<NodeVersion['source'], number> = {
  managed: 0,
  nvm: 1,
  system: 2,
  custom: 3,
};

export interface NodeRuntimeGroup {
  key: string;
  version: string;
  runtimes: NodeVersion[];
  sources: NodeVersion['source'][];
}

export interface RuntimeSourceSummary {
  source: NodeVersion['source'];
  count: number;
}

function compareRuntimes(left: NodeVersion, right: NodeVersion): number {
  const sourceOrder = SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source];
  if (sourceOrder !== 0) return sourceOrder;
  return getNodeRuntimeId(left).localeCompare(getNodeRuntimeId(right));
}

/** Keep source-specific runtime records intact while presenting one row per version. */
export function groupNodeRuntimesByVersion(runtimes: NodeVersion[]): NodeRuntimeGroup[] {
  const groups = new Map<string, NodeRuntimeGroup>();

  for (const runtime of runtimes) {
    const normalized = normalizeRuntimeVersion(runtime.version);
    const key = normalized.toLowerCase();
    const group = groups.get(key) || {
      key,
      version: normalized,
      runtimes: [],
      sources: [],
    };
    const normalizedRuntime = ensureNodeRuntime(runtime);
    group.runtimes.push(normalizedRuntime);
    if (!group.sources.includes(normalizedRuntime.source)) group.sources.push(normalizedRuntime.source);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      runtimes: [...group.runtimes].sort(compareRuntimes),
      sources: [...group.sources].sort((left, right) => SOURCE_ORDER[left] - SOURCE_ORDER[right]),
    }))
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: 'base' }));
}

export function summarizeRuntimeSources(runtimes: NodeVersion[]): RuntimeSourceSummary[] {
  const counts = new Map<NodeVersion['source'], number>();
  for (const runtime of runtimes) {
    counts.set(runtime.source, (counts.get(runtime.source) || 0) + 1);
  }
  return (Object.keys(SOURCE_ORDER) as NodeVersion['source'][])
    .filter(source => counts.has(source))
    .map(source => ({ source, count: counts.get(source) || 0 }));
}
