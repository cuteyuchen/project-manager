<script setup lang="ts">
/***********************项目树节点*********************/
import { computed } from 'vue';
import type { Project, ProjectHealthSnapshot } from '../../types';
import { useProjectStore } from '../../stores/project';
import { MAX_PROJECT_DEPTH } from '../../utils/projectTree';
import type { ProjectGitOverview } from '../../utils/projectGitOverview';
import ProjectListItem from '../ProjectListItem.vue';

const props = defineProps<{
  project: Project;
  depth: number;
  visibleIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  gitOverviewById: Readonly<Record<string, ProjectGitOverview | undefined>>;
  healthById: Readonly<Record<string, ProjectHealthSnapshot | undefined>>;
  healthLevelById: Readonly<Record<string, 'healthy' | 'warn' | 'error' | 'unknown'>>;
  selectedIds?: ReadonlySet<string>;
  isRoot?: boolean;
  draggable?: boolean;
}>();

const emit = defineEmits<{
  (event: 'toggle-expand', project: Project): void;
  (event: 'open-management', project: Project): void;
  (event: 'open-workspace', project: Project): void;
  (event: 'open-git', project: Project): void;
  (event: 'open-running', project: Project): void;
  (event: 'edit', project: Project): void;
  (event: 'toggle-select', projectId: string): void;
  (eventName: 'drag-start', mouseEvent: MouseEvent, project: Project): void;
}>();

const projectStore = useProjectStore();

/***********************层级与可见子节点*********************/
const allChildren = computed(() => projectStore.getChildren(props.project.id));
const hasChildren = computed(() => props.depth < MAX_PROJECT_DEPTH && allChildren.value.length > 0);
const visibleChildren = computed(() => allChildren.value.filter(child => props.visibleIds.has(child.id)));
const isExpanded = computed(() => hasChildren.value && props.expandedIds.has(props.project.id));

function handleRowOpen(): void {
  if (hasChildren.value) {
    emit('toggle-expand', props.project);
    return;
  }
  emit('open-management', props.project);
}

function toggleExpanded(): void {
  emit('toggle-expand', props.project);
}
</script>

<template>
  <div class="project-tree-node" :class="{ 'project-tree-node-root': isRoot }">
    <ProjectListItem
      :project="project"
      :tree-mode="true"
      :expanded="isExpanded"
      :git-overview="gitOverviewById[project.id]"
      :health-snapshot="healthById[project.id]"
      :health-level="healthLevelById[project.id]"
      selectable
      :selected="selectedIds?.has(project.id)"
      @open="handleRowOpen"
      @open-management="emit('open-management', $event)"
      @open-workspace="emit('open-workspace', $event)"
      @open-git="emit('open-git', $event)"
      @open-running="emit('open-running', $event)"
      @edit="emit('edit', $event)"
      @toggle-select="emit('toggle-select', $event)"
    >
      <template #leading>
        <div v-if="draggable" class="drag-handle" @mousedown.prevent="emit('drag-start', $event, project)" @click.stop>
          <div class="i-mdi-drag text-xl text-slate-300 dark:text-slate-600 hover:text-slate-400 dark:hover:text-slate-500 transition-colors" />
        </div>
        <button
          v-if="hasChildren"
          class="project-tree-toggle"
          :aria-label="isExpanded ? $t('dashboard.collapseProject') : $t('dashboard.expandProject')"
          :aria-expanded="isExpanded"
          @click.stop="toggleExpanded"
        >
          <div :class="isExpanded ? 'i-mdi-chevron-down' : 'i-mdi-chevron-right'" class="text-base" />
        </button>
        <span v-else class="project-tree-toggle-spacer" aria-hidden="true" />
      </template>
    </ProjectListItem>

    <div v-if="isExpanded && visibleChildren.length > 0" class="project-tree-children">
      <ProjectTreeNode
        v-for="child in visibleChildren"
        :key="child.id"
        :project="child"
        :depth="depth + 1"
        :visible-ids="visibleIds"
        :expanded-ids="expandedIds"
        :git-overview-by-id="gitOverviewById"
        :health-by-id="healthById"
        :health-level-by-id="healthLevelById"
        :selected-ids="selectedIds"
        @toggle-expand="emit('toggle-expand', $event)"
        @open-management="emit('open-management', $event)"
        @open-workspace="emit('open-workspace', $event)"
        @open-git="emit('open-git', $event)"
        @open-running="emit('open-running', $event)"
        @edit="emit('edit', $event)"
        @toggle-select="emit('toggle-select', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.project-tree-node {
  min-width: 0;
}
.project-tree-children {
  display: grid;
  gap: 6px;
  margin: 6px 0 0 18px;
  padding-left: 10px;
  border-left: 1px solid var(--app-border);
}
.project-tree-toggle,
.project-tree-toggle-spacer {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 28px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text-muted);
}
.project-tree-toggle:hover {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}
</style>
