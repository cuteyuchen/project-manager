<script setup lang="ts">
import { computed, ref } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api';
import type { Project, GitFileStatus } from '../../types';

const props = defineProps<{
  project: Project;
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

// Context menu state
const ctxMenu = ref<{
  show: boolean;
  x: number;
  y: number;
  file: GitFileStatus | null;
  isStaged: boolean;
}>({ show: false, x: 0, y: 0, file: null, isStaged: false });

function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    modified: 'text-amber-500',
    added: 'text-green-500',
    deleted: 'text-red-500',
    renamed: 'text-purple-500',
    untracked: 'text-slate-400',
    conflicted: 'text-red-600',
    copied: 'text-blue-500',
  };
  return map[status] || 'text-slate-400';
}

function getStatusLetter(status: string): string {
  const map: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', conflicted: 'C', copied: 'CP' };
  return map[status] || '?';
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function getFileDir(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.length > 0 ? parts.join('/') + '/' : '';
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function handleStage(file: GitFileStatus) {
  try {
    await gitStore.stageFiles(props.project.id, props.project.path, [file.path]);
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleUnstage(file: GitFileStatus) {
  try {
    await gitStore.unstageFiles(props.project.id, props.project.path, [file.path]);
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleStageAll() {
  try { await gitStore.stageAll(props.project.id, props.project.path); }
  catch (e: any) { ElMessage.error(t('git.operationFailed', { error: String(e) })); }
}

async function handleUnstageAll() {
  try { await gitStore.unstageAll(props.project.id, props.project.path); }
  catch (e: any) { ElMessage.error(t('git.operationFailed', { error: String(e) })); }
}

async function handleViewDiff(file: GitFileStatus) {
  try {
    await gitStore.getDiff(props.project.path, file.path, file.staged);
  } catch (e: any) {
    console.error('Failed to get diff:', e);
  }
}

// ─── Context Menu ────────────────────────────────────────────────────────────

function handleContextMenu(e: MouseEvent, file: GitFileStatus, isStaged: boolean) {
  e.preventDefault();
  ctxMenu.value = { show: true, x: e.clientX, y: e.clientY, file, isStaged };
  setTimeout(() => {
    document.addEventListener('click', closeCtxMenu, { once: true });
    document.addEventListener('contextmenu', closeCtxMenu, { once: true });
  });
}

function closeCtxMenu() {
  ctxMenu.value.show = false;
}

async function ctxStage() {
  if (!ctxMenu.value.file) return;
  closeCtxMenu();
  await handleStage(ctxMenu.value.file);
}

async function ctxUnstage() {
  if (!ctxMenu.value.file) return;
  closeCtxMenu();
  await handleUnstage(ctxMenu.value.file);
}

async function ctxDiscard() {
  if (!ctxMenu.value.file) return;
  closeCtxMenu();
  const file = ctxMenu.value.file;
  try {
    await ElMessageBox.confirm(t('git.discardConfirm'), t('git.discard'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    });
    if (file.status === 'untracked') {
      await gitStore.discardUntracked(props.project.id, props.project.path, [file.path]);
    } else {
      await gitStore.discardFiles(props.project.id, props.project.path, [file.path]);
    }
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function ctxStopTracking() {
  if (!ctxMenu.value.file) return;
  closeCtxMenu();
  try {
    await gitStore.rmCached(props.project.id, props.project.path, [ctxMenu.value.file.path]);
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function ctxIgnore() {
  if (!ctxMenu.value.file) return;
  closeCtxMenu();
  const filePath = ctxMenu.value.file.path;
  try {
    ElMessage.info('Please manually add "' + filePath + '" to .gitignore');
  } catch (e: any) {
    ElMessage.error(String(e));
  }
}

async function ctxOpenInEditor() {
  if (!ctxMenu.value.file) return;
  closeCtxMenu();
  try {
    await api.openInEditor(props.project.path + '/' + ctxMenu.value.file.path);
  } catch (e: any) {
    ElMessage.error(String(e));
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden text-xs">

    <!-- Conflicted files -->
    <div v-if="conflictedFiles.length > 0" class="border-b border-red-200/80 dark:border-red-900/30 shrink-0">
      <div class="flex items-center justify-between px-3 py-1.5 bg-red-50/80 dark:bg-red-900/15">
        <span class="font-medium text-red-600 dark:text-red-400 flex items-center gap-1">
          {{ t('git.conflictedFiles') }}
          <span class="text-[10px] bg-red-500/15 px-1.5 rounded-full">{{ conflictedFiles.length }}</span>
        </span>
      </div>
      <div class="max-h-24 overflow-y-auto custom-scrollbar">
        <div v-for="file in conflictedFiles" :key="file.path"
          @click="handleViewDiff(file)"
          @contextmenu="handleContextMenu($event, file, false)"
          class="file-row">
          <span class="w-4 text-center text-[10px] font-bold flex-shrink-0 text-red-600">C</span>
          <span class="text-slate-400/70 text-[10px] truncate">{{ getFileDir(file.path) }}</span>
          <span class="truncate font-medium flex-1 min-w-0">{{ getFileName(file.path) }}</span>
        </div>
      </div>
    </div>

    <!-- ===== Staged changes (on top) ===== -->
    <div class="flex-1 min-h-0 flex flex-col border-b border-slate-200/60 dark:border-slate-700/30">
      <div class="flex items-center justify-between px-3 py-1.5 bg-white/60 dark:bg-[#141d2e]/40 shrink-0">
        <span class="font-medium text-slate-600 dark:text-slate-400 flex items-center gap-1">
          {{ t('git.stagedChanges') }}
          <span class="text-[10px] bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 rounded-full font-bold">{{ stagedFiles.length }}</span>
        </span>
        <button v-if="stagedFiles.length > 0" @click="handleUnstageAll"
          class="px-2 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 cursor-pointer font-medium transition-colors"
          :title="t('git.unstageAll')">
          {{ t('git.unstageAll') }}
        </button>
      </div>
      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <div v-for="file in stagedFiles" :key="file.path + ':s'"
          @click="handleViewDiff(file)"
          @contextmenu="handleContextMenu($event, file, true)"
          class="file-row">
          <span class="w-4 text-center text-[10px] font-bold flex-shrink-0 rounded-sm"
            :class="getStatusColor(file.status)">
            {{ getStatusLetter(file.status) }}
          </span>
          <span class="text-slate-400/60 text-[10px] truncate">{{ getFileDir(file.path) }}</span>
          <span class="truncate flex-1 min-w-0">{{ getFileName(file.path) }}</span>
          <button @click.stop="handleUnstage(file)"
            class="px-1.5 py-0.5 rounded text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/8 hover:bg-amber-500/20 flex-shrink-0 cursor-pointer transition-colors font-medium"
            :title="t('git.unstage')">
            {{ t('git.unstage') }}
          </button>
        </div>
        <div v-if="stagedFiles.length === 0" class="flex items-center justify-center py-6 text-slate-400/50">
          {{ t('git.noChanges') }}
        </div>
      </div>
    </div>

    <!-- ===== Unstaged changes (below) ===== -->
    <div class="flex-1 min-h-0 flex flex-col">
      <div class="flex items-center justify-between px-3 py-1.5 bg-white/60 dark:bg-[#141d2e]/40 shrink-0">
        <span class="font-medium text-slate-600 dark:text-slate-400 flex items-center gap-1">
          {{ t('git.unstagedChanges') }}
          <span class="text-[10px] bg-slate-100 dark:bg-slate-800/50 px-1.5 rounded-full">{{ unstagedFiles.length }}</span>
        </span>
        <button v-if="unstagedFiles.length > 0" @click="handleStageAll"
          class="px-2 py-0.5 rounded text-[10px] bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 cursor-pointer font-medium transition-colors"
          :title="t('git.stageAll')">
          {{ t('git.stageAll') }}
        </button>
      </div>
      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <div v-for="file in unstagedFiles" :key="file.path + ':u'"
          @click="handleViewDiff(file)"
          @contextmenu="handleContextMenu($event, file, false)"
          class="file-row">
          <span class="w-4 text-center text-[10px] font-bold flex-shrink-0 rounded-sm"
            :class="getStatusColor(file.status)">
            {{ getStatusLetter(file.status) }}
          </span>
          <span class="text-slate-400/60 text-[10px] truncate">{{ getFileDir(file.path) }}</span>
          <span class="truncate flex-1 min-w-0">{{ getFileName(file.path) }}</span>
          <button @click.stop="handleStage(file)"
            class="px-1.5 py-0.5 rounded text-[10px] text-green-600 dark:text-green-400 bg-green-500/8 hover:bg-green-500/20 flex-shrink-0 cursor-pointer transition-colors font-medium"
            :title="t('git.stage')">
            {{ t('git.stage') }}
          </button>
        </div>
        <div v-if="unstagedFiles.length === 0" class="flex items-center justify-center py-6 text-slate-400/50">
          {{ t('git.noChanges') }}
        </div>
      </div>
    </div>

    <!-- File Context Menu -->
    <Teleport to="body">
      <div v-if="ctxMenu.show && ctxMenu.file"
        class="fixed z-[9999] min-w-[140px] py-1 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-[#1e293b] text-xs"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <button v-if="!ctxMenu.isStaged" @click="ctxStage" class="ctx-item">{{ t('git.stage') }}</button>
        <button v-if="ctxMenu.isStaged" @click="ctxUnstage" class="ctx-item">{{ t('git.unstage') }}</button>
        <button @click="ctxDiscard" class="ctx-item text-red-500">{{ t('git.discard') }}</button>
        <div class="border-t border-slate-200/60 dark:border-slate-700/40 my-1" />
        <button @click="ctxStopTracking" class="ctx-item">{{ t('git.stopTracking') }}</button>
        <button @click="ctxIgnore" class="ctx-item">{{ t('git.ignoreFile') }}</button>
        <div class="border-t border-slate-200/60 dark:border-slate-700/40 my-1" />
        <button @click="ctxOpenInEditor" class="ctx-item">{{ t('git.openInEditor') }}</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.file-row {
  @apply flex items-center gap-1.5 px-3 py-1 hover:bg-slate-100/80 dark:hover:bg-slate-800/20 cursor-pointer transition-colors;
}

.ctx-item {
  @apply w-full px-3 py-1.5 text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/50 cursor-pointer transition-colors block;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 2px;
}
.dark .custom-scrollbar::-webkit-scrollbar-thumb {
  background: #334155;
}
</style>
