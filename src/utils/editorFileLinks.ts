import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  hoverTooltip,
  type DecorationSet,
  type Tooltip,
} from '@codemirror/view';
import { api } from '../api';
import { buildWorkspacePathIndex } from './workspaceSearchIndex';

export interface FileLinkMatch {
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
  rawPath: string;
}

export type ResolvedTarget =
  | { type: 'file'; relativePath: string; line?: number }
  | { type: 'url'; url: string };

const COMMON_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.vue',
  '.json',
  '.d.ts',
  '.css',
  '.scss',
  '.less',
  '.rs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.vue',
  '/index.json',
  '/mod.rs',
];

/** 从一行文本中解析所有候选路径引用 */
export function findPathsInLine(lineText: string, lineFrom: number): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];

  // 1. 引号包裹的字符串: '...', "...", `...`
  const stringRegex = /(["'`])((?:\\.|[^\\])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = stringRegex.exec(lineText)) !== null) {
    const raw = m[2];
    if (!raw.trim()) continue;
    const start = lineFrom + m.index;
    matches.push({
      from: start,
      to: start + m[0].length,
      innerFrom: start + 1,
      innerTo: start + m[0].length - 1,
      rawPath: raw,
    });
  }

  // 2. Markdown 链接: [text](path)
  const mdRegex = /\[[^\]]*\]\(([^)\s]+)\)/g;
  while ((m = mdRegex.exec(lineText)) !== null) {
    const raw = m[1];
    const openParen = m[0].lastIndexOf('(');
    const start = lineFrom + m.index + openParen + 1;
    if (!matches.some(existing => existing.from <= start && existing.to >= start + raw.length)) {
      matches.push({
        from: start,
        to: start + raw.length,
        innerFrom: start,
        innerTo: start + raw.length,
        rawPath: raw,
      });
    }
  }

  // 3. CSS url(...)
  const cssRegex = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
  while ((m = cssRegex.exec(lineText)) !== null) {
    const raw = m[2];
    const quote = m[1];
    const rawIndex = m[0].indexOf(raw);
    const start = lineFrom + m.index + rawIndex;
    const from = start - (quote ? 1 : 0);
    const to = start + raw.length + (quote ? 1 : 0);
    if (!matches.some(existing => existing.from <= from && existing.to >= to)) {
      matches.push({
        from,
        to,
        innerFrom: start,
        innerTo: start + raw.length,
        rawPath: raw,
      });
    }
  }

  // 4. Rust mod foo;
  const rustModRegex = /^\s*mod\s+([a-zA-Z0-9_]+)\s*;/g;
  while ((m = rustModRegex.exec(lineText)) !== null) {
    const modName = m[1];
    const rawIndex = m[0].indexOf(modName);
    const start = lineFrom + m.index + rawIndex;
    matches.push({
      from: start,
      to: start + modName.length,
      innerFrom: start,
      innerTo: start + modName.length,
      rawPath: `./${modName}`,
    });
  }

  return matches;
}

/** 查找指定字符位置所在的路径信息 */
export function findFilePathAt(
  doc: { lineAt: (pos: number) => { from: number; to: number; text: string } },
  pos: number,
): FileLinkMatch | null {
  const line = doc.lineAt(pos);
  const matches = findPathsInLine(line.text, line.from);
  for (const match of matches) {
    if (pos >= match.from && pos <= match.to) {
      return match;
    }
  }
  return null;
}

/** 规范化相对路径并消除 . 与 .. */
export function normalizeRelativePath(baseDir: string, relPath: string): string {
  const clean = relPath.split('?')[0].split('#')[0].trim();
  let full: string;
  if (clean.startsWith('@/') || clean.startsWith('~/')) {
    full = 'src/' + clean.slice(2);
  } else if (clean.startsWith('/')) {
    full = clean.slice(1);
  } else {
    full = baseDir ? `${baseDir}/${clean}` : clean;
  }

  const parts = full.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/** 提取目标行号（支持 :42 或 #L42） */
export function extractLineNumber(rawPath: string): number | undefined {
  const match = /[:#]L?(\d+)/i.exec(rawPath);
  if (match) {
    const line = parseInt(match[1], 10);
    if (!isNaN(line) && line > 0) return line;
  }
  return undefined;
}

/** 生成候选可能的文件路径列表 */
export function getCandidates(baseDir: string, rawPath: string): string[] {
  const cleanPath = rawPath.replace(/[:#]L?\d+.*$/, '');
  const norm = normalizeRelativePath(baseDir, cleanPath);
  const candidates: string[] = [];
  const seen = new Set<string>();

  function add(p: string) {
    const lower = p.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      candidates.push(p);
    }
  }

  for (const ext of COMMON_EXTENSIONS) {
    add(norm + ext);
  }

  if (cleanPath.startsWith('@/') || cleanPath.startsWith('~/')) {
    const rawNoAlias = cleanPath.slice(2);
    for (const ext of COMMON_EXTENSIONS) {
      add(rawNoAlias + ext);
    }
  }

  if (!cleanPath.startsWith('.') && !cleanPath.startsWith('/') && !cleanPath.startsWith('@') && !cleanPath.startsWith('~')) {
    const nmPath = `node_modules/${cleanPath}`;
    for (const ext of COMMON_EXTENSIONS) {
      add(nmPath + ext);
    }
  }

  return candidates;
}

// 缓存路径解析结果，避免重复计算
const resolutionCache = new Map<string, { target: ResolvedTarget | null; timestamp: number }>();

/** 解析路径引用为项目实际文件或外部 URL */
export async function resolveFilePath(
  projectPath: string,
  currentRelativePath: string,
  rawPath: string,
  explicitIndexLookup?: Map<string, string>,
): Promise<ResolvedTarget | null> {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return { type: 'url', url: trimmed };
  }

  const cacheKey = `${projectPath}:${currentRelativePath}:${trimmed}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 30_000) {
    return cached.target;
  }

  const currentDir = currentRelativePath.includes('/')
    ? currentRelativePath.substring(0, currentRelativePath.lastIndexOf('/'))
    : '';

  const line = extractLineNumber(trimmed);
  const candidates = getCandidates(currentDir, trimmed);

  let lookup = explicitIndexLookup;
  if (!lookup) {
    try {
      const idx = await buildWorkspacePathIndex(projectPath);
      lookup = new Map<string, string>();
      for (const entry of idx.entries) {
        if (!entry.isDirectory) {
          lookup.set(entry.relativePath.toLowerCase(), entry.relativePath);
        }
      }
    } catch {
      lookup = new Map();
    }
  }

  let result: ResolvedTarget | null = null;

  // 1. 优先从工作区路径索引中快速匹配
  for (const candidate of candidates) {
    const match = lookup.get(candidate.toLowerCase());
    if (match) {
      result = { type: 'file', relativePath: match, line };
      break;
    }
  }

  // 2. 备用检查：对 node_modules 或未索引的文件通过 filesystem stat 检测
  if (!result) {
    for (const candidate of candidates) {
      try {
        const stat = await api.workspaceStat(projectPath, candidate);
        if (!stat.isDirectory) {
          result = { type: 'file', relativePath: candidate, line };
          break;
        }
      } catch {
        // 不存在，继续尝试下一候选
      }
    }
  }

  resolutionCache.set(cacheKey, { target: result, timestamp: Date.now() });
  return result;
}

/** CodeMirror 链接高亮装饰状态 */
export const setLinkHighlight = StateEffect.define<{ from: number; to: number } | null>();

export const linkHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLinkHighlight)) {
        if (!effect.value) return Decoration.none;
        return Decoration.set([
          Decoration.mark({
            class: 'cm-file-link-active',
          }).range(effect.value.from, effect.value.to),
        ]);
      }
    }
    return decorations.map(tr.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

export interface FileLinksExtensionOptions {
  getProjectPath: () => string;
  getCurrentPath: () => string;
  onJumpToFile: (target: { relativePath: string; line?: number }) => void;
  onOpenUrl: (url: string) => void;
  hintText?: string;
  urlHintText?: string;
}

/** 创建 CodeMirror 依赖跳转扩展（支持 Ctrl+鼠标左键跳转与 F12 / Ctrl+B 快捷键） */
export function createFileLinksExtension(options: FileLinksExtensionOptions): Extension {
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
  const modLabel = isMac ? 'Cmd' : 'Ctrl';
  const defaultFileHint = `${modLabel} + 单击 打开文件`;
  const defaultUrlHint = `${modLabel} + 单击 打开链接`;

  let lastMouseCoords: { x: number; y: number } | null = null;
  let currentHighlightedRange: { from: number; to: number } | null = null;

  async function executeJump(view: EditorView, pos: number): Promise<boolean> {
    const match = findFilePathAt(view.state.doc, pos);
    if (!match) return false;
    const target = await resolveFilePath(options.getProjectPath(), options.getCurrentPath(), match.rawPath);
    if (!target) return false;

    if (target.type === 'file') {
      options.onJumpToFile({ relativePath: target.relativePath, line: target.line });
    } else {
      options.onOpenUrl(target.url);
    }
    return true;
  }

  async function updateHoverHighlight(view: EditorView, x: number, y: number, isCtrlDown: boolean): Promise<void> {
    if (!isCtrlDown) {
      if (currentHighlightedRange) {
        currentHighlightedRange = null;
        view.dispatch({ effects: setLinkHighlight.of(null) });
      }
      return;
    }

    const pos = view.posAtCoords({ x, y });
    if (pos == null) {
      if (currentHighlightedRange) {
        currentHighlightedRange = null;
        view.dispatch({ effects: setLinkHighlight.of(null) });
      }
      return;
    }

    const match = findFilePathAt(view.state.doc, pos);
    if (!match) {
      if (currentHighlightedRange) {
        currentHighlightedRange = null;
        view.dispatch({ effects: setLinkHighlight.of(null) });
      }
      return;
    }

    // 如果已经在高亮同一个区间，无需重复 dispatch
    if (currentHighlightedRange && currentHighlightedRange.from === match.innerFrom && currentHighlightedRange.to === match.innerTo) {
      return;
    }

    const target = await resolveFilePath(options.getProjectPath(), options.getCurrentPath(), match.rawPath);
    if (target) {
      currentHighlightedRange = { from: match.innerFrom, to: match.innerTo };
      view.dispatch({ effects: setLinkHighlight.of(currentHighlightedRange) });
    } else {
      if (currentHighlightedRange) {
        currentHighlightedRange = null;
        view.dispatch({ effects: setLinkHighlight.of(null) });
      }
    }
  }

  const domHandlers = EditorView.domEventHandlers({
    mousemove(event, view) {
      lastMouseCoords = { x: event.clientX, y: event.clientY };
      const isCtrlDown = event.ctrlKey || event.metaKey;
      void updateHoverHighlight(view, event.clientX, event.clientY, isCtrlDown);
      return false;
    },
    mouseleave(_event, view) {
      lastMouseCoords = null;
      if (currentHighlightedRange) {
        currentHighlightedRange = null;
        view.dispatch({ effects: setLinkHighlight.of(null) });
      }
      return false;
    },
    mousedown(event, view) {
      if ((event.ctrlKey || event.metaKey) && event.button === 0) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos != null && findFilePathAt(view.state.doc, pos)) {
          // 阻止 CodeMirror 在 Ctrl+Click 时创建多光标
          event.preventDefault();
        }
      }
      return false;
    },
    click(event, view) {
      if ((event.ctrlKey || event.metaKey) && event.button === 0) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos != null) {
          event.preventDefault();
          event.stopPropagation();
          void executeJump(view, pos);
          return true;
        }
      }
      return false;
    },
    keydown(event, view) {
      if (event.key === 'Control' || event.key === 'Meta') {
        if (lastMouseCoords) {
          void updateHoverHighlight(view, lastMouseCoords.x, lastMouseCoords.y, true);
        }
      } else if (event.key === 'F12' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b')) {
        // WebStorm Ctrl+B 或 VS Code F12 跳转到定义/引用文件
        const pos = view.state.selection.main.head;
        void executeJump(view, pos);
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    },
    keyup(event, view) {
      if (event.key === 'Control' || event.key === 'Meta') {
        if (currentHighlightedRange) {
          currentHighlightedRange = null;
          view.dispatch({ effects: setLinkHighlight.of(null) });
        }
      }
      return false;
    },
  });

  const tooltipPlugin = hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const match = findFilePathAt(view.state.doc, pos);
    if (!match) return null;

    const target = await resolveFilePath(options.getProjectPath(), options.getCurrentPath(), match.rawPath);
    if (!target) return null;

    const isUrl = target.type === 'url';
    const displayText = isUrl ? target.url : target.relativePath + (target.line ? `:${target.line}` : '');
    const hint = isUrl ? (options.urlHintText || defaultUrlHint) : (options.hintText || defaultFileHint);

    return {
      pos: match.innerFrom,
      end: match.innerTo,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-file-link-tooltip';

        const icon = document.createElement('span');
        icon.className = isUrl ? 'i-mdi-open-in-new text-xs' : 'i-mdi-file-document-outline text-xs';
        icon.style.marginRight = '4px';

        const text = document.createElement('span');
        text.className = 'cm-file-link-target';
        text.textContent = displayText;

        const hintSpan = document.createElement('span');
        hintSpan.className = 'cm-file-link-hint';
        hintSpan.textContent = `(${hint})`;

        dom.appendChild(icon);
        dom.appendChild(text);
        dom.appendChild(hintSpan);

        dom.addEventListener('click', (e) => {
          e.stopPropagation();
          if (target.type === 'file') {
            options.onJumpToFile({ relativePath: target.relativePath, line: target.line });
          } else {
            options.onOpenUrl(target.url);
          }
        });

        return { dom };
      },
    };
  }, { hideOnChange: true });

  return [linkHighlightField, domHandlers, tooltipPlugin];
}
