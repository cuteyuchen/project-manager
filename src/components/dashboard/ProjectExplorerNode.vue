<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { GitFileStatus, Project } from '../../types';
import { api } from '../../api';
import { useGitStore } from '../../stores/git';
import { useProjectStore } from '../../stores/project';
import { joinAbsolutePath, normalizeComparablePath } from '../../utils/workspacePath';
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
  contextMenu: [event: MouseEvent, payload: ExplorerContextPayload];
}>();

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
const directChildIds = computed(() => {
  if (!loaded.value) return new Set<string>();
  const paths = new Set(visibleEntries.value.filter(entry => entry.isDirectory).map(entry =>
    normalizeComparablePath(joinAbsolutePath(props.project.path, entry.name)),
  ));
  return new Set(children.value.filter(child => paths.has(normalizeComparablePath(child.path))).map(child => child.id));
});
const logicalChildren = computed(() => children.value.filter(child => !directChildIds.value.has(child.id)));
const gitSummary = computed(() => gitStore.getSummary(props.project.id));
const gitKnown = computed(() => props.project.id in gitStore.isGitRepo);
const gitDirtyCount = computed(() => gitStore.getTotalChanges(props.project.id));
const running = computed(() => (projectStore.runningSubtreeCount[props.project.id] || 0) > 0);

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
});
</script>

<template>
  <div class="explorer-project-group">
    <div
      class="explorer-row explorer-project-row"
      :class="{ 'is-selected': selectedProjectId === project.id }"
      :style="{ paddingLeft: `${8 + depth * 16}px` }"
      @contextmenu.prevent="forwardContextMenu($event, { kind: 'project', project, relativePath: '', name: project.name, isDirectory: true })"
    >
      <button type="button" class="explorer-chevron" :title="expanded ? '收起' : '展开'" @click.stop="toggle">
        <div :class="expanded ? 'i-mdi-chevron-down' : 'i-mdi-chevron-right'" />
      </button>
      <button type="button" class="explorer-project-name flex min-w-0 flex-1 items-center gap-2" @click="selectProject">
        <div class="i-mdi-folder-home-outline explorer-project-icon" />
        <span class="truncate">{{ project.name }}</span>
        <span v-if="project.moduleKind" class="explorer-module-kind">{{ project.moduleKind }}</span>
      </button>
      <span v-if="running" class="explorer-running-dot" title="运行中" />
      <span v-if="gitKnown && gitDirtyCount > 0" class="explorer-project-dirty">{{ gitDirtyCount }}</span>
      <span v-else-if="gitKnown && gitSummary" class="explorer-project-branch">{{ gitSummary.branch }}</span>
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
        @context-menu="forwardContextMenu"
      />
    </div>
  </div>
</template>

<style scoped>
.explorer-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 29px;
  padding-right: 8px;
  color: var(--app-text-secondary);
  font-size: 11px;
}
.explorer-project-row {
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  background: color-mix(in srgb, var(--app-surface-soft) 60%, transparent);
  font-weight: 700;
}
.explorer-project-row:hover,
.explorer-project-row.is-selected {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.explorer-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 22px;
  flex: 0 0 16px;
  border: 0;
  background: transparent;
  color: var(--app-text-muted);
}
.explorer-project-name {
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}
.explorer-project-icon {
  flex: 0 0 17px;
  font-size: 15px;
}
.explorer-module-kind,
.explorer-project-branch {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-size: 9px;
  font-weight: 500;
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
</style>
