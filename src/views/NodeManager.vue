<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import type { ManagedRuntimeLocationMode, NodeVersion, Project } from '../types';
import { useNodeStore } from '../stores/node';
import { useProjectStore } from '../stores/project';
import { useSettingsStore } from '../stores/settings';
import { getNodeRuntimeId, resolveAppDefaultRuntime, resolveProjectRuntime } from '../utils/nodeRuntime';
import AddNodeModal from '../components/AddNodeModal.vue';
import InstallNodeModal from '../components/InstallNodeModal.vue';

const { t } = useI18n();
const nodeStore = useNodeStore();
const projectStore = useProjectStore();
const settingsStore = useSettingsStore();
const target = import.meta.env.VITE_TARGET;
const isPlugin = target === 'utools' || target === 'ztools';

const showAddModal = ref(false);
const showInstallModal = ref(false);
const showStorageDialog = ref(false);
const showUsageDialog = ref(false);
const selectedUsageRuntime = ref<NodeVersion | null>(null);
const storageMode = ref<ManagedRuntimeLocationMode>('app-data');
const customStoragePath = ref('');
const migrateExisting = ref(true);
const storageSaving = ref(false);

const sourceOrder: NodeVersion['source'][] = ['managed', 'nvm', 'system', 'custom'];

const sourceCounts = computed(() => {
  const counts: Record<NodeVersion['source'], number> = {
    managed: 0,
    nvm: 0,
    system: 0,
    custom: 0,
  };
  for (const runtime of nodeStore.versions) counts[runtime.source] += 1;
  return counts;
});

const managedRuntimes = computed(() => nodeStore.versions.filter(runtime => runtime.source === 'managed'));
const nvmRuntimes = computed(() => nodeStore.versions.filter(runtime => runtime.source === 'nvm'));
const defaultRuntime = computed(() => {
  return resolveAppDefaultRuntime(nodeStore.versions, nodeStore.appDefault).runtime;
});
const defaultUnavailable = computed(() => !!nodeStore.appDefault && !defaultRuntime.value);
const managedRoot = computed(() => nodeStore.managedLocation?.rootPath || t('nodes.locationUnknown'));
const portableAvailable = computed(() => nodeStore.managedLocation?.portableAvailable !== false);
const nvmRoots = computed(() => {
  const roots = new Set<string>();
  for (const runtime of nvmRuntimes.value) {
    if (runtime.runtimeRoot) roots.add(runtime.runtimeRoot);
  }
  return [...roots];
});

const displayRuntimes = computed<NodeVersion[]>(() => {
  const rows = [...nodeStore.versions];
  for (const progress of Object.values(nodeStore.installProgress)) {
    if (!rows.some(row => row.source === 'managed' && row.version === progress.version)) {
      rows.push({
        runtimeId: `managed:${progress.version}`,
        version: progress.version,
        path: '',
        source: 'managed',
        status: 'installing',
      });
    }
  }
  return rows;
});

function sourceLabel(source: NodeVersion['source']): string {
  if (source === 'managed') return t('nodes.sourceManaged');
  if (source === 'nvm') return t('nodes.sourceNvm');
  if (source === 'system') return t('nodes.sourceSystem');
  return t('nodes.sourceCustom');
}

function sourceTone(source: NodeVersion['source']): string {
  if (source === 'managed') return 'success';
  if (source === 'nvm') return 'warning';
  if (source === 'system') return 'info';
  return 'primary';
}

function statusLabel(runtime: NodeVersion): string {
  if (runtime.status === 'installing' || nodeStore.installProgress[runtime.version]) return t('nodes.installing');
  if (runtime.status === 'broken') return t('nodes.broken');
  if (runtime.status === 'unavailable') return t('nodes.unavailable');
  return t('nodes.available');
}

function progressText(runtime: NodeVersion): string {
  const progress = nodeStore.installProgress[runtime.version];
  if (!progress) return '';
  if (progress.phase === 'downloading' && typeof progress.percent === 'number') {
    return `${t('nodes.phaseDownloading')} ${progress.percent}%`;
  }
  const phaseKey = {
    preparing: 'nodes.phasePreparing',
    resolving: 'nodes.phaseResolving',
    verifying: 'nodes.phaseVerifying',
    extracting: 'nodes.phaseExtracting',
    finalizing: 'nodes.phaseFinalizing',
    validating: 'nodes.phaseValidating',
    cleanup: 'nodes.phaseCleanup',
    complete: 'nodes.phaseComplete',
  }[progress.phase];
  return phaseKey ? t(phaseKey) : progress.phase;
}

function projectIsRunning(project: Project): boolean {
  return Object.entries(projectStore.runningStatus).some(([key, running]) => running && key.startsWith(`${project.id}:`));
}

function projectsUsingRuntime(runtime: NodeVersion): Project[] {
  const runtimeId = getNodeRuntimeId(runtime);
  return projectStore.projects.filter(project => {
    if (project.type !== 'node') return false;
    const resolved = resolveProjectRuntime(project, nodeStore.versions, nodeStore.appDefault).runtime;
    return resolved ? getNodeRuntimeId(resolved) === runtimeId : project.nodeRuntimeId === runtimeId;
  });
}

function usageLabel(runtime: NodeVersion): string {
  const projects = projectsUsingRuntime(runtime);
  if (!projects.length) return t('nodes.noProjectUsage');
  const running = projects.filter(projectIsRunning).length;
  return running ? t('nodes.projectUsageRunning', { count: projects.length, running }) : t('nodes.projectUsage', { count: projects.length });
}

function runtimeIsRunning(runtime: NodeVersion): boolean {
  return projectsUsingRuntime(runtime).some(projectIsRunning);
}

function openFolder(path: string): void {
  if (!path) return;
  api.openFolder(path).catch(error => ElMessage.error(`${t('common.error')}: ${error}`));
}

async function refresh(): Promise<void> {
  try {
    await nodeStore.loadRuntimes();
    ElMessage.success(t('common.success'));
  } catch (error: any) {
    ElMessage.error(error?.message || t('common.error'));
  }
}

async function validateRuntime(runtime: NodeVersion): Promise<void> {
  try {
    await nodeStore.validateRuntime(getNodeRuntimeId(runtime));
    ElMessage.success(t('nodes.validationSuccess'));
  } catch (error: any) {
    ElMessage.error(error?.message || t('nodes.validationFailed'));
  }
}

async function setDefault(runtime: NodeVersion): Promise<void> {
  try {
    await nodeStore.setAppDefaultNode(runtime);
    ElMessage.success(t('nodes.defaultSaved'));
  } catch (error: any) {
    ElMessage.error(error?.message || t('common.error'));
  }
}

async function openRuntimeTerminal(runtime: NodeVersion): Promise<void> {
  try {
    await nodeStore.openTerminalWithRuntime(runtime);
  } catch (error: any) {
    ElMessage.error(error?.message || t('common.error'));
  }
}

async function copyPath(path: string): Promise<void> {
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    ElMessage.success(t('nodes.pathCopied'));
  } catch (error: any) {
    ElMessage.error(error?.message || t('common.error'));
  }
}

function showUsage(runtime: NodeVersion): void {
  selectedUsageRuntime.value = runtime;
  showUsageDialog.value = true;
}

async function removeRuntime(runtime: NodeVersion): Promise<void> {
  if (runtime.source === 'system' || runtime.source === 'nvm') return;
  const projects = projectsUsingRuntime(runtime);
  if (runtime.source === 'managed' && runtimeIsRunning(runtime)) {
    ElMessage.warning(t('nodes.uninstallRunning'));
    return;
  }

  const details = projects.length
    ? `\n${t('nodes.uninstallReferenced', { count: projects.length })}`
    : '';
  const message = runtime.source === 'managed'
    ? `${t('nodes.uninstallConfirm', { version: runtime.version })}${details}`
    : t('nodes.removeCustomConfirm');

  try {
    await ElMessageBox.confirm(message, t('common.warning'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    });
    if (runtime.source === 'managed') {
      await nodeStore.uninstallManagedNode(runtime.version);
    } else {
      nodeStore.removeNode(getNodeRuntimeId(runtime));
    }
    ElMessage.success(t('common.success'));
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return;
    ElMessage.error(error?.message || t('common.error'));
  }
}

function openStorageDialog(): void {
  const location = nodeStore.managedLocation;
  storageMode.value = location?.mode || settingsStore.settings.managedNodeRuntimeLocation?.mode || 'app-data';
  customStoragePath.value = location?.customPath || settingsStore.settings.managedNodeRuntimeLocation?.customPath || '';
  migrateExisting.value = true;
  showStorageDialog.value = true;
}

async function selectStorageFolder(): Promise<void> {
  const selected = await api.openDialog({ directory: true, multiple: false });
  if (selected && typeof selected === 'string') customStoragePath.value = selected;
}

async function saveStorageLocation(): Promise<void> {
  if (storageMode.value === 'custom' && !customStoragePath.value.trim()) {
    ElMessage.warning(t('nodes.customLocationRequired'));
    return;
  }
  if (storageMode.value === 'portable' && !portableAvailable.value) {
    ElMessage.error(t('nodes.portableUnavailable'));
    return;
  }

  const location = {
    mode: storageMode.value,
    customPath: storageMode.value === 'custom' ? customStoragePath.value.trim() : undefined,
  } as const;
  const runningRuntimePaths = managedRuntimes.value.filter(runtimeIsRunning).map(runtime => runtime.path);
  try {
    storageSaving.value = true;
    const result = await nodeStore.changeManagedRuntimeLocation(location, migrateExisting.value, runningRuntimePaths);
    settingsStore.settings.managedNodeRuntimeLocation = {
      mode: result.mode,
      customPath: result.customPath || undefined,
    };
    showStorageDialog.value = false;
    if (result.warnings?.length) {
      ElMessage.warning(result.warnings.join('\n'));
    } else {
      ElMessage.success(t('nodes.locationSaved'));
    }
  } catch (error: any) {
    ElMessage.error(error?.message || t('nodes.locationChangeFailed'));
  } finally {
    storageSaving.value = false;
  }
}

function handleRuntimeCommand(command: string, runtime: NodeVersion): void {
  if (command === 'validate') void validateRuntime(runtime);
  if (command === 'terminal') void openRuntimeTerminal(runtime);
  if (command === 'folder') openFolder(runtime.path);
  if (command === 'root') openFolder(runtime.runtimeRoot || runtime.path);
  if (command === 'copy-node') void copyPath(runtime.path);
  if (command === 'copy-root') void copyPath(runtime.runtimeRoot || runtime.path);
  if (command === 'usage') showUsage(runtime);
  if (command === 'remove') void removeRuntime(runtime);
}

onMounted(() => {
  void nodeStore.loadRuntimes();
});
</script>

<template>
  <div class="app-page">
    <div class="app-page-header">
      <div class="app-content-container app-page-header-main">
        <div class="app-page-heading">
          <h1 :class="isPlugin ? 'app-page-title !text-purple-500' : 'app-page-title'">{{ t('nodes.title') }}</h1>
          <p class="app-page-description">{{ t('nodes.description') }}</p>
        </div>
        <div class="app-page-actions flex flex-wrap justify-end gap-2">
          <el-button type="primary" size="small" :disabled="!nodeStore.managedSupported" @click="showInstallModal = true">
            <el-icon><div class="i-mdi-download" /></el-icon>{{ t('nodes.installNode') }}
          </el-button>
          <el-button type="success" size="small" @click="showAddModal = true">
            <el-icon><div class="i-mdi-plus" /></el-icon>{{ t('nodes.addNode') }}
          </el-button>
          <el-button size="small" @click="refresh">
            <el-icon><div class="i-mdi-refresh" /></el-icon>{{ t('common.refresh') }}
          </el-button>
        </div>
      </div>
    </div>

    <div class="app-page-content overflow-y-auto">
      <div class="app-content-container space-y-4 pb-6">
        <div v-if="!nodeStore.managedSupported" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {{ t('nodes.managedUnsupported') }}
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <section class="app-table-panel rounded-lg p-4">
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{{ t('nodes.defaultNode') }}</div>
                <div v-if="defaultRuntime" class="mt-1 flex items-center gap-2">
                  <span class="font-mono text-2xl font-semibold text-slate-800 dark:text-slate-100">{{ defaultRuntime.version }}</span>
                  <el-tag :type="sourceTone(defaultRuntime.source)" effect="plain" size="small">{{ sourceLabel(defaultRuntime.source) }}</el-tag>
                </div>
                <div v-else class="mt-2 text-base font-medium text-amber-600 dark:text-amber-300">
                  {{ defaultUnavailable ? t('nodes.defaultUnavailable') : t('nodes.noDefaultNode') }}
                </div>
              </div>
              <div :class="defaultRuntime ? 'i-mdi-check-circle text-emerald-500' : 'i-mdi-alert-circle text-amber-500'" class="text-2xl" />
            </div>
            <div v-if="defaultRuntime" class="truncate font-mono text-xs text-slate-500 dark:text-slate-400" :title="defaultRuntime.path">{{ defaultRuntime.path }}</div>
            <div v-else-if="nodeStore.appDefault?.path" class="truncate font-mono text-xs text-slate-400" :title="nodeStore.appDefault.path">{{ nodeStore.appDefault.path }}</div>
            <div class="mt-4 flex flex-wrap gap-2">
              <el-button v-if="defaultRuntime" size="small" @click="openRuntimeTerminal(defaultRuntime)">
                <el-icon><div class="i-mdi-console" /></el-icon>{{ t('nodes.openTerminal') }}
              </el-button>
              <el-button v-if="defaultRuntime" size="small" @click="validateRuntime(defaultRuntime)">
                <el-icon><div class="i-mdi-shield-check-outline" /></el-icon>{{ t('nodes.validate') }}
              </el-button>
              <el-button v-if="defaultRuntime" size="small" @click="openFolder(defaultRuntime.path)">
                <el-icon><div class="i-mdi-folder-open-outline" /></el-icon>{{ t('nodes.openDirectory') }}
              </el-button>
              <el-button v-if="defaultUnavailable" size="small" type="warning" plain @click="refresh">
                <el-icon><div class="i-mdi-refresh" /></el-icon>{{ t('nodes.recheck') }}
              </el-button>
            </div>
          </section>

          <section class="app-table-panel rounded-lg p-4">
            <div class="mb-3 flex items-start justify-between gap-3">
              <div>
                <div class="text-xs font-medium uppercase tracking-wide text-slate-400">{{ t('nodes.managedRuntime') }}</div>
                <div class="mt-2 flex items-center gap-2">
                  <el-tag effect="plain" type="success" size="small">{{ t(`nodes.locationMode.${nodeStore.managedLocation?.mode || 'app-data'}`) }}</el-tag>
                  <span class="text-sm text-slate-500 dark:text-slate-400">{{ t('nodes.installedCount', { count: managedRuntimes.length }) }}</span>
                </div>
              </div>
              <div class="i-mdi-database-cog-outline text-2xl text-emerald-500" />
            </div>
            <div class="truncate font-mono text-xs text-slate-500 dark:text-slate-400" :title="managedRoot">{{ managedRoot }}</div>
            <div class="mt-1 text-xs text-slate-400">{{ t('nodes.storageUsage', { size: nodeStore.managedLocation?.sizeBytes || 0 }) }}</div>
            <div class="mt-4 flex flex-wrap gap-2">
              <el-button size="small" @click="openStorageDialog">
                <el-icon><div class="i-mdi-swap-horizontal" /></el-icon>{{ t('nodes.changeLocation') }}
              </el-button>
              <el-button size="small" @click="openFolder(managedRoot)">
                <el-icon><div class="i-mdi-folder-open-outline" /></el-icon>{{ t('nodes.openDirectory') }}
              </el-button>
            </div>
          </section>
        </div>

        <section class="app-table-panel rounded-lg p-4">
          <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">{{ t('nodes.sourceOverview') }}</h2>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ t('nodes.sourceOverviewHint') }}</p>
            </div>
            <el-button size="small" @click="refresh">
              <el-icon><div class="i-mdi-refresh" /></el-icon>{{ t('nodes.rescanNvm') }}
            </el-button>
          </div>
          <div class="grid gap-3 sm:grid-cols-4">
            <div v-for="source in sourceOrder" :key="source" class="rounded-lg border border-slate-200/80 bg-white/30 px-3 py-3 dark:border-slate-700/70 dark:bg-slate-900/20">
              <div class="text-xs text-slate-500 dark:text-slate-400">{{ sourceLabel(source) }}</div>
              <div class="mt-1 text-xl font-semibold text-slate-800 dark:text-slate-100">{{ sourceCounts[source] }}</div>
            </div>
          </div>
          <div v-if="nvmRoots.length" class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span class="font-medium text-emerald-600 dark:text-emerald-300">{{ t('nodes.nvmDetected') }}</span>
            <span v-for="root in nvmRoots" :key="root" class="font-mono">{{ root }}</span>
            <span>{{ t('nodes.nvmVersionCount', { count: nvmRuntimes.length }) }}</span>
          </div>
          <div v-else class="mt-4 text-xs text-slate-400">{{ t('nodes.nvmNotDetected') }}</div>
        </section>

        <section class="app-table-panel rounded-lg p-0">
          <div class="flex items-center justify-between border-b border-slate-200/70 px-4 py-3 dark:border-slate-700/70">
            <div>
              <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">{{ t('nodes.allRuntimes') }}</h2>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ t('nodes.runtimeListHint') }}</p>
            </div>
            <span class="text-xs text-slate-400">{{ displayRuntimes.length }}</span>
          </div>
          <el-table :data="displayRuntimes" style="width: 100%" :row-style="{ background: 'transparent' }" class="custom-table">
            <el-table-column :label="t('nodes.version')" min-width="150">
              <template #default="{ row }">
                <div class="flex min-w-0 flex-col gap-1">
                  <div class="flex items-center gap-2">
                    <span class="font-mono font-semibold text-slate-800 dark:text-slate-100">{{ row.version }}</span>
                    <el-tag v-if="row.isDefault" type="success" effect="plain" size="small">{{ t('nodes.default') }}</el-tag>
                  </div>
                  <span v-if="progressText(row)" class="text-[11px] text-blue-500">{{ progressText(row) }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.source')" width="120">
              <template #default="{ row }">
                <el-tag :type="sourceTone(row.source)" effect="plain" size="small">{{ sourceLabel(row.source) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.status')" width="120">
              <template #default="{ row }">
                <span :class="row.status === 'available' ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300'" class="text-xs">{{ statusLabel(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.path')" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="min-w-0">
                  <div class="truncate font-mono text-xs text-slate-500 dark:text-slate-400" :title="row.path">{{ row.path || t('nodes.installing') }}</div>
                  <div v-if="row.runtimeRoot && row.runtimeRoot !== row.path" class="truncate text-[11px] text-slate-400" :title="row.runtimeRoot">{{ row.runtimeRoot }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.usage')" min-width="140">
              <template #default="{ row }">
                <el-button v-if="projectsUsingRuntime(row).length" text type="primary" size="small" @click="showUsage(row)">
                  {{ usageLabel(row) }}
                </el-button>
                <span v-else class="text-xs text-slate-400">{{ usageLabel(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.action')" width="240" fixed="right">
              <template #default="{ row }">
                <div class="flex items-center gap-1">
                  <el-button v-if="!row.isDefault && row.status === 'available'" text type="primary" size="small" @click="setDefault(row)">
                    {{ t('nodes.setDefault') }}
                  </el-button>
                  <el-tooltip :content="t('nodes.openTerminal')" placement="top">
                    <el-button text circle size="small" :disabled="row.status !== 'available'" @click="openRuntimeTerminal(row)">
                      <div class="i-mdi-console" />
                    </el-button>
                  </el-tooltip>
                  <el-dropdown trigger="click" @command="(command: string) => handleRuntimeCommand(command, row)">
                    <el-button text circle size="small"><div class="i-mdi-dots-vertical" /></el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="validate">{{ t('nodes.validate') }}</el-dropdown-item>
                        <el-dropdown-item command="folder">{{ t('nodes.openDirectory') }}</el-dropdown-item>
                        <el-dropdown-item v-if="row.source === 'nvm'" command="root">{{ t('nodes.openNvmDirectory') }}</el-dropdown-item>
                        <el-dropdown-item command="copy-node">{{ t('nodes.copyNodePath') }}</el-dropdown-item>
                        <el-dropdown-item command="copy-root">{{ t('nodes.copyRuntimePath') }}</el-dropdown-item>
                        <el-dropdown-item command="usage">{{ t('nodes.viewUsage') }}</el-dropdown-item>
                        <el-dropdown-item v-if="row.source === 'managed' || row.source === 'custom'" divided command="remove">
                          {{ row.source === 'managed' ? t('nodes.uninstall') : t('nodes.removeCustom') }}
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!displayRuntimes.length && !nodeStore.loading" class="px-4 py-12 text-center text-sm text-slate-400">{{ t('nodes.noNodes') }}</div>
        </section>
      </div>
    </div>

    <AddNodeModal v-model="showAddModal" />
    <InstallNodeModal v-model="showInstallModal" />

    <el-dialog v-model="showStorageDialog" :title="t('nodes.changeLocation')" width="560px" align-center destroy-on-close>
      <el-form label-position="top">
        <el-form-item :label="t('nodes.locationModeLabel')">
          <el-radio-group v-model="storageMode" class="flex flex-col items-start gap-2">
            <el-radio value="app-data">{{ t('nodes.locationMode.app-data') }}</el-radio>
            <el-radio value="custom">{{ t('nodes.locationMode.custom') }}</el-radio>
            <el-radio value="portable" :disabled="!portableAvailable">{{ t('nodes.locationMode.portable') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="storageMode === 'custom'" :label="t('nodes.customLocationLabel')">
          <el-input v-model="customStoragePath" :placeholder="t('nodes.customLocationPlaceholder')">
            <template #append><el-button @click="selectStorageFolder"><div class="i-mdi-folder" /></el-button></template>
          </el-input>
        </el-form-item>
        <div v-if="storageMode === 'portable' && !portableAvailable" class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{{ t('nodes.portableUnavailable') }}</div>
        <div v-if="managedRuntimes.length" class="mt-2 rounded-lg border border-slate-200/70 px-3 py-3 dark:border-slate-700/70">
          <div class="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">{{ t('nodes.existingManagedRuntimes', { count: managedRuntimes.length }) }}</div>
          <el-radio-group v-model="migrateExisting" class="flex flex-col items-start gap-2">
            <el-radio :value="true">{{ t('nodes.migrateExisting') }}</el-radio>
            <el-radio :value="false">{{ t('nodes.switchWithoutMigration') }}</el-radio>
          </el-radio-group>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="showStorageDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="storageSaving" @click="saveStorageLocation">{{ t('common.confirm') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showUsageDialog" :title="t('nodes.viewUsage')" width="480px" align-center>
      <div v-if="selectedUsageRuntime" class="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {{ selectedUsageRuntime.version }} · {{ sourceLabel(selectedUsageRuntime.source) }}
      </div>
      <div v-if="selectedUsageRuntime && projectsUsingRuntime(selectedUsageRuntime).length" class="space-y-2">
        <div v-for="project in projectsUsingRuntime(selectedUsageRuntime)" :key="project.id" class="flex items-center justify-between gap-3 rounded-lg border border-slate-200/70 px-3 py-2 dark:border-slate-700/70">
          <span class="truncate text-sm text-slate-700 dark:text-slate-200">{{ project.name }}</span>
          <el-tag v-if="projectIsRunning(project)" type="warning" effect="plain" size="small">{{ t('nodes.running') }}</el-tag>
        </div>
      </div>
      <div v-else class="py-8 text-center text-sm text-slate-400">{{ t('nodes.noProjectUsage') }}</div>
    </el-dialog>
  </div>
</template>

<style scoped>
:deep(.el-table) {
  --el-table-header-bg-color: transparent;
}

:deep(.el-table th.el-table__cell) {
  background-color: transparent !important;
}

:deep(.el-table__body tr:hover > td) {
  background-color: var(--app-primary-soft) !important;
}
</style>
