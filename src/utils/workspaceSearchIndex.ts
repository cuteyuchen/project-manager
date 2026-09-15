import { api } from '../api';

/***********************工作区路径索引（快速找文件）*********************/

/** 与资源管理器一致：依赖/构建目录不进索引 */
export const SEARCH_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor',
  '.next', '.nuxt', '.cache', '.gradle', '.idea', '__pycache__', '.git',
  '.svn', '.hg', '.turbo', '.yarn', '.pnpm-store',
]);

const MAX_INDEX_DEPTH = 8;
const MAX_INDEX_ENTRIES = 20000;
const SKIP_HIDDEN = true;

export interface WorkspacePathEntry {
  /** 相对项目根，使用 `/` 分隔 */
  relativePath: string;
  name: string;
  isDirectory: boolean;
}

export interface WorkspacePathIndex {
  root: string;
  entries: WorkspacePathEntry[];
  truncated: boolean;
  builtAt: number;
}

const indexCache = new Map<string, WorkspacePathIndex>();
let inflightBuild: { root: string; promise: Promise<WorkspacePathIndex> } | null = null;

function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase();
  if (SEARCH_SKIP_DIRS.has(lower)) return true;
  if (SKIP_HIDDEN && name.startsWith('.')) return true;
  return false;
}

function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

async function walk(
  root: string,
  relDir: string,
  depth: number,
  entries: WorkspacePathEntry[],
): Promise<boolean> {
  // 超深只剪掉当前分支，不中止整树；仅条目上限才向上传递中断
  if (depth > MAX_INDEX_DEPTH) return true;
  const absDir = relDir ? `${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}${relDir.replace(/\//g, root.includes('\\') ? '\\' : '/')}` : root;
  let children: { name: string; isDirectory: boolean }[] = [];
  try {
    children = await api.readDir(absDir);
  } catch {
    return true;
  }

  for (const child of children) {
    if (entries.length >= MAX_INDEX_ENTRIES) return false;
    if (child.isDirectory && shouldSkipDir(child.name)) continue;
    const relativePath = joinRel(relDir, child.name);
    entries.push({
      relativePath,
      name: child.name,
      isDirectory: child.isDirectory,
    });
    if (child.isDirectory) {
      const ok = await walk(root, relativePath, depth + 1, entries);
      if (!ok) return false;
    }
  }
  return true;
}

export async function buildWorkspacePathIndex(root: string): Promise<WorkspacePathIndex> {
  const cached = indexCache.get(root);
  if (cached && Date.now() - cached.builtAt < 60_000) return cached;
  if (inflightBuild?.root === root) return inflightBuild.promise;

  const promise = (async (): Promise<WorkspacePathIndex> => {
    const entries: WorkspacePathEntry[] = [];
    const complete = await walk(root, '', 0, entries);
    const index: WorkspacePathIndex = {
      root,
      entries,
      truncated: !complete || entries.length >= MAX_INDEX_ENTRIES,
      builtAt: Date.now(),
    };
    indexCache.set(root, index);
    return index;
  })();

  inflightBuild = { root, promise };
  try {
    return await promise;
  } finally {
    if (inflightBuild?.root === root) inflightBuild = null;
  }
}

export function invalidateWorkspacePathIndex(root?: string): void {
  if (root) indexCache.delete(root);
  else indexCache.clear();
}

/** 简单子串 + 路径分段匹配；文件名命中优先 */
export function filterPathEntries(
  entries: readonly WorkspacePathEntry[],
  query: string,
  limit = 80,
): WorkspacePathEntry[] {
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!q) return [];
  const startsWith: WorkspacePathEntry[] = [];
  const includes: WorkspacePathEntry[] = [];
  const fuzzy: WorkspacePathEntry[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const path = entry.relativePath.toLowerCase();
    const name = entry.name.toLowerCase();
    if (name.startsWith(q) || path.endsWith(`/${q}`) || path === q) {
      startsWith.push(entry);
    } else if (name.includes(q) || path.includes(q)) {
      includes.push(entry);
    } else {
      // 路径分段宽松匹配：a/b 可匹配 folder/a-something/b-file
      const parts = q.split('/').filter(Boolean);
      if (parts.length > 0 && parts.every(part => path.includes(part))) {
        fuzzy.push(entry);
      }
    }
    if (startsWith.length + includes.length + fuzzy.length >= limit * 3) break;
  }

  const score = (entry: WorkspacePathEntry, rank: number) =>
    rank * 1_000_000 + entry.relativePath.length;
  const collected = [
    ...startsWith.map(e => ({ e, r: 0 })),
    ...includes.map(e => ({ e, r: 1 })),
    ...fuzzy.map(e => ({ e, r: 2 })),
  ];
  collected.sort((a, b) => score(a.e, a.r) - score(b.e, b.r));
  return collected.slice(0, limit).map(item => item.e);
}
