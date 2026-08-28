<script setup lang="ts">
/** *********************项目工作区页：钻取进入一级项目后的详情视图*********************/
import { ref, computed, watch, onMounted, onBeforeUnmount, useTemplateRef } from 'vue';
import { useProjectStore } from '../../stores/project';
import { useNavMemoryStore } from '../../stores/navMemory.ts';
import { useI18n } from 'vue-i18n';
import type { Project } from '../../types';
import ProjectListItem from '../ProjectListItem.vue';
import ProjectManagementPanel from './ProjectManagementPanel.vue';
import SubProjectScanModal from '../SubProjectScanModal.vue';
import { MAX_PROJECT_DEPTH } from '../../utils/projectTree';
import { useListDragSort } from '../../composables/useListDragSort.ts';
import { useAppShortcuts } from '../../composables/useAppShortcuts.ts';

/** 最大钻取层级（一级→二级→三级），与扫描深度共用同一常量 */
const MAX_DEPTH = MAX_PROJECT_DEPTH;

const props = defineProps<{
  /** 钻取进入的一级项目 id */
  rootId: string;
  /** 从外部搜索跳转时需要定位的具体项目 id */
  targetProjectId?: string | null;
}>();
const emit = defineEmits<{
  /** 从一级项目返回项目列表 */
  (e: 'back'): void;
  /** 请求编辑某个项目 */
  (e: 'edit', project: Project): void;
}>();

const { t } = useI18n();
const projectStore = useProjectStore();
const navMemory = useNavMemoryStore();

/** *********************钻取路径栈*********************/
// 存 project id 链，首项恒为 rootId，长度 ≤ MAX_DEPTH
const drillStack = ref<string[]>([props.rootId]);
const navigationDirection = ref<'forward' | 'back'>('forward');
const workspaceTransitionName = computed(() => `workspace-${navigationDirection.value}`);
const subProjectScrollPositions = new Map<string, number>();
const subProjectList = useTemplateRef<HTMLElement>('subProjectList');

/**
 * 切换到另一个一级项目时重置本组件状态。
 *
 * 这个 watcher 以前是**死代码**：Dashboard 用 `:key="workspace:${rootId}"`
 * 渲染本组件，rootId 一变就整组件重挂载，它永远不触发。
 * 现在那个 :key 已改成静态值（为了让 KeepAlive 缓存跨一级项目存活），
 * 于是「切一级项目」的全部重置责任都压到这里，漏一项就会表现为
 * 「上一个项目的痕迹跟进来」。重置清单见 resetForRoot。
 */
watch(() => props.rootId, (id) => {
  resetForRoot(id);
});

/** 栈末端项目（当前所在层级节点） */
const currentNode = computed(() =>
  projectStore.projects.find(p => p.id === drillStack.value[drillStack.value.length - 1]) || null
);

/** 当前节点的直接子项目 */
const children = computed(() =>
  currentNode.value ? projectStore.getChildren(currentNode.value.id) : []
);

/** 容器模式：当前节点有子项目 */
const isContainer = computed(() => children.value.length > 0);

/** 是否允许继续下钻（未达最大深度） */
const canDrillDeeper = computed(() => drillStack.value.length < MAX_DEPTH);

/** *********************子项目拖拽排序*********************/
// 与一级项目列表共用 useListDragSort 与 theme.css 里的 .draggable-* 样式。
// 注意父项目入口卡不在 children 里，模板上必须放在 .draggable-list 外面，
// 否则容器的直接子元素与 draggableChildren 下标错位。
const {
  draggableList: draggableChildren,
  dragState: subProjectDragState,
  onDragMouseDown: onSubProjectDragMouseDown,
} = useListDragSort<Project>({
  items: children,
  onCommit: (ordered) => projectStore.applyManualOrder(ordered),
});

/** *********************面包屑*********************/
const breadcrumb = computed(() =>
  drillStack.value
    .map(id => projectStore.projects.find(p => p.id === id))
    .filter((p): p is Project => !!p)
);

function goToBreadcrumb(index: number) {
  if (index < drillStack.value.length - 1) {
    navigationDirection.value = 'back';
    drillStack.value = drillStack.value.slice(0, index + 1);
    // 回到某一层：恢复它上次选中的叶子
    selectedLeafId.value = restoreLevelLeaf(drillStack.value[drillStack.value.length - 1]);
    syncActiveIds();
  }
}

function handleBack() {
  if (drillStack.value.length > 1) {
    // 回退一级
    navigationDirection.value = 'back';
    drillStack.value = drillStack.value.slice(0, -1);
    selectedLeafId.value = restoreLevelLeaf(drillStack.value[drillStack.value.length - 1]);
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
    if (!selectedLeafId.value) return currentNode.value;
    return projectStore.projects.find(p => p.id === selectedLeafId.value) || currentNode.value;
  }
  // 叶子模式：当前节点本身即叶子
  return currentNode.value;
});

/** 共享管理面板绑定的当前项目：有选中子项目时优先子项目，否则使用当前层级自身。 */
const workspaceProject = computed<Project | null>(() => activeLeaf.value || currentNode.value);

/** 把 store 的双 active id 与当前状态同步 */
function syncActiveIds() {
  projectStore.activeRootId = props.rootId;
  projectStore.activeProjectId = activeLeaf.value?.id ?? null;
}

watch(activeLeaf, () => syncActiveIds());
onMounted(() => {
  // restoreNavMemory 内部已调 syncActiveIds；它自己会在没有记忆时安全退出
  restoreNavMemory();
  syncActiveIds();
});
onBeforeUnmount(() => {
  // 离开工作区时清空叶子，避免 git/console 串数据
  projectStore.activeProjectId = null;
});

/** 点击子项目：有子则下钻，无子则选为叶子并切到命令 tab */
function handleOpenChild(project: Project) {
  // 离开当前层级前先把「这一层选中了谁」记下来
  if (currentNode.value) {
    navMemory.rememberLevelLeaf(currentNode.value.id, project.id);
  }

  if (projectStore.hasChildren(project.id) && canDrillDeeper.value) {
    navigationDirection.value = 'forward';
    drillStack.value = [...drillStack.value, project.id];
    // 进入新层级：恢复它上次选中的叶子（校验失败回落 null）
    selectedLeafId.value = restoreLevelLeaf(project.id);
  } else {
    selectedLeafId.value = project.id;
  }
  syncActiveIds();
}

/** *********************导航记忆的校验与恢复*********************/

/**
 * 记忆里的叶子现在还能不能用。
 *
 * 三种失效：项目被级联删除、被搬到了别的父级、层级结构变了导致它不再是叶子。
 */
function isUsableLeaf(levelId: string, leafId: string): boolean {
  const project = projectStore.projects.find(p => p.id === leafId);
  if (!project) return false;

  // 特例：记的是「层级自身」（父项目入口卡）。此时它的 parentId 指向上一层，
  // 不可能等于 levelId，用下面的兄弟校验会永远判失败并把记忆删掉。
  if (leafId === levelId) return true;

  if (project.parentId !== levelId) return false;

  // 与 handleOpenChild 同一判据：深度到顶时，有子项目的节点也只能当叶子
  return !projectStore.hasChildren(leafId) || !canDrillDeeper.value;
}

/** 取某层级记住的叶子 id；无记忆或已失效时返回 null（= 选中层级自身） */
function restoreLevelLeaf(levelId: string): string | null {
  return navMemory.getLevelLeaf(levelId, id => isUsableLeaf(levelId, id));
}

function handleSubProjectScroll() {
  // 拖拽换位会带动容器滚动，那不是用户的浏览意图，别记进滚动位置
  if (subProjectDragState.value.dragging) return;
  if (currentNode.value && subProjectList.value) {
    subProjectScrollPositions.set(currentNode.value.id, subProjectList.value.scrollTop);
  }
}

function restoreCurrentScrollPosition() {
  if (!currentNode.value || !subProjectList.value) return;
  subProjectList.value.scrollTop = subProjectScrollPositions.get(currentNode.value.id) || 0;
}

function handleOpenParentProject() {
  if (!currentNode.value) return;
  const levelId = currentNode.value.id;
  // null 语义：这一层选中的是父项目入口卡本身
  navMemory.rememberLevelLeaf(levelId, null);
  selectedLeafId.value = levelId;
  syncActiveIds();
}

/** 将外部搜索结果定位到对应层级，并选中最终的叶子项目。 */
function selectTargetProject(targetId: string | null | undefined) {
  if (!targetId || targetId === props.rootId) return;

  const ancestors: string[] = [];
  const seen = new Set<string>();
  let current = projectStore.projects.find(project => project.id === targetId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ancestors.unshift(current.id);
    if (current.id === props.rootId) break;
    current = current.parentId
      ? projectStore.projects.find(project => project.id === current!.parentId)
      : undefined;
  }

  if (ancestors[0] !== props.rootId) return;

  const target = projectStore.projects.find(project => project.id === targetId);
  if (!target) return;
  if (projectStore.hasChildren(target.id) && ancestors.length < MAX_DEPTH) {
    drillStack.value = ancestors;
    selectedLeafId.value = null;
  } else {
    drillStack.value = ancestors.slice(0, -1);
    selectedLeafId.value = target.id;
  }
  syncActiveIds();
}

watch(() => props.targetProjectId, selectTargetProject, { immediate: true });

/** *********************子项目扫描/关联*********************/
const showScanModal = ref(false);

/**
 * 恢复当前层级的导航记忆（选中的叶子 + 该叶子的页签）。
 *
 * 由 onMounted 与 resetForRoot 共同调用，一份逻辑两处用：
 * - 从列表页首次进入工作区走 onMounted
 * - 切换一级项目（组件不再重挂载）走 resetForRoot
 *
 * **不恢复 drillStack**：改它会改变 currentNode.id，触发左栏 Transition 换 key，
 * 是不必要的风险面。只恢复叶子选中与页签就够。
 *
 * 外部搜索跳转优先：那条路径由 selectTargetProject 显式定位，不该被记忆覆盖。
 */
function restoreNavMemory() {
  if (props.targetProjectId) return;

  const levelId = currentNode.value?.id;
  if (!levelId) return;

  selectedLeafId.value = restoreLevelLeaf(levelId);

  syncActiveIds();
}

/** *********************工作区快捷键*********************/
// 作用域靠组件生命周期天然划分：只在工作区挂载期间生效。
// Esc / Alt+← 是固定导航键；页签快捷键可在设置页修改。

/** 页签的固定先后顺序；快捷键按「当前可见的第 n 个」映射 */
useAppShortcuts([
  // 逐级返回：先退钻取层级，到一级项目再退回列表页。
  // 裸键默认不在输入框内响应——在提交信息框里按 Esc 不该把工作区退回列表页。
  { keys: 'Escape', enabled: () => !!currentNode.value, handler: handleBack },
  // Alt+← 同样逐级返回；输入框内禁用，避免编辑文本时误导航。
  {
    keys: 'Alt+ArrowLeft',
    allowInEditable: false,
    enabled: () => !!currentNode.value,
    handler: handleBack,
  },
]);

/** *********************切换一级项目时的完整重置*********************/

/**
 * 把组件状态重置到「刚进入某个一级项目」的样子。
 *
 * 只在 rootId 变化时调用。清单里每一项都对应一种「上一个项目的痕迹跟进来」，
 * 在 Dashboard 还带 :key（整组件重挂载）的年代它们都是免费的。
 */
function resetForRoot(id: string) {
  drillStack.value = [id];
  selectedLeafId.value = null;
  // 新的一级项目一律按「前进」入场，否则会沿用上次 handleBack 留下的反向动画
  navigationDirection.value = 'forward';
  // 旧项目各层级的滚动位置对新项目毫无意义，实例长寿后也没人清理
  subProjectScrollPositions.clear();
  // 弹窗绑的是 :parent-project="currentNode"，开着不关会静默换成另一个项目的父级
  showScanModal.value = false;
  syncActiveIds();
  // 最后再用导航记忆覆盖 selectedLeafId，避免上一个一级项目的叶子泄漏。
  restoreNavMemory();
}
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

    <!-- 静态骨架：**不带 :key**，永不重建。
         层级切换只重建左栏子项目列表；右栏连同 KeepAlive 缓存留在这里活着，
         这样下钻/回退/切一级项目都不会把 GitView、ConsoleView 的实例销毁。 -->
    <div class="flex-1 min-w-0 flex overflow-hidden">
      <!-- ─── 左栏外壳：负责占住 320px ───────────────────────
           必须由外壳吃掉宽度/背景/右边框：mode="out-in" 在 leave 结束到 enter
           开始之间有一帧没有子节点，若把 w-80 留在被过渡的元素上，
           那一帧左栏宽度会归零，右栏 reflow 到全宽再弹回。 -->
      <div class="w-80 shrink-0 app-surface-sidebar border-r overflow-hidden">
        <Transition
          :name="workspaceTransitionName"
          mode="out-in"
          appear
          @after-enter="restoreCurrentScrollPosition"
        >
        <div v-if="currentNode" :key="currentNode.id" class="h-full flex flex-col overflow-hidden">
        <div class="app-section-divider px-3 py-2 border-b flex items-center justify-between">
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            {{ t('dashboard.subProjects') }}
          </span>
          <span class="text-[10px] text-slate-400">{{ children.length }}</span>
        </div>
        <div
          ref="subProjectList"
          class="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar"
          @scroll="handleSubProjectScroll"
        >
          <!-- 父项目入口：不参与排序，必须留在 .draggable-list 外面，
               否则拖拽的换位下标会与 draggableChildren 错位 -->
          <ProjectListItem
            v-if="currentNode"
            :project="currentNode"
            :display-name="t('dashboard.parentProjectEntry', { name: currentNode.name })"
            :active="!selectedLeafId || selectedLeafId === currentNode.id"
            layout="stacked"
            @open="handleOpenParentProject"
            @edit="emit('edit', currentNode)"
          />
          <div class="draggable-list space-y-2">
            <div
              v-for="child in draggableChildren"
              :key="child.id"
              :data-project-id="child.id"
              class="draggable-item"
              :class="{ 'draggable-item-active': subProjectDragState.dragging && subProjectDragState.projectId === child.id }"
              :style="subProjectDragState.dragging && subProjectDragState.projectId === child.id
                ? `transform: translateY(${subProjectDragState.dragDelta}px); z-index: 50; transition: none;`
                : ''"
            >
              <ProjectListItem
                :project="child"
                :active="selectedLeafId === child.id"
                layout="stacked"
                @open="handleOpenChild"
                @edit="emit('edit', child)"
              >
                <template #leading>
                  <div
                    class="drag-handle"
                    @mousedown.prevent="onSubProjectDragMouseDown($event, child.id)"
                    @click.stop
                  >
                    <div class="i-mdi-drag text-xl text-slate-300 dark:text-slate-600 hover:text-slate-400 dark:hover:text-slate-500 transition-colors" />
                  </div>
                </template>
              </ProjectListItem>
            </div>
          </div>
        </div>
        </div>
        </Transition>
      </div>

      <!-- ─── 右栏管理内容：完整工作区与快速管理弹窗共用 ─────────────── -->
      <ProjectManagementPanel :project="workspaceProject" />
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
/* 右栏内容切换。时长与左栏的层级过渡（workspace-forward/back）对齐，
   两侧同时收尾；否则左栏 200ms、右栏 150ms 会看出错拍。 */
.tab-fade-enter-active,
.tab-fade-leave-active {
  transition: opacity var(--app-duration-base) var(--app-ease);
}
.tab-fade-enter-from,
.tab-fade-leave-to {
  opacity: 0;
}

.workspace-forward-enter-active,
.workspace-forward-leave-active,
.workspace-back-enter-active,
.workspace-back-leave-active {
  transition: transform var(--app-duration-base) var(--app-ease), opacity var(--app-duration-base) var(--app-ease);
}
.workspace-forward-enter-from {
  opacity: 0;
  transform: translateX(18px);
}
.workspace-forward-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}
.workspace-back-enter-from {
  opacity: 0;
  transform: translateX(-18px);
}
.workspace-back-leave-to {
  opacity: 0;
  transform: translateX(12px);
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
