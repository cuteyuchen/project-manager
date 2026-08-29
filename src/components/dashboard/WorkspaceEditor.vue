<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { Project } from '../../types';
import { api } from '../../api';
import { useGitStore } from '../../stores/git';
import { useSettingsStore } from '../../stores/settings';
import { useWorkspaceEditorStore, type WorkspaceDocument } from '../../stores/workspaceEditor';
import { joinAbsolutePath } from '../../utils/workspacePath';
import LightweightEditor from './LightweightEditor.vue';
import ImageDocumentView from './ImageDocumentView.vue';

const props = defineProps<{ project: Project }>();
const editorStore = useWorkspaceEditorStore();
const gitStore = useGitStore();
const settingsStore = useSettingsStore();
const session = computed(() => editorStore.getSession(props.project.id));
const activeDocument = computed(() => {
  const key = session.value.activePath;
  return key ? session.value.documents[key] || null : null;
});
const saveBusy = ref(false);
const conflictBusy = ref(false);
let gitRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let checkingExternal = false;

const isDark = computed(() => {
  if (settingsStore.settings.themeMode === 'light') return false;
  if (settingsStore.settings.themeMode === 'dark') return true;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
});

function documentForKey(key: string): WorkspaceDocument | null {
  return session.value.documents[key] || null;
}

function selectTab(key: string): void {
  editorStore.activateDocument(props.project.id, key);
}

async function closeTab(document: WorkspaceDocument): Promise<void> {
  if (document.dirty) {
    try {
      await ElMessageBox.confirm(
        `文件「${document.name}」有未保存修改，确定关闭吗？`,
        '关闭文件',
        { type: 'warning', confirmButtonText: '关闭', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  editorStore.closeDocument(props.project.id, document.relativePath);
}

async function closeOthers(): Promise<void> {
  const activeKey = session.value.activePath;
  for (const key of [...session.value.tabs]) {
    if (key === activeKey) continue;
    const document = documentForKey(key);
    if (document) await closeTab(document);
  }
}

async function closeSaved(): Promise<void> {
  editorStore.closeSavedDocuments(props.project.id, session.value.activePath || undefined);
}

function queueGitRefresh(): void {
  if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
  gitRefreshTimer = setTimeout(async () => {
    gitRefreshTimer = null;
    if (await gitStore.checkGitRepo(props.project.id, props.project.path, { force: true })) {
      await gitStore.ensureSummaryAndStatus(props.project.id, props.project.path, { force: true });
    }
  }, 400);
}

async function saveDocument(document: WorkspaceDocument, force = false): Promise<boolean> {
  if (document.readOnly || document.kind !== 'text' || document.largeFile) return false;
  saveBusy.value = true;
  try {
    await editorStore.saveDocument(props.project, document.relativePath, force);
    queueGitRefresh();
    ElMessage.success(`已保存 ${document.name}`);
    return true;
  } catch (error) {
    if (String(error).includes('external_modified') && !force) {
      await resolveConflict(document);
      return false;
    }
    ElMessage.error(String(error));
    return false;
  } finally {
    saveBusy.value = false;
  }
}

async function saveCurrent(): Promise<void> {
  if (activeDocument.value) await saveDocument(activeDocument.value);
}

async function saveAll(): Promise<void> {
  saveBusy.value = true;
  try {
    await editorStore.saveAll(props.project);
    queueGitRefresh();
    ElMessage.success('已保存全部文件');
  } catch (error) {
    ElMessage.error(String(error));
  } finally {
    saveBusy.value = false;
  }
}

async function resolveConflict(document: WorkspaceDocument): Promise<void> {
  if (conflictBusy.value) return;
  conflictBusy.value = true;
  let handled = false;
  try {
    const result = await ElMessageBox.confirm(
      `文件「${document.name}」已被其他程序修改。重新加载会丢弃本地修改，覆盖保存会覆盖磁盘版本。`,
      '检测到外部修改',
      {
        type: 'warning',
        confirmButtonText: '重新加载磁盘版本',
        cancelButtonText: '覆盖保存当前版本',
        distinguishCancelAndClose: true,
      },
    );
    if (result === 'confirm') {
      await editorStore.reloadDocument(props.project, document.relativePath);
      handled = true;
      ElMessage.info('已从磁盘更新');
    }
  } catch (error: any) {
    if (error === 'cancel') {
      handled = await saveDocument(document, true);
    } else if (error !== 'close') {
      ElMessage.error(String(error));
    }
  } finally {
    if (handled) editorStore.setExternalConflictHandled(props.project.id, document.relativePath);
    conflictBusy.value = false;
  }
}

async function checkExternalChanges(): Promise<void> {
  if (checkingExternal) return;
  checkingExternal = true;
  try {
    const result = await editorStore.checkExternalChanges(props.project);
    if (result.reloaded.length > 0) ElMessage.info('已从磁盘更新');
    for (const document of result.conflicts) await resolveConflict(document);
  } finally {
    checkingExternal = false;
  }
}

function handleWindowFocus(): void {
  void checkExternalChanges();
}

function openExternal(document: WorkspaceDocument): void {
  void api.openPath(joinAbsolutePath(props.project.path, document.relativePath));
}

onMounted(() => {
  window.addEventListener('focus', handleWindowFocus);
  document.addEventListener('visibilitychange', handleWindowFocus);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', handleWindowFocus);
  document.removeEventListener('visibilitychange', handleWindowFocus);
  if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
});
</script>

<template>
  <div class="workspace-editor flex h-full min-h-0 flex-col">
    <div class="workspace-editor-toolbar flex shrink-0 items-center gap-1 border-b px-2 py-1">
      <div class="workspace-editor-tabs flex min-w-0 flex-1 items-center overflow-x-auto">
        <button
          v-for="key in session.tabs"
          :key="key"
          type="button"
          class="workspace-editor-tab"
          :class="{ active: session.activePath === key }"
          @click="selectTab(key)"
        >
          <span class="truncate">{{ documentForKey(key)?.name }}</span>
          <span v-if="documentForKey(key)?.dirty" class="workspace-editor-dirty" title="未保存">●</span>
          <span class="workspace-editor-close" title="关闭" @click.stop="documentForKey(key) && closeTab(documentForKey(key)!)">×</span>
        </button>
      </div>
      <button type="button" class="editor-action-btn" :disabled="saveBusy" title="保存当前文件" @click="saveCurrent">
        <div class="i-mdi-content-save-outline" />
      </button>
      <button type="button" class="editor-action-btn" :disabled="saveBusy" title="保存全部" @click="saveAll">
        <div class="i-mdi-content-save-all-outline" />
      </button>
      <button type="button" class="editor-action-btn" title="关闭其他" @click="closeOthers">
        <div class="i-mdi-close-box-multiple-outline" />
      </button>
      <button type="button" class="editor-action-btn" title="关闭已保存" @click="closeSaved">
        <div class="i-mdi-close-box-outline" />
      </button>
    </div>

    <div v-if="!activeDocument" class="workspace-editor-empty flex min-h-0 flex-1 items-center justify-center">
      <div class="text-sm text-slate-400">双击左侧文件开始编辑</div>
    </div>
    <template v-else>
      <div v-if="activeDocument.kind === 'text' && (activeDocument.readOnly || activeDocument.largeFile || activeDocument.error)" class="editor-notice flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div class="i-mdi-alert-circle-outline" />
        <span v-if="activeDocument.largeFile">文件超过 5 MB，已禁止加载到 CodeMirror。</span>
        <span v-else-if="activeDocument.error === 'file_missing'">文件已不存在。</span>
        <span v-else-if="activeDocument.protectedFile">文件大于 2 MB，已以只读模式打开。</span>
        <span v-else-if="activeDocument.encoding === 'other'">该文件不是 UTF-8，当前仅预览，保存请使用外部编辑器。</span>
        <span v-else-if="activeDocument.readOnly">该文件当前为只读，保存请使用外部编辑器。</span>
        <span v-else>{{ activeDocument.error }}</span>
        <button type="button" class="editor-external-btn" @click="openExternal(activeDocument)">外部打开</button>
      </div>
      <ImageDocumentView v-if="activeDocument.kind === 'image'" :document="activeDocument" />
      <div v-else-if="activeDocument.largeFile" class="workspace-editor-empty flex min-h-0 flex-1 items-center justify-center">
        <button type="button" class="editor-external-btn" @click="openExternal(activeDocument)">用系统程序打开</button>
      </div>
      <LightweightEditor
        v-else
        :key="activeDocument.relativePath"
        :model-value="activeDocument.content"
        :language="activeDocument.language"
        :read-only="activeDocument.readOnly || !!activeDocument.missing"
        :dark="isDark"
        @update:model-value="editorStore.updateContent(props.project.id, activeDocument.relativePath, $event)"
        @save="saveCurrent"
      />
    </template>
  </div>
</template>

<style scoped>
.workspace-editor {
  background: var(--app-surface);
}
.workspace-editor-toolbar {
  min-height: 38px;
  background: var(--app-surface-soft);
}
.workspace-editor-tabs {
  gap: 2px;
}
.workspace-editor-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 96px;
  max-width: 190px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 11px;
  text-align: left;
}
.workspace-editor-tab.active {
  border-bottom-color: var(--app-primary);
  background: var(--app-surface);
  color: var(--app-text);
}
.workspace-editor-dirty {
  color: var(--app-warning);
  font-size: 10px;
}
.workspace-editor-close {
  margin-left: auto;
  color: var(--app-text-muted);
  font-size: 16px;
  line-height: 1;
}
.workspace-editor-close:hover {
  color: var(--app-danger);
}
.editor-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-secondary);
}
.editor-action-btn:hover:not(:disabled) {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.editor-action-btn:disabled {
  opacity: 0.45;
}
.workspace-editor-empty {
  background: var(--app-surface);
}
.editor-notice {
  color: var(--app-warning);
  font-size: 11px;
}
.editor-external-btn {
  margin-left: auto;
  padding: 4px 8px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  background: var(--app-surface-soft);
  color: var(--app-text-secondary);
  font-size: 11px;
}
.editor-external-btn:hover {
  border-color: var(--app-primary);
  color: var(--app-primary);
}
</style>
