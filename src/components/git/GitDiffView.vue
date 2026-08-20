<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import type { Project } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

/** 该项目自己那一桶 diff 选中态（store 已按 projectId 分桶） */
const selection = computed(() => gitStore.getDiffSelection(props.project.id));
const diffContent = computed(() => selection.value.content);
const diffFile = computed(() => selection.value.file);
const hasSelectedFile = computed(() => !!selection.value.file);
const reverting = ref(false);

/***********************正文被淘汰后按需重取*********************/
// 桶数超上限时只丢 content、保留「看的是哪个文件」（见 utils/gitDiffSelection.ts）。
// 这里把缺失的正文补回来，让淘汰对用户不可见——否则切回项目会显示成「什么都没选」。
//
// 每个目标只重取一次：diff 本身可能就是空的（比如空的未跟踪文件），
// 那样「取回来还是空」会让这个 watch 反复自激成死循环。
const refetchedTargets = new Set<string>();

watch(selection, (current) => {
  if (!current.file || current.content) return;

  const target = current.source === 'worktree'
    ? `worktree:${current.staged ? 'staged' : 'unstaged'}:${current.file}`
    : `commit:${current.source.commit}:${current.file}`;
  if (refetchedTargets.has(target)) return;
  refetchedTargets.add(target);

  const request = current.source === 'worktree'
    ? gitStore.getDiff(props.project.id, props.project.path, current.file, current.staged)
    : gitStore.getDiffCommitFile(props.project.id, props.project.path, current.source.commit, current.file);

  // 取不到就维持空态：getDiff 失败时内部已清桶，这里不再重试
  void request.catch(() => {});
}, { immediate: true });

const DIFF_BINARY_MARKER = '__BINARY_FILE__';
const DIFF_TOO_LARGE_MARKER = '__FILE_TOO_LARGE__';
const isBinaryFile = computed(() => diffContent.value === DIFF_BINARY_MARKER);
const isTooLargeFile = computed(() => diffContent.value === DIFF_TOO_LARGE_MARKER);
const isUnsupported = computed(() => isBinaryFile.value || isTooLargeFile.value);

interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  oldNum?: number;
  newNum?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
  rawLines: string[];
}

const diffHeaders = computed(() => {
  const headers: string[] = [];
  for (const line of diffContent.value.split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      headers.push(line);
    }
    if (line.startsWith('@@')) break;
  }
  return headers;
});

const parsedHunks = computed((): DiffHunk[] => {
  const raw = diffContent.value;
  if (!raw) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)/);
      if (match) {
        oldNum = parseInt(match[1]) - 1;
        const newMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        newNum = newMatch ? parseInt(newMatch[1]) - 1 : oldNum;
      }
      current = { header: line, lines: [], rawLines: [line] };
      hunks.push(current);
      continue;
    }

    if (!current) continue;

    current.rawLines.push(line);
    if (line.startsWith('+')) {
      newNum++;
      current.lines.push({ type: 'add', content: line.slice(1), newNum });
    } else if (line.startsWith('-')) {
      oldNum++;
      current.lines.push({ type: 'del', content: line.slice(1), oldNum });
    } else {
      oldNum++;
      newNum++;
      current.lines.push({
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldNum,
        newNum,
      });
    }
  }
  return hunks;
});

const rawDiffLines = computed(() => diffContent.value.split('\n').filter(line => line.length > 0));
const hasParsedHunks = computed(() => parsedHunks.value.length > 0);

const stats = computed(() => {
  let adds = 0;
  let dels = 0;
  for (const hunk of parsedHunks.value) {
    for (const line of hunk.lines) {
      if (line.type === 'add') adds++;
      else if (line.type === 'del') dels++;
    }
  }
  return { adds, dels };
});

async function rollbackHunk(hunk: DiffHunk) {
  if (!diffFile.value || !hunk.rawLines.length || reverting.value) return;
  reverting.value = true;
  try {
    const patchText = `${diffHeaders.value.join('\n')}\n${hunk.rawLines.join('\n')}\n`;
    await gitStore.revertHunk(
      props.project.id,
      props.project.path,
      patchText,
      selection.value.staged,
    );
  } finally {
    reverting.value = false;
  }
}
</script>

<template>
  <div class="git-diff-view">
    <!-- No file selected -->
    <div v-if="!hasSelectedFile" class="git-empty">
      <div class="i-mdi-file-document-outline git-empty-icon" />
      <span>{{ t('git.selectFileToView') }}</span>
    </div>

    <!-- File selected but no diff content -->
    <div v-else-if="!diffContent" class="git-empty">
      <div class="i-mdi-check-circle-outline git-empty-icon" />
      <span>{{ t('git.noDiff') }}</span>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="git-diff-header">
        <span class="git-diff-title">{{ diffFile || t('git.commitDetail') }}</span>
        <span v-if="!isUnsupported" class="git-diff-stat-add">+{{ stats.adds }}</span>
        <span v-if="!isUnsupported" class="git-diff-stat-del">-{{ stats.dels }}</span>
      </div>

      <!-- Binary / Too large message -->
      <div v-if="isUnsupported" class="git-empty">
        <div :class="isBinaryFile ? 'i-mdi-file-question-outline' : 'i-mdi-file-alert-outline'" class="git-empty-icon" />
        <span>{{ isBinaryFile ? t('git.binaryFileNoDiff') : t('git.fileTooLargeNoDiff') }}</span>
      </div>

      <!-- Diff content -->
      <div v-if="!isUnsupported" class="git-diff-body select-text cursor-text">
        <div v-if="!hasParsedHunks" class="git-diff-hunk">
          <div class="git-diff-hunk-header">
            <span class="truncate">{{ diffFile || t('git.commitDetail') }}</span>
          </div>
          <pre class="m-0 p-2 overflow-auto whitespace-pre-wrap">{{ rawDiffLines.join('\n') }}</pre>
        </div>
        <div
          v-for="(hunk, hunkIndex) in parsedHunks"
          :key="hunkIndex"
          class="git-diff-hunk"
        >
          <div class="git-diff-hunk-header">
            <span class="truncate">{{ hunk.header }}</span>
            <button
              type="button"
              class="git-diff-rollback"
              :disabled="reverting"
              @click="rollbackHunk(hunk)"
            >
              回滚区块
            </button>
          </div>
          <table class="git-diff-table">
            <tbody>
              <tr
                v-for="(line, i) in hunk.lines"
                :key="i"
                :class="{
                  'is-add': line.type === 'add',
                  'is-del': line.type === 'del',
                }"
              >
                <td class="git-diff-ln">{{ line.oldNum || '' }}</td>
                <td class="git-diff-ln">{{ line.newNum || '' }}</td>
                <td class="git-diff-code">{{ line.content }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
