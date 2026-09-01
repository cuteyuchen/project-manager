<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { GitFileStatus, GitIgnoreKind } from '../../types';
import { positionContextSubmenu } from '../../utils/contextMenuPosition';

const props = defineProps<{
  x: number;
  y: number;
  files: GitFileStatus[];
  targetPath: string;
}>();

const emit = defineEmits<{
  action: [value: {
    type: 'stage' | 'unstage' | 'discard' | 'ignore' | 'stopTracking' | 'editor' | 'folder' | 'copyRelative' | 'copyAbsolute' | 'history';
    kind?: GitIgnoreKind;
    local?: boolean;
  }];
  close: [];
}>();

const { t } = useI18n();
const ignoreOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const submenuRef = ref<HTMLElement | null>(null);
const submenuStyle = ref({ left: '0px', top: '0px' });

function uniqueFiles(files: GitFileStatus[]): GitFileStatus[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

const stageable = computed(() => uniqueFiles(props.files.filter(file => !file.staged)));
const unstageable = computed(() => uniqueFiles(props.files.filter(file => file.staged)));
const discardableTracked = computed(() => uniqueFiles(props.files.filter(
  file => !file.staged && file.status !== 'untracked' && file.status !== 'conflicted',
)));
const discardableUntracked = computed(() => uniqueFiles(props.files.filter(
  file => !file.staged && file.status === 'untracked',
)));
const tracked = computed(() => uniqueFiles(props.files.filter(file => file.status !== 'untracked')));

const extensionFiles = computed(() => uniqueFiles(props.files.filter(file => {
  const name = file.path.split('/').pop() || file.path;
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1;
})));
const directoryFiles = computed(() => uniqueFiles(props.files.filter(file => file.path.includes('/'))));

const menuStyle = ref({ left: `${props.x}px`, top: `${props.y}px` });

function updateMenuPosition() {
  const gap = 8;
  const width = menuRef.value?.offsetWidth || 220;
  const height = menuRef.value?.offsetHeight || 320;
  const maxLeft = Math.max(gap, window.innerWidth - width - gap);
  const maxTop = Math.max(gap, window.innerHeight - height - gap);

  menuStyle.value = {
    left: `${Math.min(Math.max(gap, props.x), maxLeft)}px`,
    top: `${Math.min(Math.max(gap, props.y), maxTop)}px`,
  };
}

function updateSubmenuPosition() {
  if (!ignoreOpen.value || !menuRef.value || !submenuRef.value) return;
  const wrap = menuRef.value.querySelector<HTMLElement>('.ctx-submenu-wrap');
  if (!wrap) return;
  const anchor = wrap.getBoundingClientRect();
  const position = positionContextSubmenu(
    { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
    submenuRef.value.offsetWidth || 210,
    submenuRef.value.offsetHeight || 300,
    { width: window.innerWidth, height: window.innerHeight },
  );
  submenuStyle.value = { left: `${position.left}px`, top: `${position.top}px` };
}

function action(type: 'stage' | 'unstage' | 'discard' | 'ignore' | 'stopTracking' | 'editor' | 'folder' | 'copyRelative' | 'copyAbsolute' | 'history', kind?: GitIgnoreKind, local?: boolean) {
  emit('action', { type, kind, local });
  if (type !== 'ignore') emit('close');
}

function handleMenuMouseMove(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest('.ctx-submenu-wrap')) return;
  ignoreOpen.value = false;
}

function closeIgnoreSubmenu(): void {
  ignoreOpen.value = false;
}

function closeOnViewportChange() {
  emit('close');
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true);
  void nextTick(updateMenuPosition);
  window.addEventListener('resize', closeOnViewportChange);
  document.addEventListener('scroll', closeOnViewportChange, true);
  document.addEventListener('wheel', closeOnViewportChange, true);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', closeOnViewportChange);
  document.removeEventListener('scroll', closeOnViewportChange, true);
  document.removeEventListener('wheel', closeOnViewportChange, true);
});

watch(() => [props.x, props.y], () => {
  void nextTick(updateMenuPosition);
});

watch(ignoreOpen, (open) => {
  if (open) void nextTick(updateSubmenuPosition);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="git-file-context-menu fixed min-w-[220px] py-1"
      :style="menuStyle"
      @click.stop
      @mousemove="handleMenuMouseMove"
      @mouseleave="ignoreOpen = false"
    >
      <button type="button" class="ctx-item" :disabled="stageable.length === 0" @mouseenter="closeIgnoreSubmenu" @click="action('stage')">
        <span>{{ stageable.length > 1 ? t('git.stageN', { count: stageable.length }) : t('git.stage') }}</span>
      </button>
      <button type="button" class="ctx-item" :disabled="unstageable.length === 0" @mouseenter="closeIgnoreSubmenu" @click="action('unstage')">
        <span>{{ unstageable.length > 1 ? t('git.unstageN', { count: unstageable.length }) : t('git.unstage') }}</span>
      </button>

      <div class="ctx-sep" @mouseenter="closeIgnoreSubmenu" />
      <button
        type="button"
        class="ctx-item danger"
        :disabled="discardableTracked.length === 0 && discardableUntracked.length === 0"
        @mouseenter="closeIgnoreSubmenu"
        @click="action('discard')"
      >
        <span>{{ (discardableTracked.length + discardableUntracked.length) > 1
          ? t('git.discardN', { count: discardableTracked.length + discardableUntracked.length })
          : t('git.discard') }}</span>
      </button>

      <div class="ctx-sep" @mouseenter="closeIgnoreSubmenu" />
      <div class="ctx-submenu-wrap" @mouseenter="ignoreOpen = true">
        <button type="button" class="ctx-item ctx-submenu-trigger" :disabled="props.files.length === 0">
          <span>{{ t('git.ignoreMenu') }}</span>
          <span class="i-mdi-chevron-right text-sm opacity-60" />
        </button>
        <div v-if="ignoreOpen" ref="submenuRef" class="ctx-submenu" :style="submenuStyle">
          <div class="ctx-group-label">{{ t('git.ignoreProject') }}</div>
          <button type="button" class="ctx-item" @click="action('ignore', 'file', false)">
            {{ t('git.ignoreThisFile') }}<span v-if="props.files.length > 1">（{{ props.files.length }}）</span>
          </button>
          <button type="button" class="ctx-item" @click="action('ignore', 'filename', false)">
            {{ t('git.ignoreSameName') }}
          </button>
          <button type="button" class="ctx-item" :disabled="extensionFiles.length === 0" @click="action('ignore', 'extension', false)">
            {{ t('git.ignoreExtension') }}<span v-if="extensionFiles.length !== props.files.length">（{{ extensionFiles.length }}）</span>
          </button>
          <button type="button" class="ctx-item" :disabled="directoryFiles.length === 0" @click="action('ignore', 'directory', false)">
            {{ t('git.ignoreDirectory') }}<span v-if="directoryFiles.length !== props.files.length">（{{ directoryFiles.length }}）</span>
          </button>
          <div class="ctx-sep" />
          <div class="ctx-group-label">{{ t('git.localIgnore') }}</div>
          <button type="button" class="ctx-item" @click="action('ignore', 'file', true)">
            {{ t('git.ignoreThisFileLocal') }}
          </button>
          <button type="button" class="ctx-item" @click="action('ignore', 'filename', true)">
            {{ t('git.ignoreSameNameLocal') }}
          </button>
          <button type="button" class="ctx-item" :disabled="extensionFiles.length === 0" @click="action('ignore', 'extension', true)">
            {{ t('git.ignoreExtensionLocal') }}
          </button>
          <button type="button" class="ctx-item" :disabled="directoryFiles.length === 0" @click="action('ignore', 'directory', true)">
            {{ t('git.ignoreDirectoryLocal') }}
          </button>
        </div>
      </div>

      <button type="button" class="ctx-item" :disabled="tracked.length === 0" @mouseenter="closeIgnoreSubmenu" @click="action('stopTracking')">
        {{ tracked.length > 1 ? t('git.stopTrackingN', { count: tracked.length }) : t('git.stopTracking') }}
      </button>

      <div class="ctx-sep" @mouseenter="closeIgnoreSubmenu" />
      <button type="button" class="ctx-item" @mouseenter="closeIgnoreSubmenu" @click="action('editor')">
        {{ t('git.openInEditor') }}
      </button>
      <button type="button" class="ctx-item" @mouseenter="closeIgnoreSubmenu" @click="action('folder')">
        {{ t('git.revealInFolder') }}
      </button>
      <button type="button" class="ctx-item" @mouseenter="closeIgnoreSubmenu" @click="action('copyRelative')">
        {{ t('git.copyRelativePath') }}
      </button>
      <button type="button" class="ctx-item" @mouseenter="closeIgnoreSubmenu" @click="action('copyAbsolute')">
        {{ t('git.copyAbsolutePath') }}
      </button>

      <div class="ctx-sep" @mouseenter="closeIgnoreSubmenu" />
      <button type="button" class="ctx-item" @mouseenter="closeIgnoreSubmenu" @click="action('history')">
        {{ t('git.fileHistory') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.git-file-context-menu {
  z-index: 4000;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface-raised, var(--app-surface));
  box-shadow: var(--app-shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18));
  color: var(--app-text-secondary);
}

.ctx-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 28px;
  padding: 5px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--app-font-control);
  text-align: left;
  cursor: pointer;
}

.ctx-item:hover:not(:disabled) {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}

.ctx-item.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-danger) 12%, transparent);
  color: var(--app-danger);
}

.ctx-item:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.ctx-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--app-border);
}

.ctx-submenu-wrap {
  position: relative;
}

.ctx-submenu-trigger {
  cursor: default;
}

.ctx-submenu {
  position: fixed;
  min-width: 210px;
  padding: 4px 0;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-surface-raised, var(--app-surface));
  box-shadow: var(--app-shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18));
}

.ctx-group-label {
  padding: 4px 10px 3px;
  color: var(--app-text-muted);
  font-size: var(--app-font-meta);
}
</style>
