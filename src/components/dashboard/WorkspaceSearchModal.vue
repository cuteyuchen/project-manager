<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import type { Project } from '../../types';
import { api } from '../../api';
import { useSettingsStore } from '../../stores/settings';
import { editorLanguageForPath } from '../../utils/editorLanguage';
import { joinAbsolutePath } from '../../utils/workspacePath';
import {
  buildWorkspacePathIndex,
  filterPathEntries,
  type WorkspacePathEntry,
} from '../../utils/workspaceSearchIndex';
import {
  replaceInWorkspaceFiles,
  searchWorkspaceContent,
  type ContentSearchMatch,
} from '../../utils/workspaceContentSearch';
import LightweightEditor from './LightweightEditor.vue';
import { escapeHtml } from '../../utils/escapeHtml';

export type WorkspaceSearchMode = 'files' | 'content';

const props = defineProps<{
  project: Project;
  mode: WorkspaceSearchMode;
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
  openFile: [relativePath: string, line?: number];
  replaced: [];
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const query = ref('');
const replaceQuery = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const selectedIndex = ref(0);
const loading = ref(false);
const buildingIndex = ref(false);
const replacing = ref(false);
const fileResults = ref<WorkspacePathEntry[]>([]);
const contentResults = ref<ContentSearchMatch[]>([]);
const truncated = ref(false);
const cancelledFlag = ref<{ cancelled: boolean } | null>(null);

/** 下方预览 */
const previewPath = ref('');
const previewContent = ref('');
const previewLine = ref(1);
const previewLoading = ref(false);
let previewToken = 0;

const isDark = computed(() => {
  if (settingsStore.settings.themeMode === 'light') return false;
  if (settingsStore.settings.themeMode === 'dark') return true;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
});

const modeLabel = computed(() => props.mode === 'files' ? t('editor.searchFiles') : t('editor.searchContent'));
const placeholder = computed(() => props.mode === 'files'
  ? t('editor.searchFilesPlaceholder')
  : t('editor.searchContentPlaceholder'));

const isContentMode = computed(() => props.mode === 'content');
const resultListCount = computed(() =>
  props.mode === 'files' ? fileResults.value.length : contentResults.value.length,
);
const selectedMatch = computed(() =>
  isContentMode.value ? contentResults.value[selectedIndex.value] || null : null,
);
const uniqueFileCount = computed(() => {
  const set = new Set(contentResults.value.map(item => item.relativePath));
  return set.size;
});

watch(() => props.open, async (open) => {
  if (!open) {
    cancelSearch();
    query.value = '';
    replaceQuery.value = '';
    fileResults.value = [];
    contentResults.value = [];
    truncated.value = false;
    clearPreview();
    return;
  }
  selectedIndex.value = 0;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
});

watch(() => props.mode, () => {
  selectedIndex.value = 0;
  clearPreview();
  void refreshResults();
});

let queryTimer: ReturnType<typeof setTimeout> | null = null;
watch(query, () => {
  selectedIndex.value = 0;
  clearPreview();
  if (queryTimer) clearTimeout(queryTimer);
  queryTimer = setTimeout(() => void refreshResults(), 120);
});

watch(selectedIndex, () => {
  if (isContentMode.value) void loadPreviewForSelected();
});

function clearPreview(): void {
  previewPath.value = '';
  previewContent.value = '';
  previewLine.value = 1;
}

function cancelSearch(): void {
  if (cancelledFlag.value) cancelledFlag.value.cancelled = true;
  cancelledFlag.value = null;
  loading.value = false;
}

async function refreshResults(): Promise<void> {
  cancelSearch();
  truncated.value = false;
  const q = query.value.trim();
  if (!q) {
    fileResults.value = [];
    contentResults.value = [];
    return;
  }

  loading.value = true;
  buildingIndex.value = true;
  try {
    const index = await buildWorkspacePathIndex(props.project.path);
    if (!props.open) return;
    truncated.value ||= index.truncated;

    if (props.mode === 'files') {
      fileResults.value = filterPathEntries(index.entries, q, 80);
      contentResults.value = [];
    } else {
      const signal = { cancelled: false };
      cancelledFlag.value = signal;
      const candidates = index.entries.filter(e => !e.isDirectory);
      const result = await searchWorkspaceContent({
        root: props.project.path,
        entries: candidates,
        query: q,
        signal,
      });
      if (signal.cancelled || !props.open) return;
      contentResults.value = result.matches;
      truncated.value ||= result.truncated;
      fileResults.value = [];
      // 结果刷新后主动加载预览（selectedIndex 可能未变化，watch 不会触发）
      if (contentResults.value.length > 0) {
        selectedIndex.value = 0;
        void loadPreviewForSelected();
      } else {
        clearPreview();
      }
    }
  } catch {
    fileResults.value = [];
    contentResults.value = [];
  } finally {
    buildingIndex.value = false;
    loading.value = false;
  }
}

async function loadPreviewForSelected(): Promise<void> {
  const match = selectedMatch.value;
  if (!match) {
    clearPreview();
    return;
  }
  const token = ++previewToken;
  previewLoading.value = true;
  previewPath.value = match.relativePath;
  previewLine.value = match.line;
  try {
    const abs = joinAbsolutePath(props.project.path, match.relativePath);
    const snapshot = await api.workspaceReadEditorFile(props.project.path, match.relativePath)
      .catch(() => api.readTextFile(abs).then(content => ({ content })));
    if (token !== previewToken) return;
    previewContent.value = snapshot.content ?? '';
  } catch {
    if (token !== previewToken) return;
    previewContent.value = '';
  } finally {
    if (token === previewToken) previewLoading.value = false;
  }
}

function moveSelection(delta: number): void {
  const count = resultListCount.value;
  if (count === 0) return;
  selectedIndex.value = (selectedIndex.value + delta + count) % count;
  void nextTick(() => {
    const list = listRef.value;
    const active = list?.querySelector<HTMLElement>('.ws-search-row.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  });
}

function openSelectedInEditor(): void {
  if (props.mode === 'files') {
    const entry = fileResults.value[selectedIndex.value];
    if (!entry) return;
    emit('openFile', entry.relativePath);
    emit('close');
    return;
  }
  const match = contentResults.value[selectedIndex.value];
  if (!match) return;
  emit('openFile', match.relativePath, match.line);
  emit('close');
}

async function replaceAll(): Promise<void> {
  const q = query.value.trim();
  if (!q || !isContentMode.value || contentResults.value.length === 0) return;
  try {
    await ElMessageBox.confirm(
      t('editor.replaceAllConfirm', {
        count: contentResults.value.length,
        files: uniqueFileCount.value,
      }),
      t('editor.replaceAll'),
      { type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel') },
    );
  } catch {
    return;
  }
  replacing.value = true;
  try {
    const result = await replaceInWorkspaceFiles({
      root: props.project.path,
      matches: contentResults.value,
      query: q,
      replacement: replaceQuery.value,
    });
    ElMessage.success(t('editor.replaceAllDone', { files: result.files, count: result.occurrences }));
    emit('replaced');
    await refreshResults();
  } catch (error) {
    ElMessage.error(String(error));
  } finally {
    replacing.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      void replaceAll();
      return;
    }
    openSelectedInEditor();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
}

function selectRow(index: number): void {
  selectedIndex.value = index;
}

/** 预览行里把查询命中加粗，避免 HTML 注入 */
function highlightPreview(preview: string, q: string): string {
  const safe = escapeHtml(preview);
  const needle = q.trim();
  if (!needle) return safe;
  const escapedQ = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(escapedQ, 'gi'), (match) => `<mark class="ws-search-hit">${match}</mark>`);
}

function openRow(index: number): void {
  selectedIndex.value = index;
  if (props.mode === 'files') {
    openSelectedInEditor();
    return;
  }
  // 内容模式：选中即下方预览；再点一次或 Ctrl+Enter / 按钮再进编辑器
  void loadPreviewForSelected();
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true);
  cancelSearch();
  if (queryTimer) clearTimeout(queryTimer);
});

function onWindowKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ws-search-overlay" @mousedown.self="emit('close')">
      <div
        class="ws-search-panel"
        :class="{ 'is-content': isContentMode }"
        role="dialog"
        :aria-label="modeLabel"
      >
        <div class="ws-search-toolbar">
          <div class="ws-search-field">
            <div class="i-mdi-magnify ws-search-icon" />
            <input
              ref="inputRef"
              v-model="query"
              class="ws-search-input"
              type="text"
              :placeholder="placeholder"
              :aria-label="placeholder"
              spellcheck="false"
              @keydown="onKeydown"
            >
            <button
              v-if="query"
              type="button"
              class="ws-search-icon-btn"
              :title="t('editor.searchClose')"
              @click="query = ''"
            >
              <div class="i-mdi-close" />
            </button>
          </div>

          <template v-if="isContentMode">
            <div class="ws-search-field">
              <div class="i-mdi-find-replace ws-search-icon" />
              <input
                v-model="replaceQuery"
                class="ws-search-input"
                type="text"
                :placeholder="t('editor.replacePlaceholder')"
                :aria-label="t('editor.replacePlaceholder')"
                spellcheck="false"
                @keydown="onKeydown"
              >
            </div>
            <button
              type="button"
              class="ws-search-action"
              :disabled="replacing || !query.trim() || contentResults.length === 0"
              :title="t('editor.replaceAll')"
              @click="replaceAll"
            >
              <div class="i-mdi-find-replace text-sm" />
              <span>{{ t('editor.replaceAll') }}</span>
            </button>
          </template>

          <button
            type="button"
            class="ws-search-action is-primary"
            :disabled="resultListCount === 0"
            :title="t('editor.searchOpen')"
            @click="openSelectedInEditor"
          >
            <div class="i-mdi-open-in-new text-sm" />
            <span>{{ t('editor.searchOpen') }}</span>
          </button>

          <span v-if="loading || buildingIndex" class="ws-search-loading">
            <span class="ws-search-spinner" />{{ t('editor.searchIndexing') }}
          </span>
          <span v-else-if="isContentMode" class="ws-search-count">
            {{ t('editor.matchCount', { matches: contentResults.length, files: uniqueFileCount }) }}
          </span>
          <span v-else class="ws-search-count">{{ resultListCount }}</span>

          <button type="button" class="ws-search-icon-btn" :title="t('common.close')" @click="emit('close')">
            <div class="i-mdi-close" />
          </button>
        </div>

        <div class="ws-search-body">
          <div ref="listRef" class="ws-search-list custom-scrollbar">
            <div v-if="!query.trim()" class="ws-search-empty">
              {{ t('editor.searchTypeToStart') }}
            </div>
            <div v-else-if="resultListCount === 0" class="ws-search-empty">
              {{ loading ? t('editor.searchIndexing') : t('editor.searchNoResults') }}
            </div>

            <template v-else-if="mode === 'files'">
              <button
                v-for="(entry, index) in fileResults"
                :key="entry.relativePath"
                type="button"
                class="ws-search-row"
                :class="{ 'is-active': index === selectedIndex }"
                @mouseenter="selectRow(index)"
                @click="openRow(index)"
              >
                <div class="i-mdi-file-document-outline ws-search-row-icon" />
                <div class="ws-search-row-main">
                  <div class="ws-search-row-name">{{ entry.name }}</div>
                  <div class="ws-search-row-path">{{ entry.relativePath }}</div>
                </div>
              </button>
            </template>

            <template v-else>
              <button
                v-for="(match, index) in contentResults"
                :key="`${match.relativePath}:${match.line}:${index}`"
                type="button"
                class="ws-search-row"
                :class="{ 'is-active': index === selectedIndex }"
                @mouseenter="selectRow(index)"
                @click="openRow(index)"
              >
                <div class="i-mdi-file-search-outline ws-search-row-icon" />
                <div class="ws-search-row-main">
                  <div class="ws-search-row-meta">
                    <span class="ws-search-row-path">{{ match.relativePath }}</span>
                    <span class="ws-search-row-line">:{{ match.line }}</span>
                  </div>
                  <div class="ws-search-row-preview" v-html="highlightPreview(match.preview, query)" />
                </div>
              </button>
            </template>

            <div v-if="truncated" class="ws-search-truncated">{{ t('editor.searchTruncated') }}</div>
          </div>

          <div v-if="isContentMode && (previewPath || previewLoading)" class="ws-search-preview">
            <div class="ws-search-preview-bar">
              <span class="ws-search-preview-path" :title="previewPath">
                {{ previewPath }}<span v-if="previewLine">:{{ previewLine }}</span>
              </span>
              <span v-if="previewLoading" class="ws-search-loading">
                <span class="ws-search-spinner" />{{ t('editor.searchIndexing') }}
              </span>
            </div>
            <div class="ws-search-preview-editor">
              <LightweightEditor
                v-if="previewContent"
                :key="`${previewPath}:${previewLine}`"
                :model-value="previewContent"
                :language="editorLanguageForPath(previewPath)"
                :dark="isDark"
                read-only
                :initial-line="previewLine"
              />
              <div v-else-if="!previewLoading" class="ws-search-empty">{{ t('editor.searchNoResults') }}</div>
            </div>
          </div>
        </div>

        <div class="ws-search-footer app-text-meta">
          <span>↑↓</span><span>{{ t('editor.searchNavigate') }}</span>
          <span>Enter</span><span>{{ t('editor.searchOpen') }}</span>
          <template v-if="isContentMode">
            <span>Ctrl+Enter</span><span>{{ t('editor.replaceAll') }}</span>
          </template>
          <span>Esc</span><span>{{ t('editor.searchClose') }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ws-search-overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 6vh;
  background: rgba(2, 6, 23, 0.42);
  backdrop-filter: blur(2px);
}
.ws-search-panel {
  width: min(720px, calc(100vw - 32px));
  height: min(560px, 82vh);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-popup-surface);
  box-shadow: var(--app-shadow-lg);
  overflow: hidden;
  color: var(--app-text);
}
.ws-search-panel.is-content {
  width: min(960px, calc(100vw - 24px));
  height: min(720px, 88vh);
}
.ws-search-toolbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-popup-surface);
}
.ws-search-field {
  display: flex;
  flex: 1 1 200px;
  min-width: 160px;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
}
.ws-search-icon {
  color: var(--app-text-muted);
  flex-shrink: 0;
}
.ws-search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--app-text);
  font-size: var(--app-font-body);
}
.ws-search-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface);
  color: var(--app-text-secondary);
  font-size: var(--app-font-control);
  cursor: pointer;
  white-space: nowrap;
}
.ws-search-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ws-search-action.is-primary {
  border-color: color-mix(in srgb, var(--app-primary) 40%, transparent);
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.ws-search-icon-btn {
  border: 0;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  flex-shrink: 0;
}
.ws-search-icon-btn:hover {
  color: var(--app-text);
}
.ws-search-count,
.ws-search-loading {
  color: var(--app-text-muted);
  font-size: var(--app-font-meta);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.ws-search-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--app-border-strong);
  border-top-color: var(--app-primary);
  border-radius: 50%;
  animation: ws-spin 0.7s linear infinite;
}
@keyframes ws-spin {
  to { transform: rotate(360deg); }
}
.ws-search-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.ws-search-list {
  flex: 0 1 42%;
  min-height: 96px;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px;
}
.ws-search-empty {
  padding: 28px 12px;
  text-align: center;
  color: var(--app-text-muted);
  font-size: var(--app-font-meta);
}
.ws-search-row {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.ws-search-row.is-active {
  background: var(--app-primary-soft);
}
.ws-search-row-icon {
  margin-top: 2px;
  color: var(--app-text-muted);
  flex-shrink: 0;
}
.ws-search-row-main {
  min-width: 0;
  flex: 1;
}
.ws-search-row-name {
  font-size: var(--app-font-control);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-search-row-path,
.ws-search-row-meta {
  color: var(--app-text-muted);
  font-size: var(--app-font-meta);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-search-row-line {
  color: var(--app-primary);
}
.ws-search-row-preview {
  margin-top: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--app-font-meta);
  color: var(--app-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-search-row-preview :deep(.ws-search-hit) {
  background: color-mix(in srgb, var(--app-primary) 28%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.ws-search-truncated {
  padding: 8px 10px;
  color: var(--app-warning);
  font-size: var(--app-font-meta);
}
.ws-search-preview {
  display: flex;
  flex: 1 1 58%;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--app-border);
  background: var(--app-surface);
}
.ws-search-preview-bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--app-border);
  color: var(--app-text-muted);
  font-size: var(--app-font-meta);
}
.ws-search-preview-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.ws-search-preview-editor {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.ws-search-preview-editor :deep(.lightweight-editor),
.ws-search-preview-editor :deep(.cm-editor) {
  height: 100% !important;
  max-height: 100%;
}
.ws-search-preview-editor :deep(.cm-scroller) {
  overflow: auto !important;
}
.ws-search-footer {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 6px 12px;
  border-top: 1px solid var(--app-border);
  background: var(--app-popup-surface);
  color: var(--app-text-muted);
}
.ws-search-footer span:nth-child(odd) {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  background: var(--app-surface-soft);
  border: 1px solid var(--app-border);
  border-radius: 4px;
  padding: 0 4px;
}
</style>
