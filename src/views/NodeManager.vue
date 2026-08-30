<script setup lang="ts">
import { computed, ref } from 'vue';
import { useNodeStore } from '../stores/node';
import { useProjectStore } from '../stores/project';
import AddNodeModal from '../components/AddNodeModal.vue';
import InstallNodeModal from '../components/InstallNodeModal.vue';
import SetDefaultNodeModal from '../components/SetDefaultNodeModal.vue';
import { ElMessageBox, ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import type { NodeVersion } from '../types';
import { resolveProjectNodePath } from '../utils/nodeRuntime';

const { t } = useI18n();
const nodeStore = useNodeStore();
const projectStore = useProjectStore();
const showAddModal = ref(false);
const showInstallModal = ref(false);
const showSetDefaultModal = ref(false);
const target = import.meta.env.VITE_TARGET;
const isPlugin = target === 'utools' || target === 'ztools';

function openFolder(path: string) {
    api.openFolder(path).catch(err => {
        ElMessage.error(t('common.error') + ': ' + err);
    });
}

async function refresh() {
    await nodeStore.loadRuntimes();
    ElMessage.success(t('common.success'));
}

function sourceLabel(source: string) {
    if (source === 'managed') return t('nodes.sourceManaged');
    if (source === 'system') return t('nodes.sourceSystem');
    return t('nodes.sourceCustom');
}

function statusLabel(row: NodeVersion) {
    if (row.isDefault) return t('nodes.default');
    if (nodeStore.installProgress[row.version]) return t('nodes.installing');
    if (row.status === 'broken') return t('nodes.broken');
    return t('nodes.available');
}

function progressText(row: NodeVersion) {
    const progress = nodeStore.installProgress[row.version];
    if (!progress) return '';
    if (progress.phase === 'downloading' && typeof progress.percent === 'number') {
        return `${t('nodes.phaseDownloading')} ${progress.percent}%`;
    }
    const phaseKey = {
        resolving: 'nodes.phaseResolving',
        verifying: 'nodes.phaseVerifying',
        extracting: 'nodes.phaseExtracting',
        validating: 'nodes.phaseValidating',
        complete: 'nodes.phaseComplete',
    }[progress.phase];
    return phaseKey ? t(phaseKey) : progress.phase;
}

async function handleSetDefault(row: NodeVersion) {
    try {
        await nodeStore.setAppDefaultNode(row);
        ElMessage.success(t('common.success'));
    } catch (error: any) {
        ElMessage.error(error?.message || t('common.error'));
    }
}

function referencingProjects(version: string, path: string) {
    return projectStore.projects.filter(project => {
        if (project.type !== 'node') return false;
        if (project.nodeVersion === version) return true;
        return resolveProjectNodePath(project, nodeStore.versions, nodeStore.appDefault) === path;
    });
}

function runtimeInUse(path: string) {
    return projectStore.projects.some(project => {
        if (project.type !== 'node') return false;
        const nodePath = resolveProjectNodePath(project, nodeStore.versions, nodeStore.appDefault);
        if (nodePath !== path) return false;
        return Object.entries(projectStore.runningStatus).some(([key, running]) => running && key.startsWith(`${project.id}:`));
    });
}

async function handleRemove(row: NodeVersion) {
    if (row.source === 'system') return;

    if (row.source === 'managed' && runtimeInUse(row.path)) {
        ElMessage.warning(t('nodes.uninstallRunning'));
        return;
    }

    const refs = referencingProjects(row.version, row.path);
    const isDefault = !!row.isDefault;
    const extra: string[] = [];
    if (isDefault) extra.push(t('nodes.uninstallDefaultHint'));
    if (refs.length) extra.push(t('nodes.uninstallReferenced', { count: refs.length }));

    const message = row.source === 'managed'
        ? `${t('nodes.uninstallConfirm', { version: row.version })}${extra.length ? `\n${extra.join('\n')}` : ''}`
        : t('nodes.removeCustomConfirm');

    try {
        await ElMessageBox.confirm(message, t('common.warning'), {
            confirmButtonText: t('common.confirm'),
            cancelButtonText: t('common.cancel'),
            type: 'warning',
        });
        if (row.source === 'managed') {
            await nodeStore.uninstallManagedNode(row.version);
        } else {
            nodeStore.removeNode(row.path);
        }
        ElMessage.success(t('common.success'));
    } catch (error: any) {
        if (error === 'cancel' || error === 'close') return;
        ElMessage.error(error?.message || t('common.error'));
    }
}

const canInstallManaged = computed(() => nodeStore.managedSupported);

const displayVersions = computed(() => {
    const list = [...nodeStore.versions];
    for (const progress of Object.values(nodeStore.installProgress)) {
        if (!list.some(row => row.version === progress.version)) {
            list.push({
                version: progress.version,
                path: '',
                source: 'managed',
                status: 'installing',
            });
        }
    }
    return list;
});
</script>

<template>
    <div class="app-page">
        <div class="app-page-header">
          <div class="app-content-container app-page-header-main">
            <div class="app-page-heading">
            <h1
                :class="isPlugin 
                    ? 'app-page-title !text-purple-500'
                    : 'app-page-title'">
                {{ t('nodes.title') }}</h1>
                <p class="app-page-description">{{ t('nodes.description') }}</p>
            </div>
            <div class="app-page-actions grid !grid-cols-2 w-fit">
                <el-button type="primary" @click="showInstallModal = true" class="!rounded-lg !ml-0" size="small" :disabled="!canInstallManaged">
                    <el-icon class="mr-1">
                        <div class="i-mdi-download" />
                    </el-icon> {{ t('nodes.installNode') }}
                </el-button>
                <el-button type="success" @click="showAddModal = true" class="!rounded-lg !ml-0" size="small">
                    <el-icon class="mr-1">
                        <div class="i-mdi-plus" />
                    </el-icon> {{ t('nodes.addNode') }}
                </el-button>
                <el-button type="warning" @click="showSetDefaultModal = true" class="!rounded-lg !ml-0" size="small">
                    <el-icon class="mr-1">
                        <div class="i-mdi-cog" />
                    </el-icon> {{ t('nodes.setDefaultNode') }}
                </el-button>
                <el-button type="info" @click="refresh" class="!rounded-lg !ml-0" size="small">
                    <el-icon class="mr-1">
                        <div class="i-mdi-refresh" />
                    </el-icon> {{ t('common.refresh') }}
                </el-button>
            </div>
          </div>
        </div>

        <div class="app-page-content">
        <div class="app-content-container h-full"><div class="app-table-panel h-full">
            <div v-if="!canInstallManaged" class="px-4 py-2 text-xs text-amber-600 dark:text-amber-300">
                {{ t('nodes.managedUnsupported') }}
            </div>
            <el-table :data="displayVersions" style="width: 100%" height="100%"
                :row-style="{ background: 'transparent' }" class="custom-table">
                <el-table-column prop="version" :label="t('nodes.version')">
                    <template #default="{ row }">
                        <span class="font-semibold text-sm font-mono text-slate-800 dark:text-slate-200">{{ row.version
                        }}</span>
                    </template>
                </el-table-column>
                <el-table-column prop="source" :label="t('nodes.source')">
                    <template #default="{ row }">
                        <div class="flex items-center gap-2">
                            <el-tag v-if="row.source === 'system'" type="info" effect="light"
                                class="!border-slate-300 dark:!bg-slate-700/50 dark:!border-slate-600 dark:text-white">{{ sourceLabel(row.source) }}</el-tag>
                            <el-tag v-else-if="row.source === 'managed'" effect="light"
                                class="!text-emerald-600 !border-emerald-300 dark:!bg-emerald-500/20 dark:!text-emerald-300 dark:!border-emerald-500/30">{{ sourceLabel(row.source) }}</el-tag>
                            <el-tag v-else effect="light"
                                class="!text-amber-600 !border-amber-300 dark:!bg-amber-500/20 dark:!text-amber-300 dark:!border-amber-500/30">{{ sourceLabel(row.source) }}</el-tag>
                            <el-tag v-if="row.isDefault" type="success" effect="light">{{ t('nodes.default') }}</el-tag>
                            <el-tag v-else-if="nodeStore.installProgress[row.version]" type="warning" effect="light">{{ t('nodes.installing') }}</el-tag>
                            <el-tag v-else-if="row.status === 'broken'" type="danger" effect="light">{{ t('nodes.broken') }}</el-tag>
                            <el-tag v-else type="info" effect="plain">{{ statusLabel(row) }}</el-tag>
                        </div>
                    </template>
                </el-table-column>
                <el-table-column prop="path" :label="t('nodes.path')" show-overflow-tooltip>
                    <template #default="{ row }">
                        <div class="flex items-center gap-2 group cursor-pointer" @click="openFolder(row.path)">
                            <span
                                class="text-slate-500 dark:text-slate-400 font-mono text-xs group-hover:text-blue-500 transition-colors">{{
                                    row.path }}</span>
                            <div
                                class="i-mdi-folder-open-outline text-xs opacity-0 group-hover:opacity-100 text-blue-500 transition-opacity" />
                        </div>
                        <div v-if="progressText(row)" class="text-[11px] text-blue-500 mt-1">{{ progressText(row) }}</div>
                    </template>
                </el-table-column>
                <el-table-column :label="t('nodes.action')" width="220" align="center">
                    <template #default="{ row }">
                        <div class="flex items-center justify-center gap-2">
                            <el-button type="primary" size="small"
                                plain @click="handleSetDefault(row)" class="!rounded-md">{{ t('nodes.setDefault') }}</el-button>
                            <el-button v-if="row.source === 'custom' || row.source === 'managed'" type="danger" size="small"
                                plain @click="handleRemove(row)" class="!rounded-md">{{
                                    row.source === 'managed' ? t('nodes.uninstall') : t('common.delete') }}</el-button>
                        </div>
                    </template>
                </el-table-column>
            </el-table>
        </div></div>
        </div>

        <AddNodeModal v-model="showAddModal" />
        <InstallNodeModal v-model="showInstallModal" />
        <SetDefaultNodeModal v-model="showSetDefaultModal" />
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
