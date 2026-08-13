<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessageBox } from 'element-plus';
import type { Project, GitFileStatus } from '../../types';
import { showPersistentGitError } from './message';

const props = defineProps<{
  project: Project;
  stagedRatio: number;
}>();

const emit = defineEmits<{
  'staged-split-mousedown': [e: MouseEvent];
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const statusResult = computed(() => gitStore.getStatus(props.project.id));
const stagedFiles = computed(() => statusResult.value?.staged || []);
const unstagedFiles = computed(() => [
  ...(statusResult.value?.unstaged || []),
  ...(statusResult.value?.untracked || []),
]);
const conflictedFiles = computed(() => statusResult.value?.conflicted || []);

const hasChanges = computed(() =>
  stagedFiles.value.length > 0 || unstagedFiles.value.length > 0 || conflictedFiles.value.length > 0
);

// Multi-select state
const selectedFiles = ref<Set<string>>(new Set());
const lastClickedFile = ref<string | null>(null);
const lastClickedArea = ref<'staged' | 'unstaged' | 'conflicted' | null>(null);

const selectedStagedCount = computed(() =>
  stagedFiles.value.filter(f => selectedFiles.value.has(f.path)).length
);
const selectedUnstagedCount = computed(() =>
  unstagedFiles.value.filter(f => selectedFiles.value.has(f.path)).length
);

// Clear selection when project changes
watch(() => props.project.id, () => {
  selectedFiles.value.clear();
  lastClickedFile.value = null;
  lastClickedArea.value = null;
});

// Clear selection for files that no longer exist in status
watch(statusResult, () => {
  if (selectedFiles.value.size === 0) return;
  const allPaths = new Set([
    ...stagedFiles.value.map(f => f.path),
    ...unstagedFiles.value.map(f => f.path),
    ...conflictedFiles.value.map(f => f.path),
  ]);
  for (const path of selectedFiles.value) {
    if (!allPaths.has(path)) {
      selectedFiles.value.delete(path);
    }
  }
});

function isFileSelected(file: GitFileStatus): boolean {
  return selectedFiles.value.has(file.path);
}

function getFileList(area: 'staged' | 'unstaged' | 'conflicted'): GitFileStatus[] {
  if (area === 'staged') return stagedFiles.value;
  if (area === 'conflicted') return conflictedFiles.value;
  return unstagedFiles.value;
}

function handleFileClick(event: MouseEvent, file: GitFileStatus, area: 'staged' | 'unstaged' | 'conflicted') {
  if (event.ctrlKey || event.metaKey) {
    // Ctrl+click: toggle selection
    if (selectedFiles.value.has(file.path)) {
      selectedFiles.value.delete(file.path);
    } else {
      selectedFiles.value.add(file.path);
    }
    lastClickedFile.value = file.path;
    lastClickedArea.value = area;
  } else if (event.shiftKey && lastClickedFile.value && lastClickedArea.value === area) {
    // Shift+click: range select within same area
    const fileList = getFileList(area);
    const lastIdx = fileList.findIndex(f => f.path === lastClickedFile.value);
    const currentIdx = fileList.findIndex(f => f.path === file.path);
    if (lastIdx !== -1 && currentIdx !== -1) {
      const start = Math.min(lastIdx, currentIdx);
      const end = Math.max(lastIdx, currentIdx);
      for (let i = start; i <= end; i++) {
        selectedFiles.value.add(fileList[i].path);
      }
    }
  } else {
    // Normal click: clear multi-select, select single, view diff
    selectedFiles.value.clear();
    selectedFiles.value.add(file.path);
    lastClickedFile.value = file.path;
    lastClickedArea.value = area;
    viewDiff(file);
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'untracked': return 'U';
    case 'conflicted': return 'C';
    case 'copied': return 'C';
    default: return '?';
  }
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

function fileDir(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.length > 0 ? parts.join('/') + '/' : '';
}

async function viewDiff(file: GitFileStatus) {
  try {
    await gitStore.getDiff(props.project.path, file.path, file.staged);
  } catch (e) {
    showPersistentGitError(t('git.diffLoadFailed', { error: String(e) }));
  }
}

async function stageFile(file: GitFileStatus) {
  await gitStore.stageFiles(props.project.id, props.project.path, [file.path]);
}

async function unstageFile(file: GitFileStatus) {
  await gitStore.unstageFiles(props.project.id, props.project.path, [file.path]);
}

async function discardFile(file: GitFileStatus) {
  try {
    await ElMessageBox.confirm(t('git.discardConfirm'), t('common.warning'), { type: 'warning' });
  } catch {
    return;
  }
  try {
    if (file.status === 'untracked') {
      await gitStore.discardUntracked(props.project.id, props.project.path, [file.path]);
    } else {
      await gitStore.discardFiles(props.project.id, props.project.path, [file.path]);
    }
  } catch (e) {
    showPersistentGitError(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleStageAll() {
  await gitStore.stageAll(props.project.id, props.project.path);
}

async function handleUnstageAll() {
  await gitStore.unstageAll(props.project.id, props.project.path);
}

// Batch operations
async function handleBatchStage() {
  const files = [
    ...unstagedFiles.value.filter(f => selectedFiles.value.has(f.path)),
    ...conflictedFiles.value.filter(f => selectedFiles.value.has(f.path)),
  ];
  if (files.length > 0) {
    await gitStore.stageFiles(props.project.id, props.project.path, files.map(f => f.path));
    selectedFiles.value.clear();
  }
}

async function handleBatchUnstage() {
  const files = stagedFiles.value.filter(f => selectedFiles.value.has(f.path));
  if (files.length > 0) {
    await gitStore.unstageFiles(props.project.id, props.project.path, files.map(f => f.path));
    selectedFiles.value.clear();
  }
}

async function handleBatchDiscard() {
  try {
    await ElMessageBox.confirm(t('git.discardConfirm'), t('common.warning'), { type: 'warning' });
  } catch {
    return;
  }
  const selected = unstagedFiles.value.filter(f => selectedFiles.value.has(f.path));
  const untracked = selected.filter(f => f.status === 'untracked');
  const modified = selected.filter(f => f.status !== 'untracked');
  try {
    if (untracked.length > 0) {
      await gitStore.discardUntracked(props.project.id, props.project.path, untracked.map(f => f.path));
    }
    if (modified.length > 0) {
      await gitStore.discardFiles(props.project.id, props.project.path, modified.map(f => f.path));
    }
    selectedFiles.value.clear();
  } catch (e) {
    showPersistentGitError(t('git.operationFailed', { error: String(e) }));
  }
}
</script>

<template>
  <div class="git-status-panel">
    <!-- No changes -->
    <div v-if="!hasChanges" class="git-empty">
      <div class="i-mdi-check-circle-outline git-empty-icon" />
      <span>{{ t('git.noChanges') }}</span>
    </div>

    <template v-else>
      <!-- Staged area (top) -->
      <div class="git-scm-section" :style="{ height: stagedRatio + '%' }">
        <div class="git-scm-section-header is-staged">
          <span class="flex-1 min-w-0 truncate">
            {{ t('git.stagedChanges') }}
            <span class="git-scm-count">{{ stagedFiles.length }}</span>
            <template v-if="selectedStagedCount > 0">
              <span class="font-normal opacity-80"> · {{ t('git.selectedCount', { count: selectedStagedCount }) }}</span>
            </template>
          </span>
          <div class="git-scm-actions">
            <template v-if="selectedStagedCount > 1">
              <button type="button" class="git-scm-chip-btn" :title="t('git.batchUnstage')" @click="handleBatchUnstage">
                {{ t('git.batchUnstage') }}
              </button>
              <button type="button" class="git-scm-icon-btn" :title="t('git.clearSelection')" @click="selectedFiles.clear()">
                <div class="i-mdi-close-circle-outline" />
              </button>
            </template>
            <button
              v-else-if="stagedFiles.length > 0"
              type="button"
              class="git-scm-icon-btn"
              :title="t('git.unstageAll')"
              @click="handleUnstageAll"
            >
              <div class="i-mdi-minus-circle-outline" />
            </button>
          </div>
        </div>
        <div class="git-scm-list">
          <div v-if="stagedFiles.length === 0" class="git-scm-list-empty">
            {{ t('git.noChanges') }}
          </div>
          <div
            v-for="file in stagedFiles"
            :key="'s:' + file.path"
            class="git-scm-file-row"
            :class="{ 'is-selected': isFileSelected(file) }"
            @click="handleFileClick($event, file, 'staged')"
          >
            <span class="git-scm-file-status" :class="`is-${file.status}`">{{ statusIcon(file.status) }}</span>
            <span class="git-scm-file-main">
              <span class="git-scm-file-dir">{{ fileDir(file.path) }}</span><span class="git-scm-file-name">{{ fileName(file.path) }}</span>
            </span>
            <div class="git-scm-file-actions">
              <button type="button" :title="t('git.unstage')" @click.stop="unstageFile(file)">
                <div class="i-mdi-minus text-xs" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Staged/Unstaged drag handle -->
      <div
        class="git-split-h"
        @mousedown="emit('staged-split-mousedown', $event)"
      />

      <!-- Unstaged area (bottom) -->
      <div class="git-scm-section" :style="{ height: (100 - stagedRatio) + '%' }">
        <!-- Conflicted files at top of unstaged -->
        <template v-if="conflictedFiles.length > 0">
          <div class="git-scm-section-header is-conflict">
            <span class="flex-1 min-w-0 truncate">
              {{ t('git.conflictedFiles') }}
              <span class="git-scm-count">{{ conflictedFiles.length }}</span>
            </span>
          </div>
          <div class="max-h-[100px] overflow-auto shrink-0">
            <div
              v-for="file in conflictedFiles"
              :key="'c:' + file.path"
              class="git-scm-file-row"
              :class="{ 'is-selected': isFileSelected(file) }"
              @click="handleFileClick($event, file, 'conflicted')"
            >
              <span class="git-scm-file-status is-conflicted">C</span>
              <span class="git-scm-file-main">
                <span class="git-scm-file-dir">{{ fileDir(file.path) }}</span><span class="git-scm-file-name">{{ fileName(file.path) }}</span>
              </span>
              <div class="git-scm-file-actions">
                <button type="button" class="is-success" :title="t('git.stage')" @click.stop="stageFile(file)">
                  <div class="i-mdi-plus text-xs" />
                </button>
              </div>
            </div>
          </div>
        </template>

        <div class="git-scm-section-header is-unstaged">
          <span class="flex-1 min-w-0 truncate">
            {{ t('git.unstagedChanges') }}
            <span class="git-scm-count">{{ unstagedFiles.length }}</span>
            <template v-if="selectedUnstagedCount > 0">
              <span class="font-normal opacity-80"> · {{ t('git.selectedCount', { count: selectedUnstagedCount }) }}</span>
            </template>
          </span>
          <div class="git-scm-actions">
            <template v-if="selectedUnstagedCount > 1">
              <button type="button" class="git-scm-chip-btn" :title="t('git.batchStage')" @click="handleBatchStage">
                {{ t('git.batchStage') }}
              </button>
              <button type="button" class="git-scm-chip-btn" :title="t('git.batchDiscard')" @click="handleBatchDiscard">
                {{ t('git.batchDiscard') }}
              </button>
              <button type="button" class="git-scm-icon-btn" :title="t('git.clearSelection')" @click="selectedFiles.clear()">
                <div class="i-mdi-close-circle-outline" />
              </button>
            </template>
            <button
              v-else-if="unstagedFiles.length > 0"
              type="button"
              class="git-scm-icon-btn"
              :title="t('git.stageAll')"
              @click="handleStageAll"
            >
              <div class="i-mdi-plus-circle-outline" />
            </button>
          </div>
        </div>
        <div class="git-scm-list">
          <div v-if="unstagedFiles.length === 0" class="git-scm-list-empty">
            {{ t('git.noChanges') }}
          </div>
          <div
            v-for="file in unstagedFiles"
            :key="'u:' + file.path"
            class="git-scm-file-row"
            :class="{ 'is-selected': isFileSelected(file) }"
            @click="handleFileClick($event, file, 'unstaged')"
          >
            <span class="git-scm-file-status" :class="`is-${file.status}`">{{ statusIcon(file.status) }}</span>
            <span class="git-scm-file-main">
              <span class="git-scm-file-dir">{{ fileDir(file.path) }}</span><span class="git-scm-file-name">{{ fileName(file.path) }}</span>
            </span>
            <div class="git-scm-file-actions">
              <button type="button" class="is-success" :title="t('git.stage')" @click.stop="stageFile(file)">
                <div class="i-mdi-plus text-xs" />
              </button>
              <button type="button" class="is-danger" :title="t('git.discard')" @click.stop="discardFile(file)">
                <div class="i-mdi-undo text-xs" />
              </button>
            </div>
          </div>
        </div>
      </div>

    </template>
  </div>
</template>
