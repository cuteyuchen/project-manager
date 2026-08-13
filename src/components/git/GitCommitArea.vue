<script setup lang="ts">
import { shallowRef, computed, ref, onMounted, onUnmounted } from 'vue';
import { useGitStore } from '../../stores/git.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { Project } from '../../types.ts';
import { showPersistentGitError } from './message.ts';
import { applyGeneratedCommitMessage } from './aiCommitMessageTarget.ts';

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
const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

const status = computed(() => gitStore.getStatus(props.project.id));
const summary = computed(() => gitStore.getSummary(props.project.id));

const stagedFiles = computed(() => status.value?.staged || []);
const unstagedCount = computed(() =>
  (status.value?.unstaged?.length || 0) + (status.value?.untracked?.length || 0)
);
const hasConflicts = computed(() =>
  Boolean(summary.value?.has_conflicts) || (status.value?.conflicted?.length || 0) > 0
);
/** 无 staged 但有未暂存变更时，提交将自动暂存 */
const willAutoStage = computed(() =>
  !hasConflicts.value && stagedFiles.value.length === 0 && unstagedCount.value > 0
);
const canCommit = computed(() =>
  !hasConflicts.value && (
    stagedFiles.value.length > 0 || willAutoStage.value
  )
);
/** amend：无冲突、有远程时仅 ahead 可改写；无远程也可 */
const canAmend = computed(() => {
  if (hasConflicts.value) return false;
  const s = summary.value;
  if (!s || s.is_detached) return false;
  if (!s.has_remote) return true;
  return s.ahead > 0 && s.behind === 0;
});

const aiEnabled = computed(() => settingsStore.settings.gitAiEnabled);

const commitHint = computed(() => {
  if (hasConflicts.value) return t('git.commitBlockedByConflict');
  if (willAutoStage.value) return t('git.commitAutoStageHint', { count: unstagedCount.value });
  return '';
});

/***********************通用判断*********************/

function isCancelledError(error: unknown): boolean {
  return String(error).toLowerCase().includes('cancelled');
}

function closeMenu() {
  menuOpen.value = false;
}

function onDocClick(e: MouseEvent) {
  if (!menuRef.value) return;
  if (!menuRef.value.contains(e.target as Node)) closeMenu();
}

onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));

/***********************提交操作*********************/

async function handleCommit() {
  if (!commitMessage.value.trim()) {
    ElMessage.warning(t('git.commitEmpty'));
    return;
  }
  if (!canCommit.value) {
    if (hasConflicts.value) {
      ElMessage.warning(t('git.commitBlockedByConflict'));
    } else {
      ElMessage.warning(t('git.commitNoStaged'));
    }
    return;
  }
  try {
    await gitStore.commitWithAutoStage(
      props.project.id,
      props.project.path,
      commitMessage.value.trim(),
    );
    commitMessage.value = '';
    ElMessage.success(t('git.commitSuccess'));
  } catch (e: any) {
    if (String(e).includes('has_conflicts')) {
      ElMessage.warning(t('git.commitBlockedByConflict'));
      return;
    }
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
  if (!canCommit.value) {
    if (hasConflicts.value) {
      ElMessage.warning(t('git.commitBlockedByConflict'));
    } else {
      ElMessage.warning(t('git.commitNoStaged'));
    }
    return;
  }
  try {
    await gitStore.commitWithAutoStage(
      props.project.id,
      props.project.path,
      commitMessage.value.trim(),
    );
    commitMessage.value = '';
    const s = summary.value;
    if (s && !s.has_remote) {
      await gitStore.push(props.project.id, props.project.path, 'origin', s.branch, false, true);
    } else {
      await gitStore.push(props.project.id, props.project.path);
    }
    ElMessage.success(t('git.commitAndPushSuccess'));
  } catch (e: any) {
    if (String(e).includes('has_conflicts')) {
      ElMessage.warning(t('git.commitBlockedByConflict'));
      return;
    }
    if (isCancelledError(e)) {
      ElMessage.info(t('git.operationCancelled'));
      return;
    }
    showPersistentGitError(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleAmend() {
  closeMenu();
  if (!canAmend.value) {
    ElMessage.warning(t('git.amendDisabled'));
    return;
  }
  const msg = commitMessage.value.trim();
  try {
    await gitStore.amend(props.project.id, props.project.path, msg || undefined);
    if (msg) commitMessage.value = '';
    ElMessage.success(t('git.amendSuccess'));
  } catch (e: any) {
    if (isCancelledError(e)) {
      ElMessage.info(t('git.operationCancelled'));
      return;
    }
    showPersistentGitError(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleUndoLastCommit(mode: 'soft' | 'mixed') {
  closeMenu();
  try {
    if (mode === 'mixed') {
      await ElMessageBox.confirm(t('git.undoCommitMixedConfirm'), t('common.warning'), {
        type: 'warning',
      });
    }
    await gitStore.resetTo(props.project.id, props.project.path, mode, 'HEAD~1');
    ElMessage.success(t('git.undoCommitSuccess'));
  } catch (e: any) {
    if (e === 'cancel' || e?.toString?.().includes('cancel')) return;
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
    // 无 staged 时先自动暂存，便于 AI 读取 diff
    if (willAutoStage.value) {
      await gitStore.stageAll(requestProjectId, requestProjectPath);
    }
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
          :disabled="aiGenerating || hasConflicts"
          class="git-ai-button flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          :title="t('git.aiGenerate')"
        >
          <div :class="aiGenerating ? 'i-mdi-loading animate-spin' : 'i-mdi-auto-fix'" class="text-xs" />
          {{ aiGenerating ? t('git.aiGenerating') : t('git.aiGenerate') }}
        </button>
        <span
          v-if="stagedFiles.length > 0"
          class="git-staged-pill text-[9px] px-1.5 py-0.5 rounded-full leading-none font-medium"
        >{{ stagedFiles.length }} {{ t('git.staged') }}</span>
        <span
          v-else-if="willAutoStage"
          class="git-autostage-pill text-[9px] px-1.5 py-0.5 rounded-full leading-none font-medium"
        >{{ t('git.autoStage') }}</span>
      </div>
    </div>

    <!-- 冲突 / 自动暂存提示 -->
    <div v-if="commitHint" class="px-2.5 py-1 text-[10px] shrink-0" :class="hasConflicts ? 'git-hint-danger' : 'git-hint-info'">
      {{ commitHint }}
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
      <button
        @click="handleCommit"
        :disabled="!commitMessage.trim() || !canCommit"
        class="git-commit-primary flex-1 py-1.5 rounded-md text-[11px] font-medium transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1"
      >
        <div class="i-mdi-check text-xs" />
        {{ t('git.commit') }}
      </button>
      <button
        @click="handleCommitAndPush"
        :disabled="!commitMessage.trim() || !canCommit"
        class="git-commit-success flex-1 py-1.5 rounded-md text-[11px] font-medium transition-all duration-200 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1"
        :title="t('git.commitAndPush')"
      >
        <div class="i-mdi-source-commit text-xs" />
        {{ t('git.commitAndPush') }}
      </button>
      <!-- 更多：amend / undo -->
      <div ref="menuRef" class="relative shrink-0">
        <button
          type="button"
          class="git-commit-more h-full px-2 rounded-md text-[11px] cursor-pointer"
          :title="t('git.moreCommitActions')"
          @click.stop="menuOpen = !menuOpen"
        >
          <div class="i-mdi-dots-vertical text-sm" />
        </button>
        <div v-if="menuOpen" class="git-commit-menu">
          <button type="button" :disabled="!canAmend" @click="handleAmend">
            {{ t('git.amend') }}
          </button>
          <button type="button" @click="handleUndoLastCommit('soft')">
            {{ t('git.undoCommitSoft') }}
          </button>
          <button type="button" @click="handleUndoLastCommit('mixed')">
            {{ t('git.undoCommitMixed') }}
          </button>
        </div>
      </div>
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

.git-autostage-pill {
  background: color-mix(in srgb, var(--app-warning, #f59e0b) 14%, transparent);
  color: var(--app-warning, #d97706);
}

.git-hint-danger {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 8%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--app-danger) 20%, transparent);
}

.git-hint-info {
  color: var(--app-text-secondary);
  background: var(--app-surface-soft);
  border-bottom: 1px solid var(--app-border);
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

.git-commit-more {
  border: 1px solid var(--app-border);
  background: var(--app-surface-soft);
  color: var(--app-text-secondary);
}

.git-commit-more:hover {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}

.git-commit-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 4px);
  min-width: 160px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-surface-raised, var(--app-surface));
  box-shadow: var(--app-shadow-md, 0 8px 24px rgba(0, 0, 0, 0.12));
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.git-commit-menu button {
  border: none;
  background: transparent;
  text-align: left;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--app-text-secondary);
  cursor: pointer;
}

.git-commit-menu button:hover:not(:disabled) {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}

.git-commit-menu button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
