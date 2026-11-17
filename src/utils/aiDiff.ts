/**
 * AI 提交信息用的 diff 压缩。
 *
 * 直接把 `git diff --cached` 的完整输出发给模型有两类必炸场景：
 * 1. 一次改了几十上百个文件，请求体超过模型最大输入 token；
 * 2. 单个大文件（大 JSON、锁文件、生成物）或二进制文件（图片等）撑爆输入。
 *
 * 这里在发送前做三层收敛：
 * - 二进制文件只保留「哪个文件变了」，不带内容；
 * - 每个文件的 patch 有独立字符预算，超出截断并标注；
 * - 所有 patch 共享一个总预算，放不下的文件只进文件清单。
 * 文件清单始终完整（截断到 maxSummaryFiles），模型即使看不到全部 patch
 * 也能据此写出覆盖所有改动的提交信息。
 *
 * 放在前端而不是 Rust/插件侧，是为了让 Tauri / uTools / ZTools 三个目标
 * 共用同一套压缩逻辑。
 */

export interface CompactAiDiffOptions {
  /** 所有文件 patch 的总字符预算 */
  totalBudget?: number;
  /** 单个文件 patch 的字符预算 */
  perFileBudget?: number;
  /** 文件清单最多列出的条目数 */
  maxSummaryFiles?: number;
}

/** 默认预算约 20k 字符 ≈ 6k token，8k 上下文的模型也放得下 */
export const AI_DIFF_TOTAL_BUDGET = 20_000;
export const AI_DIFF_PER_FILE_BUDGET = 3_000;
/** 模型上下文比预期更小（如 4k）时的降级预算 */
export const AI_DIFF_FALLBACK_TOTAL_BUDGET = 4_000;
export const AI_DIFF_FALLBACK_PER_FILE_BUDGET = 800;

const MAX_SUMMARY_FILES = 100;
/** 剩余预算低于这个值就不值得再塞一个 patch 了 */
const MIN_PATCH_BUDGET = 200;

interface DiffSection {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  text: string;
}

function splitDiffSections(raw: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections.filter(section => section.trim().length > 0);
}

function extractFilePath(lines: string[]): string {
  for (const line of lines) {
    if (line.startsWith('+++ b/')) return line.slice(6);
    if (line.startsWith('rename to ')) return line.slice(10);
  }
  for (const line of lines) {
    if (line.startsWith('--- a/')) return line.slice(6);
  }
  const match = (lines[0] || '').match(/^diff --git a\/.* b\/(.+)$/);
  return match ? match[1] : '(unknown file)';
}

function analyzeSection(text: string): DiffSection {
  const lines = text.split('\n');
  let added = 0;
  let deleted = 0;
  let binary = false;
  for (const line of lines) {
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) binary = true;
    else if (line.startsWith('GIT binary patch')) binary = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  return { path: extractFilePath(lines), added, deleted, binary, text };
}

function truncatePatch(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return { text: kept.join('\n'), truncated: true };
}

export function compactDiffForAi(rawDiff: string, options: CompactAiDiffOptions = {}): string {
  const totalBudget = options.totalBudget ?? AI_DIFF_TOTAL_BUDGET;
  const perFileBudget = options.perFileBudget ?? AI_DIFF_PER_FILE_BUDGET;
  const maxSummaryFiles = options.maxSummaryFiles ?? MAX_SUMMARY_FILES;

  const raw = rawDiff.trim();
  if (!raw) return '';

  const sections = splitDiffSections(raw).map(analyzeSection);

  /***********************文件清单：让模型知道全貌*********************/
  const summaryEntries = sections.map(section =>
    section.binary
      ? `- ${section.path} (binary)`
      : `- ${section.path} (+${section.added}/-${section.deleted})`
  );
  const summaryLines = summaryEntries.slice(0, maxSummaryFiles);
  if (summaryEntries.length > maxSummaryFiles) {
    summaryLines.push(`- ... and ${summaryEntries.length - maxSummaryFiles} more files`);
  }
  const summary = `Changed files (${sections.length}):\n${summaryLines.join('\n')}`;

  /***********************patch 正文：单文件限额 + 总预算*********************/
  let remaining = totalBudget;
  let anyTruncated = summaryEntries.length > maxSummaryFiles;
  const patches: string[] = [];
  for (const section of sections) {
    // 二进制内容对生成提交信息没有价值，清单里标注即可
    if (section.binary) continue;
    const budget = Math.min(perFileBudget, remaining);
    if (budget < MIN_PATCH_BUDGET) {
      anyTruncated = true;
      continue;
    }
    const { text, truncated } = truncatePatch(section.text, budget);
    remaining -= text.length;
    if (truncated) {
      anyTruncated = true;
      patches.push(`${text}\n... [diff truncated: this file has +${section.added}/-${section.deleted} lines in total]`);
    } else {
      patches.push(text);
    }
  }

  const parts = [summary, ...patches];
  if (anyTruncated) {
    parts.push('[Note: Some diffs were truncated or omitted to fit the model input limit. Cover all changes using the file summary above.]');
  }
  return parts.join('\n\n');
}

/**
 * 判断错误是否为「输入超过模型上下文」。
 *
 * 各厂商措辞不一，但基本都围绕 context length / token limit / too long。
 * 命中后值得用更小的预算重试一次，而不是直接报失败。
 */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /maximum context length|context (?:length|window|size)|token limit|too many tokens|input (?:is )?too long|prompt (?:is )?too long|reduce the length|input length.{0,40}exceed/i.test(message);
}