<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useTemplateRef } from 'vue';
import { useProjectStore } from '../stores/project';
import { useUsageStore } from '../stores/usage';
import { useSettingsStore } from '../stores/settings';
import ProjectListItem from '../components/ProjectListItem.vue';
import AddProjectModal from '../components/AddProjectModal.vue';
import ProjectGroupManager from '../components/ProjectGroupManager.vue';
import ImportScanModal from '../components/ImportScanModal.vue';
import SubProjectScanModal from '../components/SubProjectScanModal.vue';
import ProjectWorkspace from '../components/dashboard/ProjectWorkspace.vue';
// ─── 项目总控能力组件 ─────────────────────────────────────────────────
import ViewPresetChips from '../components/dashboard/ViewPresetChips.vue';
import WorkspaceProfileMenu from '../components/dashboard/WorkspaceProfileMenu.vue';
// ─── 项目总控能力 composable ──────────────────────────────────────────
import { useViewPresets } from '../composables/dashboard/useViewPresets';
import { useProjectBatch } from '../composables/dashboard/useProjectBatch';
import { useProjectHealth } from '../composables/dashboard/useProjectHealth';
import { useWorkspaceProfiles } from '../composables/dashboard/useWorkspaceProfiles';
import type { Project, ProjectHealthSnapshot } from '../types';
import type { ImportNode } from '../api/types';
import { useI18n } from 'vue-i18n';
import { compareProjectsByPinnedThenOrder } from '../utils/projectTree.ts';
import { useListDragSort } from '../composables/useListDragSort.ts';
import { useAppShortcuts } from '../composables/useAppShortcuts.ts';
import {
    DEFAULT_FOCUS_SEARCH_SHORTCUT,
    DEFAULT_NEW_PROJECT_SHORTCUT,
    DEFAULT_REFRESH_PROJECTS_SHORTCUT,
} from '../utils/shortcut.ts';
import { collectProjectTags, projectMatchesSelectedTags } from '../utils/projectTags';
import { pinyin } from 'pinyin-pro';

const { t } = useI18n();
const projectStore = useProjectStore();
const usageStore = useUsageStore();
const settingsStore = useSettingsStore();
const showModal = ref(false);
const editingProject = ref<Project | null>(null);
const refreshing = ref(false);
const PROJECT_LIST_ITEM_GAP = 8;
const PROJECT_LIST_OVERSCAN = 4;

/** 快捷筛选类型：基础(all/pinned/recent/favorite) + 健康(running/dirty/unhealthy/missing) */
type QuickFilter = 'all' | 'pinned' | 'recent' | 'favorite' | 'running' | 'dirty' | 'unhealthy' | 'missing';

/** *********************钻取状态：为空时显示列表页，否则显示工作区页*********************/
const drilledRootId = ref<string | null>(null);
const workspaceTargetProjectId = ref<string | null>(null);

/** 进入某一级项目的工作区 */
function openProjectWorkspace(project: Project) {
    drilledRootId.value = project.id;
}

/** 从工作区返回列表 */
function backToList() {
    drilledRootId.value = null;
    projectStore.activeRootId = null;
    projectStore.activeProjectId = null;
    // 必须清掉搜索跳转目标：它非空会让下次进入同一项目时被自动下钻到旧目标，
    // 也会让工作区的导航恢复逻辑一直走「搜索优先」的早退分支
    workspaceTargetProjectId.value = null;
    void nextTick(() => {
        const container = projectListContainer.value;
        if (!container) return;
        container.scrollTop = projectListScrollTop.value;
        projectListResizeObserver?.observe(container);
        updateProjectListViewport();
    });
}

/**
 * 消费外部（如全局搜索）请求打开的工作区信号。
 * immediate: true 覆盖「Dashboard 因 v-if 重新挂载、错过挂载前赋值」的时序问题；
 * 消费后立即置空，避免返回列表后再次被触发。
 */
watch(() => projectStore.pendingWorkspaceRootId, (rootId) => {
    if (!rootId) return;
    const target = projectStore.projects.find(p => p.id === rootId);
    workspaceTargetProjectId.value = projectStore.pendingWorkspaceProjectId;
    projectStore.pendingWorkspaceRootId = null;
    projectStore.pendingWorkspaceProjectId = null;
    if (!target) return;
    // 直接切 rootId 即可。
    // 原先这里要「先返回列表、再于下一帧进入目标」，是因为 ProjectWorkspace 带
    // :key="workspace:${rootId}"，在 Transition mode="out-in" 下同分支换 key 会挂载失败。
    // 现在 key 已是静态值（为让 KeepAlive 缓存跨一级项目存活），同一个 vnode 只换 props，
    // Transition 完全不介入，那套绕法既没必要、又会白白闪一下列表页并销毁整份缓存。
    openProjectWorkspace(target);
}, { immediate: true });

/** 工作区内请求编辑项目 */
function editFromWorkspace(project: Project) {
    openEditModal(project);
}

// Project list container ref for scroll-to-project
const projectListContainer = useTemplateRef<HTMLElement>('projectListContainer');
const projectListScrollTop = ref(0);
const projectListViewportHeight = ref(0);
const projectItemHeights = ref<Record<string, number>>({});
const projectItemElements = new Map<string, HTMLElement>();

function resolveElementRef(target: unknown): Element | null {
    if (target instanceof Element) return target;
    if (target && typeof target === 'object' && '$el' in target) {
        const maybeElement = (target as { $el?: unknown }).$el;
        return maybeElement instanceof Element ? maybeElement : null;
    }
    return null;
}

function estimateProjectItemHeight(project: Project) {
    // 行高固定；含描述/标签的行略高
    const hasMeta = !!(project.description || (project.tags && project.tags.length) || project.groupId);
    return (hasMeta ? 68 : 52) + PROJECT_LIST_ITEM_GAP;
}

function handleProjectListScroll() {
    const container = projectListContainer.value;
    if (!container) return;
    projectListScrollTop.value = container.scrollTop;
}

function updateProjectListViewport() {
    const container = projectListContainer.value;
    if (!container) return;
    projectListViewportHeight.value = container.clientHeight;
    projectListScrollTop.value = container.scrollTop;
}

let projectListResizeObserver: ResizeObserver | null = null;
let projectItemResizeObserver: ResizeObserver | null = null;

function registerProjectItemRef(projectId: string, element: Element | null) {
    const existing = projectItemElements.get(projectId);
    if (existing && existing !== element) {
        projectItemResizeObserver?.unobserve(existing);
        projectItemElements.delete(projectId);
    }

    if (!(element instanceof HTMLElement)) return;

    element.dataset.projectId = projectId;
    projectItemElements.set(projectId, element);
    projectItemResizeObserver?.observe(element);
}

function findProjectMetricIndexByOffset(offset: number) {
    const metrics = projectListMetrics.value;
    let low = 0;
    let high = metrics.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const metric = metrics[mid];

        if (offset < metric.start) {
            high = mid - 1;
        } else if (offset >= metric.end) {
            low = mid + 1;
        } else {
            return mid;
        }
    }

    return Math.max(0, Math.min(metrics.length - 1, low));
}

onMounted(() => {
    if (projectListContainer.value) {
        projectListResizeObserver = new ResizeObserver(updateProjectListViewport);
        projectListResizeObserver.observe(projectListContainer.value);
        updateProjectListViewport();
    }

    projectItemResizeObserver = new ResizeObserver((entries) => {
        const nextHeights = { ...projectItemHeights.value };
        let changed = false;

        for (const entry of entries) {
            const projectId = (entry.target as HTMLElement).dataset.projectId;
            if (!projectId) continue;

            const measured = Math.ceil(entry.contentRect.height);
            if (nextHeights[projectId] !== measured) {
                nextHeights[projectId] = measured;
                changed = true;
            }
        }

        if (changed) {
            projectItemHeights.value = nextHeights;
        }
    });
});

onBeforeUnmount(() => {
    projectListResizeObserver?.disconnect();
    projectItemResizeObserver?.disconnect();
    projectItemElements.clear();
    projectPinyinCache.clear();
});

//************* 搜索功能 *************
const searchQuery = ref('');
/** el-input 实例：聚焦搜索快捷键需要拿到内部的原生 input */
const projectSearchInput = useTemplateRef<{ $el?: HTMLElement } | null>('projectSearchInput');
const showGroupManager = ref(false);
const showImportModal = ref(false);

/***********************筛选状态*********************/
const activeQuickFilter = ref<QuickFilter>('all');
const selectedGroupId = ref('');
const selectedTags = ref<string[]>([]);

/** 基础快捷筛选（segmented 控件） */
const quickFilterOptions = computed(() => [
    { label: t('dashboard.filterAll'), value: 'all' },
    { label: t('dashboard.filterFavorite'), value: 'favorite' },
    { label: t('dashboard.filterPinned'), value: 'pinned' },
    { label: t('dashboard.filterRecent'), value: 'recent' },
]);

/** 健康状态快捷筛选 chips（原「项目总览」的分类） */
const healthFilterChips = computed(() => [
    { key: 'running', label: t('dashboard.overviewRunning'), icon: 'i-mdi-play-circle-outline', tone: 'emerald', count: healthCounts.value.running },
    { key: 'dirty', label: t('dashboard.overviewDirty'), icon: 'i-mdi-git', tone: 'amber', count: healthCounts.value.dirty },
    { key: 'unhealthy', label: t('dashboard.overviewUnhealthy'), icon: 'i-mdi-alert-circle-outline', tone: 'red', count: healthCounts.value.unhealthy },
    { key: 'missing', label: t('dashboard.overviewMissing'), icon: 'i-mdi-folder-alert-outline', tone: 'rose', count: healthCounts.value.missing },
]);

function toggleHealthFilter(key: QuickFilter) {
    activeQuickFilter.value = activeQuickFilter.value === key ? 'all' : key;
}

/** 聚合所有项目标签用于筛选下拉 */
const allTags = computed(() => collectProjectTags(projectStore.projects));

function buildPinyinSearchText(text: string): string {
    if (!text) return '';
    const syllables = pinyin(text, { toneType: 'none', type: 'array' }) as string[];
    const full = syllables.join('');
    const initials = syllables.map(s => s[0] || '').join('');
    return `${full} ${initials}`.toLowerCase();
}

const projectPinyinCache = new Map<string, string>();

function getCachedPinyinSearchText(text: string) {
    if (!text) return '';
    const cached = projectPinyinCache.get(text);
    if (cached) return cached;

    const next = buildPinyinSearchText(text);
    projectPinyinCache.set(text, next);
    return next;
}

const sortMode = computed(() => settingsStore.settings.sortMode ?? 'default');

// ─── 保存视图 composable ──────────────────────────────────────────────
const {
  presets: viewPresets,
  activePresetId,
  saveCurrentView,
  applyPreset,
  deletePreset,
  detectActivePreset,
} = useViewPresets({
  searchQuery,
  activeQuickFilter,
  selectedGroupId,
  selectedTags,
  sortMode,
});

const sortOptions = computed(() => [
    { label: t('dashboard.sortModeDefault'), value: 'default' },
    { label: t('dashboard.sortModeSmart'), value: 'smart' },
]);

// Whether drag is allowed (default mode + no active search + no active filters)
const isDraggable = computed(() =>
    sortMode.value === 'default'
    && !searchQuery.value.trim()
    && activeQuickFilter.value === 'all'
    && !selectedGroupId.value
    && selectedTags.value.length === 0
);

/** 仅一级项目参与列表展示（子项目在其父的工作区内显示） */
const rootProjects = computed(() => projectStore.projects.filter(p => !p.parentId));

const sortedProjects = computed(() => {
    if (sortMode.value === 'smart') {
        const weights = usageStore.calculateAllWeights();
        return [...rootProjects.value].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            const wa = weights[a.id] ?? 0;
            const wb = weights[b.id] ?? 0;
            if (wa !== wb) return wb - wa;
            if (a.pinned && b.pinned) return (a.pinOrder ?? 0) - (b.pinOrder ?? 0);
            return 0;
        });
    }
    // 默认排序：置顶优先，其次手动拖拽序号。
    // 与子项目列表（stores/project.ts 的 getChildren）共用同一个比较器，
    // 避免两处规则漂移。
    return [...rootProjects.value].sort(compareProjectsByPinnedThenOrder);
});

const projectSearchIndex = computed(() => {
    return sortedProjects.value.map(project => ({
        project,
        normalizedName: project.name.toLowerCase(),
        normalizedPath: project.path.toLowerCase(),
        compactName: project.name.toLowerCase().replace(/\s+/g, ''),
        compactPath: project.path.toLowerCase().replace(/\s+/g, ''),
        namePinyin: getCachedPinyinSearchText(project.name),
        pathPinyin: getCachedPinyinSearchText(project.path),
        normalizedDescription: (project.description || '').toLowerCase(),
        normalizedTags: (project.tags || []).join(' ').toLowerCase(),
        normalizedScripts: (project.scripts || []).join(' ').toLowerCase(),
        normalizedCustomCommands: (project.customCommands || []).map(c => c.name).join(' ').toLowerCase(),
    }));
});

const filteredProjects = computed(() => {
    /***********************筛选链：快捷筛选 → 分组 → 标签 → 搜索文本*********************/
    let result = sortedProjects.value;

    // 快捷筛选（基础 + 健康）
    switch (activeQuickFilter.value) {
        case 'pinned':
            result = result.filter(p => p.pinned);
            break;
        case 'favorite':
            result = result.filter(p => p.favorite);
            break;
        case 'recent': {
            const weights = usageStore.calculateAllWeights();
            result = result.filter(p => (weights[p.id] ?? 0) > 0);
            break;
        }
        case 'running':
            result = result.filter(p => isProjectRunning(p.id));
            break;
        case 'dirty':
            result = result.filter(p => !!getHealth(p.id)?.gitDirty);
            break;
        case 'unhealthy':
            result = result.filter(p => isProjectUnhealthy(p.id));
            break;
        case 'missing':
            result = result.filter(p => getHealth(p.id)?.pathExists === false);
            break;
    }

    // 分组筛选
    if (selectedGroupId.value) {
        result = result.filter(p => p.groupId === selectedGroupId.value);
    }

    // 标签筛选（项目必须包含所有选中标签）
    if (selectedTags.value.length > 0) {
        result = result.filter(p => projectMatchesSelectedTags(p, selectedTags.value));
    }

    // 搜索文本
    const query = searchQuery.value.trim().toLowerCase();
    const compactQuery = query.replace(/\s+/g, '');

    if (query) {
        const index = projectSearchIndex.value;
        const indexMap = new Map(index.map(item => [item.project.id, item]));
        result = result.filter(p => {
            const entry = indexMap.get(p.id);
            if (!entry) return false;
            return entry.normalizedName.includes(query)
                || entry.normalizedPath.includes(query)
                || entry.compactName.includes(compactQuery)
                || entry.compactPath.includes(compactQuery)
                || entry.namePinyin.includes(compactQuery)
                || entry.pathPinyin.includes(compactQuery)
                || entry.normalizedDescription.includes(query)
                || entry.normalizedTags.includes(query)
                || entry.normalizedScripts.includes(compactQuery)
                || entry.normalizedCustomCommands.includes(compactQuery);
        });
    }

    return result;
});

// ─── 多选批量操作 composable ──────────────────────────────────────────
const filteredProjectIds = computed(() => filteredProjects.value.map((p) => p.id));
const {
  selectedIds,
  selectedCount,
  isAllSelected,
  toggleSelect,
  toggleSelectAll,
  clearSelection,
  batchSetGroup,
  batchPin,
  batchRemove,
} = useProjectBatch({ filteredProjectIds });

/** 批量设置分组的下拉可见性 */
const showBatchGroupMenu = ref(false);
const batchGroupTarget = ref('');

async function applyBatchGroup() {
    await batchSetGroup(batchGroupTarget.value || undefined);
    showBatchGroupMenu.value = false;
    batchGroupTarget.value = '';
}

// ─── 项目健康状态 composable ───────────────────────────────────────────
const {
  getHealth,
  healthLevel,
} = useProjectHealth({ filteredProjects: rootProjects });

// ─── 启动组 composable ────────────────────────────────────────────────
const {
  profiles: workspaceProfiles,
  createProfile,
  deleteProfile,
  runProfile,
  stopAll: stopProfile,
} = useWorkspaceProfiles();

/***********************健康状态统计与判定*********************/
// 读聚合值而非 runningProjectCount：后者只按发起命令的项目自身计数，
// 一级项目卡片会漏掉「子项目正在运行」。
function isProjectRunning(projectId: string): boolean {
    return (projectStore.runningSubtreeCount[projectId] ?? 0) > 0;
}

function getRealHealthIssues(snapshot: ProjectHealthSnapshot | undefined) {
    return snapshot?.issues.filter((issue) => issue.code !== 'not_git') ?? [];
}

function isProjectUnhealthy(projectId: string): boolean {
    const snapshot = getHealth(projectId);
    if (!snapshot) return false;
    return !snapshot.pathExists || getRealHealthIssues(snapshot).length > 0;
}

/** 健康分类计数（仅统计一级项目） */
const healthCounts = computed(() => {
    const list = rootProjects.value;
    return {
        running: list.filter(p => isProjectRunning(p.id)).length,
        dirty: list.filter(p => !!getHealth(p.id)?.gitDirty).length,
        unhealthy: list.filter(p => isProjectUnhealthy(p.id)).length,
        missing: list.filter(p => getHealth(p.id)?.pathExists === false).length,
    };
});

/** 自动检测活跃视图 */
watch([searchQuery, activeQuickFilter, selectedGroupId, selectedTags, sortMode], () => {
  detectActivePreset();
});

/***********************项目列表手动拖拽排序*********************/
// 拖拽逻辑抽到 composables/useListDragSort.ts，与工作区的子项目列表共用；
// 这里只负责把新顺序写回项目数据。
const { draggableList, dragState, onDragMouseDown } = useListDragSort<Project>({
    items: sortedProjects,
    onCommit: (ordered) => projectStore.applyManualOrder(ordered),
});

const projectListMetrics = computed(() => {
    let offset = 0;

    return filteredProjects.value.map((project) => {
        const height = projectItemHeights.value[project.id] ?? estimateProjectItemHeight(project);
        const start = offset;
        offset += height;

        return {
            project,
            start,
            end: offset,
            height,
        };
    });
});

const totalProjectListHeight = computed(() => {
    const metrics = projectListMetrics.value;
    return metrics.length ? metrics[metrics.length - 1].end : 0;
});

const visibleProjectMetrics = computed(() => {
    const metrics = projectListMetrics.value;
    if (metrics.length === 0) return [];

    const viewportStart = Math.max(0, projectListScrollTop.value);
    const viewportEnd = viewportStart + Math.max(projectListViewportHeight.value, 1);
    const startIndex = Math.max(0, findProjectMetricIndexByOffset(viewportStart) - PROJECT_LIST_OVERSCAN);
    const endIndex = Math.min(metrics.length, findProjectMetricIndexByOffset(viewportEnd) + PROJECT_LIST_OVERSCAN + 1);

    return metrics.slice(startIndex, endIndex);
});

/** 待选择层级的新建项目（父项目已入库，等待用户决定挂载哪些子级） */
const pendingLevelProject = ref<Project | null>(null);
/** 该项目扫描到的候选树 */
const pendingLevelNodes = ref<ImportNode[]>([]);
const showLevelModal = ref(false);

function handleAdd(project: Project, subProjectTree: ImportNode[] = []) {
  projectStore.addProject(project);
  if (subProjectTree.length === 0) return;

  // 扫描到子级/孙级：弹出树形层级选择弹窗，由用户决定挂载到哪一级。
  // 父项目已先行入库，因此这里直接把它当作已有项目传给弹窗，
  // 用户取消也不影响父项目本身——他之后还能在编辑页再次调整层级。
  pendingLevelProject.value = project;
  pendingLevelNodes.value = subProjectTree;
  showLevelModal.value = true;
}

/** 层级选择弹窗彻底关闭后再清理暂存，避免关闭动画被截断 */
function handleLevelClosed() {
  pendingLevelProject.value = null;
  pendingLevelNodes.value = [];
}

function handleUpdate(project: Project) {
  projectStore.updateProject(project);
  editingProject.value = null;
}

function openAddModal() {
    editingProject.value = null;
    showModal.value = true;
}

function openEditModal(project: Project) {
    editingProject.value = project;
    showModal.value = true;
}

async function refreshProjects() {
    refreshing.value = true;
    try {
        await projectStore.refreshAll();
    } finally {
        refreshing.value = false;
    }
}

/***********************列表页快捷键*********************/
// 只在列表页生效：Dashboard 挂载期间注册，工作区那套键位写在 ProjectWorkspace 里。
// 键位可在设置页改，缺省值见 utils/shortcut.ts。
useAppShortcuts([
    {
        keys: () => settingsStore.settings.focusSearchShortcut || DEFAULT_FOCUS_SEARCH_SHORTCUT,
        // 搜索框本身也要能用这个键重新聚焦并全选，所以允许在输入框内触发
        allowInEditable: true,
        enabled: () => !drilledRootId.value,
        handler: () => {
            const input = projectSearchInput.value?.$el?.querySelector?.('input');
            if (input instanceof HTMLInputElement) {
                input.focus();
                input.select();
            }
        },
    },
    {
        keys: () => settingsStore.settings.newProjectShortcut || DEFAULT_NEW_PROJECT_SHORTCUT,
        enabled: () => !drilledRootId.value,
        handler: openAddModal,
    },
    {
        keys: () => settingsStore.settings.refreshProjectsShortcut || DEFAULT_REFRESH_PROJECTS_SHORTCUT,
        enabled: () => !drilledRootId.value && !refreshing.value,
        handler: () => void refreshProjects(),
    },
]);
</script>

<template>
  <div class="h-full overflow-hidden">
    <!-- 列表页 ↔ 工作区页过渡：进入工作区滑入，返回列表滑出。 -->
    <Transition name="dashboard-page" mode="out-in">
      <!-- ═══ 钻取后：项目工作区页 ═══ -->
      <ProjectWorkspace
        v-if="drilledRootId"
        key="workspace"
        :root-id="drilledRootId"
        :target-project-id="workspaceTargetProjectId"
        @back="backToList"
        @edit="editFromWorkspace"
      />

      <!-- ═══ 默认：项目列表页（全宽） ═══ -->
      <div v-else key="project-list" class="h-full flex flex-col app-surface-sidebar">
        <!-- 顶部工具栏 -->
        <div class="app-page-header">
          <div class="app-content-container app-page-header-main">
            <div class="app-page-heading">
                <h2 class="app-page-title">{{ t('dashboard.title') }}</h2>
                <p class="app-page-description">{{ t('dashboard.projectCount', { count: rootProjects.length }) }}</p>
            </div>
            <div class="app-page-actions">
                <button @click="showImportModal = true" class="toolbar-text-btn">
                    <div class="i-mdi-folder-search-outline text-base" />
                    <span>{{ t('dashboard.batchAddProject') }}</span>
                </button>
                <button @click="showGroupManager = true" class="toolbar-text-btn">
                    <div class="i-mdi-folder-plus-outline text-base" />
                    <span>{{ t('dashboard.manageGroups') }}</span>
                </button>
                <button @click="refreshProjects" :disabled="refreshing" class="toolbar-text-btn">
                    <div class="i-mdi-refresh text-base transition-transform duration-700" :class="{ 'animate-spin': refreshing }" />
                    <span>{{ t('common.refresh') }}</span>
                </button>
                <button @click="openAddModal" class="toolbar-primary-btn">
                    <div class="i-mdi-plus text-base" />
                    <span>{{ t('dashboard.addProject') }}</span>
                </button>
            </div>
          </div>
        </div>

        <!-- 选择操作栏（有选中项时显示） -->
        <div v-if="selectedCount > 0" class="selection-bar app-section-divider px-6 py-2.5 border-b flex items-center justify-between">
            <div class="flex items-center gap-3">
                <span class="text-sm font-semibold text-blue-600 dark:text-blue-400">{{ t('dashboard.batchSelected', { count: selectedCount }) }}</span>
                <button class="selection-link" @click="toggleSelectAll">{{ isAllSelected ? t('dashboard.batchDeselectAll') : t('dashboard.batchSelectAll') }}</button>
                <button class="selection-link" @click="clearSelection">{{ t('common.cancel') }}</button>
            </div>
            <div class="flex items-center gap-2">
                <button class="selection-action-btn" @click="batchPin"><div class="i-mdi-pin-outline text-sm" />{{ t('dashboard.batchPin') }}</button>
                <button class="selection-action-btn" @click="showBatchGroupMenu = true"><div class="i-mdi-folder-outline text-sm" />{{ t('dashboard.batchSetGroup') }}</button>
                <button class="selection-action-btn selection-action-danger" @click="batchRemove"><div class="i-mdi-delete-outline text-sm" />{{ t('dashboard.batchRemove') }}</button>
            </div>
        </div>

        <!-- 筛选工具栏 -->
        <div class="app-section-divider px-6 py-3 border-b filter-toolbar">
          <div class="app-content-container space-y-3">
            <!-- 第一行：搜索 + 分组/标签 + 排序 -->
            <div class="flex items-center gap-3">
                <el-input
                    v-model="searchQuery"
                    ref="projectSearchInput"
                    :placeholder="t('dashboard.searchPlaceholder')"
                    clearable
                    style="width: 280px"
                >
                    <template #prefix>
                        <el-icon><div class="i-mdi-magnify" /></el-icon>
                    </template>
                </el-input>

                <el-select v-model="selectedGroupId" clearable :placeholder="t('dashboard.group')" style="width: 150px">
                    <el-option :label="t('dashboard.filterAll')" value="" />
                    <el-option v-for="group in projectStore.projectGroups" :key="group.id" :label="group.name" :value="group.id" />
                </el-select>
                <el-select v-model="selectedTags" multiple clearable collapse-tags collapse-tags-tooltip :placeholder="t('dashboard.tags')" style="width: 180px">
                    <el-option v-for="tag in allTags" :key="tag" :label="tag" :value="tag" />
                </el-select>

                <div class="flex-1" />

                <span class="text-xs text-slate-400 dark:text-slate-500">{{ t('dashboard.sortMode') }}</span>
                <el-tooltip :content="sortMode === 'smart' ? t('dashboard.sortModeSmartHint') : t('dashboard.sortModeDefaultHint')" placement="top" :show-after="300">
                    <el-segmented v-model="settingsStore.settings.sortMode" :options="sortOptions" />
                </el-tooltip>
            </div>

            <!-- 第二行：基础快捷筛选 + 健康状态 chips + 保存视图/启动组 -->
            <div class="flex items-center gap-2 flex-wrap">
                <el-segmented v-model="activeQuickFilter" :options="quickFilterOptions" />
                <span class="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />
                <button
                    v-for="chip in healthFilterChips"
                    :key="chip.key"
                    @click="toggleHealthFilter(chip.key as any)"
                    class="health-chip"
                    :class="[`health-chip-${chip.tone}`, { 'health-chip-active': activeQuickFilter === chip.key }]"
                    :title="chip.label"
                >
                    <div :class="chip.icon" class="text-sm" />
                    <span>{{ chip.label }}</span>
                    <span class="health-chip-count">{{ chip.count }}</span>
                </button>

                <div class="flex-1" />

                <ViewPresetChips
                    :presets="viewPresets"
                    :active-preset-id="activePresetId"
                    @apply="applyPreset"
                    @delete="deletePreset"
                    @save="saveCurrentView"
                />
                <WorkspaceProfileMenu
                    :profiles="workspaceProfiles"
                    :projects="projectStore.projects"
                    @create="createProfile"
                    @delete="deleteProfile"
                    @run="runProfile"
                    @stop="stopProfile"
                />
            </div>
          </div>
        </div>

        <!-- 项目列表 -->
        <div class="flex-1 overflow-y-auto px-6 py-4 custom-scrollbar" ref="projectListContainer" @scroll="handleProjectListScroll">
             <!-- Draggable list (default sort mode, no search) -->
             <div v-if="isDraggable && draggableList.length > 0" class="draggable-list app-content-container space-y-2">
                 <div
                     v-for="project in draggableList"
                     :key="project.id"
                     :data-project-id="project.id"
                     class="draggable-item"
                     :class="{ 'draggable-item-active': dragState.dragging && dragState.projectId === project.id }"
                     :style="dragState.dragging && dragState.projectId === project.id
                         ? `transform: translateY(${dragState.dragDelta}px); z-index: 50; transition: none;`
                         : ''"
                 >
                    <ProjectListItem
                        :project="project"
                        :health-snapshot="getHealth(project.id)"
                        :health-level="healthLevel(getHealth(project.id))"
                        selectable
                        :selected="selectedIds.has(project.id)"
                        @open="openProjectWorkspace(project)"
                        @toggle-select="toggleSelect(project.id)"
                        @edit="openEditModal(project)"
                    >
                        <template #leading>
                            <div
                                class="drag-handle"
                                @mousedown.prevent="onDragMouseDown($event, project.id)"
                                @click.stop
                            >
                                <div class="i-mdi-drag text-xl text-slate-300 dark:text-slate-600 hover:text-slate-400 dark:hover:text-slate-500 transition-colors" />
                            </div>
                        </template>
                    </ProjectListItem>
                 </div>
             </div>

             <!-- Virtual scroll list (smart sort mode or searching) -->
             <div v-else-if="filteredProjects.length > 0" class="relative min-h-full app-content-container" :style="{ height: `${totalProjectListHeight}px` }">
                <div
                    v-for="item in visibleProjectMetrics"
                    :key="item.project.id"
                    :ref="(el) => registerProjectItemRef(item.project.id, resolveElementRef(el))"
                    class="absolute left-0 right-0"
                    :style="{ transform: `translateY(${item.start}px)`, paddingBottom: `${PROJECT_LIST_ITEM_GAP}px` }"
                >
                    <ProjectListItem
                        :project="item.project"
                        :health-snapshot="getHealth(item.project.id)"
                        :health-level="healthLevel(getHealth(item.project.id))"
                        selectable
                        :selected="selectedIds.has(item.project.id)"
                        @open="openProjectWorkspace(item.project)"
                        @toggle-select="toggleSelect(item.project.id)"
                        @edit="openEditModal(item.project)"
                    />
                 </div>
             </div>

             <div v-if="filteredProjects.length === 0 && rootProjects.length > 0" class="text-center mt-16 text-slate-400 dark:text-slate-500">
                <div class="i-mdi-magnify text-4xl mb-3 opacity-20 mx-auto" />
                <p class="text-sm font-medium">{{ t('common.search') }}</p>
                <p class="text-xs opacity-50 mt-1">{{ t('dashboard.searchPlaceholder') }}</p>
             </div>

             <div v-else-if="rootProjects.length === 0" class="text-center mt-20 text-slate-400 dark:text-slate-500">
                <div class="i-mdi-folder-open-outline text-5xl mb-3 opacity-20 mx-auto" />
                <p class="text-sm font-medium">{{ t('dashboard.noProjects') }}</p>
                <p class="text-xs opacity-50 mt-1">{{ t('dashboard.addProject') }}</p>
             </div>
         </div>
    </div>
    </Transition>

    <AddProjectModal
        v-model="showModal"
        :edit-project="editingProject"
        @add="handleAdd"
        @update="handleUpdate"
    />

    <!-- 单个添加后的层级选择：让用户决定扫描到的子级/孙级挂到哪一级 -->
    <SubProjectScanModal
        v-if="pendingLevelProject"
        v-model="showLevelModal"
        :parent-project="pendingLevelProject"
        :preset-nodes="pendingLevelNodes"
        @closed="handleLevelClosed"
    />

    <ProjectGroupManager v-model="showGroupManager" />

    <ImportScanModal v-model="showImportModal" />

    <!-- 批量设置分组 -->
    <el-dialog v-model="showBatchGroupMenu" :title="t('dashboard.batchSetGroup')" width="360px" align-center>
      <el-select v-model="batchGroupTarget" :placeholder="t('dashboard.group')" clearable class="w-full">
        <el-option :label="t('dashboard.ungrouped')" value="" />
        <el-option v-for="group in projectStore.projectGroups" :key="group.id" :label="group.name" :value="group.id" />
      </el-select>
      <template #footer>
        <el-button @click="showBatchGroupMenu = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" @click="applyBatchGroup">{{ t('common.confirm') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--app-text-muted) 72%, transparent);
}
.scrollbar-none::-webkit-scrollbar {
  display: none;
}
.scrollbar-none {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
/* Tab panel fade transition */
.tab-fade-enter-active,
.tab-fade-leave-active {
  transition: opacity 0.15s ease;
}
.tab-fade-enter-from,
.tab-fade-leave-to {
  opacity: 0;
}

/* 顶部工具栏文字按钮 */
.toolbar-text-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: none;
  border-radius: var(--app-radius-md);
  background: transparent;
  color: var(--app-text-secondary);
  font-size: 13px;
  font-weight: 500;
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease);
}
.toolbar-text-btn:hover:not(:disabled) {
  color: var(--app-primary);
  background: var(--app-primary-soft);
}
.toolbar-text-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.toolbar-primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 16px;
  border: none;
  border-radius: var(--app-radius-md);
  background: var(--app-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  box-shadow: var(--app-shadow-sm);
  transition: filter var(--app-duration-fast) var(--app-ease);
}
.toolbar-primary-btn:hover {
  filter: brightness(1.08);
}

/* 选择操作栏 */
.selection-bar {
  background: color-mix(in srgb, var(--app-primary) 6%, transparent);
}
.selection-link {
  border: none;
  background: transparent;
  color: var(--app-text-secondary);
  font-size: 13px;
  transition: color var(--app-duration-fast) var(--app-ease);
}
.selection-link:hover {
  color: var(--app-primary);
}
.selection-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  background: var(--app-surface);
  color: var(--app-text-secondary);
  font-size: 12px;
  font-weight: 500;
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease),
    border-color var(--app-duration-fast) var(--app-ease);
}
.selection-action-btn:hover {
  color: var(--app-primary);
  border-color: color-mix(in srgb, var(--app-primary) 40%, transparent);
}
.selection-action-danger:hover {
  color: var(--app-danger, #ef4444);
  border-color: color-mix(in srgb, #ef4444 40%, transparent);
}

/* 健康状态快捷筛选 chips */
.health-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--app-border);
  background: var(--app-surface);
  color: var(--app-text-secondary);
  cursor: pointer;
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease),
    border-color var(--app-duration-fast) var(--app-ease);
}
.health-chip:hover {
  border-color: var(--app-border-strong);
  color: var(--app-text);
}
.health-chip-count {
  min-width: 18px;
  text-align: center;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--app-surface-soft);
  font-size: 11px;
  font-weight: 700;
}
.health-chip-active {
  color: #fff;
}
.health-chip-emerald.health-chip-active { background: var(--app-success); border-color: var(--app-success); }
.health-chip-amber.health-chip-active { background: var(--app-warning); border-color: var(--app-warning); }
.health-chip-red.health-chip-active,
.health-chip-rose.health-chip-active { background: var(--app-danger, #ef4444); border-color: var(--app-danger, #ef4444); }
.health-chip-active .health-chip-count {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

/* 列表页 ↔ 工作区页过渡：工作区从下方滑入，返回时列表从下方回到原位。 */
.dashboard-page-enter-active,
.dashboard-page-leave-active {
  transition: opacity 180ms var(--app-ease), transform 180ms var(--app-ease);
}
.dashboard-page-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.dashboard-page-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
