<script setup lang="ts">
/** *********************项目工作区页：钻取进入一级项目后的详情视图*********************/
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, useTemplateRef } from 'vue';
import { useProjectStore } from '../../stores/project';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import type { Project } from '../../types';
import ProjectListItem from '../ProjectListItem.vue';
import ConsoleView from '../ConsoleView.vue';
import GitView from '../git/GitView.vue';
import FileManager from '../FileManager.vue';
import ProjectMemo from '../ProjectMemo.vue';
import FrontendEnvPanel from '../FrontendEnvPanel.vue';
import SubProjectScanModal from '../SubProjectScanModal.vue';

/** 最大钻取层级（一级→二级→三级） */
const MAX_DEPTH = 3;

const props = defineProps<{
  /** 钻取进入的一级项目 id */
  rootId: string;
}>();
const emit = defineEmits<{
  /** 从一级项目返回项目列表 */
  (e: 'back'): void;
  /** 请求编辑某个项目 */
  (e: 'edit', project: Project): void;
}>();

const { t } = useI18n();
const projectStore = useProjectStore();
const gitStore = useGitStore();

/** *********************钻取路径栈*********************/
// 存 project id 链，首项恒为 rootId，长度 ≤ MAX_DEPTH
const drillStack = ref<string[]>([props.rootId]);

// rootId 变化（切换到另一个一级项目）时重置栈
watch(() => props.rootId, (id) => {
  drillStack.value = [id];
  selectedLeafId.value = null;
  syncActiveIds();
});

/** 栈末端项目（当前所在层级节点） */
const currentNode = computed(() =>
  projectStore.projects.find(p => p.id === drillStack.value[drillStack.value.length - 1]) || null
);

/** 一级项目（文件/备忘录绑定它） */
const rootProject = computed(() =>
  projectStore.projects.find(p => p.id === props.rootId) || null
);

/** 当前节点的直接子项目 */
const children = computed(() =>
  currentNode.value ? projectStore.getChildren(currentNode.value.id) : []
);

/** 容器模式：当前节点有子项目 */
const isContainer = computed(() => children.value.length > 0);

/** 是否允许继续下钻（未达最大深度） */
const canDrillDeeper = computed(() => drillStack.value.length < MAX_DEPTH);

/** *********************面包屑*********************/
const breadcrumb = computed(() =>
  drillStack.value
    .map(id => projectStore.projects.find(p => p.id === id))
    .filter((p): p is Project => !!p)
);

function goToBreadcrumb(index: number) {
  if (index < drillStack.value.length - 1) {
    drillStack.value = drillStack.value.slice(0, index + 1);
    selectedLeafId.value = null;
    syncActiveIds();
  }
}

function handleBack() {
  if (drillStack.value.length > 1) {
    // 回退一级
    drillStack.value = drillStack.value.slice(0, -1);
    selectedLeafId.value = null;
    syncActiveIds();
  } else {
    // 已在一级项目，返回列表
    emit('back');
  }
}

/** *********************叶子选中与 active id 同步*********************/
// 容器模式下用户在子项目列表选中的叶子项目 id
const selectedLeafId = ref<string | null>(null);

/** 当前用于 console/git/env 的叶子项目 */
const activeLeaf = computed<Project | null>(() => {
  if (isContainer.value) {
    if (!selectedLeafId.value) return null;
    return projectStore.projects.find(p => p.id === selectedLeafId.value) || null;
  }
  // 叶子模式：当前节点本身即叶子
  return currentNode.value;
});

/** 把 store 的双 active id 与当前状态同步 */
function syncActiveIds() {
  projectStore.activeRootId = props.rootId;
  projectStore.activeProjectId = activeLeaf.value?.id ?? null;
}

watch(activeLeaf, () => syncActiveIds());
onMounted(() => syncActiveIds());
onBeforeUnmount(() => {
  // 离开工作区时清空叶子，避免 git/console 串数据
  projectStore.activeProjectId = null;
});

/** 点击子项目：有子则下钻，无子则选为叶子并切到命令 tab */
function handleOpenChild(project: Project) {
  if (projectStore.hasChildren(project.id) && canDrillDeeper.value) {
    drillStack.value = [...drillStack.value, project.id];
    selectedLeafId.value = null;
  } else {
    selectedLeafId.value = project.id;
    rightTab.value = 'console';
  }
  syncActiveIds();
}

/** *********************右侧工作区 tab*********************/
type WorkTab = 'console' | 'git' | 'files' | 'memo' | 'env';
const rightTab = ref<WorkTab>('console');

// 叶子模式默认停在 console；容器模式默认停在 files（一级功能，无需先选子项目）
watch(isContainer, (container) => {
  rightTab.value = container ? 'files' : 'console';
}, { immediate: true });

// 跨组件请求切 tab（运行命令时联动到 console）
watch(() => projectStore.requestedRightTabToken, () => {
  const tab = projectStore.requestedRightTab;
  if (tab) rightTab.value = tab as WorkTab;
});

/** git 徽章 */
const isGitRepo = computed(() =>
  activeLeaf.value ? (gitStore.isGitRepo[activeLeaf.value.id] || false) : false
);
const gitChangesCount = computed(() =>
  activeLeaf.value ? gitStore.getTotalChanges(activeLeaf.value.id) : 0
);

watch(activeLeaf, (leaf) => {
  if (leaf) void gitStore.checkGitRepo(leaf.id, leaf.path);
});

/** console/git/env 需要一个已选叶子；未选时禁用 */
const leafTabsDisabled = computed(() => !activeLeaf.value);

// 若当前在需要叶子的 tab 但没有选中叶子，回退到 files
watch([leafTabsDisabled, rightTab], ([disabled, tab]) => {
  if (disabled && (tab === 'console' || tab === 'git' || tab === 'env')) {
    rightTab.value = 'files';
  }
});

/** *********************子项目扫描/关联*********************/
const showScanModal = ref(false);

const tabScrollContainer = useTemplateRef<HTMLElement>('tabScrollContainer');
const canScrollLeft = ref(false);
const canScrollRight = ref(false);

function checkTabOverflow() {
  const el = tabScrollContainer.value;
  if (!el) return;
  canScrollLeft.value = el.scrollLeft > 0;
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

function scrollTabs(direction: 'left' | 'right') {
  const el = tabScrollContainer.value;
  if (!el) return;
  el.scrollBy({ left: direction === 'left' ? -120 : 120, behavior: 'smooth' });
}

let tabResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  nextTick(checkTabOverflow);
  if (tabScrollContainer.value) {
    tabResizeObserver = new ResizeObserver(checkTabOverflow);
    tabResizeObserver.observe(tabScrollContainer.value);
  }
});
onBeforeUnmount(() => tabResizeObserver?.disconnect());
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- ─── 顶部：返回 + 面包屑 + 子项目扫描 ─────────────────────── -->
    <div class="workspace-header app-section-divider flex items-center gap-2 px-3 py-2 border-b shrink-0">
      <button @click="handleBack" class="toolbar-icon-btn shrink-0" :title="t('dashboard.back')">
        <div class="i-mdi-arrow-left text-base" />
      </button>
      <!-- 面包屑 -->
      <div class="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto scrollbar-none">
        <template v-for="(node, index) in breadcrumb" :key="node.id">
          <div v-if="index > 0" class="i-mdi-chevron-right text-xs text-slate-400 shrink-0" />
          <button
            class="breadcrumb-item shrink-0"
            :class="{ 'breadcrumb-item-active': index === breadcrumb.length - 1 }"
            @click="goToBreadcrumb(index)"
          >
            {{ node.name }}
          </button>
        </template>
      </div>
      <!-- 扫描/关联子项目 -->
      <button @click="showScanModal = true" class="toolbar-icon-btn shrink-0" :title="t('dashboard.scanSubProjects')">
        <div class="i-mdi-file-tree text-base" />
      </button>
    </div>

    <div class="flex-1 flex overflow-hidden">
      <!-- ─── 容器模式：左侧子项目列表 ─────────────────────── -->
      <div v-if="isContainer" class="w-80 shrink-0 flex flex-col app-surface-sidebar border-r overflow-hidden">
        <div class="app-section-divider px-3 py-2 border-b flex items-center justify-between">
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            {{ t('dashboard.subProjects') }}
          </span>
          <span class="text-[10px] text-slate-400">{{ children.length }}</span>
        </div>
        <div class="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
          <ProjectListItem
            v-for="child in children"
            :key="child.id"
            :project="child"
            :active="selectedLeafId === child.id"
            layout="stacked"
            @open="handleOpenChild"
            @edit="emit('edit', child)"
          />
        </div>
      </div>

      <!-- ─── 右侧工作区 ─────────────────────── -->
      <div class="flex-1 flex flex-col overflow-hidden app-workspace-panel">
        <!-- Tab 栏 -->
        <div class="workspace-topbar app-workspace-topbar flex items-center border-b px-3 shrink-0 min-w-0">
          <div class="project-title-group flex items-center gap-2 pr-3 mr-2 shrink-0 min-w-0">
            <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate max-w-40 tracking-tight">
              {{ (isContainer ? activeLeaf?.name : currentNode?.name) ?? currentNode?.name }}
            </h3>
          </div>
          <button v-show="canScrollLeft" @click="scrollTabs('left')" class="toolbar-scroll-btn shrink-0">
            <div class="i-mdi-chevron-left text-base" />
          </button>
          <div ref="tabScrollContainer" @scroll="checkTabOverflow" class="flex items-center overflow-x-auto scrollbar-none min-w-0 flex-1 py-2 px-1">
            <div class="workspace-tab-group">
              <button
                @click="rightTab = 'console'"
                class="workspace-tab-btn"
                :class="{ 'workspace-tab-btn-active': rightTab === 'console' }"
                :disabled="leafTabsDisabled"
              >
                <div class="i-mdi-console text-sm" />
                <span>{{ t('dashboard.console') }}</span>
              </button>
              <button
                @click="rightTab = 'git'"
                class="workspace-tab-btn"
                :class="{ 'workspace-tab-btn-active': rightTab === 'git' }"
                :disabled="leafTabsDisabled"
              >
                <div class="i-mdi-git text-sm" />
                <span>{{ t('git.title') }}</span>
                <span v-if="isGitRepo && gitChangesCount > 0" class="workspace-tab-badge">{{ gitChangesCount }}</span>
              </button>
              <button
                @click="rightTab = 'env'"
                class="workspace-tab-btn"
                :class="{ 'workspace-tab-btn-active': rightTab === 'env' }"
                :disabled="leafTabsDisabled"
              >
                <div class="i-mdi-tune-variant text-sm" />
                <span>{{ t('dashboard.envSwitcher') }}</span>
              </button>
              <!-- 文件/备忘录：一级项目功能 -->
              <button
                @click="rightTab = 'files'"
                class="workspace-tab-btn"
                :class="{ 'workspace-tab-btn-active': rightTab === 'files' }"
              >
                <div class="i-mdi-folder-outline text-sm" />
                <span>{{ t('dashboard.files') }}</span>
              </button>
              <button
                @click="rightTab = 'memo'"
                class="workspace-tab-btn"
                :class="{ 'workspace-tab-btn-active': rightTab === 'memo' }"
              >
                <div class="i-mdi-note-text-outline text-sm" />
                <span>{{ t('dashboard.memo') }}</span>
              </button>
            </div>
          </div>
          <button v-show="canScrollRight" @click="scrollTabs('right')" class="toolbar-scroll-btn shrink-0">
            <div class="i-mdi-chevron-right text-base" />
          </button>
        </div>

        <!-- Tab 内容 -->
        <div class="flex-1 overflow-hidden relative">
          <!-- 容器模式未选子项目时的占位提示 -->
          <div
            v-if="isContainer && leafTabsDisabled && (rightTab === 'console' || rightTab === 'git' || rightTab === 'env')"
            class="h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-500"
          >
            <div class="i-mdi-gesture-tap text-5xl mb-3 opacity-20" />
            <p class="text-sm">{{ t('dashboard.selectSubProjectHint') }}</p>
          </div>
          <Transition v-else name="tab-fade" mode="out-in">
            <KeepAlive>
              <ConsoleView v-if="rightTab === 'console'" />
              <GitView v-else-if="rightTab === 'git'" />
              <FrontendEnvPanel v-else-if="rightTab === 'env' && activeLeaf" :project="activeLeaf" />
              <FileManager v-else-if="rightTab === 'files' && rootProject" :project="rootProject" />
              <ProjectMemo v-else-if="rightTab === 'memo' && rootProject" :project="rootProject" />
            </KeepAlive>
          </Transition>
        </div>
      </div>
    </div>

    <!-- 子项目扫描/关联弹窗 -->
    <SubProjectScanModal
      v-if="currentNode"
      v-model="showScanModal"
      :parent-project="currentNode"
    />
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  border-radius: 2px;
}
.scrollbar-none::-webkit-scrollbar {
  display: none;
}
.scrollbar-none {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.tab-fade-enter-active,
.tab-fade-leave-active {
  transition: opacity 0.15s ease;
}
.tab-fade-enter-from,
.tab-fade-leave-to {
  opacity: 0;
}

.workspace-header {
  box-shadow: inset 0 -1px 0 var(--app-border);
}

.breadcrumb-item {
  border: none;
  background: transparent;
  padding: 3px 8px;
  border-radius: var(--app-radius-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text-secondary);
  white-space: nowrap;
  transition: background-color var(--app-duration-fast) var(--app-ease), color var(--app-duration-fast) var(--app-ease);
}
.breadcrumb-item:hover {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
.breadcrumb-item-active {
  color: var(--app-primary);
  cursor: default;
}

.workspace-topbar {
  box-shadow: inset 0 -1px 0 var(--app-border);
}
.project-title-group {
  padding: 3px 6px 3px 3px;
  border-radius: var(--app-radius-lg);
}
.toolbar-icon-btn,
.toolbar-scroll-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  width: 32px;
  border: none;
  border-radius: var(--app-radius-md);
  background: var(--app-surface-soft);
  color: var(--app-text-secondary);
  box-shadow: inset 0 0 0 1px var(--app-border);
  transition: background-color var(--app-duration-fast) var(--app-ease), color var(--app-duration-fast) var(--app-ease);
}
.toolbar-icon-btn:hover,
.toolbar-scroll-btn:hover {
  color: var(--app-primary);
  background: var(--app-primary-soft);
}
.workspace-tab-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: var(--app-radius-lg);
  background: var(--app-surface-soft);
  box-shadow: inset 0 0 0 1px var(--app-border);
}
.workspace-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: none;
  border-radius: var(--app-radius-md);
  background: transparent;
  color: var(--app-text-secondary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background-color var(--app-duration-fast) var(--app-ease), color var(--app-duration-fast) var(--app-ease);
}
.workspace-tab-btn:hover:not(:disabled) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-surface) 74%, transparent);
}
.workspace-tab-btn:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}
.workspace-tab-btn-active {
  background: var(--app-surface);
  color: var(--app-primary);
  box-shadow: var(--app-shadow-sm), inset 0 0 0 1px color-mix(in srgb, var(--app-primary) 26%, transparent);
}
.workspace-tab-badge {
  margin-left: 2px;
  min-width: 18px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-warning) 14%, transparent);
  padding: 0 6px;
  color: var(--app-warning);
  font-size: 10px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
</style>
