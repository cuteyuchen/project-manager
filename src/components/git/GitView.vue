<script setup lang="ts">
import { ref, computed, watch, provide } from 'vue';
import { useProjectStore } from '../../stores/project';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import GitToolbar from './GitToolbar.vue';
import GitSidebar from './GitSidebar.vue';
import GitStatusPanel from './GitStatusPanel.vue';
import GitCommitArea from './GitCommitArea.vue';
import GitDiffView from './GitDiffView.vue';
import GitLogGraph from './GitLogGraph.vue';
import GitBranchDialog from './GitBranchDialog.vue';
import GitStashPanel from './GitStashPanel.vue';

const { t } = useI18n();
const projectStore = useProjectStore();
const gitStore = useGitStore();

const activeSubTab = ref<'status' | 'log'>('status');
const showBranchDialog = ref(false);
const showStashDialog = ref(false);
const branchDialogMode = ref<'create' | 'delete'>('create');
const branchToDelete = ref('');

// Resizable panel sizes
const sidebarWidth = ref(200);
const fileListWidth = ref(340);
const commitHeight = ref(140);
const logGraphRef = ref<InstanceType<typeof GitLogGraph> | null>(null);

// Provide scroll-to-branch for sidebar click
provide('scrollToBranch', (branchName: string) => {
  if (activeSubTab.value !== 'log') {
    activeSubTab.value = 'log';
    setTimeout(() => logGraphRef.value?.scrollToBranch(branchName), 100);
  } else {
    logGraphRef.value?.scrollToBranch(branchName);
  }
});

const activeProject = computed(() =>
  projectStore.projects.find(p => p.id === projectStore.activeProjectId)
);

const isGitRepo = computed(() => {
  if (!activeProject.value) return false;
  return gitStore.isGitRepo[activeProject.value.id] || false;
});

// Watch project changes — refresh and clear stale diff
watch(activeProject, async (newProject, oldProject) => {
  if (oldProject?.id !== newProject?.id) {
    gitStore.clearDiff();
  }
  if (newProject) {
    const isRepo = await gitStore.checkGitRepo(newProject.id, newProject.path);
    if (isRepo) {
      await gitStore.refreshAll(newProject.id, newProject.path);
    }
  }
}, { immediate: true });

async function handleInitRepo() {
  if (!activeProject.value) return;
  try {
    await gitStore.initRepo(activeProject.value.id, activeProject.value.path);
    ElMessage.success(t('git.initSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

function handleOpenBranchDialog(mode: 'create' | 'delete' = 'create', branch = '') {
  branchDialogMode.value = mode;
  branchToDelete.value = branch;
  showBranchDialog.value = true;
}

function handleOpenStash() {
  showStashDialog.value = true;
}

async function handleRefresh() {
  if (!activeProject.value) return;
  await gitStore.refreshAll(activeProject.value.id, activeProject.value.path);
}

// ─── Drag resize ─────────────────────────────────────────────────────────────
let dragging: 'sidebar' | 'fileList' | 'commit' | null = null;
let startPos = 0;
let startSize = 0;

function onDragStart(type: typeof dragging, e: MouseEvent) {
  dragging = type;
  startPos = type === 'commit' ? e.clientY : e.clientX;
  startSize = type === 'sidebar' ? sidebarWidth.value
    : type === 'fileList' ? fileListWidth.value
    : commitHeight.value;
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  document.body.style.cursor = type === 'commit' ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
}

function onDragMove(e: MouseEvent) {
  if (!dragging) return;
  const delta = dragging === 'commit'
    ? startPos - e.clientY
    : e.clientX - startPos;
  const newSize = startSize + delta;
  if (dragging === 'sidebar') sidebarWidth.value = Math.max(140, Math.min(400, newSize));
  else if (dragging === 'fileList') fileListWidth.value = Math.max(200, Math.min(600, newSize));
  else commitHeight.value = Math.max(80, Math.min(400, newSize));
}

function onDragEnd() {
  dragging = null;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-[#f8f9fb] dark:bg-[#0c1222]">
    <template v-if="isGitRepo && activeProject">
      <!-- Toolbar -->
      <GitToolbar
        :project="activeProject"
        @open-branch-dialog="handleOpenBranchDialog"
        @open-stash="handleOpenStash"
        @refresh="handleRefresh"
      />

      <!-- Sub-tab toggle -->
      <div class="flex border-b border-slate-200/80 dark:border-slate-700/40 bg-white/60 dark:bg-[#141d2e]/60 px-3 shrink-0">
        <button
          @click="activeSubTab = 'status'"
          class="px-3 py-1.5 text-xs font-medium border-b-2 transition-all cursor-pointer"
          :class="activeSubTab === 'status'
            ? 'border-blue-500 text-blue-600 dark:text-blue-400'
            : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'"
        >
          <div class="flex items-center gap-1.5">
            <div class="i-mdi-file-document-edit-outline text-sm" />
            {{ t('git.fileStatus') }}
            <span v-if="gitStore.getTotalChanges(activeProject.id) > 0"
              class="px-1.5 py-0 rounded-full text-[10px] bg-blue-500/15 text-blue-600 dark:text-blue-400 font-bold leading-4">
              {{ gitStore.getTotalChanges(activeProject.id) }}
            </span>
          </div>
        </button>
        <button
          @click="activeSubTab = 'log'"
          class="px-3 py-1.5 text-xs font-medium border-b-2 transition-all cursor-pointer"
          :class="activeSubTab === 'log'
            ? 'border-blue-500 text-blue-600 dark:text-blue-400'
            : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'"
        >
          <div class="flex items-center gap-1.5">
            <div class="i-mdi-source-commit text-sm" />
            {{ t('git.commitHistory') }}
          </div>
        </button>
      </div>

      <!-- Content area -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Sidebar -->
        <GitSidebar
          :project="activeProject"
          :style="{ width: sidebarWidth + 'px', minWidth: sidebarWidth + 'px' }"
          @open-branch-dialog="handleOpenBranchDialog"
          @open-stash="handleOpenStash"
        />
        <!-- Sidebar resize handle -->
        <div class="w-[3px] hover:bg-blue-400/50 active:bg-blue-500/60 cursor-col-resize transition-colors shrink-0 bg-slate-200/60 dark:bg-slate-700/30"
          @mousedown="onDragStart('sidebar', $event)" />

        <!-- Main content -->
        <div class="flex-1 flex flex-col overflow-hidden min-w-0">
          <template v-if="activeSubTab === 'status'">
            <div class="flex-1 flex overflow-hidden">
              <!-- Left: file list + commit area -->
              <div class="flex flex-col overflow-hidden"
                :style="{ width: fileListWidth + 'px', minWidth: fileListWidth + 'px' }">
                <div class="flex-1 overflow-hidden">
                  <GitStatusPanel :project="activeProject" />
                </div>
                <!-- Commit resize handle -->
                <div class="h-[3px] hover:bg-blue-400/50 active:bg-blue-500/60 cursor-row-resize transition-colors shrink-0 bg-slate-200/60 dark:bg-slate-700/30"
                  @mousedown="onDragStart('commit', $event)" />
                <!-- Commit message area -->
                <div class="shrink-0 overflow-hidden"
                  :style="{ height: commitHeight + 'px' }">
                  <GitCommitArea :project="activeProject" />
                </div>
              </div>
              <!-- File list resize handle -->
              <div class="w-[3px] hover:bg-blue-400/50 active:bg-blue-500/60 cursor-col-resize transition-colors shrink-0 bg-slate-200/60 dark:bg-slate-700/30"
                @mousedown="onDragStart('fileList', $event)" />
              <!-- Diff view -->
              <GitDiffView class="flex-1 min-w-0" :project="activeProject" />
            </div>
          </template>

          <template v-if="activeSubTab === 'log'">
            <GitLogGraph ref="logGraphRef" :project="activeProject" />
          </template>
        </div>
      </div>

      <!-- Dialogs -->
      <GitBranchDialog
        v-model="showBranchDialog"
        :project="activeProject"
        :mode="branchDialogMode"
        :branch-to-delete="branchToDelete"
      />
      <GitStashPanel
        v-model="showStashDialog"
        :project="activeProject"
      />
    </template>

    <!-- Not a Git repo -->
    <template v-else-if="activeProject">
      <div class="flex-1 flex items-center justify-center">
        <div class="text-center">
          <div class="i-mdi-git text-6xl text-slate-300 dark:text-slate-600 mx-auto mb-4" />
          <p class="text-lg font-medium text-slate-500 dark:text-slate-400 mb-2">{{ t('git.notGitRepo') }}</p>
          <button
            @click="handleInitRepo"
            class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
          >
            <div class="flex items-center gap-2">
              <div class="i-mdi-plus text-base" />
              {{ t('git.initRepo') }}
            </div>
          </button>
        </div>
      </div>
    </template>

    <!-- No project selected -->
    <template v-else>
      <div class="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500">
        <div class="text-center">
          <div class="i-mdi-source-branch text-6xl opacity-20 mx-auto mb-4" />
          <p class="text-sm">{{ t('dashboard.selectScript') }}</p>
        </div>
      </div>
    </template>
  </div>
</template>
