<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import type { ManagedRuntimeLocationMode, NodeVersion, Project } from '../types';
import { useNodeStore } from '../stores/node';
import { useProjectStore } from '../stores/project';
import { useSettingsStore } from '../stores/settings';
import { getNodeRuntimeId, resolveAppDefaultRuntime } from '../utils/nodeRuntime';
import { groupNodeRuntimesByVersion, type NodeRuntimeGroup } from '../utils/nodeRuntimeGrouping';
import { getProjectsUsingRuntime, type ProjectRuntimeUsage, type RuntimeUsageReason } from '../utils/nodeRuntimeUsage';
import AddNodeModal from '../components/AddNodeModal.vue';
import InstallNodeModal from '../components/InstallNodeModal.vue';

const { t } = useI18n();
const emit = defineEmits<{
  navigateProject: [projectId: string];
}>();
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
const selectedUsageGroup = ref<NodeRuntimeGroup | null>(null);
const usageSearchQuery = ref('');
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
const managedRoot = computed(() => nodeStore.managedLocation?.rootPath || '');
const managedRootLabel = computed(() => managedRoot.value || t('nodes.locationUnknown'));
const portableAvailable = computed(() => nodeStore.managedLocation?.portableAvailable === true);
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

const runtimeGroups = computed<NodeRuntimeGroup[]>(() => groupNodeRuntimesByVersion(displayRuntimes.value));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

const managedStorageText = computed(() => {
  if (nodeStore.managedLocationLoading || !nodeStore.managedLocation) return t('nodes.storageCalculating');
  if (nodeStore.managedLocation.sizeStatus === 'error') return t('nodes.storageUnavailable');
  return t('nodes.storageUsage', { size: formatBytes(nodeStore.managedLocation.sizeBytes) });
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

function runtimeIsAvailable(runtime: NodeVersion): boolean {
  return !nodeStore.installProgress[runtime.version]
    && (runtime.status === undefined || runtime.status === 'available');
}

function groupStatusLabel(group: NodeRuntimeGroup): string {
  const installing = group.runtimes.some(runtime => runtime.status === 'installing' || nodeStore.installProgress[runtime.version]);
  if (installing) return t('nodes.installing');
  const available = group.runtimes.filter(runtimeIsAvailable).length;
  if (available === group.runtimes.length) return t('nodes.available');
  if (available > 0) return t('nodes.runtimeGroupPartial', { available, total: group.runtimes.length });
  return t('nodes.broken');
}

function groupStatusTone(group: NodeRuntimeGroup): string {
  if (group.runtimes.some(runtime => runtime.status === 'installing' || nodeStore.installProgress[runtime.version])) return 'text-blue-500';
  return group.runtimes.some(runtimeIsAvailable)
    ? 'text-emerald-600 dark:text-emerald-300'
    : 'text-amber-600 dark:text-amber-300';
}

function groupProgressText(group: NodeRuntimeGroup): string {
  const runtime = group.runtimes.find(item => nodeStore.installProgress[item.version]);
  return runtime ? progressText(runtime) : '';
}

function primaryRuntime(group: NodeRuntimeGroup): NodeVersion {
  return group.runtimes[0];
}

function groupHasDefault(group: NodeRuntimeGroup): boolean {
  return group.runtimes.some(runtime => runtime.isDefault);
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

function runtimeUsages(runtime: NodeVersion): ProjectRuntimeUsage[] {
  return getProjectsUsingRuntime(projectStore.projects, runtime, nodeStore.versions, nodeStore.appDefault);
}

function projectsUsingRuntime(runtime: NodeVersion): Project[] {
  return runtimeUsages(runtime).map(usage => usage.project);
}

function runtimeIsRunning(runtime: NodeVersion): boolean {
  return projectsUsingRuntime(runtime).some(projectIsRunning);
}

function groupProjectsUsingRuntime(group: NodeRuntimeGroup): Project[] {
  return groupUsageEntries(group).map(usage => usage.project);
}

function groupUsageEntries(group: NodeRuntimeGroup): ProjectRuntimeUsage[] {
  const usages = new Map<string, ProjectRuntimeUsage>();
  for (const runtime of group.runtimes) {
    for (const usage of runtimeUsages(runtime)) {
      if (!usages.has(usage.project.id)) usages.set(usage.project.id, usage);
    }
  }
  return [...usages.values()];
}

function groupUsageLabel(group: NodeRuntimeGroup): string {
  const projects = groupProjectsUsingRuntime(group);
  if (!projects.length) return t('nodes.noProjectUsage');
  const running = projects.filter(projectIsRunning).length;
  return running ? t('nodes.projectUsageRunning', { count: projects.length, running }) : t('nodes.projectUsage', { count: projects.length });
}

function openFolder(path: string): void {
  if (!path) return;
  api.openFolder(path).catch(error => ElMessage.error(`${t('common.error')}: ${error}`));
}

function openManagedRuntimeRoot(): void {
  nodeStore.openManagedRuntimeRoot().catch(error => {
    ElMessage.error(`${t('common.error')}: ${error}`);
  });
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

function showUsage(runtime: NodeVersion, group: NodeRuntimeGroup | null = null): void {
  selectedUsageRuntime.value = runtime;
  selectedUsageGroup.value = group;
  usageSearchQuery.value = '';
  showUsageDialog.value = true;
}

function showGroupUsage(group: NodeRuntimeGroup): void {
  showUsage(primaryRuntime(group), group);
}

const selectedUsageEntries = computed<ProjectRuntimeUsage[]>(() => {
  const usages = selectedUsageGroup.value
    ? groupUsageEntries(selectedUsageGroup.value)
    : selectedUsageRuntime.value
      ? runtimeUsages(selectedUsageRuntime.value)
      : [];
  const query = usageSearchQuery.value.trim().toLowerCase();
  return usages.filter(({ project }) => {
    if (!query) return true;
    return `${project.name} ${project.path}`.toLowerCase().includes(query);
  });
});

function usageReasonLabel(reason: RuntimeUsageReason, project: Project): string {
  if (reason === 'runtime-id') return t('nodes.usageReasonRuntime');
  if (reason === 'version') return t('nodes.usageReasonVersion', { version: project.nodeVersion || '' });
  return t('nodes.usageReasonDefault');
}

function openUsageProject(project: Project): void {
  showUsageDialog.value = false;
  emit('navigateProject', project.id);
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

function handleRuntimeCommand(command: string, runtime: NodeVersion, group: NodeRuntimeGroup | null = null): void {
  if (command === 'validate') void validateRuntime(runtime);
  if (command === 'terminal') void openRuntimeTerminal(runtime);
  if (command === 'folder') openFolder(runtime.path);
  if (command === 'root') openFolder(runtime.runtimeRoot || runtime.path);
  if (command === 'copy-node') void copyPath(runtime.path);
  if (command === 'copy-root') void copyPath(runtime.runtimeRoot || runtime.path);
  if (command === 'usage') showUsage(runtime, group);
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
            <div class="truncate font-mono text-xs text-slate-500 dark:text-slate-400" :title="managedRootLabel">{{ managedRootLabel }}</div>
            <div class="mt-1 flex items-center gap-1 text-xs text-slate-400">
              <el-icon v-if="nodeStore.managedLocationLoading"><div class="i-mdi-loading animate-spin" /></el-icon>
              <span>{{ managedStorageText }}</span>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <el-button size="small" @click="openStorageDialog">
                <el-icon><div class="i-mdi-swap-horizontal" /></el-icon>{{ t('nodes.changeLocation') }}
              </el-button>
              <el-button size="small" :disabled="!managedRoot" @click="openManagedRuntimeRoot">
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
            <span class="text-xs text-slate-400">{{ runtimeGroups.length }}</span>
          </div>
          <el-table :data="runtimeGroups" row-key="key" style="width: 100%" :row-style="{ background: 'transparent' }" class="custom-table">
            <el-table-column :label="t('nodes.version')" min-width="150">
              <template #default="{ row }">
                <div class="flex min-w-0 flex-col gap-1">
                  <div class="flex items-center gap-2">
                    <span class="font-mono font-semibold text-slate-800 dark:text-slate-100">{{ row.version }}</span>
                    <el-tag v-if="groupHasDefault(row)" type="success" effect="plain" size="small">{{ t('nodes.default') }}</el-tag>
                  </div>
                  <span v-if="groupProgressText(row)" class="text-[11px] text-blue-500">{{ groupProgressText(row) }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.source')" min-width="190">
              <template #default="{ row }">
                <el-tag :type="sourceTone(primaryRuntime(row).source)" effect="plain" size="small">{{ sourceLabel(primaryRuntime(row).source) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.status')" width="130">
              <template #default="{ row }">
                <span :class="groupStatusTone(row)" class="text-xs">{{ groupStatusLabel(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.path')" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="truncate font-mono text-xs text-slate-500 dark:text-slate-400" :title="primaryRuntime(row).path">{{ primaryRuntime(row).path || t('nodes.installing') }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.usage')" min-width="150">
              <template #default="{ row }">
                <span :class="groupProjectsUsingRuntime(row).length ? 'text-slate-600 dark:text-slate-300' : 'text-slate-400'" class="text-xs">{{ groupUsageLabel(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="t('nodes.actions')" width="190" fixed="right" align="right">
              <template #default="{ row }">
                <div class="flex items-center justify-end gap-1">
                  <el-tooltip v-if="groupProjectsUsingRuntime(row).length" :content="t('nodes.viewUsage')" placement="top">
                    <el-button text circle size="small" @click="showGroupUsage(row)">
                      <div class="i-mdi-account-multiple-outline" />
                    </el-button>
                  </el-tooltip>
                  <el-button v-if="!groupHasDefault(row) && runtimeIsAvailable(primaryRuntime(row))" text type="primary" size="small" @click="setDefault(primaryRuntime(row))">
                    {{ t('nodes.setDefault') }}
                  </el-button>
                  <el-tooltip :content="t('nodes.openTerminal')" placement="top">
                    <el-button text circle size="small" :disabled="!runtimeIsAvailable(primaryRuntime(row))" @click="openRuntimeTerminal(primaryRuntime(row))">
                      <div class="i-mdi-console" />
                    </el-button>
                  </el-tooltip>
                  <el-dropdown trigger="click" @command="(command: string) => handleRuntimeCommand(command, primaryRuntime(row), row)">
                    <el-button text circle size="small" :title="t('nodes.actions')"><div class="i-mdi-dots-vertical" /></el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="validate">{{ t('nodes.validate') }}</el-dropdown-item>
                        <el-dropdown-item command="folder">{{ t('nodes.openDirectory') }}</el-dropdown-item>
                        <el-dropdown-item v-if="primaryRuntime(row).source === 'nvm'" command="root">{{ t('nodes.openNvmDirectory') }}</el-dropdown-item>
                        <el-dropdown-item command="copy-node">{{ t('nodes.copyNodePath') }}</el-dropdown-item>
                        <el-dropdown-item command="copy-root">{{ t('nodes.copyRuntimePath') }}</el-dropdown-item>
                        <el-dropdown-item command="usage">{{ t('nodes.viewUsage') }}</el-dropdown-item>
                        <el-dropdown-item v-if="primaryRuntime(row).source === 'managed' || primaryRuntime(row).source === 'custom'" divided command="remove">
                          {{ primaryRuntime(row).source === 'managed' ? t('nodes.uninstall') : t('nodes.removeCustom') }}
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!runtimeGroups.length && !nodeStore.loading" class="px-4 py-12 text-center text-sm text-slate-400">{{ t('nodes.noNodes') }}</div>
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

    <el-dialog v-model="showUsageDialog" :title="t('nodes.viewUsage')" width="420px" align-center class="runtime-usage-dialog">
      <div v-if="selectedUsageRuntime" class="mb-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-mono text-base font-semibold text-slate-800 dark:text-slate-100">{{ selectedUsageRuntime.version }}</span>
            <el-tag :type="sourceTone(selectedUsageRuntime.source)" effect="plain" size="small">{{ sourceLabel(selectedUsageRuntime.source) }}</el-tag>
          </div>
          <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('nodes.usageSummary', { count: selectedUsageEntries.length }) }}
          </div>
        </div>
        <div class="i-mdi-account-multiple-outline shrink-0 text-xl text-slate-400" />
      </div>
      <el-input v-model="usageSearchQuery" clearable :placeholder="t('nodes.usageSearchPlaceholder')" class="mb-3">
        <template #prefix><el-icon><div class="i-mdi-magnify" /></el-icon></template>
      </el-input>
      <div v-if="selectedUsageEntries.length" class="runtime-usage-list">
        <button v-for="usage in selectedUsageEntries" :key="usage.project.id" type="button" class="runtime-usage-item" @click="openUsageProject(usage.project)">
          <span class="min-w-0 flex-1 text-left">
            <span class="block truncate text-sm font-medium text-slate-700 dark:text-slate-200">{{ usage.project.name }}</span>
            <span class="mt-0.5 block truncate font-mono text-[11px] text-slate-400" :title="usage.project.path">{{ usage.project.path }}</span>
            <span class="mt-1 block truncate text-[11px] text-slate-500 dark:text-slate-400">{{ usageReasonLabel(usage.reason, usage.project) }}</span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <el-tag v-if="projectIsRunning(usage.project)" type="warning" effect="plain" size="small">{{ t('nodes.running') }}</el-tag>
            <span class="i-mdi-chevron-right text-base text-slate-400" />
          </span>
        </button>
      </div>
      <div v-else class="py-8 text-center text-sm text-slate-400">
        {{ usageSearchQuery ? t('nodes.usageNoMatch') : t('nodes.noProjectUsage') }}
      </div>
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

.runtime-usage-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  max-height: max(72px, calc(70vh - 132px));
  min-height: 0;
  overflow-y: auto;
  padding: 1px 4px 4px 1px;
}

.runtime-usage-item {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 82px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  padding: 10px;
  background: transparent;
  text-align: left;
  transition: background-color var(--app-duration-fast) var(--app-ease);
}

.runtime-usage-item:hover {
  background: var(--app-primary-soft);
}

:deep(.runtime-usage-dialog .el-dialog__body) {
  max-height: 70vh;
  overflow: hidden;
}

:deep(.runtime-usage-dialog) {
  max-width: calc(100vw - 24px);
}

@media (max-width: 520px) {
  .runtime-usage-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
