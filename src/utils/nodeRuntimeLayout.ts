export type NodeRuntimeListMode = 'table' | 'compact-table' | 'card';

export function getRuntimeListMode(width: number): NodeRuntimeListMode {
  if (width >= 1350) return 'table';
  if (width >= 760) return 'compact-table';
  return 'card';
}

/**
 * 计算是否需要切换列表模式；未跨 breakpoint 时返回 null，避免无意义的布局写入。
 */
export function resolveRuntimeListModeChange(
  width: number,
  currentMode: NodeRuntimeListMode,
): NodeRuntimeListMode | null {
  const nextMode = getRuntimeListMode(width);
  return nextMode === currentMode ? null : nextMode;
}
