import { api } from '../api';
import { SEARCH_SKIP_DIRS, type WorkspacePathEntry } from './workspaceSearchIndex';

/***********************工作区全文搜索（有界并发，不预索引）*********************/

export interface ContentSearchMatch {
  relativePath: string;
  name: string;
  line: number;
  preview: string;
}

export interface ContentSearchResult {
  matches: ContentSearchMatch[];
  scanned: number;
  truncated: boolean;
  cancelled: boolean;
}

const MAX_SCAN_FILES = 1500;
const MAX_MATCHES = 500;
const MAX_FILE_BYTES = 1_000_000;
const CONCURRENCY = 8;
const MAX_LINE_PREVIEW = 160;

const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'json', 'md', 'mdx', 'txt', 'css', 'scss', 'less', 'html', 'htm', 'xml',
  'yml', 'yaml', 'toml', 'ini', 'env', 'rs', 'go', 'py', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'swift', 'sql', 'sh', 'bash',
  'zsh', 'ps1', 'gitignore', 'dockerfile', 'editorconfig', 'prettierrc',
  'eslintrc', 'babelrc', 'npmrc', 'nvmrc', 'lock',
]);

const TEXT_NAME = new Set([
  'dockerfile', 'makefile', 'license', 'readme', 'changelog', 'agents.md', 'claude.md',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : name.toLowerCase();
}

function isProbablyText(entry: WorkspacePathEntry): boolean {
  if (entry.isDirectory) return false;
  const lower = entry.name.toLowerCase();
  if (TEXT_NAME.has(lower) || lower.startsWith('readme') || lower.startsWith('agents') || lower.startsWith('claude')) return true;
  const ext = extOf(entry.name);
  if (TEXT_EXT.has(ext)) return true;
  // 无扩展名的源文件（如 Makefile 变体）按名称宽松放行
  return !entry.name.includes('.');
}

function joinAbs(root: string, rel: string): string {
  if (!rel) return root;
  const sep = root.includes('\\') ? '\\' : '/';
  const cleanRoot = root.replace(/[\\/]+$/, '');
  return `${cleanRoot}${sep}${rel.replace(/\//g, sep)}`;
}

function shouldSkipByPath(relativePath: string): boolean {
  return relativePath.split('/').some(segment => SEARCH_SKIP_DIRS.has(segment.toLowerCase()));
}

export async function searchWorkspaceContent(options: {
  root: string;
  entries: readonly WorkspacePathEntry[];
  query: string;
  signal?: { cancelled: boolean };
  limit?: number;
}): Promise<ContentSearchResult> {
  const { root, entries, signal } = options;
  const query = options.query.trim().toLowerCase();
  const limit = options.limit ?? MAX_MATCHES;
  const matches: ContentSearchMatch[] = [];
  if (!query) return { matches: [], scanned: 0, truncated: false, cancelled: false };

  const textEntries = entries.filter(entry =>
    !entry.isDirectory && isProbablyText(entry) && !shouldSkipByPath(entry.relativePath));
  // 路径/文件名与查询相关的候选优先扫描，避免大仓库里被 walk 顺序截断
  const prioritized: WorkspacePathEntry[] = [];
  const rest: WorkspacePathEntry[] = [];
  for (const entry of textEntries) {
    const path = entry.relativePath.toLowerCase();
    if (path.includes(query) || entry.name.toLowerCase().includes(query)) {
      prioritized.push(entry);
    } else {
      rest.push(entry);
    }
  }
  const candidates = [...prioritized, ...rest].slice(0, MAX_SCAN_FILES * 4);
  const hasMoreCandidates = textEntries.length > candidates.length;

  let scanned = 0;
  let cursor = 0;
  let truncated = false;
  let cancelled = false;

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.cancelled) {
        cancelled = true;
        return;
      }
      if (matches.length >= limit || scanned >= MAX_SCAN_FILES) {
        truncated = matches.length >= limit || scanned >= MAX_SCAN_FILES;
        return;
      }
      const index = cursor++;
      if (index >= candidates.length) return;
      const entry = candidates[index];
      if (signal?.cancelled) {
        cancelled = true;
        return;
      }

      let content = '';
      try {
        content = await api.readTextFile(joinAbs(root, entry.relativePath));
      } catch {
        scanned += 1;
        continue;
      }
      scanned += 1;
      if (content.length > MAX_FILE_BYTES) continue;
      const lower = content.toLowerCase();
      if (!lower.includes(query)) continue;

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
        const line = lines[i];
        if (!line.toLowerCase().includes(query)) continue;
        const idx = line.toLowerCase().indexOf(query);
        const start = Math.max(0, idx - 40);
        const preview = (start > 0 ? '…' : '') + line.slice(start, start + MAX_LINE_PREVIEW).trim();
        matches.push({
          relativePath: entry.relativePath,
          name: entry.name,
          line: i + 1,
          preview,
        });
      }
      if (signal?.cancelled) {
        cancelled = true;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, candidates.length)) }, () => worker());
  await Promise.all(workers);
  // 仅在仍有未扫候选或结果被截断时标记 truncated
  if (matches.length >= limit || (hasMoreCandidates && scanned >= MAX_SCAN_FILES)) truncated = true;
  return { matches, scanned, truncated, cancelled };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按搜索结果对文件做全局替换（大小写不敏感，保留原匹配大小写不做智能变换，直接写入 replacement）。
 */
export async function replaceInWorkspaceFiles(options: {
  root: string;
  matches: readonly ContentSearchMatch[];
  query: string;
  replacement: string;
}): Promise<{ files: number; occurrences: number }> {
  const { root, matches, query, replacement } = options;
  const needle = query.trim();
  if (!needle || matches.length === 0) return { files: 0, occurrences: 0 };

  const files = new Map<string, ContentSearchMatch>();
  for (const match of matches) {
    if (!files.has(match.relativePath)) files.set(match.relativePath, match);
  }

  const pattern = new RegExp(escapeRegExp(needle), 'gi');
  let fileCount = 0;
  let occurrenceCount = 0;

  for (const relativePath of files.keys()) {
    const abs = joinAbs(root, relativePath);
    let content = '';
    try {
      content = await api.readTextFile(abs);
    } catch {
      continue;
    }
    const next = content.replace(pattern, () => {
      occurrenceCount += 1;
      return replacement;
    });
    if (next === content) continue;
    try {
      await api.writeTextFile(abs, next);
      fileCount += 1;
    } catch {
      // 单文件写入失败不中断其它文件
    }
  }

  return { files: fileCount, occurrences: occurrenceCount };
}
