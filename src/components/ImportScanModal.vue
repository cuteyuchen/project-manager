<script setup lang="ts">
/** *********************两段式批量导入：多选目录 → 预扫描 → 勾选 → 导入*********************/
/** 支持两种模式：
 *  - 'children'：所选目录被当作扫描根，后端扫描其下的子项目作为候选（遇容器下沉到孙级）。
 *  - 'direct'：所选目录本身就是待导入项目，直接作为候选显示。
 */
import { ref, computed } from 'vue';
import { useProjectStore } from '../stores/project';
import { api } from '../api';
import type { ImportCandidate, ImportNode } from '../api/types';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { flattenImportNodeTree, buildImportProjectTree } from '../utils/importProjectTree';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const { t } = useI18n();
const projectStore = useProjectStore();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

/** 导入模式：'children' 扫描所选目录的子项目；'direct' 直接将所选目录作为候选 */
type ImportMode = 'children' | 'direct';
const importMode = ref<ImportMode>('children');

/** *********************扫描状态*********************/
const scanning = ref(false);
const importing = ref(false);
/** 已选中的目录（children 模式下为扫描根，direct 模式下为候选项目本身） */
const rootPaths = ref<string[]>([]);
/** 候选项：承载 ImportCandidate 样式字段（名称/路径/子模块数/是否 Git），并在 children 模式下附带对应的 ImportNode 以便递归导入其下子节点。 */
type ScanCandidate = ImportCandidate & {
  selected: boolean;
  exists: boolean;
  /** children 模式下此项对应的嵌套树节点（用于递归构建嵌套子项目）；direct 模式无此值。 */
  node?: ImportNode;
};

const candidates = ref<ScanCandidate[]>([]);

/** 规范化路径用于去重和匹配已有项目 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 从完整路径中取最后一段作为显示名 */
function folderName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** 选择目录（支持多选）并触发扫描 */
async function pickAndScan() {
  try {
    const selected = await api.openDialog({ directory: true, multiple: true });
    if (selected == null) return;

    // multiple: true 时返回 string[]；旧逻辑下 multiple: false 返回 string。
    // 这里统一收集为数组。
    const paths: string[] = Array.isArray(selected)
      ? selected.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : typeof selected === 'string'
        ? [selected]
        : [];

    if (paths.length === 0) return;

    rootPaths.value = paths;
    await runScan();
  } catch (e) {
    console.error('Failed to pick directories for import scan', e);
    ElMessage.error(t('common.error'));
  }
}

/** 继续追加选择目录（保留已选并在其上叠加，去重） */
async function addFoldersAndScan() {
  try {
    const selected = await api.openDialog({ directory: true, multiple: true });
    if (selected == null) return;

    const paths: string[] = Array.isArray(selected)
      ? selected.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : typeof selected === 'string'
        ? [selected]
        : [];

    if (paths.length === 0) return;

    const existing = new Set(rootPaths.value.map(normalizePath));
    const merged = [...rootPaths.value];
    for (const p of paths) {
      if (!existing.has(normalizePath(p))) merged.push(p);
    }
    rootPaths.value = merged;
    await runScan();
  } catch (e) {
    console.error('Failed to add directories for import scan', e);
    ElMessage.error(t('common.error'));
  }
}

/** 移除一个已选目录，并重新扫描剩余目录 */
async function removeRootPath(p: string) {
  rootPaths.value = rootPaths.value.filter((x) => x !== p);
  await runScan();
}

/** 切换导入模式后，若已有已选目录则按新模式重新扫描一次。 */
async function onModeChange() {
  if (rootPaths.value.length > 0) {
    await runScan();
  }
}

/** 计算某个 ImportNode 子树内的可识别模块节点数（含容器自身不计，递归加总叶子模块数）。 */
function countModulesInNode(node: ImportNode): number {
  if (node.kind !== 'unknown') {
    // 该节点本身已识别为模块；不再统计其（本应为空的）子节点
    return 1 + node.children.reduce((sum, child) => sum + countModulesInNode(child), 0);
  }
  // 容器节点：仅累加子节点贡献
  return node.children.reduce((sum, child) => sum + countModulesInNode(child), 0);
}

/** 执行扫描：children 模式调用 scanImportTree 返回嵌套树，direct 模式将所选目录构造成候选 */
async function runScan() {
  if (rootPaths.value.length === 0) return;
  scanning.value = true;
  try {
    const existingPaths = new Set(projectStore.projects.map((p) => normalizePath(p.path)));

    if (importMode.value === 'children') {
      // 并发扫描每个根目录，获取嵌套树。顶层节点作为候选展示，其下子节点在导入时递归挂入。
      const lists = await Promise.all(
        rootPaths.value.map((p) =>
          api.scanImportTree(p).catch((e) => {
            console.error(`Failed to scan import tree at ${p}`, e);
            return [] as ImportNode[];
          }),
        ),
      );

      const seen = new Set<string>();
      const merged: ScanCandidate[] = [];
      for (const tree of lists) {
        for (const node of tree) {
          const key = normalizePath(node.path);
          if (seen.has(key)) continue;
          seen.add(key);
          const exists = existingPaths.has(normalizePath(node.path));
          merged.push({
            name: node.name,
            path: node.path,
            hasGit: node.hasGit,
            subModuleCount: countModulesInNode(node),
            exists,
            selected: !exists,
            node,
          });
        }
      }
      candidates.value = merged;
    } else {
      // direct：所选目录直接作为候选。并发检查每个目录是否 Git 仓库。
      const gitChecks = await Promise.all(
        rootPaths.value.map((p) => api.gitCheck(p).catch(() => false)),
      );
      const seen = new Set<string>();
      const merged: ScanCandidate[] = [];
      rootPaths.value.forEach((p, i) => {
        const key = normalizePath(p);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({
          name: folderName(p),
          path: p,
          hasGit: gitChecks[i] === true,
          subModuleCount: 0,
          exists: existingPaths.has(normalizePath(p)),
          selected: !existingPaths.has(normalizePath(p)),
        });
      });
      candidates.value = merged;
    }
  } catch (e) {
    console.error('Failed to scan import tree', e);
    ElMessage.error(t('common.error'));
    candidates.value = [];
  } finally {
    scanning.value = false;
  }
}

/** 可选（未存在）候选 */
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

/** *********************导入*********************/
async function doImport() {
  const targets = candidates.value.filter((c) => c.selected && !c.exists);
  if (targets.length === 0) return;

  importing.value = true;
  let added = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      if (importMode.value === 'children' && target.node) {
        // children 模式：后端已返回嵌套树。将整棵子树扁平化（父在前、子在后，各自已带 parentId）后逐条入库。
        const projects = flattenImportNodeTree([target.node], undefined);
        const existingPaths = new Set(projectStore.projects.map((p) => normalizePath(p.path)));
        for (const p of projects) {
          if (existingPaths.has(normalizePath(p.path))) continue;
          projectStore.addProject(p);
          existingPaths.add(p.path);
        }
      } else {
        // direct 模式：所选目录作为一级项目，再单独扫描其下子模块挂为子项目。
        // 这里复用旧的扁平构建路径（与 AddProjectModal 行为一致）。
        const [info, subProjects] = await Promise.all([
          api.scanProject(target.path).catch((error) => {
            console.error(`Failed to scan project metadata at ${target.path}`, error);
            return null;
          }),
          api.scanSubProjects(target.path).catch((error) => {
            console.error(`Failed to scan sub projects at ${target.path}`, error);
            return [];
          }),
        ]);

        const tree = buildImportProjectTree(target, info, subProjects);
        projectStore.addProject(tree.root);
        if (tree.children.length > 0) {
          projectStore.addSubProjects(tree.root.id, tree.children);
        }
      }
      added++;
    } catch (e) {
      console.error(`Failed to import project at ${target.path}`, e);
      failed++;
    }
  }

  importing.value = false;

  if (added > 0) ElMessage.success(t('dashboard.batchAddSuccess', { count: added }));
  if (failed > 0 && added === 0) ElMessage.warning(t('dashboard.batchAddFail', { count: failed }));

  // 关闭并重置
  visible.value = false;
  resetState();
}

function resetState() {
  rootPaths.value = [];
  candidates.value = [];
}

function handleClosed() {
  resetState();
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('import.title')"
    width="640px"
    align-center
    class="app-centered-dialog"
    @closed="handleClosed"
  >
    <div class="space-y-3">
      <!-- 模式切换 -->
      <div class="import-mode-row">
        <el-segmented
          v-model="importMode"
          :options="[
            { label: t('import.modeChildren'), value: 'children' },
            { label: t('import.modeDirect'), value: 'direct' },
          ]"
          @change="onModeChange"
        />
        <span class="text-[10px] text-slate-400 leading-tight max-w-[260px] truncate" :title="importMode === 'children' ? t('import.modeChildrenHint') : t('import.modeDirectHint')">
          {{ importMode === 'children' ? t('import.modeChildrenHint') : t('import.modeDirectHint') }}
        </span>
      </div>

      <!-- 目录选择 -->
      <div class="flex items-center gap-2">
        <el-button :loading="scanning" @click="pickAndScan">
          <div class="i-mdi-folder-open-outline mr-1" />
          {{ rootPaths.length > 0 ? t('import.replaceSelected') : t('import.pickDir') }}
        </el-button>
        <el-button v-if="rootPaths.length > 0" :loading="scanning" @click="addFoldersAndScan">
          <div class="i-mdi-folder-plus-outline mr-1" />
          {{ t('import.addMore') }}
        </el-button>
        <el-button v-if="rootPaths.length > 0" :loading="scanning" @click="runScan" :title="t('import.rescan')">
          <div class="i-mdi-refresh" />
        </el-button>
      </div>

      <!-- 已选目录（可移除） -->
      <div v-if="rootPaths.length > 0" class="flex flex-wrap gap-1.5">
        <el-tag
          v-for="p in rootPaths"
          :key="p"
          closable
          size="small"
          type="info"
          class="root-folder-tag"
          @close="removeRootPath(p)"
        >
          <div class="inline-flex items-center gap-1 max-w-full">
            <div class="i-mdi-folder text-[10px]" />
            <span class="font-medium truncate" :title="p">{{ folderName(p) }}</span>
            <span class="font-mono text-[9px] opacity-50 truncate" :title="p">— {{ p }}</span>
          </div>
        </el-tag>
      </div>

      <!-- 候选列表 -->
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
                <span v-if="c.exists" class="import-tag import-tag-muted">{{ t('import.exists') }}</span>
                <span v-if="c.hasGit" class="import-tag import-tag-git"><div class="i-mdi-git text-[9px]" /> Git</span>
                <span v-if="importMode === 'children' && c.subModuleCount > 0" class="import-tag import-tag-module">
                  {{ t('import.moduleCount', { count: c.subModuleCount }) }}
                </span>
              </div>
              <div class="text-[10px] text-slate-400 font-mono truncate">{{ c.path }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="rootPaths.length > 0 && !scanning" class="text-center py-8 text-slate-400">
        <div class="i-mdi-folder-search-outline text-4xl mb-2 opacity-30 mx-auto" />
        <p class="text-sm">{{ t('import.empty') }}</p>
      </div>

      <div v-else-if="rootPaths.length === 0 && !scanning" class="text-center py-8 text-slate-400">
        <div class="i-mdi-folder-search-outline text-4xl mb-2 opacity-30 mx-auto" />
        <p class="text-sm">{{ t('import.pickHint') }}</p>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="importing" :disabled="selectedCount === 0" @click="doImport">
          {{ t('import.importSelected', { count: selectedCount }) }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-radius: var(--app-radius-xs);
  font-size: 9px;
  font-weight: 600;
}
.import-tag-muted {
  background: var(--app-surface-soft);
  border: 1px solid var(--app-border);
  color: var(--app-text-muted);
}
.import-tag-git {
  background: color-mix(in srgb, var(--app-warning) 12%, transparent);
  color: var(--app-warning);
}
.import-tag-module {
  background: color-mix(in srgb, var(--app-primary) 12%, transparent);
  color: var(--app-primary);
}
.import-mode-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.root-folder-tag {
  max-width: 100%;
}
.root-folder-tag :deep(.el-tag__close) {
  flex-shrink: 0;
}
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  border-radius: 2px;
}
</style>
