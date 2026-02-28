<script setup lang="ts">
import { computed } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import 'diff2html/bundles/css/diff2html.min.css';
import type { Project } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const diffContent = computed(() => gitStore.selectedDiff);
const diffFile = computed(() => gitStore.selectedDiffFile);
const isStaged = computed(() => gitStore.selectedDiffStaged);

// ─── Parse diff into file header + hunks ──────────────────────────────────
interface DiffHunk {
  header: string;       // @@ -x,y +a,b @@ optional context
  lines: string[];      // all lines including the @@ header
  rawPatch: string;     // reconstructed patch text for this hunk (with file header)
  additions: number;
  deletions: number;
}

interface ParsedDiff {
  fileHeader: string;   // everything before the first hunk
  hunks: DiffHunk[];
  fileName: string;
  additions: number;
  deletions: number;
}

const parsedDiff = computed((): ParsedDiff | null => {
  const raw = diffContent.value;
  if (!raw) return null;

  const lines = raw.split('\n');
  let fileHeader = '';
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;

  // Collect file header lines (everything before first @@)
  let headerDone = false;

  for (const line of lines) {
    if (!headerDone) {
      if (line.startsWith('@@')) {
        headerDone = true;
      } else {
        fileHeader += line + '\n';
        continue;
      }
    }

    if (line.startsWith('@@')) {
      // Start new hunk
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        header: line,
        lines: [line],
        rawPatch: '',
        additions: 0,
        deletions: 0,
      };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) currentHunk.additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) currentHunk.deletions++;
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  // Build rawPatch for each hunk (file header + this hunk)
  for (const hunk of hunks) {
    hunk.rawPatch = fileHeader + hunk.lines.join('\n') + '\n';
  }

  // Total stats
  let totalAdd = 0, totalDel = 0;
  for (const h of hunks) { totalAdd += h.additions; totalDel += h.deletions; }

  // Extract file name from header
  const nameMatch = fileHeader.match(/^diff --git a\/(.+?) b\//m);
  const fileName = nameMatch ? nameMatch[1] : diffFile.value || '';

  return { fileHeader, hunks, fileName, additions: totalAdd, deletions: totalDel };
});

// ─── Hunk actions ─────────────────────────────────────────────────────────

async function stageHunk(hunk: DiffHunk) {
  try {
    // Apply hunk patch to index (--cached)
    await gitStore.applyPatch(props.project.id, props.project.path, hunk.rawPatch, true, false);
    // Refresh the diff
    if (diffFile.value) {
      await gitStore.getDiff(props.project.path, diffFile.value, isStaged.value);
    }
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function unstageHunk(hunk: DiffHunk) {
  try {
    // Reverse apply from index
    await gitStore.applyPatch(props.project.id, props.project.path, hunk.rawPatch, true, true);
    if (diffFile.value) {
      await gitStore.getDiff(props.project.path, diffFile.value, isStaged.value);
    }
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function discardHunk(hunk: DiffHunk) {
  try {
    // Reverse apply to working tree (not cached)
    await gitStore.applyPatch(props.project.id, props.project.path, hunk.rawPatch, false, true);
    if (diffFile.value) {
      await gitStore.getDiff(props.project.path, diffFile.value, isStaged.value);
    }
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

// ─── Line rendering helpers ───────────────────────────────────────────────

// Line numbers
interface NumberedLine {
  oldNum: number | null;
  newNum: number | null;
  text: string;
  type: 'add' | 'del' | 'context' | 'header';
}

function computeLineNumbers(lines: string[]): NumberedLine[] {
  const result: NumberedLine[] = [];
  let oldLine = 0, newLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // Parse hunk header to get line numbers
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1]) - 1;
        newLine = parseInt(match[2]) - 1;
      }
      result.push({ oldNum: null, newNum: null, text: line, type: 'header' });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      newLine++;
      result.push({ oldNum: null, newNum: newLine, text: line.substring(1), type: 'add' });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      oldLine++;
      result.push({ oldNum: oldLine, newNum: null, text: line.substring(1), type: 'del' });
    } else {
      oldLine++;
      newLine++;
      result.push({ oldNum: oldLine, newNum: newLine, text: line.startsWith(' ') ? line.substring(1) : line, type: 'context' });
    }
  }
  return result;
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div v-if="parsedDiff" class="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 dark:border-slate-700/30 bg-white/50 dark:bg-[#1e293b]/50 flex-shrink-0">
      <div class="flex items-center gap-2 text-xs">
        <div class="i-mdi-file-compare text-blue-500" />
        <span class="font-medium text-slate-700 dark:text-slate-300 truncate max-w-[260px]">{{ parsedDiff.fileName || diffFile }}</span>
        <span class="text-green-500 font-mono">+{{ parsedDiff.additions }}</span>
        <span class="text-red-500 font-mono">-{{ parsedDiff.deletions }}</span>
      </div>
      <div class="flex items-center gap-1 text-[10px] text-slate-400">
        <span v-if="isStaged" class="px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">{{ t('git.staged') }}</span>
        <span v-else class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">{{ t('git.unstaged') }}</span>
      </div>
    </div>

    <!-- Hunk list -->
    <div v-if="parsedDiff && parsedDiff.hunks.length > 0" class="flex-1 overflow-auto custom-scrollbar">
      <div v-for="(hunk, hunkIdx) in parsedDiff.hunks" :key="hunkIdx" class="border-b border-slate-200/60 dark:border-slate-700/30">
        <!-- Hunk header with actions -->
        <div class="flex items-center justify-between px-3 py-1 bg-blue-50/60 dark:bg-blue-900/10 sticky top-0 z-10 border-b border-slate-200/40 dark:border-slate-700/20">
          <span class="font-mono text-[11px] text-blue-600 dark:text-blue-400 truncate flex-1">{{ hunk.header }}</span>
          <div class="flex items-center gap-1 flex-shrink-0 ml-2">
            <button v-if="!isStaged" @click="stageHunk(hunk)"
              class="hunk-action-btn text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30"
              :title="t('git.stageHunk')">
              {{ t('git.stageHunk') }}
            </button>
            <button v-if="isStaged" @click="unstageHunk(hunk)"
              class="hunk-action-btn text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30"
              :title="t('git.unstageHunk')">
              {{ t('git.unstageHunk') }}
            </button>
            <button v-if="!isStaged" @click="discardHunk(hunk)"
              class="hunk-action-btn text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
              :title="t('git.discardHunk')">
              {{ t('git.discardHunk') }}
            </button>
          </div>
        </div>

        <!-- Hunk content: line-by-line diff -->
        <table class="w-full text-xs font-mono diff-table">
          <tbody>
            <tr v-for="(nline, lineIdx) in computeLineNumbers(hunk.lines.slice(1))" :key="lineIdx"
              :class="{
                'bg-green-50/80 dark:bg-green-900/10': nline.type === 'add',
                'bg-red-50/80 dark:bg-red-900/10': nline.type === 'del',
              }">
              <td class="diff-line-num text-right select-none w-[50px] px-2 border-r border-slate-200/40 dark:border-slate-700/20"
                :class="{ 'text-red-400': nline.type === 'del', 'text-green-400': nline.type === 'add' }">
                {{ nline.oldNum ?? '' }}
              </td>
              <td class="diff-line-num text-right select-none w-[50px] px-2 border-r border-slate-200/40 dark:border-slate-700/20"
                :class="{ 'text-red-400': nline.type === 'del', 'text-green-400': nline.type === 'add' }">
                {{ nline.newNum ?? '' }}
              </td>
              <td class="diff-line-sign w-[18px] text-center select-none"
                :class="{ 'text-green-600 dark:text-green-400': nline.type === 'add', 'text-red-600 dark:text-red-400': nline.type === 'del' }">
                {{ nline.type === 'add' ? '+' : nline.type === 'del' ? '-' : '' }}
              </td>
              <td class="diff-line-content whitespace-pre pl-1 pr-3">{{ nline.text }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500">
      <div class="text-center">
        <div class="i-mdi-file-compare text-5xl opacity-20 mx-auto mb-3" />
        <p class="text-sm">{{ t('git.selectFileToView') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hunk-action-btn {
  @apply flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer transition-colors;
}

.diff-table {
  border-collapse: collapse;
}

.diff-table td {
  padding-top: 0;
  padding-bottom: 0;
  line-height: 20px;
  font-size: 12px;
}

.diff-line-num {
  color: #94a3b8;
  font-size: 10px;
  min-width: 35px;
  user-select: none;
}

.diff-line-content {
  font-family: 'Cascadia Code', 'Fira Code', 'Source Code Pro', 'Consolas', monospace;
  tab-size: 4;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 3px;
}
.dark .custom-scrollbar::-webkit-scrollbar-thumb {
  background: #334155;
}
</style>
