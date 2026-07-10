<script setup lang="ts">
/** *********************两段式批量导入：预扫描 → 勾选 → 导入*********************/
import { ref, computed } from 'vue';
import { useProjectStore } from '../stores/project';
import { api } from '../api';
import type { ImportCandidate } from '../api/types';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import { normalizeNvmVersion, findInstalledNodeVersion } from '../utils/nvm';
import { buildImportProjectTree } from '../utils/importProjectTree';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const { t } = useI18n();
const projectStore = useProjectStore();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

/** *********************扫描状态*********************/
const scanning = ref(false);
const importing = ref(false);
const rootPath = ref('');
const candidates = ref<(ImportCandidate & { selected: boolean; exists: boolean })[]>([]);

/** 选择根目录并预扫描 */
async function pickAndScan() {
  try {
    const selected = await api.openDialog({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) {
      if (Array.isArray(selected) && selected[0]) {
        rootPath.value = selected[0];
      } else {
        return;
      }
    } else {
      rootPath.value = selected;
    }
    await runScan();
  } catch (e) {
    console.error('Failed to pick directory for import scan', e);
    ElMessage.error(t('common.error'));
  }
}

/** 执行预扫描 */
async function runScan() {
  if (!rootPath.value) return;
  scanning.value = true;
  try {
    const list = await api.scanImportPreview(rootPath.value);
    const existingPaths = new Set(projectStore.projects.map((p) => normalizePath(p.path)));
    candidates.value = list.map((c) => {
      const exists = existingPaths.has(normalizePath(c.path));
      return { ...c, exists, selected: !exists };
    });
  } catch (e) {
    console.error('Failed to scan import preview', e);
    ElMessage.error(t('common.error'));
    candidates.value = [];
  } finally {
    scanning.value = false;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
  let currentNodeVersions: string[] = [];
  try {
    const nvmList = await api.getNvmList();
    currentNodeVersions = nvmList.map((v) => v.version);
  } catch (e) {
    console.error('Failed to load node versions before import', e);
  }

  for (const target of targets) {
    try {
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

      let nodeVersion: string | undefined;
      if (info?.projectType === 'node') {
        nodeVersion = 'Default';
        const normalizedNvm = normalizeNvmVersion(info.nvmVersion);
        if (normalizedNvm) {
          const installed = findInstalledNodeVersion(currentNodeVersions, normalizedNvm);
          if (installed) nodeVersion = installed;
        }
      }

      const tree = buildImportProjectTree(target, info, subProjects, { nodeVersion });
      projectStore.addProject(tree.root);
      if (tree.children.length > 0) {
        projectStore.addSubProjects(tree.root.id, tree.children);
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
  rootPath.value = '';
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
      <!-- 目录选择 -->
      <div class="flex items-center gap-2">
        <el-input v-model="rootPath" :placeholder="t('import.pickHint')" readonly size="default" class="flex-1">
          <template #prefix><el-icon><div class="i-mdi-folder-outline" /></el-icon></template>
        </el-input>
        <el-button :loading="scanning" @click="pickAndScan">{{ t('import.pickDir') }}</el-button>
        <el-button v-if="rootPath" :loading="scanning" @click="runScan" :title="t('import.rescan')">
          <div class="i-mdi-refresh" />
        </el-button>
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
                <span v-if="c.subModuleCount > 0" class="import-tag import-tag-module">
                  {{ t('import.moduleCount', { count: c.subModuleCount }) }}
                </span>
              </div>
              <div class="text-[10px] text-slate-400 font-mono truncate">{{ c.path }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="rootPath && !scanning" class="text-center py-8 text-slate-400">
        <div class="i-mdi-folder-search-outline text-4xl mb-2 opacity-30 mx-auto" />
        <p class="text-sm">{{ t('import.empty') }}</p>
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
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  border-radius: 2px;
}
</style>
