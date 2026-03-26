<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useProjectStore } from '../../stores/project';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import GitToolbar from './GitToolbar.vue';
import GitStatusPanel from './GitStatusPanel.vue';
import GitCommitArea from './GitCommitArea.vue';
import GitDiffView from './GitDiffView.vue';
import GitHistory from './GitHistory.vue';
import GitBranchDialog from './GitBranchDialog.vue';

const { t } = useI18n();
const projectStore = useProjectStore();
const gitStore = useGitStore();

const activeTab = ref<'changes' | 'history'>('changes');
const showBranchDialog = ref(false);

const activeProject = computed(() =>
  projectStore.projects.find(p => p.id === projectStore.activeProjectId)
);

const isGitRepo = computed(() => {
  if (!activeProject.value) return false;
  return gitStore.isGitRepo[activeProject.value.id] || false;
});

// Watch project changes — refresh and clear stale diff
watch(activeProject, async (newProject, oldProject) => {
  if (oldProject?.id !== newProject?.id) {
    gitStore.clearDiff();
  }
  if (newProject) {
    const isRepo = await gitStore.checkGitRepo(newProject.id, newProject.path);
    if (isRepo) {
      await gitStore.refreshSummaryAndStatus(newProject.id, newProject.path);
    }
  }
}, { immediate: true });

// Clear diff when switching tabs; lazy-load history
watch(activeTab, (tab) => {
  gitStore.clearDiff();
  if (tab === 'history' && activeProject.value) {
    gitStore.refreshHistory(activeProject.value.id, activeProject.value.path);
  }
});

async function handleInitRepo() {
  if (!activeProject.value) return;
  try {
    await gitStore.initRepo(activeProject.value.id, activeProject.value.path);
    ElMessage.success(t('git.initSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleRefresh() {
  if (!activeProject.value) return;
  await gitStore.refreshSummaryAndStatus(activeProject.value.id, activeProject.value.path);
  if (activeTab.value === 'history') {
    await gitStore.refreshHistory(activeProject.value.id, activeProject.value.path);
  }
}

const tabs = computed(() => [
  { value: 'changes' as const, label: t('git.fileStatus') },
  { value: 'history' as const, label: t('git.commitHistory') },
]);
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Not a git repo -->
    <div v-if="!isGitRepo" class="flex-1 flex flex-col items-center justify-center gap-3">
      <div class="i-mdi-source-branch text-4xl text-slate-300 dark:text-slate-600" />
      <p class="text-sm text-slate-500 dark:text-slate-400">{{ t('git.notGitRepo') }}</p>
      <button @click="handleInitRepo"
        class="px-4 py-1.5 rounded-md text-xs font-medium bg-blue-500 hover:bg-blue-600 text-white transition-colors cursor-pointer">
        {{ t('git.initRepo') }}
      </button>
    </div>

    <!-- Git view -->
    <template v-else-if="activeProject">
      <!-- Toolbar -->
      <GitToolbar
        :project="activeProject"
        @open-branch-dialog="showBranchDialog = true"
        @refresh="handleRefresh"
      />

      <!-- Tab bar -->
      <div class="flex border-b border-slate-200/40 dark:border-slate-700/30 shrink-0 px-2">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          @click="activeTab = tab.value"
          class="px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2 -mb-px cursor-pointer"
          :class="activeTab === tab.value
            ? 'border-blue-500 text-blue-600 dark:text-blue-400'
            : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Content area -->
      <div class="flex-1 flex min-h-0">
        <!-- Left panel -->
        <div class="w-[300px] flex flex-col border-r border-slate-200/40 dark:border-slate-700/30 shrink-0">
          <template v-if="activeTab === 'changes'">
            <div class="flex-1 min-h-0 overflow-auto">
              <GitStatusPanel :project="activeProject" />
            </div>
            <GitCommitArea :project="activeProject" />
          </template>
          <template v-else>
            <GitHistory :project="activeProject" />
          </template>
        </div>

        <!-- Right panel: shared diff view -->
        <div class="flex-1 min-w-0">
          <GitDiffView :project="activeProject" />
        </div>
      </div>

      <!-- Branch dialog -->
      <GitBranchDialog
        v-model="showBranchDialog"
        :project="activeProject"
      />
    </template>
  </div>
</template>
