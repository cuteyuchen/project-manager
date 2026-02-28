<script setup lang="ts">
import { computed } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import type { Project } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const emit = defineEmits<{
  (e: 'open-branch-dialog', mode: 'create' | 'delete', branch?: string): void;
  (e: 'open-stash'): void;
  (e: 'refresh'): void;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const currentBranch = computed(() => gitStore.getCurrentBranch(props.project.id));

const currentBranchInfo = computed(() => {
  const branches = gitStore.getBranches(props.project.id);
  return branches.find(b => b.is_current);
});

const isLoading = computed(() => gitStore.operationLoading);

async function handleFetch() {
  try {
    await gitStore.fetch(props.project.id, props.project.path);
    ElMessage.success(t('git.fetchSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handlePull() {
  try {
    await gitStore.pull(props.project.id, props.project.path);
    ElMessage.success(t('git.pullSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handlePush() {
  try {
    await gitStore.push(props.project.id, props.project.path);
    ElMessage.success(t('git.pushSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}
</script>

<template>
  <div class="flex items-center gap-1 px-3 py-2 border-b border-slate-200 dark:border-slate-700/50 bg-white/80 dark:bg-[#1e293b]/80 backdrop-blur-sm">
    <!-- Current branch display -->
    <div class="flex items-center gap-1.5 mr-3 px-2 py-1 rounded bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50">
      <div class="i-mdi-source-branch text-sm text-blue-500" />
      <span class="text-xs font-medium text-slate-700 dark:text-slate-300 max-w-[120px] truncate">{{ currentBranch || 'HEAD' }}</span>
      <template v-if="currentBranchInfo">
        <span v-if="currentBranchInfo.ahead > 0" class="text-[10px] px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">
          ↑{{ currentBranchInfo.ahead }}
        </span>
        <span v-if="currentBranchInfo.behind > 0" class="text-[10px] px-1 py-0.5 rounded bg-orange-500/10 text-orange-600 dark:text-orange-400">
          ↓{{ currentBranchInfo.behind }}
        </span>
      </template>
    </div>

    <!-- Action buttons -->
    <button @click="handleFetch" :disabled="isLoading"
      class="toolbar-btn" :title="t('git.fetch')">
      <div class="i-mdi-cloud-download-outline text-sm" />
      <span class="text-xs">{{ t('git.fetch') }}</span>
    </button>

    <button @click="handlePull" :disabled="isLoading"
      class="toolbar-btn" :title="t('git.pull')">
      <div class="i-mdi-arrow-down-bold text-sm" />
      <span class="text-xs">{{ t('git.pull') }}</span>
      <span v-if="currentBranchInfo && currentBranchInfo.behind > 0"
        class="px-1.5 py-0 rounded-full text-[10px] bg-orange-500 text-white font-bold leading-4 ml-0.5">
        {{ currentBranchInfo.behind }}
      </span>
    </button>

    <button @click="handlePush" :disabled="isLoading"
      class="toolbar-btn" :title="t('git.push')">
      <div class="i-mdi-arrow-up-bold text-sm" />
      <span class="text-xs">{{ t('git.push') }}</span>
      <span v-if="currentBranchInfo && currentBranchInfo.ahead > 0"
        class="px-1.5 py-0 rounded-full text-[10px] bg-green-500 text-white font-bold leading-4 ml-0.5">
        {{ currentBranchInfo.ahead }}
      </span>
    </button>

    <div class="w-px h-5 bg-slate-200 dark:bg-slate-700/50 mx-1" />

    <button @click="emit('open-branch-dialog', 'create')" :disabled="isLoading"
      class="toolbar-btn" :title="t('git.newBranch')">
      <div class="i-mdi-source-branch-plus text-sm" />
      <span class="text-xs">{{ t('git.branch') }}</span>
    </button>

    <button @click="emit('open-stash')" :disabled="isLoading"
      class="toolbar-btn" :title="t('git.stash')">
      <div class="i-mdi-package-down text-sm" />
      <span class="text-xs">{{ t('git.stash') }}</span>
    </button>

    <div class="flex-1" />

    <!-- Refresh -->
    <button @click="emit('refresh')" :disabled="isLoading"
      class="toolbar-btn" :title="t('git.refresh')">
      <div class="i-mdi-refresh text-sm" :class="{ 'animate-spin': isLoading }" />
    </button>

    <!-- Loading indicator -->
    <div v-if="isLoading" class="flex items-center gap-1 text-blue-500 text-xs">
      <div class="i-mdi-loading animate-spin text-sm" />
    </div>
  </div>
</template>

<style scoped>
.toolbar-btn {
  @apply flex items-center gap-1 px-2 py-1.5 rounded text-slate-600 dark:text-slate-400 
         hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors cursor-pointer
         disabled:opacity-50 disabled:cursor-not-allowed border border-transparent
         hover:border-slate-200 dark:hover:border-slate-700/50;
}
</style>
