<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useProjectStore } from '../stores/project';
import { useGitStore } from '../stores/git';
import ProjectListItem from '../components/ProjectListItem.vue';
import ConsoleView from '../components/ConsoleView.vue';
import GitView from '../components/git/GitView.vue';
import AddProjectModal from '../components/AddProjectModal.vue';
import type { Project } from '../types';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { ElMessage } from 'element-plus';
import { normalizeNvmVersion, findInstalledNodeVersion } from '../utils/nvm';
import { pinyin } from 'pinyin-pro';

const { t } = useI18n();
const projectStore = useProjectStore();
const gitStore = useGitStore();
const showModal = ref(false);
const editingProject = ref<Project | null>(null);
const refreshing = ref(false);

// Right panel tab: 'console' or 'git'
const rightTab = ref<'console' | 'git'>('console');

const activeProject = computed(() =>
  projectStore.projects.find(p => p.id === projectStore.activeProjectId)
);

const isGitRepo = computed(() => {
  if (!activeProject.value) return false;
  return gitStore.isGitRepo[activeProject.value.id] || false;
});

const gitChangesCount = computed(() => {
  if (!activeProject.value) return 0;
  return gitStore.getTotalChanges(activeProject.value.id);
});

// Auto-check git repo when project changes
watch(activeProject, async (newProject) => {
  if (newProject) {
    await gitStore.checkGitRepo(newProject.id, newProject.path);
  }
}, { immediate: true });

//************* 搜索功能 *************
const searchQuery = ref('');

function buildPinyinSearchText(text: string): string {
    if (!text) return '';
    const syllables = pinyin(text, { toneType: 'none', type: 'array' }) as string[];
    const full = syllables.join('');
    const initials = syllables.map(s => s[0] || '').join('');
    return `${full} ${initials}`.toLowerCase();
}

const filteredProjects = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    const compactQuery = query.replace(/\s+/g, '');
  if (!query) {
    return projectStore.projects;
  }
    return projectStore.projects.filter(project => {
        const name = project.name.toLowerCase();
        const projectPath = project.path.toLowerCase();

        if (name.includes(query) || projectPath.includes(query)) {
            return true;
        }

        const namePinyin = buildPinyinSearchText(project.name);
        const pathPinyin = buildPinyinSearchText(project.path);

        return namePinyin.includes(compactQuery) || pathPinyin.includes(compactQuery);
    });
});

function handleAdd(project: Project) {
  projectStore.addProject(project);
}

function handleUpdate(project: Project) {
  projectStore.updateProject(project);
  editingProject.value = null;
}

function openAddModal() {
    editingProject.value = null;
    showModal.value = true;
}

function openEditModal(project: Project) {
    editingProject.value = project;
    showModal.value = true;
}

async function refreshProjects() {
    refreshing.value = true;
    try {
        await projectStore.refreshAll();
    } finally {
        refreshing.value = false;
    }
}

async function batchAddProjects() {
    try {
        const selected = await api.openDialog({
            directory: true,
            multiple: true,
        });
        
        if (!selected) return;
        
        const paths = Array.isArray(selected) ? selected : [selected];
        if (paths.length === 0) return;
        
        let addedCount = 0;
        let skipCount = 0;
        let failCount = 0;
        let hasInvalidNvmrc = false;
        
        const pathsToScan: string[] = [];
        const processedInstallVersions = new Set<string>();
        let currentNodeVersions: string[] = [];

        try {
            const nvmList = await api.getNvmList();
            currentNodeVersions = nvmList.map(v => v.version);
        } catch (e) {
            console.error('Failed to load node versions before batch add', e);
        }
        
        // First pass: determine which paths to scan
        for (const path of paths) {
            try {
                // Try to scan the selected path directly
                await api.scanProject(path);
                pathsToScan.push(path);
            } catch (e) {
                // If it fails, it might be a parent directory. Let's check its subdirectories.
                try {
                    const entries = await api.readDir(path);
                    for (const entry of entries) {
                        if (entry.isDirectory) {
                            const subPath = `${path}/${entry.name}`.replace(/\\/g, '/');
                            try {
                                await api.scanProject(subPath);
                                pathsToScan.push(subPath);
                            } catch (subE) {
                                // Not a project, ignore
                            }
                        }
                    }
                } catch (dirE) {
                    console.error(`Failed to read directory ${path}`, dirE);
                    failCount++;
                }
            }
        }
        
        // Second pass: add the valid projects
        for (const path of pathsToScan) {
            // Check if already exists
            if (projectStore.projects.some(p => p.path === path)) {
                skipCount++;
                continue;
            }
            
            try {
                const info = await api.scanProject(path);
                let nodeVersion = 'Default';

                const normalizedNvmVersion = normalizeNvmVersion(info.nvmVersion);
                if (normalizedNvmVersion) {
                    let installed = findInstalledNodeVersion(currentNodeVersions, normalizedNvmVersion);

                    if (!installed && !processedInstallVersions.has(normalizedNvmVersion)) {
                        processedInstallVersions.add(normalizedNvmVersion);
                        try {
                            ElMessage.info(t('project.autoInstallStart', { version: normalizedNvmVersion }));
                            await api.installNode(normalizedNvmVersion);
                            ElMessage.success(t('project.autoInstallSuccess', { version: normalizedNvmVersion }));

                            const latestList = await api.getNvmList();
                            currentNodeVersions = latestList.map(v => v.version);
                            installed = findInstalledNodeVersion(currentNodeVersions, normalizedNvmVersion);
                        } catch (installErr) {
                            ElMessage.error(`${t('project.autoInstallFailed', { version: normalizedNvmVersion })}: ${String(installErr)}`);
                            console.error('Failed to auto-install node version in batch add', installErr);
                        }
                    }

                    if (!installed) {
                        installed = findInstalledNodeVersion(currentNodeVersions, normalizedNvmVersion);
                    }

                    if (installed) {
                        nodeVersion = installed;
                    }
                } else if (info.nvmVersion) {
                    hasInvalidNvmrc = true;
                    console.warn('Invalid .nvmrc version in batch add, skipping auto install', info.nvmVersion);
                }

                const project: Project = {
                    id: crypto.randomUUID(),
                    name: info.name || path.split(/[/\\]/).pop() || 'Unknown',
                    path: path,
                    type: 'node',
                    nodeVersion,
                    packageManager: info.packageManager || 'npm',
                    scripts: info.scripts
                };
                projectStore.addProject(project);
                addedCount++;
            } catch (e) {
                console.error(`Failed to scan project at ${path}`, e);
                failCount++;
            }
        }
        
        if (addedCount > 0) {
            ElMessage.success(t('dashboard.batchAddSuccess', { count: addedCount }));
        }
        if (skipCount > 0) {
            ElMessage.info(t('dashboard.batchAddSkip', { count: skipCount }));
        }
        if (failCount > 0 && addedCount === 0) {
            ElMessage.warning(t('dashboard.batchAddFail', { count: failCount }));
        }
        if (hasInvalidNvmrc) {
            ElMessage.warning(t('project.invalidNvmrc'));
        }
    } catch (err) {
        console.error('Failed to batch add projects:', err);
        ElMessage.error(t('common.error'));
    }
}
</script>

<template>
  <div class="h-full flex overflow-hidden">
    <!-- Project List Sidebar -->
    <div class="w-72 flex flex-col border-r border-slate-200 dark:border-slate-700/30 bg-white/95 dark:bg-[#0f172a]/95 backdrop-blur-xl z-20 shadow-2xl transition-colors duration-300">
        <div class="p-4 border-b border-slate-200 dark:border-slate-700/30 flex justify-between items-center bg-white/50 dark:bg-[#0f172a]/50">
            <h2 class="text-base font-bold text-slate-800 dark:text-slate-100 tracking-wide uppercase text-xs opacity-80 pl-2">{{ t('dashboard.title') }}</h2>
            <div class="flex gap-2">
                <button @click="refreshProjects" :disabled="refreshing" class="p-1.5 rounded-md bg-slate-500/10 text-slate-600 dark:text-slate-400 hover:bg-slate-500 hover:text-white transition-all border border-slate-500/20 group cursor-pointer disabled:opacity-50" :title="t('common.refresh') || 'Refresh'">
                    <div class="i-mdi-refresh text-lg transition-transform duration-700" :class="{ 'animate-spin': refreshing }" />
                </button>
                <button @click="batchAddProjects" class="p-1.5 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500 hover:text-white transition-all border border-green-500/20 group cursor-pointer" :title="t('dashboard.batchAddProject')">
                    <div class="i-mdi-folder-multiple-plus text-lg group-hover:scale-110 transition-transform" />
                </button>
                <button @click="openAddModal" class="p-1.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500 hover:text-white transition-all border border-blue-500/20 group cursor-pointer" :title="t('dashboard.addProject')">
                    <div class="i-mdi-plus text-lg group-hover:scale-110 transition-transform" />
                </button>
            </div>
        </div>
        
        <!-- 搜索框 -->
        <div class="px-3 py-2 border-b border-slate-200 dark:border-slate-700/30">
            <el-input
                v-model="searchQuery"
                :placeholder="t('dashboard.searchPlaceholder')"
                clearable
                class="w-full"
            >
                <template #prefix>
                    <el-icon><div class="i-mdi-magnify" /></el-icon>
                </template>
            </el-input>
        </div>
        
        <div class="flex-1 overflow-y-auto p-3 custom-scrollbar space-y-2">
             <ProjectListItem 
                v-for="project in filteredProjects" 
                :key="project.id" 
                :project="project" 
                @edit="openEditModal(project)"
             />
             
             <div v-if="filteredProjects.length === 0 && projectStore.projects.length > 0" class="text-center mt-10 text-slate-400 dark:text-slate-500">
                <div class="i-mdi-magnify text-4xl mb-3 opacity-20 mx-auto" />
                <p class="text-sm font-medium">{{ t('common.search') }}</p>
                <p class="text-xs opacity-50 mt-1">{{ t('dashboard.searchPlaceholder') }}</p>
             </div>
             
             <div v-else-if="projectStore.projects.length === 0" class="text-center mt-20 text-slate-400 dark:text-slate-500">
                <div class="i-mdi-folder-open-outline text-5xl mb-3 opacity-20 mx-auto" />
                <p class="text-sm font-medium">{{ t('dashboard.noProjects') }}</p>
                <p class="text-xs opacity-50 mt-1">{{ t('dashboard.addProject') }}</p>
             </div>
        </div>
    </div>

    <!-- Main Right Panel with Tabs -->
    <div class="flex-1 overflow-hidden relative bg-slate-50 dark:bg-[#0b1120] shadow-inner transition-colors duration-300 flex flex-col">
        <!-- Tab Bar -->
        <div class="flex items-center border-b border-slate-200 dark:border-slate-700/30 bg-white/80 dark:bg-[#0f172a]/80 backdrop-blur-sm px-2 shrink-0">
            <button
                @click="rightTab = 'console'"
                class="px-4 py-2 text-sm font-medium transition-all relative cursor-pointer"
                :class="rightTab === 'console'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'"
            >
                <div class="flex items-center gap-1.5">
                    <div class="i-mdi-console text-base" />
                    <span>{{ t('dashboard.console') }}</span>
                </div>
                <div v-if="rightTab === 'console'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-t" />
            </button>
            <button
                @click="rightTab = 'git'"
                class="px-4 py-2 text-sm font-medium transition-all relative cursor-pointer"
                :class="rightTab === 'git'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'"
            >
                <div class="flex items-center gap-1.5">
                    <div class="i-mdi-git text-base" />
                    <span>{{ t('git.title') }}</span>
                    <span v-if="isGitRepo && gitChangesCount > 0" class="ml-1 px-1.5 py-0 text-xs rounded-full bg-orange-500/15 text-orange-600 dark:text-orange-400 font-medium min-w-5 text-center">{{ gitChangesCount }}</span>
                </div>
                <div v-if="rightTab === 'git'" class="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-t" />
            </button>
        </div>

        <!-- Tab Content -->
        <div class="flex-1 overflow-hidden relative">
            <ConsoleView v-show="rightTab === 'console'" />
            <GitView v-show="rightTab === 'git'" />
        </div>
    </div>

    <AddProjectModal 
        v-model="showModal" 
        :edit-project="editingProject"
        @add="handleAdd" 
        @update="handleUpdate"
    />
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 2px;
}
.dark .custom-scrollbar::-webkit-scrollbar-thumb {
  background: #334155;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}
.dark .custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #475569;
}
</style>
