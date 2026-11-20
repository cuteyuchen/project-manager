<script setup lang="ts">
/***********************快捷选择项目下拉内容*********************/
/**
 * 下拉只列出一级项目，并且只允许选中一级项目。
 *
 * 下钻到子项目由调用方负责：快速管理弹窗用右侧的子级项目切换器，
 * 项目详情页用左侧文件树。这样下拉里不会再铺开整棵项目树。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Project } from '../../types';
import type { ProjectGitOverview } from '../../utils/projectGitOverview';
import { compareProjectsByPinnedThenOrder } from '../../utils/projectTree';
import { buildProjectSearchEntry, projectSearchEntryMatches } from '../../utils/projectSearch';

const props = withDefaults(defineProps<{
  projects: readonly Project[];
  currentProjectId?: string | null;
  gitOverviewById?: Readonly<Record<string, ProjectGitOverview | undefined>>;
  runningCountByProjectId?: Readonly<Record<string, number>>;
  visible?: boolean;
}>(), {
  currentProjectId: null,
  gitOverviewById: undefined,
  runningCountByProjectId: undefined,
  visible: false,
});

const emit = defineEmits<{
  (event: 'select', project: Project): void;
}>();

const { t } = useI18n();
const searchQuery = ref('');

const projectById = computed(() => new Map(props.projects.map(project => [project.id, project])));

const searchEntries = computed(() => new Map(
  props.projects.map(project => [project.id, buildProjectSearchEntry(project)]),
));

/**
 * 当前所在的一级项目：当前项目本身是子项目时沿 parentId 回溯到根。
 * 用于让下拉里「自己所在的那条一级项目」保持高亮，而不是整列都没有选中态。
 */
const currentRootId = computed(() => {
  let current = props.currentProjectId ? projectById.value.get(props.currentProjectId) : undefined;
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    current = projectById.value.get(current.parentId);
  }
  return current?.id ?? null;
});

/** 只有一级项目（没有 parentId）进入下拉列表，子项目一律不进。 */
const rootProjects = computed(() => props.projects
  .filter(project => !project.parentId)
  .sort(compareProjectsByPinnedThenOrder));

const childrenByParentId = computed(() => {
  const result = new Map<string, Project[]>();
  for (const project of props.projects) {
    if (!project.parentId) continue;
    const siblings = result.get(project.parentId);
    if (siblings) siblings.push(project);
    else result.set(project.parentId, [project]);
  }
  return result;
});

/**
 * 一级项目 → 它整棵子树的 id 集合。
 *
 * 下拉虽然只列一级项目，但搜索仍要能命中选择项内部的项目：输入某个子项目名时
 * 保留它所属的一级项目，用户选完一级项目就能在右侧子项目切换器里找到它。
 */
const subtreeProjectIds = computed(() => {
  const result = new Map<string, string[]>();
  for (const rootProject of rootProjects.value) {
    const ids: string[] = [rootProject.id];
    const seen = new Set(ids);
    const stack = [rootProject.id];
    while (stack.length > 0) {
      const parentId = stack.pop() as string;
      for (const child of childrenByParentId.value.get(parentId) || []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        ids.push(child.id);
        stack.push(child.id);
      }
    }
    result.set(rootProject.id, ids);
  }
  return result;
});

const rows = computed(() => {
  const query = searchQuery.value.trim();
  if (!query) return rootProjects.value;
  return rootProjects.value.filter(project => (subtreeProjectIds.value.get(project.id) || [project.id])
    .some(id => {
      const entry = searchEntries.value.get(id);
      return entry ? projectSearchEntryMatches(entry, query) : false;
    }));
});

function isRunning(projectId: string): boolean {
  return (props.runningCountByProjectId?.[projectId] || 0) > 0;
}

function selectProject(project: Project): void {
  searchQuery.value = '';
  emit('select', project);
}

function handleRowKeydown(event: KeyboardEvent, project: Project): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  selectProject(project);
}

const listRef = ref<HTMLElement | null>(null);

function performScroll(): boolean {
  const list = listRef.value;
  if (!list || list.clientHeight === 0) return false;
  const activeEl = list.querySelector<HTMLElement>('.project-switcher-row-active');
  if (!activeEl) return false;

  const listRect = list.getBoundingClientRect();
  const activeRect = activeEl.getBoundingClientRect();

  const relativeTop = activeRect.top - listRect.top + list.scrollTop;
  const listHeight = list.clientHeight;
  const activeHeight = activeEl.offsetHeight;

  const targetScrollTop = Math.max(0, Math.round(relativeTop - (listHeight - activeHeight) / 2));
  list.scrollTop = targetScrollTop;
  return true;
}

function scrollToActive(): void {
  nextTick(() => {
    if (!performScroll()) {
      requestAnimationFrame(() => {
        if (!performScroll()) {
          setTimeout(performScroll, 50);
        }
      });
    }
  });
}

watch(() => props.visible, (val) => {
  if (val) {
    scrollToActive();
  }
});

watch(currentRootId, () => {
  if (props.visible) {
    scrollToActive();
  }
});

onMounted(() => {
  scrollToActive();
});

defineExpose({
  scrollToActive,
});
</script>

<template>
  <div class="project-switcher-popover">
    <el-input
      v-model="searchQuery"
      class="project-switcher-search"
      size="small"
      clearable
      :placeholder="t('dashboard.searchPlaceholder')"
      :aria-label="t('dashboard.searchPlaceholder')"
    >
      <template #prefix>
        <el-icon><div class="i-mdi-magnify" /></el-icon>
      </template>
    </el-input>

    <div v-if="rows.length > 0" ref="listRef" class="project-switcher-list" role="listbox">
      <div
        v-for="project in rows"
        :key="project.id"
        class="project-switcher-row"
        :class="{ 'project-switcher-row-active': project.id === currentRootId }"
        :title="project.path"
        :aria-selected="project.id === currentRootId"
        role="option"
        tabindex="0"
        @click.stop="selectProject(project)"
        @keydown="handleRowKeydown($event, project)"
      >
        <span class="project-switcher-tree-mark">
          <span class="i-mdi-folder-home-outline" aria-hidden="true" />
        </span>
        <span class="project-switcher-row-main">
          <span class="project-switcher-row-title">
            <span class="truncate">{{ project.name }}</span>
            <span v-if="project.moduleKind" class="project-switcher-kind">
              {{ t(`project.moduleKind.${project.moduleKind}`) }}
            </span>
          </span>
          <span class="project-switcher-row-path">{{ project.path }}</span>
        </span>
        <span class="project-switcher-row-status" aria-hidden="true">
          <span v-if="project.id === currentRootId" class="i-mdi-check project-switcher-current" />
          <span v-if="isRunning(project.id)" class="project-switcher-running" />
          <span
            v-if="gitOverviewById?.[project.id]?.isGitRepo && !gitOverviewById[project.id]?.clean"
            class="project-switcher-git-dirty"
          >
            <span v-if="gitOverviewById[project.id]?.modified">M{{ gitOverviewById[project.id]?.modified }}</span>
            <span v-if="gitOverviewById[project.id]?.added">A{{ gitOverviewById[project.id]?.added }}</span>
            <span v-if="gitOverviewById[project.id]?.deleted">D{{ gitOverviewById[project.id]?.deleted }}</span>
            <span v-if="gitOverviewById[project.id]?.conflicted">!{{ gitOverviewById[project.id]?.conflicted }}</span>
          </span>
        </span>
      </div>
    </div>
    <div v-else class="project-switcher-empty">
      {{ t('dashboard.noSearchResults') }}
    </div>
  </div>
</template>

<style scoped>
.project-switcher-popover {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  max-width: min(360px, calc(100vw - 48px));
  gap: 8px;
}
.project-switcher-search {
  flex-shrink: 0;
}
.project-switcher-list {
  position: relative;
  display: flex;
  flex-direction: column;
  max-height: min(360px, 48vh);
  overflow-y: auto;
  padding: 2px 0;
}
.project-switcher-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text-secondary);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}
.project-switcher-row:hover,
.project-switcher-row-active,
.project-switcher-row:focus-visible {
  background: var(--app-primary-soft);
  color: var(--app-text);
  outline: none;
}
.project-switcher-tree-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  color: var(--app-text-muted);
  font-size: 14px;
}
.project-switcher-row-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.project-switcher-row-title {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  font-size: var(--app-font-control);
  font-weight: 600;
}
.project-switcher-kind {
  flex-shrink: 0;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--app-primary) 22%, transparent);
  border-radius: var(--app-radius-xs);
  color: var(--app-primary);
  font-size: var(--app-font-caption);
  font-weight: 600;
}
.project-switcher-row-path {
  min-width: 0;
  overflow: hidden;
  color: var(--app-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: var(--app-font-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-switcher-row-status {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex-shrink: 0;
  min-width: 18px;
  font-size: var(--app-font-meta);
  font-weight: 700;
}
.project-switcher-current {
  color: var(--app-primary);
  font-size: var(--app-font-control);
}
.project-switcher-running {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 5px color-mix(in srgb, var(--app-success) 70%, transparent);
}
.project-switcher-git-dirty {
  display: inline-flex;
  gap: 3px;
  color: var(--app-warning);
  white-space: nowrap;
}
.project-switcher-empty {
  padding: 20px 8px;
  color: var(--app-text-muted);
  font-size: var(--app-font-meta);
  line-height: var(--app-line-height-caption);
  text-align: center;
}
</style>
