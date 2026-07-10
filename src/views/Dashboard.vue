<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useTemplateRef } from 'vue';
import { useProjectStore } from '../stores/project';
import { useUsageStore } from '../stores/usage';
import { useSettingsStore } from '../stores/settings';
import ProjectListItem from '../components/ProjectListItem.vue';
import AddProjectModal from '../components/AddProjectModal.vue';
import ProjectGroupManager from '../components/ProjectGroupManager.vue';
import ImportScanModal from '../components/ImportScanModal.vue';
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
import { useI18n } from 'vue-i18n';
import { calculateDraggedItemCenterY, calculateDraggedItemTranslateY, calculateFlipTransforms } from '../utils/dragPosition';
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

/** 进入某一级项目的工作区 */
function openProjectWorkspace(project: Project) {
    drilledRootId.value = project.id;
}

/** 从工作区返回列表 */
function backToList() {
    drilledRootId.value = null;
    projectStore.activeRootId = null;
    projectStore.activeProjectId = null;
    void nextTick(() => {
        const container = projectListContainer.value;
        if (!container) return;
        container.scrollTop = projectListScrollTop.value;
        projectListResizeObserver?.observe(container);
        updateProjectListViewport();
    });
}

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
    // Default sort: pinned first, then by sortOrder (manual), then by original array order
    return [...rootProjects.value].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        if (a.pinned && b.pinned) return (a.pinOrder ?? 0) - (b.pinOrder ?? 0);
        // For unpinned: use sortOrder if available, otherwise maintain original order
        const oa = a.sortOrder ?? Infinity;
        const ob = b.sortOrder ?? Infinity;
        if (oa !== ob) return oa - ob;
        return 0;
    });
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
function isProjectRunning(projectId: string): boolean {
    return (projectStore.runningProjectCount[projectId] ?? 0) > 0;
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
const draggableList = ref<Project[]>([]);
const dragState = ref({
    dragging: false,
    projectId: null as string | null,
    pointerOffsetY: 0,
    dragDelta: 0,
    fromIndex: -1,
    currentFromIndex: -1,
    containerEl: null as HTMLElement | null,
});
let flipAnimating = false;

watch(() => sortedProjects.value, (newSorted) => {
    if (!dragState.value.dragging) {
        draggableList.value = [...newSorted];
    }
}, { immediate: true });

function onDragMouseDown(e: MouseEvent, projectId: string) {
    e.preventDefault();
    const handleEl = e.currentTarget as HTMLElement;
    const itemEl = handleEl.closest('.draggable-item') as HTMLElement;
    const listEl = handleEl.closest('.draggable-list') as HTMLElement;
    if (!itemEl || !listEl) return;

    const startIndex = draggableList.value.findIndex(p => p.id === projectId);
    if (startIndex < 0) return;

    const itemRect = itemEl.getBoundingClientRect();

    dragState.value = {
        dragging: true,
        projectId,
        pointerOffsetY: e.clientY - itemRect.top,
        dragDelta: 0,
        fromIndex: startIndex,
        currentFromIndex: startIndex,
        containerEl: listEl,
    };

    document.addEventListener('mousemove', onDragMouseMove);
    document.addEventListener('mouseup', onDragMouseUp);
}

function onDragMouseMove(e: MouseEvent) {
    const state = dragState.value;
    if (!state.dragging || !state.containerEl) return;

    // 按当前 DOM 基准位置计算位移，避免换位后叠加初始位移导致元素远离鼠标。
    const items = Array.from(state.containerEl.children) as HTMLElement[];
    const draggedItem = items[state.currentFromIndex];
    if (!draggedItem) return;

    state.dragDelta = calculateDraggedItemTranslateY({
        pointerClientY: e.clientY,
        listClientTop: state.containerEl.getBoundingClientRect().top,
        pointerOffsetY: state.pointerOffsetY,
        itemOffsetTop: draggedItem.offsetTop,
    });

    let targetIndex = state.currentFromIndex;
    const draggedCenter = calculateDraggedItemCenterY({
        itemOffsetTop: draggedItem.offsetTop,
        itemHeight: draggedItem.offsetHeight,
        translateY: state.dragDelta,
    });

    for (let i = 0; i < items.length; i++) {
        if (i === state.currentFromIndex) continue;
        const itemTop = items[i].offsetTop;
        const itemHeight = items[i].offsetHeight;
        const itemCenter = itemTop + itemHeight / 2;

        if (state.currentFromIndex < i && draggedCenter > itemCenter) {
            targetIndex = i;
        } else if (state.currentFromIndex > i && draggedCenter < itemCenter) {
            targetIndex = i;
        }
    }

    if (targetIndex !== state.currentFromIndex && !flipAnimating) {
        animateReorder(state.currentFromIndex, targetIndex);
        state.currentFromIndex = targetIndex;
    }
}

function animateReorder(fromIdx: number, toIdx: number) {
    const listEl = dragState.value.containerEl;
    if (!listEl) return;
    flipAnimating = true;

    // 按项目 ID 记录换位前位置，用于 FLIP 动画。
    const children = Array.from(listEl.children) as HTMLElement[];
    const oldPositions = children
        .map(el => ({ id: el.dataset.projectId ?? '', top: el.offsetTop }))
        .filter(item => item.id);

    // 更新列表顺序，让 DOM 进入换位后的真实布局。
    const [moved] = draggableList.value.splice(fromIdx, 1);
    draggableList.value.splice(toIdx, 0, moved);

    // DOM 更新后，让非拖拽元素从旧位置平滑移动到新位置。
    nextTick(() => {
        const newChildren = Array.from(listEl.children) as HTMLElement[];
        const transforms = calculateFlipTransforms({
            oldPositions,
            newPositions: newChildren
                .map(el => ({ id: el.dataset.projectId ?? '', top: el.offsetTop }))
                .filter(item => item.id),
            excludedId: dragState.value.projectId,
        });

        newChildren.forEach((el) => {
            const translateY = transforms.get(el.dataset.projectId ?? '');
            if (translateY !== undefined) {
                el.style.transition = 'none';
                el.style.transform = `translateY(${translateY}px)`;
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        el.style.transition = 'transform 0.18s ease';
                        el.style.transform = '';
                        el.addEventListener('transitionend', () => {
                            el.style.transition = '';
                            el.style.transform = '';
                        }, { once: true });
                    });
                });
            }
        });

        setTimeout(() => { flipAnimating = false; }, 200);
    });
}

function onDragMouseUp() {
    document.removeEventListener('mousemove', onDragMouseMove);
    document.removeEventListener('mouseup', onDragMouseUp);

    const state = dragState.value;
    if (state.dragging && state.currentFromIndex !== state.fromIndex) {
        syncDraggableOrder();
    }

    dragState.value = {
        dragging: false,
        projectId: null,
        pointerOffsetY: 0,
        dragDelta: 0,
        fromIndex: -1,
        currentFromIndex: -1,
        containerEl: null,
    };
}

function syncDraggableOrder() {
    const projectMap = new Map(projectStore.projects.map(p => [p.id, p]));
    let unpinnedIndex = 0;
    draggableList.value.forEach((p, i) => {
        const proj = projectMap.get(p.id);
        if (!proj) return;
        if (p.pinned) {
            proj.pinOrder = i;
        } else {
            proj.sortOrder = unpinnedIndex++;
        }
    });
}

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

function handleAdd(project: Project, children: Omit<Project, 'id' | 'parentId'>[] = []) {
  projectStore.addProject(project);
  if (children.length > 0) {
    projectStore.addSubProjects(project.id, children);
  }
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
</script>

<template>
  <div class="h-full overflow-hidden">
    <!-- ═══ 钻取后：项目工作区页 ═══ -->
    <ProjectWorkspace
      v-if="drilledRootId"
      :root-id="drilledRootId"
      @back="backToList"
      @edit="editFromWorkspace"
    />

    <!-- ═══ 默认：项目列表页（全宽） ═══ -->
    <div v-else class="h-full flex flex-col app-surface-sidebar">
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

    <AddProjectModal
        v-model="showModal"
        :edit-project="editingProject"
        @add="handleAdd"
        @update="handleUpdate"
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

/* Draggable list items */
.draggable-list {
  position: relative;
}
.draggable-item {
  position: relative;
}
.draggable-item-active {
  box-shadow: var(--app-shadow-md);
  border-radius: var(--app-radius-lg);
  opacity: 0.95;
}

/* Drag handle */
.drag-handle {
  width: 22px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: grab;
  opacity: 0.6;
  transition: opacity 0.15s ease;
}
.draggable-item:hover .drag-handle {
  opacity: 1;
}
.drag-handle:active {
  cursor: grabbing;
}
</style>
