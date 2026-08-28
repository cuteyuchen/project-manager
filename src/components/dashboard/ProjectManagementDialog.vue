<script setup lang="ts">
/***********************快速管理弹窗*********************/
import { computed, nextTick, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Project, WorkspaceTab } from '../../types';
import ProjectManagementPanel from './ProjectManagementPanel.vue';

const props = withDefaults(defineProps<{
  modelValue: boolean;
  project: Project | null;
  initialTab?: WorkspaceTab | null;
}>(), {
  initialTab: null,
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'open-workspace', project: Project): void;
}>();

const { t } = useI18n();
const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});
const managementPanel = useTemplateRef<InstanceType<typeof ProjectManagementPanel>>('managementPanel');

/***********************打开状态同步*********************/
function activatePanel(): void {
  void nextTick(() => managementPanel.value?.activate(props.initialTab));
}

watch(() => props.modelValue, (opened) => {
  if (opened) activatePanel();
});

watch(() => props.project?.id, () => {
  if (props.modelValue) activatePanel();
});

watch(() => props.initialTab, () => {
  if (props.modelValue) activatePanel();
});

function openWorkspace(): void {
  if (!props.project) return;
  emit('open-workspace', props.project);
  visible.value = false;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    class="project-management-dialog"
    width="88%"
    top="6vh"
    :close-on-press-escape="true"
    :destroy-on-close="false"
    append-to-body
  >
    <template #header>
      <div class="project-management-dialog-header">
        <div class="min-w-0">
          <div class="project-management-dialog-title truncate">{{ project?.name }}</div>
          <div class="project-management-dialog-path truncate">{{ project?.path }}</div>
        </div>
        <button
          class="project-management-dialog-workspace"
          :title="t('dashboard.openFullWorkspace')"
          @click="openWorkspace"
        >
          <div class="i-mdi-open-in-new text-sm" />
          <span>{{ t('dashboard.openFullWorkspace') }}</span>
        </button>
      </div>
    </template>

    <div class="project-management-dialog-body">
      <ProjectManagementPanel
        v-if="project"
        ref="managementPanel"
        :project="project"
        :initial-tab="initialTab"
        :show-title="false"
      />
    </div>
  </el-dialog>
</template>

<style scoped>
.project-management-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
  padding-right: 8px;
}
.project-management-dialog-title {
  color: var(--app-text);
  font-size: 15px;
  font-weight: 700;
}
.project-management-dialog-path {
  margin-top: 2px;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
}
.project-management-dialog-workspace {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  background: var(--app-surface-soft);
  color: var(--app-text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.project-management-dialog-workspace:hover {
  border-color: color-mix(in srgb, var(--app-primary) 40%, transparent);
  color: var(--app-primary);
}
.project-management-dialog-body {
  height: min(78vh, 760px);
  min-height: 420px;
  margin: -8px -20px -20px;
  overflow: hidden;
}
:deep(.project-management-dialog .el-dialog__header) {
  margin-right: 0;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--app-border);
}
:deep(.project-management-dialog .el-dialog__body) {
  padding: 0 20px 20px;
}
@media (max-width: 800px) {
  .project-management-dialog-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding-right: 26px;
  }
  .project-management-dialog-workspace {
    width: 100%;
    justify-content: center;
  }
  .project-management-dialog-body {
    min-height: 360px;
  }
}
</style>
