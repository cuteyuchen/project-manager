/***********************解析 Git unified diff 为编辑器行号标记*********************/

export type EditorLineMarkerKind = 'added' | 'deleted' | 'modified';

export interface EditorLineMarkers {
  added: Set<number>;
  deleted: Set<number>;
  modified: Set<number>;
}

export function emptyLineMarkers(): EditorLineMarkers {
  return { added: new Set(), deleted: new Set(), modified: new Set() };
}

export function isEmptyLineMarkers(markers: EditorLineMarkers): boolean {
  return markers.added.size === 0 && markers.deleted.size === 0 && markers.modified.size === 0;
}

/**
 * 展示层规范化：added/modified 为 1-based 行号；
 * deleted 存「删除块前一行」行号（0 表示文件开头，画在首行顶边）。
 */
export function toDisplayLineMarkers(markers: EditorLineMarkers): EditorLineMarkers {
  return {
    added: new Set(markers.added),
    deleted: new Set(markers.deleted),
    modified: new Set(markers.modified),
  };
}

/**
 * 解析单文件 unified diff 的 hunk 行，得到「新文件」行号上的标记集合。
 * - 纯新增 → added
 * - 纯删除 → deleted（记录删除块前一行；0=文件开头）
 * - 相邻删除+新增视为修改 → modified
 */
export function parseUnifiedDiffLineMarkers(diffText: string): EditorLineMarkers {
  const markers = emptyLineMarkers();
  if (!diffText || diffText === '__BINARY_FILE__' || diffText === '__FILE_TOO_LARGE__') return markers;

  let newLine = 0;
  /** 当前连续删除块（旧文件行）对应的第一个新行位置 */
  let pendingDeleteAt = -1;
  let pendingDeleteCount = 0;

  const flushPendingDelete = () => {
    if (pendingDeleteCount <= 0 || pendingDeleteAt < 0) return;
    // 标记落在删除块「前」一行的底边，即两行之间；文件开头用 0
    markers.deleted.add(pendingDeleteAt > 1 ? pendingDeleteAt - 1 : 0);
    pendingDeleteCount = 0;
    pendingDeleteAt = -1;
  };

  for (const rawLine of diffText.split('\n')) {
    if (rawLine.startsWith('@@')) {
      flushPendingDelete();
      const match = rawLine.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      newLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('diff ') || rawLine.startsWith('index ')) {
      continue;
    }
    if (!rawLine) continue;

    const prefix = rawLine[0];

    if (prefix === ' ') {
      flushPendingDelete();
      newLine += 1;
      continue;
    }
    if (prefix === '-') {
      if (pendingDeleteCount === 0) pendingDeleteAt = newLine > 0 ? newLine : 1;
      pendingDeleteCount += 1;
      continue;
    }
    if (prefix === '+') {
      const lineNo = newLine > 0 ? newLine : 1;
      if (pendingDeleteCount > 0) {
        markers.modified.add(lineNo);
        pendingDeleteCount = 0;
        pendingDeleteAt = -1;
      } else {
        markers.added.add(lineNo);
      }
      newLine += 1;
      continue;
    }
  }
  flushPendingDelete();
  return markers;
}

/** 合并 staged 与 unstaged 两份 diff 的行标记（同一行优先 modified > deleted > added） */
export function mergeLineMarkers(...parts: EditorLineMarkers[]): EditorLineMarkers {
  const merged = emptyLineMarkers();
  for (const part of parts) {
    for (const line of part.added) {
      if (!merged.modified.has(line) && !merged.deleted.has(line)) merged.added.add(line);
    }
    for (const line of part.deleted) {
      if (!merged.modified.has(line)) merged.deleted.add(line);
    }
    for (const line of part.modified) {
      merged.added.delete(line);
      merged.deleted.delete(line);
      merged.modified.add(line);
    }
  }
  return merged;
}
