<script setup lang="ts">
import { shallowRef, computed } from 'vue';
import { useGitStore } from '../../stores/git';
import { useSettingsStore } from '../../stores/settings';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import type { Project } from '../../types';
import { showPersistentGitError } from './message';
import { applyGeneratedCommitMessage } from './aiCommitMessageTarget';

/***********************组件输入与依赖*********************/

const props = defineProps<{
  project: Project;
}>();

const { t } = useI18n();
const gitStore = useGitStore();
const settingsStore = useSettingsStore();

/***********************提交信息状态*********************/

const commitMessage = computed({
  get: () => gitStore.commitMessage[props.project.id] || '',
  set: (v: string) => { gitStore.commitMessage[props.project.id] = v; },
});
const aiGenerating = shallowRef(false);

const stagedFiles = computed(() => {
  const s = gitStore.getStatus(props.project.id);
  return s?.staged || [];
});

const aiEnabled = computed(() => settingsStore.settings.gitAiEnabled);

/***********************通用判断*********************/

function isCancelledError(error: unknown): boolean {
  return String(error).toLowerCase().includes('cancelled');
}

/***********************提交操作*********************/

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
    if (isCancelledError(e)) {
      ElMessage.info(t('git.operationCancelled'));
      return;
    }
    showPersistentGitError(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleCommitAndPush() {
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
    await gitStore.push(props.project.id, props.project.path);
    ElMessage.success(t('git.commitAndPushSuccess'));
  } catch (e: any) {
    if (isCancelledError(e)) {
      ElMessage.info(t('git.operationCancelled'));
      return;
    }
    showPersistentGitError(t('git.operationFailed', { error: String(e) }));
  }
}

/***********************AI提交信息生成*********************/

async function handleAiGenerate() {
  const s = settingsStore.settings;
  const service = s.gitAiPrimaryService;
  if (!service?.apiKey?.trim() || !service?.baseUrl?.trim() || !service?.model?.trim()) {
    ElMessage.warning(t('git.aiConfigMissing'));
    return;
  }

  const requestProjectId = props.project.id;
  const requestProjectPath = props.project.path;

  aiGenerating.value = true;
  try {
    const msg = await gitStore.generateAiCommitMessage(requestProjectId, requestProjectPath, {
      service,
      promptTemplate: s.gitAiPromptTemplate,
      stream: s.gitAiStream,
    });
    if (applyGeneratedCommitMessage(gitStore.commitMessage, requestProjectId, msg)) {
      ElMessage.success(t('git.aiSuccess'));
    }
  } catch (e: any) {
    const msg = String(e);
    if (msg.includes('no_staged')) {
      ElMessage.warning(t('git.aiNoStaged'));
    } else {
      showPersistentGitError(t('git.aiError', { error: msg }));
    }
  } finally {
    aiGenerating.value = false;
  }
}
</script>

<template>
  <div class="git-commit-area flex flex-col shrink-0 overflow-hidden font-sans">
    <!-- Header -->
    <div class="git-commit-header flex items-center justify-between px-2.5 py-1 shrink-0">
      <span class="text-[10px] font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1">
        <div class="i-mdi-message-text-outline text-xs text-blue-500/60" />
        {{ t('git.commitMessage') }}
      </span>
      <div class="flex items-center gap-1">
        <button
          v-if="aiEnabled"
          @click="handleAiGenerate"
          :disabled="aiGenerating"
          class="git-ai-button flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          :title="t('git.aiGenerate')"
        >
          <div :class="aiGenerating ? 'i-mdi-loading animate-spin' : 'i-mdi-auto-fix'" class="text-xs" />
          {{ aiGenerating ? t('git.aiGenerating') : t('git.aiGenerate') }}
        </button>
        <span v-if="stagedFiles.length > 0" class="git-staged-pill text-[9px] px-1.5 py-0.5 rounded-full leading-none font-medium">{{ stagedFiles.length }} {{ t('git.staged') }}</span>
      </div>
    </div>
    <!-- Textarea -->
    <div class="p-1.5 flex-1 min-h-0 overflow-hidden">
      <textarea
        v-model="commitMessage"
        :placeholder="t('git.commitPlaceholder')"
        class="git-commit-textarea w-full h-full box-border px-2 py-1.5 text-[11px] rounded-md resize-none focus:outline-none transition-all duration-150"
        @keydown.ctrl.enter="handleCommit"
      />
    </div>
    <!-- Commit buttons -->
    <div class="px-1.5 pb-1.5 shrink-0 flex gap-1.5">
      <button @click="handleCommit"
        :disabled="!commitMessage.trim() || stagedFiles.length === 0"
        class="git-commit-primary flex-1 py-1.5 rounded-md text-[11px] font-medium transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1">
        <div class="i-mdi-check text-xs" />
        {{ t('git.commit') }}
      </button>
      <button @click="handleCommitAndPush"
        :disabled="!commitMessage.trim() || stagedFiles.length === 0"
        class="git-commit-success flex-1 py-1.5 rounded-md text-[11px] font-medium transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1"
        :title="t('git.commitAndPush')">
        <div class="i-mdi-source-commit text-xs" />
        {{ t('git.commitAndPush') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.git-commit-area {
  background: var(--app-surface);
  color: var(--app-text);
}

.git-commit-header {
  border-bottom: 1px solid var(--app-border);
}

.git-ai-button {
  background: color-mix(in srgb, var(--app-primary) 10%, transparent);
  color: var(--app-primary);
}

.git-ai-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-primary) 16%, transparent);
}

.git-staged-pill {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}

.git-commit-textarea {
  border: 1px solid var(--app-border);
  background: var(--app-surface-soft);
  color: var(--app-text-secondary);
}

.git-commit-textarea:focus {
  border-color: color-mix(in srgb, var(--app-primary) 36%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary) 20%, transparent);
}

.git-commit-textarea::placeholder {
  color: var(--app-text-muted);
}

.git-commit-primary {
  background: var(--app-primary);
  color: white;
  box-shadow: var(--app-shadow-sm);
}

.git-commit-primary:hover:not(:disabled) {
  background: var(--app-primary-hover);
}

.git-commit-success {
  background: var(--app-success);
  color: white;
  box-shadow: var(--app-shadow-sm);
}

.git-commit-success:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-success) 86%, black);
}
</style>
