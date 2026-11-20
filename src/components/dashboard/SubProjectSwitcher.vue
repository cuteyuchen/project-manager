<script setup lang="ts">
/***********************子级项目切换器*********************/
/**
 * 一级项目下钻后的子项目切换器。
 *
 * 把一级项目下的所有后代项目（二级、三级…）逐个平铺成可点击的胶囊，
 * 层级之间用颜色区分：「二级套三级」时二级容器和三级叶子都会出现。
 * 一级项目本身不在这里，它由左侧下拉框选择。
 */
import { computed, nextTick, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Project } from '../../types';
import { useGitStore } from '../../stores/git';
import { collectSubProjectRows } from '../../utils/projectTree';

const props = withDefaults(defineProps<{
  projects: readonly Project[];
  /** 当前一级项目 id；为空时不渲染任何子项目 */
  rootId?: string | null;
  /** 当前正在管理/查看的项目 id，用于高亮 */
  currentProjectId?: string | null;
  /** 项目子树运行中的命令数，用于展示运行中小圆点 */
  runningCountByProjectId?: Readonly<Record<string, number>>;
}>(), {
  rootId: null,
  currentProjectId: null,
  runningCountByProjectId: undefined,
});

const emit = defineEmits<{
  (event: 'select', project: Project): void;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const chips = computed(() => collectSubProjectRows(props.projects, props.rootId));
const rootProject = computed(() => props.projects.find(p => p.id === props.rootId) || null);
const switcherRef = useTemplateRef<HTMLElement>('switcherRef');

const allProjects = computed<Project[]>(() => {
  const result: Project[] = [];
  if (rootProject.value) result.push(rootProject.value);
  for (const chip of chips.value) {
    result.push(chip.project);
  }
  return result;
});

/** 当前分支来自 git store 的 summary 缓存（与文件树同一份数据源） */
const branchById = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {};
  for (const project of allProjects.value) {
    const projectId = project.id;
    if (gitStore.isGitRepo[projectId] !== true) continue;
    const branch = gitStore.getSummary(projectId)?.branch;
    if (branch) result[projectId] = branch;
  }
  return result;
});

/**
 * 分支不在 Project 上，只能从 git summary 取；胶囊首次出现时按需拉一次，
 * 否则刚打开弹窗时所有子项目都没有分支名。store 内部有 TTL 与请求去重，
 * 和文件树节点挂载时的做法一致。
 */
watch(
  () => allProjects.value.map(project => `${project.id}:${project.path}`).join('|'),
  () => {
    for (const project of allProjects.value) {
      void gitStore.ensureSummaryAndStatus(project.id, project.path);
    }
  },
  { immediate: true },
);

function isRunning(projectId: string): boolean {
  return (props.runningCountByProjectId?.[projectId] || 0) > 0;
}

/** 子项目多到换行/滚动时，保证高亮项在可视区内 */
watch(() => [props.rootId, props.currentProjectId, chips.value.length], () => {
  void nextTick(() => {
    switcherRef.value
      ?.querySelector<HTMLElement>('.sub-project-chip.is-active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}, { immediate: true });

/** 层级只用于取色，超过三级按最深一级处理 */
function depthClass(depth: number): string {
  return `is-depth-${Math.min(depth, 3)}`;
}
</script>

<template>
  <div v-if="chips.length > 0 && rootProject" ref="switcherRef" class="sub-project-switcher" role="tablist">
    <!-- 父级/根级项目胶囊 -->
    <button
      type="button"
      role="tab"
      class="sub-project-chip is-depth-1"
      :class="{ 'is-active': rootProject.id === currentProjectId }"
      :title="rootProject.path || rootProject.name"
      :aria-selected="rootProject.id === currentProjectId"
      @click.stop="emit('select', rootProject)"
    >
      <span v-if="rootProject.id === currentProjectId" class="i-mdi-check sub-project-chip-check" aria-hidden="true" />
      <span
        v-if="isRunning(rootProject.id)"
        class="sub-project-chip-running"
        :title="t('dashboard.running')"
      />
      <span class="i-mdi-folder-home-outline text-xs shrink-0 opacity-80" aria-hidden="true" />
      <span class="sub-project-chip-name">{{ rootProject.name }}</span>
      <span v-if="branchById[rootProject.id]" class="sub-project-chip-branch" :title="branchById[rootProject.id]">
        <span class="i-mdi-source-branch" aria-hidden="true" />
        <span class="sub-project-chip-branch-name">{{ branchById[rootProject.id] }}</span>
      </span>
    </button>
    <!-- 子级项目胶囊 -->
    <button
      v-for="chip in chips"
      :key="chip.project.id"
      type="button"
      role="tab"
      class="sub-project-chip"
      :class="[depthClass(chip.depth), { 'is-active': chip.project.id === currentProjectId }]"
      :title="chip.project.path || chip.project.name"
      :aria-selected="chip.project.id === currentProjectId"
      @click.stop="emit('select', chip.project)"
    >
      <span v-if="chip.project.id === currentProjectId" class="i-mdi-check sub-project-chip-check" aria-hidden="true" />
      <span
        v-if="isRunning(chip.project.id)"
        class="sub-project-chip-running"
        :title="t('dashboard.running')"
      />
      <span class="sub-project-chip-name">{{ chip.project.name }}</span>
      <span v-if="branchById[chip.project.id]" class="sub-project-chip-branch" :title="branchById[chip.project.id]">
        <span class="i-mdi-source-branch" aria-hidden="true" />
        <span class="sub-project-chip-branch-name">{{ branchById[chip.project.id] }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.sub-project-switcher {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-height: 56px;
  padding: 1px 0;
  overflow-y: auto;
  scrollbar-width: thin;
}
.sub-project-chip {
  --chip-accent: var(--app-primary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--chip-accent) 24%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--chip-accent) 5%, transparent);
  color: var(--app-text-secondary);
  font-family: inherit;
  font-size: var(--app-font-caption);
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    border-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease),
    box-shadow var(--app-duration-fast) var(--app-ease);
}
.sub-project-chip:hover {
  border-color: color-mix(in srgb, var(--chip-accent) 46%, transparent);
  background: color-mix(in srgb, var(--chip-accent) 12%, transparent);
  color: color-mix(in srgb, var(--chip-accent) 80%, var(--app-text));
}
/*
 * 选中态：实心填充 + 白字 + 勾选图标。
 * 之前的浅色描边和未选中几乎分不出来，这里直接换成"反色"处理，
 * 颜色仍沿用层级色，所以选中后还能看出是二级还是三级。
 */
.sub-project-chip.is-active,
.sub-project-chip.is-active:hover {
  border-color: var(--chip-accent);
  background: var(--chip-accent);
  color: #ffffff;
  font-weight: 700;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--chip-accent) 45%, transparent);
}
.sub-project-chip-check {
  flex: 0 0 auto;
  font-size: var(--app-font-caption);
}
.sub-project-chip:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--chip-accent) 60%, transparent);
  outline-offset: 1px;
}
.sub-project-chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 运行中：绿色小圆点，和下拉/文件树保持同一套视觉 */
.sub-project-chip-running {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 5px color-mix(in srgb, var(--app-success) 70%, transparent);
}
/* 分支：跟在项目名后面，弱化到次要文字色，避免抢项目名的视觉权重 */
.sub-project-chip-branch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 1 auto;
  min-width: 0;
  padding-left: 5px;
  border-left: 1px solid color-mix(in srgb, var(--chip-accent) 24%, transparent);
  color: color-mix(in srgb, var(--app-text-muted) 88%, var(--chip-accent));
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: var(--app-font-caption);
  font-weight: 500;
}
.sub-project-chip-branch .i-mdi-source-branch {
  flex: 0 0 auto;
  font-size: var(--app-font-caption);
  opacity: 0.85;
}
.sub-project-chip-branch-name {
  min-width: 0;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 选中态是实心底色，分支和运行圆点一起反色，否则读不清 */
.sub-project-chip.is-active .sub-project-chip-branch {
  border-left-color: rgba(255, 255, 255, 0.42);
  color: rgba(255, 255, 255, 0.86);
}
.sub-project-chip.is-active .sub-project-chip-running {
  background: #ffffff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.85);
}

/* 层级配色：一级=主项目色，二级=蓝，三级=紫（更深层级沿用紫色），深浅主题都保留对比度 */
.sub-project-chip.is-depth-1 {
  --chip-accent: var(--app-primary);
}
.sub-project-chip.is-depth-2 {
  --chip-accent: var(--app-primary);
}
.sub-project-chip.is-depth-3 {
  --chip-accent: #7c3aed;
}
:global(html.dark) .sub-project-chip.is-depth-3 {
  --chip-accent: #a78bfa;
}

/* 深色主题下次级色本身是浅色，实心胶囊改用深色文字/图标保住对比度 */
:global(html.dark) .sub-project-chip.is-active {
  color: #0b1120;
}
:global(html.dark) .sub-project-chip.is-active .sub-project-chip-branch {
  border-left-color: rgba(11, 17, 32, 0.35);
  color: rgba(11, 17, 32, 0.72);
}
:global(html.dark) .sub-project-chip.is-active .sub-project-chip-running {
  background: #0b1120;
  box-shadow: 0 0 6px rgba(11, 17, 32, 0.55);
}
</style>
