<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { GitFileStatus, Project } from '../../types';
import { api } from '../../api';
import { useGitStore } from '../../stores/git';
import { useProjectStore } from '../../stores/project';
import { useWorkspaceEditorStore } from '../../stores/workspaceEditor';
import { useProjectExternalActions } from '../../composables/useProjectExternalActions';
import { fileKind } from '../../utils/fileTypes';
import { clampContextMenuPosition } from '../../utils/contextMenuPosition';
import { joinAbsolutePath, joinWorkspacePath, normalizeWorkspaceRelativePath, parentWorkspacePath } from '../../utils/workspacePath';
import { cleanupRemovedExplorerProjects, setExplorerExpanded } from '../../utils/workspaceExplorerState';
import ProjectExplorerNode, { type ExplorerContextPayload } from './ProjectExplorerNode.vue';

const props = defineProps<{
  rootId: string;
  selectedProjectId: string | null;
}>();

const emit = defineEmits<{
  selectProject: [project: Project];
  editProject: [project: Project];
  scanProject: [project: Project];
}>();

const projectStore = useProjectStore();
const editorStore = useWorkspaceEditorStore();
const gitStore = useGitStore();
const rootProject = computed(() => projectStore.projects.find(project => project.id === props.rootId) || null);
const workspaceRootKey = computed(() => rootProject.value?.path || props.rootId);
const showHidden = ref(false);
const showHeavy = ref(false);
const refreshToken = ref(0);
const selectedFileKey = ref<string | null>(null);
const contextMenuRef = ref<HTMLElement | null>(null);
const contextMenu = ref<{ x: number; y: number; payload: ExplorerContextPayload } | null>(null);
const contextMenuStyle = ref({ left: '0px', top: '0px' });
const contextProject = computed(() => contextMenu.value?.payload.project || null);
const { openEditor, openTerminal, openFolder } = useProjectExternalActions(contextProject);
const gitStatusMaps = computed<Record<string, ReadonlyMap<string, GitFileStatus>>>(() => {
  const maps: Record<string, ReadonlyMap<string, GitFileStatus>> = {};
  for (const project of projectStore.projects) {
    if (!gitStore.isGitRepo[project.id]) continue;
    const status = gitStore.getStatus(project.id);
    if (!status) continue;
    const map = new Map<string, GitFileStatus>();
    for (const file of [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted]) {
      map.set(file.path.replace(/\\/g, '/'), file);
    }
    maps[project.id] = map;
  }
  return maps;
});

function projectById(id: string | null | undefined): Project | null {
  return id ? projectStore.projects.find(project => project.id === id) || null : null;
}

function expandTargetAncestors(projectId: string | null): void {
  const root = rootProject.value;
  if (!root) return;
  setExplorerExpanded(workspaceRootKey.value, `project:${root.id}`, true);
  const seen = new Set<string>();
  let current = projectById(projectId);
  while (current && current.id !== root.id && !seen.has(current.id)) {
    seen.add(current.id);
    setExplorerExpanded(workspaceRootKey.value, `project:${current.id}`, true);
    current = projectById(current.parentId);
  }
}

watch(() => props.selectedProjectId, value => expandTargetAncestors(value), { immediate: true });
watch(() => props.rootId, () => {
  selectedFileKey.value = null;
  contextMenu.value = null;
  refreshToken.value += 1;
  expandTargetAncestors(props.selectedProjectId);
});
watch(
  () => projectStore.projects.map(project => project.id).join('|'),
  () => cleanupRemovedExplorerProjects(workspaceRootKey.value, new Set(projectStore.projects.map(project => project.id))),
  { immediate: true },
);

function selectProject(project: Project): void {
  selectedFileKey.value = null;
  emit('selectProject', project);
}

function selectFile(project: Project, relativePath: string): void {
  selectedFileKey.value = `${project.id}:${relativePath}`;
}

async function openFile(project: Project, relativePath: string): Promise<void> {
  selectProject(project);
  if (fileKind(relativePath) === 'binary') {
    await api.openPath(joinAbsolutePath(project.path, relativePath));
    return;
  }
  try {
    await editorStore.openFile(project, relativePath);
    projectStore.requestRightTab('editor', project.id);
  } catch (error) {
    ElMessage.error(String(error));
  }
}

function updateContextMenuPosition(): void {
  if (!contextMenu.value || !contextMenuRef.value) return;
  const position = clampContextMenuPosition(
    contextMenu.value.x,
    contextMenu.value.y,
    contextMenuRef.value.offsetWidth || 230,
    contextMenuRef.value.offsetHeight || 360,
    { width: window.innerWidth, height: window.innerHeight },
  );
  contextMenuStyle.value = { left: `${position.left}px`, top: `${position.top}px` };
}

function showContextMenu(event: MouseEvent, payload: ExplorerContextPayload): void {
  contextMenu.value = { x: event.clientX, y: event.clientY, payload };
  void nextTick(updateContextMenuPosition);
}

function closeContextMenu(): void {
  contextMenu.value = null;
}

function closeOnViewportChange(): void {
  closeContextMenu();
}

function menuTargetDirectory(payload: ExplorerContextPayload): string {
  return payload.isDirectory ? payload.relativePath : parentWorkspacePath(payload.relativePath);
}

function promptValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && 'value' in raw) return String((raw as { value: unknown }).value).trim();
  return '';
}

async function promptName(title: string, value = ''): Promise<string | null> {
  try {
    const result = await ElMessageBox.prompt('请输入名称', title, {
      inputValue: value,
      inputPattern: /.+/,
      inputErrorMessage: '名称不能为空',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
    const next = promptValue(result);
    return next || null;
  } catch {
    return null;
  }
}

async function createItem(kind: 'file' | 'directory'): Promise<void> {
  const menu = contextMenu.value;
  if (!menu) return;
  const { payload } = menu;
  closeContextMenu();
  const name = await promptName(kind === 'file' ? '新建文件' : '新建文件夹');
  if (!name) return;
  try {
    const relativePath = joinWorkspacePath(menuTargetDirectory(payload), name);
    if (kind === 'file') await api.workspaceCreateFile(payload.project.path, relativePath);
    else await api.workspaceCreateDirectory(payload.project.path, relativePath);
    refreshToken.value += 1;
    ElMessage.success('已创建');
  } catch (error) {
    ElMessage.error(String(error));
  }
}

async function renameItem(): Promise<void> {
  const menu = contextMenu.value;
  if (!menu) return;
  const { payload } = menu;
  closeContextMenu();
  const name = await promptName('重命名', payload.name);
  if (!name) return;
  try {
    const from = normalizeWorkspaceRelativePath(payload.relativePath, false);
    const to = joinWorkspacePath(parentWorkspacePath(from), name);
    await api.workspaceRename(payload.project.path, from, to);
    editorStore.renamePath(payload.project.id, from, to, payload.project.path);
    refreshToken.value += 1;
    ElMessage.success('已重命名');
  } catch (error) {
    ElMessage.error(String(error));
  }
}

async function trashItem(): Promise<void> {
  const menu = contextMenu.value;
  if (!menu) return;
  const { payload } = menu;
  closeContextMenu();
  const mode = await api.workspaceTrashMode();
  const permanent = mode === 'permanent';
  try {
    await ElMessageBox.confirm(
      permanent ? `「${payload.name}」将被永久删除，确定继续吗？` : `确定将「${payload.name}」移到回收站吗？`,
      permanent ? '永久删除' : '移到回收站',
      { type: 'warning', confirmButtonText: permanent ? '永久删除' : '确定', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await api.workspaceTrash(payload.project.path, payload.relativePath);
    editorStore.markMissing(payload.project.id, payload.relativePath);
    refreshToken.value += 1;
    ElMessage.success('已删除');
  } catch (error) {
    ElMessage.error(String(error));
  }
}

async function copyPath(full: boolean): Promise<void> {
  const payload = contextMenu.value?.payload;
  if (!payload) return;
  const path = full ? joinAbsolutePath(payload.project.path, payload.relativePath) : payload.relativePath;
  closeContextMenu();
  try {
    await navigator.clipboard.writeText(path);
    ElMessage.success('路径已复制');
  } catch (error) {
    ElMessage.error(String(error));
  }
}

async function revealItem(): Promise<void> {
  const payload = contextMenu.value?.payload;
  if (!payload) return;
  closeContextMenu();
  await api.revealInFolder(joinAbsolutePath(payload.project.path, payload.relativePath));
}

async function externalOpen(): Promise<void> {
  const payload = contextMenu.value?.payload;
  if (!payload) return;
  closeContextMenu();
  const target = joinAbsolutePath(payload.project.path, payload.relativePath);
  if (payload.isDirectory) await api.openFolder(target);
  else await api.openPath(target);
}

async function editorOpen(): Promise<void> {
  const payload = contextMenu.value?.payload;
  if (!payload) return;
  closeContextMenu();
  await openFile(payload.project, payload.relativePath);
}

async function projectAction(action: 'terminal' | 'editor' | 'folder' | 'edit' | 'scan'): Promise<void> {
  const project = contextMenu.value?.payload.project;
  if (!project) return;
  closeContextMenu();
  if (action === 'terminal') return openTerminal();
  if (action === 'editor') return openEditor();
  if (action === 'folder') return openFolder();
  if (action === 'edit') return emit('editProject', project);
  emit('scanProject', project);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && contextMenu.value) {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
  }
}

function closeOnDocumentMouseDown(event: MouseEvent): void {
  const target = event.target;
  if (target instanceof Node && contextMenuRef.value?.contains(target)) return;
  closeContextMenu();
}

onMounted(() => {
  document.addEventListener('mousedown', closeOnDocumentMouseDown, true);
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('wheel', closeOnViewportChange, true);
  document.addEventListener('scroll', closeOnViewportChange, true);
  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('resize', closeOnViewportChange);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', closeOnDocumentMouseDown, true);
  document.removeEventListener('click', closeContextMenu);
  document.removeEventListener('wheel', closeOnViewportChange, true);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  document.removeEventListener('keydown', handleKeydown, true);
  window.removeEventListener('resize', closeOnViewportChange);
});
</script>

<template>
  <aside class="workspace-project-explorer flex h-full min-h-0 w-80 shrink-0 flex-col border-r">
    <div class="explorer-header flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <span class="explorer-title">PROJECT EXPLORER</span>
      <button type="button" class="explorer-header-btn" title="显示选项" @click="showHidden = !showHidden">
        <div class="i-mdi-eye-outline" />
      </button>
      <button type="button" class="explorer-header-btn" :class="{ active: showHeavy }" title="显示依赖/构建目录" @click="showHeavy = !showHeavy">
        <div class="i-mdi-package-variant-closed" />
      </button>
    </div>
    <div v-if="!rootProject" class="flex min-h-0 flex-1 items-center justify-center text-xs text-slate-400">项目不存在</div>
    <div v-else class="explorer-tree min-h-0 flex-1 overflow-y-auto py-1 custom-scrollbar">
      <ProjectExplorerNode
        :key="`${rootProject.id}:${refreshToken}`"
        :project="rootProject"
        :workspace-root-id="workspaceRootKey"
        :depth="0"
        :selected-project-id="selectedProjectId"
        :selected-file-key="selectedFileKey"
        :show-hidden="showHidden"
        :show-heavy="showHeavy"
        :git-status-maps="gitStatusMaps"
        @select-project="selectProject"
        @edit-project="emit('editProject', $event)"
        @scan-project="emit('scanProject', $event)"
        @select-file="selectFile"
        @open-file="openFile"
        @context-menu="showContextMenu"
      />
    </div>
  </aside>

  <Teleport to="body">
    <div
      v-if="contextMenu"
      ref="contextMenuRef"
      class="workspace-context-menu fixed min-w-[230px] py-1"
      :style="contextMenuStyle"
      @mousedown.stop
      @click.stop
    >
      <template v-if="contextMenu.payload.kind === 'project'">
        <button type="button" class="context-item" @click="projectAction('terminal')"><div class="i-mdi-console-line" />终端</button>
        <button type="button" class="context-item" @click="projectAction('editor')"><div class="i-mdi-code-tags" />外部编辑器</button>
        <button type="button" class="context-item" @click="projectAction('folder')"><div class="i-mdi-folder-open-outline" />文件夹</button>
        <div class="context-separator" />
        <button type="button" class="context-item" @click="projectAction('edit')"><div class="i-mdi-pencil-outline" />编辑项目</button>
        <button type="button" class="context-item" @click="projectAction('scan')"><div class="i-mdi-file-tree-outline" />扫描子项目</button>
      </template>
      <template v-else>
        <button type="button" class="context-item" @click="contextMenu.payload.isDirectory ? externalOpen() : editorOpen()"><div class="i-mdi-folder-open-outline" />打开</button>
        <button v-if="!contextMenu.payload.isDirectory" type="button" class="context-item" @click="editorOpen"><div class="i-mdi-file-edit-outline" />在轻量编辑器打开</button>
        <div class="context-separator" />
        <button type="button" class="context-item" @click="createItem('file')"><div class="i-mdi-file-plus-outline" />新建文件</button>
        <button type="button" class="context-item" @click="createItem('directory')"><div class="i-mdi-folder-plus-outline" />新建文件夹</button>
        <div class="context-separator" />
        <button type="button" class="context-item" @click="renameItem"><div class="i-mdi-rename-box-outline" />重命名</button>
        <button type="button" class="context-item danger" @click="trashItem"><div class="i-mdi-delete-outline" />删除</button>
        <div class="context-separator" />
        <button type="button" class="context-item" @click="copyPath(false)"><div class="i-mdi-content-copy" />复制相对路径</button>
        <button type="button" class="context-item" @click="copyPath(true)"><div class="i-mdi-content-copy" />复制完整路径</button>
        <button type="button" class="context-item" @click="revealItem"><div class="i-mdi-folder-search-outline" />在文件夹中显示</button>
        <button type="button" class="context-item" @click="externalOpen"><div class="i-mdi-open-in-new" />用外部程序打开</button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.workspace-project-explorer {
  background: var(--app-surface-sidebar);
  color: var(--app-text-secondary);
}
.explorer-header {
  min-height: 38px;
  background: var(--app-surface-soft);
}
.explorer-title {
  flex: 1 1 auto;
  color: var(--app-text-muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
}
.explorer-header-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
}
.explorer-header-btn:hover,
.explorer-header-btn.active {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.custom-scrollbar::-webkit-scrollbar {
  width: 5px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 50%, transparent);
  border-radius: 3px;
}
.workspace-context-menu {
  z-index: 5000;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface-raised, var(--app-surface));
  box-shadow: var(--app-shadow-md, 0 8px 24px rgba(0, 0, 0, 0.2));
  color: var(--app-text-secondary);
}
.context-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 29px;
  padding: 5px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 11px;
  text-align: left;
}
.context-item:hover {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.context-item.danger:hover {
  color: var(--app-danger);
}
.context-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--app-border);
}
</style>
