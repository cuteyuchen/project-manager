<script setup lang="ts">
import type { Project } from '../types';
import { useProjectStore } from '../stores/project';
import { useNodeStore } from '../stores/node';
import { useSettingsStore } from '../stores/settings';
import HealthBadge from './dashboard/HealthBadge.vue';
import type { ProjectHealthSnapshot } from '../types';
import { computed } from 'vue';
import { api } from '../api';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { resolveNodePathFromVersion, resolveProjectNodePath, isExplicitNodeVersion } from '../utils/nodeRuntime';
import { normalizeNvmVersion } from '../utils/nvm';
import { resolveTerminalCommand } from '../utils/terminalConfig';

const { t } = useI18n();
const props = defineProps<{
    project: Project;
    healthSnapshot?: ProjectHealthSnapshot;
    healthLevel?: 'healthy' | 'warn' | 'error' | 'unknown';
    /** 外部指定选中态（用于子项目列表高亮）；不传时回退到 store.activeProjectId 比较 */
    active?: boolean;
    /** 是否显示行首多选框 */
    selectable?: boolean;
    /** 多选是否选中 */
    selected?: boolean;
    /** 卡片布局：inline 用于主列表，stacked 用于窄侧栏子项目列表 */
    layout?: 'inline' | 'stacked';
}>();
const emit = defineEmits(['edit', 'open', 'toggle-select']);
const store = useProjectStore();
const nodeStore = useNodeStore();
const settingsStore = useSettingsStore();

const isActive = computed(() =>
    props.active !== undefined ? props.active : store.activeProjectId === props.project.id
);

/** 直接子项目数量：>0 时该卡片可下钻 */
const childCount = computed(() =>
    store.projects.filter(p => p.parentId === props.project.id).length
);

/** 模块类型徽章文案（前端/后端等） */
const moduleKindLabel = computed(() =>
    props.project.moduleKind ? t(`project.moduleKind.${props.project.moduleKind}`) : ''
);

const isRunning = computed(() => {
    return (store.runningProjectCount[props.project.id] || 0) > 0;
});

/***********************项目附加信息*********************/

/** 分组名称 */
const groupName = computed(() => {
    if (!props.project.groupId) return '';
    const group = store.projectGroups.find(g => g.id === props.project.groupId);
    return group ? group.name : '';
});

/** 显示的标签（最多 3 个） */
const displayTags = computed(() => {
    if (!props.project.tags || props.project.tags.length === 0) return [];
    return props.project.tags.slice(0, 3);
});

/** 超出的标签数量 */
const extraTagsCount = computed(() => {
    if (!props.project.tags) return 0;
    return Math.max(0, props.project.tags.length - 3);
});

/***********************交互*********************/

function handleClick() {
    // 由父组件决定语义：列表页 = 钻取进入工作区；子项目列表 = 选中
    emit('open', props.project);
}

function handleToggleSelect() {
    emit('toggle-select', props.project.id);
}

function handleToggleFavorite() {
    store.toggleFavorite(props.project.id);
}

function handleTogglePin() {
    if (props.project.pinned) {
        store.unpinProject(props.project.id);
    } else {
        store.pinProject(props.project.id);
    }
}

function handleDelete() {
    const hasChildren = childCount.value > 0;
    ElMessageBox.confirm(
        hasChildren
            ? t('dashboard.deleteProjectWithChildrenConfirm', { name: props.project.name, count: childCount.value })
            : t('dashboard.deleteProjectConfirm', { name: props.project.name }),
        t('dashboard.deleteProject'),
        {
            confirmButtonText: t('common.confirm'),
            cancelButtonText: t('common.cancel'),
            type: 'warning',
            customClass: 'dark-message-box'
        }
    )
        .then(() => {
            store.removeProject(props.project.id);
            ElMessage.success(t('common.success'));
        })
        .catch(() => { });
}

async function openEditor() {
    try {
        let editorPath = settingsStore.settings.editorPath;
        if (props.project.editorId && settingsStore.settings.editors?.length) {
            const found = settingsStore.settings.editors.find(e => e.id === props.project.editorId);
            if (found) editorPath = found.path;
        } else if (settingsStore.settings.editors?.length) {
            const defaultEditor = settingsStore.settings.defaultEditorId
                ? settingsStore.settings.editors.find(e => e.id === settingsStore.settings.defaultEditorId)
                : undefined;
            editorPath = (defaultEditor || settingsStore.settings.editors[0]).path;
        }
        await api.openInEditor(props.project.path, editorPath);
    } catch (e) {
        console.error(e);
        ElMessage.error(`${t('common.error')}: ${e}`);
    }
}

async function openTerminal() {
    try {
        if (props.project.type === 'node') {
            await nodeStore.loadNvmNodes();
        }

        let nodePath = '';
        if (props.project.type === 'node') {
            nodePath = resolveProjectNodePath(props.project, nodeStore.versions);

            if (!nodePath && isExplicitNodeVersion(props.project.nodeVersion)) {
                const version = normalizeNvmVersion(props.project.nodeVersion!)!;
                try {
                    ElMessage.info(t('project.autoInstallStart', { version }));
                    await nodeStore.installNode(version);
                    ElMessage.success(t('project.autoInstallSuccess', { version }));
                    nodePath = resolveProjectNodePath(props.project, nodeStore.versions);
                } catch (installError) {
                    ElMessage.error(`${t('project.autoInstallFailed', { version })}: ${String(installError)}`);
                    console.error('Failed to auto-install node version for terminal', installError);
                }
            }

            if (!nodePath) {
                try {
                    const info = await api.scanProject(props.project.path);
                    nodePath = resolveNodePathFromVersion(info.nvmVersion, nodeStore.versions);
                } catch (scanError) {
                    console.warn('Failed to scan project for terminal node version', scanError);
                }
            }
        }

        const terminalCommand = resolveTerminalCommand(
            settingsStore.settings.defaultTerminal,
            settingsStore.settings.customTerminals,
        );

        const packageManager = props.project.packageManager || 'npm';
        await api.openInTerminal(props.project.path, terminalCommand, nodePath, packageManager);
    } catch (e) {
        console.error(e);
        ElMessage.error(`${t('common.error')}: ${e}`);
    }
}

async function openFolder() {
    try {
        await api.openFolder(props.project.path);
    } catch (e) {
        console.error(e);
        ElMessage.error(`${t('common.error')}: ${e}`);
    }
}
</script>

<template>
    <div
        class="project-row group"
        :class="[
            isActive ? 'project-row-active' : 'project-row-idle',
            {
                'project-row-selected': selected,
                'project-row-stacked': layout === 'stacked',
            },
        ]"
        @click="handleClick"
    >
        <div class="project-row-content">
            <!-- ─── 行首：多选框 + 拖拽手柄 + 收藏星 ─────────────── -->
            <div class="project-row-leading" @click.stop>
                <label v-if="selectable" class="row-checkbox" @click.stop>
                    <input type="checkbox" :checked="selected" @change="handleToggleSelect" />
                    <span class="row-checkbox-box">
                        <div v-if="selected" class="i-mdi-check text-white text-sm" />
                    </span>
                </label>
                <slot name="leading" />
                <button
                    class="row-star"
                    :class="project.favorite ? 'text-amber-400' : 'text-slate-300 dark:text-slate-600 hover:text-amber-400'"
                    :title="project.favorite ? t('project.unfavorite') : t('project.favorite')"
                    @click.stop="handleToggleFavorite"
                >
                    <div :class="project.favorite ? 'i-mdi-star' : 'i-mdi-star-outline'" class="text-xl" />
                </button>
            </div>

            <!-- ─── 健康状态点 + pin ─────────────── -->
            <div v-if="healthSnapshot || project.pinned" class="project-row-status">
                <HealthBadge v-if="healthSnapshot" :snapshot="healthSnapshot" :level="healthLevel ?? 'unknown'" />
                <div v-if="project.pinned" class="i-mdi-pin text-amber-500 text-base" />
            </div>

            <!-- ─── 主体：名称 / 路径 / 标签 ─────────────── -->
            <div class="project-row-main">
                <div class="project-row-title-line">
                    <h3 class="project-row-title" :class="isActive ? 'text-blue-700 dark:text-blue-400' : 'text-slate-700 dark:text-slate-200'">
                        {{ project.name }}
                    </h3>
                    <span v-if="moduleKindLabel" class="project-kind-chip shrink-0">{{ moduleKindLabel }}</span>
                    <span class="project-row-path">{{ project.path }}</span>
                    <div v-if="isRunning" class="project-running-dot shrink-0" />
                </div>
                <div v-if="project.description || displayTags.length > 0 || groupName" class="project-row-meta">
                    <span v-if="project.description" class="text-[10px] text-slate-400 dark:text-slate-500 truncate max-w-40" :title="project.description">
                        {{ project.description }}
                    </span>
                    <span
                        v-for="tag in displayTags"
                        :key="tag"
                        class="project-tag-chip project-tag-chip-primary"
                    >
                        {{ tag }}
                    </span>
                    <span v-if="extraTagsCount > 0" class="text-[9px] text-slate-400 dark:text-slate-500">+{{ extraTagsCount }}</span>
                    <span v-if="groupName" class="project-tag-chip project-tag-chip-muted inline-flex items-center gap-0.5">
                        <div class="i-mdi-folder-network text-[8px]" />
                        {{ groupName }}
                    </span>
                </div>
            </div>

            <!-- ─── 子项目数量 + 下钻箭头 ─────────────── -->
            <div v-if="childCount > 0" class="project-row-child">
                <span class="project-child-chip inline-flex items-center gap-0.5" :title="t('dashboard.subProjectCount', { count: childCount })">
                    <div class="i-mdi-file-tree text-[9px]" />
                    {{ childCount }}
                </span>
                <div class="i-mdi-chevron-right text-base text-slate-400 dark:text-slate-500" />
            </div>
        </div>

        <!-- ─── 行尾：操作按钮（常驻，不再悬浮）─────────────── -->
        <div class="project-row-actions" @click.stop>
            <button class="row-action-btn hover:text-amber-500" :class="{ 'text-amber-500': project.pinned }" :title="project.pinned ? t('dashboard.unpin') : t('dashboard.pin')" @click.stop="handleTogglePin">
                <div :class="project.pinned ? 'i-mdi-pin' : 'i-mdi-pin-outline'" class="text-sm" />
            </button>
            <button class="row-action-btn hover:text-blue-500" :title="t('dashboard.openInEditor')" @click.stop="openEditor">
                <div class="i-mdi-code-tags text-sm" />
            </button>
            <button class="row-action-btn hover:text-purple-500" :title="t('dashboard.openInTerminal')" @click.stop="openTerminal">
                <div class="i-mdi-console-line text-sm" />
            </button>
            <button class="row-action-btn hover:text-amber-500" :title="t('dashboard.openInExplorer')" @click.stop="openFolder">
                <div class="i-mdi-folder-open text-sm" />
            </button>
            <button class="row-action-btn hover:text-emerald-500" :title="t('project.editProject')" @click.stop="$emit('edit')">
                <div class="i-mdi-pencil text-sm" />
            </button>
            <button class="row-action-btn hover:text-red-500" :title="t('dashboard.deleteProject')" @click.stop="handleDelete">
                <div class="i-mdi-delete text-sm" />
            </button>
        </div>

    </div>
</template>

<style scoped>
.project-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--app-radius-lg);
  border: 1px solid var(--app-border);
  background: var(--app-surface);
  box-shadow: var(--app-shadow-sm);
  cursor: pointer;
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    border-color var(--app-duration-fast) var(--app-ease);
}

.project-row-content {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.project-row-leading,
.project-row-status,
.project-row-actions,
.project-row-child {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.project-row-leading {
  gap: 8px;
}

.project-row-status {
  gap: 6px;
}

.project-row-actions {
  gap: 2px;
}

.project-row-child {
  gap: 4px;
  padding-left: 4px;
  border-left: 1px solid var(--app-border);
}

.project-row-main {
  flex: 1;
  min-width: 0;
}

.project-row-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.project-row-title {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-row-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  color: rgb(148 163 184);
}

.project-row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  max-height: 20px;
  margin-top: 2px;
  overflow: hidden;
}

.project-row-stacked {
  min-height: 112px;
  align-items: stretch;
  flex-direction: column;
  gap: 10px;
  padding: 14px 12px 12px;
}

.project-row-stacked .project-row-content {
  align-items: flex-start;
  gap: 8px;
}

.project-row-stacked .project-row-main {
  padding-top: 0;
}

.project-row-stacked .project-row-title-line {
  flex-wrap: wrap;
  row-gap: 4px;
}

.project-row-stacked .project-row-title {
  flex: 1 1 0;
  font-size: 14px;
}

.project-row-stacked .project-row-path {
  flex-basis: 100%;
}

.project-row-stacked .project-row-actions {
  width: 100%;
  justify-content: flex-end;
  padding-top: 8px;
  border-top: 1px solid var(--app-border);
}

.project-row-stacked .row-action-btn {
  width: 32px;
  height: 32px;
}

.project-row-idle:hover {
  background: var(--app-surface-soft);
  border-color: var(--app-border-strong);
}

.project-row-active {
  background: var(--app-primary-soft);
  border-color: color-mix(in srgb, var(--app-primary) 30%, transparent);
}

.project-row-selected {
  border-color: color-mix(in srgb, var(--app-primary) 45%, transparent);
  background: color-mix(in srgb, var(--app-primary) 8%, transparent);
}

/* 多选框 */
.row-checkbox {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
.row-checkbox input {
  display: none;
}
.row-checkbox-box {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: 1.5px solid var(--app-border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--app-duration-fast) var(--app-ease), border-color var(--app-duration-fast) var(--app-ease);
}
.row-checkbox input:checked + .row-checkbox-box {
  background: var(--app-primary);
  border-color: var(--app-primary);
}

.row-star {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  background: transparent;
  transition: color var(--app-duration-fast) var(--app-ease);
}

.row-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--app-radius-md);
  background: transparent;
  color: var(--app-text-muted);
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease);
}
.row-action-btn:hover {
  background: var(--app-surface-soft);
}

.project-running-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 6px color-mix(in srgb, var(--app-success) 58%, transparent);
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.project-tag-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: var(--app-radius-xs);
  font-size: 9px;
  font-weight: 600;
}
.project-tag-chip-primary {
  background: var(--app-primary-soft);
  border: 1px solid color-mix(in srgb, var(--app-primary) 24%, transparent);
  color: var(--app-primary);
}
.project-tag-chip-muted {
  background: var(--app-surface-soft);
  border: 1px solid var(--app-border);
  color: var(--app-text-secondary);
}

.project-kind-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: var(--app-radius-xs);
  font-size: 9px;
  font-weight: 600;
  background: color-mix(in srgb, var(--app-primary) 12%, transparent);
  color: var(--app-primary);
  border: 1px solid color-mix(in srgb, var(--app-primary) 22%, transparent);
}

.project-child-chip {
  padding: 0 5px;
  border-radius: var(--app-radius-xs);
  font-size: 9px;
  font-weight: 600;
  background: var(--app-surface-soft);
  border: 1px solid var(--app-border);
  color: var(--app-text-secondary);
}
</style>
