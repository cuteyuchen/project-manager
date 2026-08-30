<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { GitFileStatus, Project, ProjectQuickCommand } from '../../types';
import { api } from '../../api';
import { useGitStore } from '../../stores/git';
import { useProjectStore } from '../../stores/project';
import { getCustomCommandDisplayName, getProjectCommandRunId } from '../../utils/projectCommands';
import { resolveProjectQuickCommands } from '../../utils/projectQuickCommands';
import { shouldAppendLogicalExplorerChild } from '../../utils/workspacePath';
import { explorerStateVersion, isExplorerExpanded, setExplorerExpanded } from '../../utils/workspaceExplorerState';
import FileTreeNode from './FileTreeNode.vue';

const HIDDEN_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor', '.next', '.nuxt',
  '.cache', '.gradle', '.idea', '__pycache__',
]);
const COMMON_CONFIG = /^(\.env(?:\..*)?|\.gitignore|\.editorconfig|\.npmrc|\.nvmrc|\.prettierrc|\.eslintrc)$/i;

export interface ExplorerContextPayload {
  kind: 'project' | 'file';
  project: Project;
  relativePath: string;
  name: string;
  isDirectory: boolean;
}

export type ExplorerProjectAction = 'git' | 'terminal' | 'editor' | 'folder' | 'edit' | 'scan' | 'pin' | 'delete';

const props = defineProps<{
  project: Project;
  workspaceRootId: string;
  depth: number;
  selectedProjectId: string | null;
  selectedFileKey?: string | null;
  showHidden: boolean;
  showHeavy: boolean;
  gitStatusMaps: Readonly<Record<string, ReadonlyMap<string, GitFileStatus>>>;
}>();

const emit = defineEmits<{
  selectProject: [project: Project];
  editProject: [project: Project];
  scanProject: [project: Project];
  selectFile: [project: Project, relativePath: string];
  openFile: [project: Project, relativePath: string];
  projectAction: [project: Project, action: ExplorerProjectAction];
  contextMenu: [event: MouseEvent, payload: ExplorerContextPayload];
}>();

const { t } = useI18n();
const projectStore = useProjectStore();
const gitStore = useGitStore();
const entries = ref<{ name: string; isDirectory: boolean; size?: number }[]>([]);
const loading = ref(false);
const loaded = ref(false);
const nodeKey = computed(() => `project:${props.project.id}`);
const expanded = computed(() => {
  void explorerStateVersion.value;
  return isExplorerExpanded(props.workspaceRootId, nodeKey.value, props.depth === 0);
});
const children = computed(() => projectStore.getChildren(props.project.id));
const visibleEntries = computed(() => entries.value.filter(entry => {
  if (entry.name === '.git') return false;
  if (!props.showHeavy && entry.isDirectory && HIDDEN_DIRS.has(entry.name.toLowerCase())) return false;
  if (!props.showHidden && entry.name.startsWith('.') && !COMMON_CONFIG.test(entry.name)) return false;
  return true;
}));
/** 路径落在当前项目文件系统子树内的注册子项目由目录节点渲染，不再额外追加 logical child。 */
const logicalChildren = computed(() =>
  children.value.filter(child => shouldAppendLogicalExplorerChild(props.project.path, child.path)),
);
const gitSummary = computed(() => gitStore.getSummary(props.project.id));
const gitKnown = computed(() => props.project.id in gitStore.isGitRepo);
const gitDirtyCount = computed(() => gitStore.getTotalChanges(props.project.id));
const running = computed(() => (projectStore.runningSubtreeCount[props.project.id] || 0) > 0);
const quickCommands = computed(() => resolveProjectQuickCommands(props.project));
const quickCommandsOpen = ref(false);
const moreOpen = ref(false);
const projectRow = ref<HTMLElement | null>(null);
const moduleKindLabel = computed(() => props.project.moduleKind ? t(`project.moduleKind.${props.project.moduleKind}`) : '');

function isQuickCommandRunning(command: ProjectQuickCommand): boolean {
  return !!projectStore.runningStatus[getProjectCommandRunId(props.project.id, command.type, command.id)];
}

function quickCommandLabel(command: ProjectQuickCommand): string {
  if (command.type === 'script') return command.id;
  const custom = props.project.customCommands?.find(item => item.id === command.id);
  return custom ? getCustomCommandDisplayName(custom, t) : command.id;
}

function toggleQuickCommand(command: ProjectQuickCommand): void {
  if (isQuickCommandRunning(command)) {
    void projectStore.stopProject(props.project, command.id, command.type);
  } else if (command.type === 'script') {
    void projectStore.runProject(props.project, command.id);
  } else {
    void projectStore.runCustomCommand(props.project, command.id);
  }
  quickCommandsOpen.value = false;
}

function runQuickCommand(): void {
  const command = quickCommands.value[0];
  if (quickCommands.value.length === 1 && command) {
    toggleQuickCommand(command);
    return;
  }
  quickCommandsOpen.value = !quickCommandsOpen.value;
  moreOpen.value = false;
}

function emitProjectAction(action: ExplorerProjectAction): void {
  quickCommandsOpen.value = false;
  moreOpen.value = false;
  emit('projectAction', props.project, action);
}

function toggleMore(): void {
  moreOpen.value = !moreOpen.value;
  quickCommandsOpen.value = false;
}

function closeMenus(event: MouseEvent): void {
  const target = event.target;
  if (target instanceof Node && projectRow.value?.contains(target)) return;
  quickCommandsOpen.value = false;
  moreOpen.value = false;
}

function syncMenuListener(open: boolean): void {
  if (open) document.addEventListener('click', closeMenus, true);
  else document.removeEventListener('click', closeMenus, true);
}

watch([quickCommandsOpen, moreOpen], ([quickOpen, moreOpenValue]) => {
  syncMenuListener(quickOpen || moreOpenValue);
});

async function loadEntries(): Promise<void> {
  if (loaded.value || loading.value) return;
  loading.value = true;
  try {
    entries.value = await api.workspaceReadDir(props.project.path, '');
    loaded.value = true;
  } finally {
    loading.value = false;
  }
}

async function toggle(): Promise<void> {
  const next = !expanded.value;
  setExplorerExpanded(props.workspaceRootId, nodeKey.value, next);
  if (next) await loadEntries();
}

function selectProject(): void {
  emit('selectProject', props.project);
}

function forwardSelectFile(project: Project, relativePath: string): void {
  emit('selectFile', project, relativePath);
}

function forwardOpenFile(project: Project, relativePath: string): void {
  emit('openFile', project, relativePath);
}

function forwardProjectAction(project: Project, action: ExplorerProjectAction): void {
  emit('projectAction', project, action);
}

function forwardContextMenu(event: MouseEvent, payload: ExplorerContextPayload): void {
  emit('contextMenu', event, payload);
}

function forwardEditProject(project: Project): void {
  emit('editProject', project);
}

function forwardScanProject(project: Project): void {
  emit('scanProject', project);
}

onMounted(() => {
  if (expanded.value) void loadEntries();
  void gitStore.ensureSummaryAndStatus(props.project.id, props.project.path);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenus, true);
});
</script>

<template>
  <div class="explorer-project-group" :class="{ 'is-child-project-group': depth > 0 }">
    <div
      ref="projectRow"
      class="explorer-row explorer-project-row"
      :class="{
        'is-selected': selectedProjectId === project.id,
        'is-root-project': depth === 0,
        'is-child-project': depth > 0,
      }"
      :style="{ paddingLeft: `${8 + depth * 16}px` }"
      @click="selectProject"
      @contextmenu.prevent="forwardContextMenu($event, { kind: 'project', project, relativePath: '', name: project.name, isDirectory: true })"
    >
      <button
        type="button"
        class="explorer-chevron"
        :title="expanded ? '收起' : '展开'"
        :aria-label="expanded ? '收起' : '展开'"
        :aria-expanded="expanded"
        @click.stop="toggle"
      >
        <div :class="expanded ? 'i-mdi-chevron-down' : 'i-mdi-chevron-right'" />
      </button>
      <button type="button" class="explorer-project-name flex min-w-0 flex-1 items-center gap-2" @click.stop="selectProject">
        <div :class="depth === 0 ? 'i-mdi-folder-home-outline' : 'i-mdi-folder-star-outline'" class="explorer-project-icon" />
        <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
        <span v-if="moduleKindLabel" class="explorer-module-kind">{{ moduleKindLabel }}</span>
      </button>
      <div class="explorer-project-meta">
        <span v-if="running" class="explorer-running-dot" title="运行中" />
        <span v-if="gitKnown && gitDirtyCount > 0" class="explorer-project-dirty">{{ gitDirtyCount }}</span>
        <span v-else-if="gitKnown && gitSummary" class="explorer-project-branch">{{ gitSummary.branch }}</span>
      </div>
      <div class="explorer-project-actions" @click.stop>
        <button
          v-if="quickCommands.length > 0"
          type="button"
          class="explorer-project-action explorer-action-run"
          :title="quickCommands.length === 1 && quickCommands[0] ? (isQuickCommandRunning(quickCommands[0]) ? `停止 ${quickCommandLabel(quickCommands[0])}` : `运行 ${quickCommandLabel(quickCommands[0])}`) : '选择快捷命令'"
          @click.stop="runQuickCommand"
        >
          <div :class="quickCommands.length === 1 && quickCommands[0] && isQuickCommandRunning(quickCommands[0]) ? 'i-mdi-stop' : quickCommands.length > 1 ? 'i-mdi-play-box-multiple-outline' : 'i-mdi-play'" />
        </button>
        <div v-if="quickCommandsOpen && quickCommands.length > 1" class="explorer-action-menu explorer-quick-menu" @click.stop>
          <button v-for="command in quickCommands.slice(0, 3)" :key="`${command.type}:${command.id}`" type="button" class="explorer-menu-item" @click.stop="toggleQuickCommand(command)">
            <div :class="isQuickCommandRunning(command) ? 'i-mdi-stop' : 'i-mdi-play'" />
            <span class="truncate">{{ quickCommandLabel(command) }}</span>
          </button>
        </div>
        <button v-if="gitKnown" type="button" class="explorer-project-action explorer-action-git" :title="gitDirtyCount > 0 ? `Git（${gitDirtyCount} 项变更）` : 'Git'" @click.stop="emitProjectAction('git')">
          <div class="i-mdi-source-branch" />
          <span v-if="gitDirtyCount > 0" class="explorer-action-count">{{ gitDirtyCount }}</span>
        </button>
        <button type="button" class="explorer-project-action explorer-action-secondary" title="终端" @click.stop="emitProjectAction('terminal')">
          <div class="i-mdi-console-line" />
        </button>
        <button type="button" class="explorer-project-action explorer-action-secondary" title="外部编辑器" @click.stop="emitProjectAction('editor')">
          <div class="i-mdi-code-tags" />
        </button>
        <button type="button" class="explorer-project-action explorer-action-secondary" title="文件夹" @click.stop="emitProjectAction('folder')">
          <div class="i-mdi-folder-open-outline" />
        </button>
        <button type="button" class="explorer-project-action explorer-action-more" :title="moreOpen ? '收起更多操作' : '更多操作'" :aria-expanded="moreOpen" @click.stop="toggleMore">
          <div class="i-mdi-dots-horizontal" />
        </button>
        <div v-if="moreOpen" class="explorer-action-menu explorer-more-menu" @click.stop>
          <button type="button" class="explorer-menu-item" @click.stop="emitProjectAction('edit')"><div class="i-mdi-pencil-outline" /><span>编辑项目</span></button>
          <button type="button" class="explorer-menu-item" @click.stop="emitProjectAction('scan')"><div class="i-mdi-file-tree-outline" /><span>{{ t('dashboard.manageSubProjects') }}</span></button>
          <button type="button" class="explorer-menu-item" @click.stop="emitProjectAction('pin')"><div :class="project.pinned ? 'i-mdi-pin-off-outline' : 'i-mdi-pin-outline'" /><span>{{ project.pinned ? '取消置顶' : '置顶项目' }}</span></button>
          <button type="button" class="explorer-menu-item danger" @click.stop="emitProjectAction('delete')"><div class="i-mdi-delete-outline" /><span>删除项目</span></button>
        </div>
      </div>
    </div>

    <div v-if="expanded" class="explorer-project-children">
      <div v-if="loading" class="explorer-loading" :style="{ paddingLeft: `${26 + depth * 16}px` }">加载中…</div>
      <FileTreeNode
        v-for="entry in visibleEntries"
        :key="`${project.id}:${entry.name}`"
        :project="project"
        :workspace-root-id="workspaceRootId"
        :entry="entry"
        :relative-path="entry.name"
        :depth="depth + 1"
        :show-hidden="showHidden"
        :show-heavy="showHeavy"
        :git-status-map="gitStatusMaps[project.id] || null"
        :git-status-maps="gitStatusMaps"
        :selected-file-key="selectedFileKey"
        :selected-project-id="selectedProjectId"
        @select-file="forwardSelectFile"
        @open-file="forwardOpenFile"
        @project-action="forwardProjectAction"
        @context-menu="forwardContextMenu"
        @select-project="emit('selectProject', $event)"
        @edit-project="forwardEditProject"
        @scan-project="forwardScanProject"
      />
      <ProjectExplorerNode
        v-for="child in logicalChildren"
        :key="child.id"
        :project="child"
        :workspace-root-id="workspaceRootId"
        :depth="depth + 1"
        :selected-project-id="selectedProjectId"
        :show-hidden="showHidden"
        :show-heavy="showHeavy"
        :git-status-maps="gitStatusMaps"
        :selected-file-key="selectedFileKey"
        @select-project="emit('selectProject', $event)"
        @edit-project="forwardEditProject"
        @scan-project="forwardScanProject"
        @select-file="forwardSelectFile"
        @open-file="forwardOpenFile"
        @project-action="forwardProjectAction"
        @context-menu="forwardContextMenu"
      />
    </div>
  </div>
</template>

<style scoped>
.explorer-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 29px;
  padding-right: 8px;
  color: var(--app-text-secondary);
  font-size: 11px;
  user-select: none;
  -webkit-user-select: none;
}
.explorer-project-row {
  min-height: 31px;
  border-left: 2px solid transparent;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  background: color-mix(in srgb, var(--app-surface-soft) 60%, transparent);
  font-weight: 700;
}
.explorer-project-row:hover,
.explorer-project-row.is-selected {
  background: color-mix(in srgb, var(--app-primary) 10%, var(--app-surface-soft));
  color: var(--app-primary);
}
.explorer-project-row.is-root-project {
  min-height: 34px;
  border-left-width: 3px;
  border-left-color: color-mix(in srgb, var(--app-primary) 72%, transparent);
  background: color-mix(in srgb, var(--app-primary) 6%, var(--app-surface-soft));
  font-weight: 800;
}
.explorer-project-row.is-child-project {
  border-left-color: color-mix(in srgb, var(--app-primary) 38%, var(--app-border));
  background: color-mix(in srgb, var(--app-primary) 3%, var(--app-surface-soft));
}
.explorer-project-row.is-selected {
  border-left-color: var(--app-primary);
  background: color-mix(in srgb, var(--app-primary) 14%, var(--app-surface-soft));
}
.explorer-project-children {
  margin-left: 12px;
  padding-left: 5px;
  border-left: 1px solid color-mix(in srgb, var(--app-primary) 28%, var(--app-border));
}
.explorer-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 24px;
  flex: 0 0 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 16px;
  line-height: 1;
}
.explorer-chevron:hover {
  background: color-mix(in srgb, var(--app-primary) 10%, transparent);
  color: var(--app-primary);
}
.explorer-chevron:focus-visible {
  outline: 2px solid var(--app-primary);
  outline-offset: -1px;
}
.explorer-project-name {
  min-width: 0;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  user-select: none;
  -webkit-user-select: none;
}
.explorer-project-icon {
  flex: 0 0 17px;
  font-size: 15px;
}
.is-root-project .explorer-project-icon {
  color: var(--app-primary);
  font-size: 16px;
}
.is-child-project .explorer-project-icon {
  color: color-mix(in srgb, var(--app-primary) 76%, var(--app-text-secondary));
}
.explorer-module-kind,
.explorer-project-branch {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-size: 9px;
  font-weight: 500;
}
.explorer-project-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  min-width: 20px;
  max-width: 94px;
  overflow: hidden;
}
.explorer-project-branch {
  max-width: 78px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.explorer-project-dirty {
  color: var(--app-warning);
  font-size: 10px;
}
.explorer-running-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--app-success);
}
.explorer-loading {
  min-height: 24px;
  color: var(--app-text-muted);
  font-size: 10px;
}
.explorer-project-actions {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1px;
  width: 132px;
  min-width: 132px;
  height: 26px;
  flex: 0 0 132px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity var(--app-duration-fast) var(--app-ease), visibility var(--app-duration-fast) var(--app-ease);
}
.explorer-project-row:hover .explorer-project-actions,
.explorer-project-row.is-selected .explorer-project-actions,
.explorer-project-row:focus-within .explorer-project-actions {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
.explorer-project-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 13px;
}
.explorer-project-action:hover {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.explorer-action-run:hover {
  color: var(--app-success);
}
.explorer-action-git {
  position: relative;
}
.explorer-action-git:hover {
  color: var(--app-warning);
}
.explorer-action-count {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 10px;
  padding: 0 2px;
  border-radius: 4px;
  background: var(--app-warning);
  color: var(--app-surface);
  font-size: 8px;
  line-height: 11px;
  text-align: center;
}
.explorer-action-menu {
  position: absolute;
  top: calc(100% + 3px);
  right: 0;
  z-index: 30;
  min-width: 154px;
  padding: 3px;
  border: 1px solid var(--app-border);
  border-radius: 5px;
  background: var(--app-surface-raised, var(--app-surface));
  box-shadow: var(--app-shadow-md, 0 8px 24px rgba(0, 0, 0, 0.2));
  color: var(--app-text-secondary);
}
.explorer-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 27px;
  padding: 4px 7px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 10px;
  text-align: left;
}
.explorer-menu-item:hover {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.explorer-menu-item.danger:hover {
  color: var(--app-danger);
}
@container (max-width: 300px) {
  .explorer-project-actions {
    width: 78px;
    min-width: 78px;
    flex-basis: 78px;
  }
  .explorer-action-secondary {
    display: none;
  }
}
</style>
