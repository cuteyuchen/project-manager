<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import type { Project } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const commitMessage = ref('');

const stagedFiles = computed(() => {
  const s = gitStore.getStatus(props.project.id);
  return s?.staged || [];
});

async function handleCommit() {
  if (!commitMessage.value.trim()) {
    ElMessage.warning(t('git.commitEmpty'));
    return;
  }
  if (stagedFiles.value.length === 0) {
    ElMessage.warning(t('git.commitNoStaged'));
    return;
  }
  try {
    await gitStore.commit(props.project.id, props.project.path, commitMessage.value.trim());
    commitMessage.value = '';
    ElMessage.success(t('git.commitSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-white/50 dark:bg-[#0f172a]/50">
    <!-- Header -->
    <div class="flex items-center justify-between px-2.5 py-1.5 border-b border-slate-200/60 dark:border-slate-700/30 shrink-0">
      <span class="text-[11px] font-medium text-slate-500 dark:text-slate-400">{{ t('git.commitMessage') }}</span>
      <span v-if="stagedFiles.length > 0" class="text-[10px] text-blue-500">{{ stagedFiles.length }} {{ t('git.staged') }}</span>
    </div>
    <!-- Textarea -->
    <div class="flex-1 p-1.5 overflow-hidden min-h-0">
      <textarea
        v-model="commitMessage"
        :placeholder="t('git.commitPlaceholder')"
        class="w-full h-full px-2 py-1.5 text-xs rounded border border-slate-200/80 dark:border-slate-700/40 bg-slate-50/80 dark:bg-slate-900/30 text-slate-700 dark:text-slate-300 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500/40 focus:border-blue-500/40 placeholder:text-slate-400/50"
        @keydown.ctrl.enter="handleCommit"
      />
    </div>
    <!-- Commit button -->
    <div class="px-1.5 pb-1.5 shrink-0">
      <button @click="handleCommit"
        :disabled="!commitMessage.trim() || stagedFiles.length === 0"
        class="w-full py-1.5 rounded text-xs font-medium bg-blue-500 hover:bg-blue-600 text-white transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed flex items-center justify-center gap-1">
        <div class="i-mdi-check text-sm" />
        {{ t('git.commit') }}
      </button>
    </div>
  </div>
</template>
