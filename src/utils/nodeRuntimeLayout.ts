export type NodeRuntimeListMode = 'table' | 'compact-table' | 'card';

export function getRuntimeListMode(width: number): NodeRuntimeListMode {
  if (width >= 1050) return 'table';
  if (width >= 760) return 'compact-table';
  return 'card';
}
