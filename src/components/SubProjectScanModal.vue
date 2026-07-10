<script setup lang="ts">
/** *********************子项目扫描/关联弹窗*********************/
import { ref, computed, watch } from 'vue';
import { useProjectStore } from '../stores/project';
import { api } from '../api';
import type { SubProjectCandidate } from '../api/types';
import type { Project, ProjectModuleKind } from '../types';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';

/** 最大层级：一级→二级→三级 */
const MAX_DEPTH = 3;

const props = defineProps<{
  modelValue: boolean;
  parentProject: Project;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const { t } = useI18n();
const projectStore = useProjectStore();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const scanning = ref(false);
const candidates = ref<(SubProjectCandidate & { selected: boolean; exists: boolean })[]>([]);

/** 父项目当前深度：其子项目深度 = parentDepth + 1，须 ≤ MAX_DEPTH */
const parentDepth = computed(() => projectStore.getProjectDepth(props.parentProject.id));
/** 是否允许再加一层子项目 */
const canAddChildren = computed(() => parentDepth.value < MAX_DEPTH);

// 打开时自动扫描
watch(visible, (v) => {
  if (v) runScan();
});

async function runScan() {
  if (!canAddChildren.value) {
    candidates.value = [];
    return;
  }
  scanning.value = true;
  try {
    const list = await api.scanSubProjects(props.parentProject.path);
    const existingPaths = new Set(projectStore.projects.map((p) => normalizePath(p.path)));
    candidates.value = list.map((c) => {
      const exists = existingPaths.has(normalizePath(c.path));
      return { ...c, exists, selected: !exists };
    });
  } catch (e) {
    console.error('Failed to scan sub projects', e);
    ElMessage.error(t('common.error'));
    candidates.value = [];
  } finally {
    scanning.value = false;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const selectableCandidates = computed(() => candidates.value.filter((c) => !c.exists));
const selectedCount = computed(() => candidates.value.filter((c) => c.selected && !c.exists).length);
const allSelected = computed(() =>
  selectableCandidates.value.length > 0 && selectableCandidates.value.every((c) => c.selected)
);

function toggleSelectAll() {
  const next = !allSelected.value;
  for (const c of candidates.value) {
    if (!c.exists) c.selected = next;
  }
}

/** kind → moduleKind 映射（后端返回的 kind 已与 ProjectModuleKind 对齐） */
function toModuleKind(kind: string): ProjectModuleKind {
  const valid: ProjectModuleKind[] = ['frontend', 'backend', 'node', 'go', 'rust', 'python', 'dotnet', 'static', 'unknown'];
  return (valid as string[]).includes(kind) ? (kind as ProjectModuleKind) : 'unknown';
}

function kindLabel(kind: string): string {
  return t(`project.moduleKind.${toModuleKind(kind)}`);
}

function confirmAdd() {
  const targets = candidates.value.filter((c) => c.selected && !c.exists);
  if (targets.length === 0) return;

  const children = targets.map((c) => ({
    name: c.name,
    path: c.path,
    type: (c.kind === 'node' || c.kind === 'frontend' || c.kind === 'static' ? 'node' : 'other') as Project['type'],
    moduleKind: toModuleKind(c.kind),
    scripts: c.scripts,
    packageManager: (c.hasPackageJson ? 'npm' : undefined) as Project['packageManager'],
  }));

  const created = projectStore.addSubProjects(props.parentProject.id, children);
  ElMessage.success(t('dashboard.subProjectAdded', { count: created.length }));
  visible.value = false;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('dashboard.scanSubProjects')"
    width="600px"
    align-center
    class="app-centered-dialog"
  >
    <!-- 深度超限提示 -->
    <div v-if="!canAddChildren" class="text-center py-8 text-slate-400">
      <div class="i-mdi-alert-circle-outline text-4xl mb-2 opacity-30 mx-auto" />
      <p class="text-sm">{{ t('dashboard.maxDepthReached') }}</p>
    </div>

    <template v-else>
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-slate-400 truncate font-mono">{{ parentProject.path }}</span>
        <el-button size="small" :loading="scanning" @click="runScan">
          <div class="i-mdi-refresh mr-1" /> {{ t('import.rescan') }}
        </el-button>
      </div>

      <div v-if="candidates.length > 0" class="border rounded-lg overflow-hidden app-section-divider">
        <div class="flex items-center justify-between px-3 py-2 border-b bg-slate-50 dark:bg-slate-800/40">
          <el-checkbox
            :model-value="allSelected"
            :indeterminate="selectedCount > 0 && !allSelected"
            :disabled="selectableCandidates.length === 0"
            @change="toggleSelectAll"
          >
            {{ t('import.selectAll') }}
          </el-checkbox>
          <span class="text-xs text-slate-400">{{ t('import.selectedCount', { count: selectedCount }) }}</span>
        </div>
        <div class="max-h-80 overflow-y-auto custom-scrollbar">
          <div
            v-for="c in candidates"
            :key="c.path"
            class="flex items-center gap-2 px-3 py-2 border-b last:border-b-0 transition-colors"
            :class="c.exists ? 'opacity-50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/30 cursor-pointer'"
            @click="!c.exists && (c.selected = !c.selected)"
          >
            <el-checkbox :model-value="c.selected" :disabled="c.exists" @click.stop @change="c.selected = $event as boolean" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{{ c.name }}</span>
                <span class="sub-kind-chip">{{ kindLabel(c.kind) }}</span>
                <span v-if="c.framework" class="text-[10px] text-slate-400">{{ c.framework }}</span>
                <span v-if="c.exists" class="sub-kind-chip sub-kind-muted">{{ t('import.exists') }}</span>
              </div>
              <div class="text-[10px] text-slate-400 font-mono truncate">{{ c.path }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="!scanning" class="text-center py-8 text-slate-400">
        <div class="i-mdi-folder-search-outline text-4xl mb-2 opacity-30 mx-auto" />
        <p class="text-sm">{{ t('dashboard.noSubProjectsFound') }}</p>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
        <el-button v-if="canAddChildren" type="primary" :disabled="selectedCount === 0" @click="confirmAdd">
          {{ t('dashboard.addSubProjects', { count: selectedCount }) }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.sub-kind-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: var(--app-radius-xs);
  font-size: 9px;
  font-weight: 600;
  background: color-mix(in srgb, var(--app-primary) 12%, transparent);
  color: var(--app-primary);
}
.sub-kind-muted {
  background: var(--app-surface-soft);
  color: var(--app-text-muted);
}
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  border-radius: 2px;
}
</style>
