<script setup lang="ts">
import { computed, ref, inject } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { Project } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const emit = defineEmits<{
  (e: 'open-branch-dialog', mode: 'create' | 'delete', branch?: string): void;
  (e: 'open-stash'): void;
}>();

const { t } = useI18n();
const gitStore = useGitStore();
const scrollToBranch = inject<(name: string) => void>('scrollToBranch', () => {});

const expandedSections = ref<Record<string, boolean>>({
  branches: true,
  remoteBranches: false,
  tags: false,
  remotes: false,
  stashes: false,
});

// Context menu state
const contextMenu = ref<{
  show: boolean;
  x: number;
  y: number;
  name: string;
  type: 'local' | 'remote' | 'tag';
  isCurrent: boolean;
}>({ show: false, x: 0, y: 0, name: '', type: 'local', isCurrent: false });

const localBranches = computed(() => gitStore.getLocalBranches(props.project.id));
const remoteBranches = computed(() => gitStore.getRemoteBranches(props.project.id));
const tagList = computed(() => gitStore.tags[props.project.id] || []);
const remoteList = computed(() => gitStore.remotes[props.project.id] || []);
const stashList = computed(() => gitStore.stashes[props.project.id] || []);

function toggleSection(section: string) {
  expandedSections.value[section] = !expandedSections.value[section];
}

// Left click: navigate to branch/tag position in log graph
function handleItemClick(name: string) {
  scrollToBranch(name);
}

// Right click: show context menu
function handleContextMenu(e: MouseEvent, name: string, type: 'local' | 'remote' | 'tag', isCurrent: boolean = false) {
  e.preventDefault();
  contextMenu.value = { show: true, x: e.clientX, y: e.clientY, name, type, isCurrent };
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
  });
}

function closeContextMenu() {
  contextMenu.value.show = false;
}

// ── Branch operations ────────────────────────────────────────────────────

async function handleCheckout() {
  closeContextMenu();
  const name = contextMenu.value.name;
  if (contextMenu.value.type === 'remote') {
    const parts = name.split('/');
    const localName = parts.slice(1).join('/');
    try {
      await gitStore.checkout(props.project.id, props.project.path, localName);
      ElMessage.success(t('git.switchSuccess', { name: localName }));
    } catch {
      try {
        await gitStore.createBranch(props.project.id, props.project.path, localName, name);
        ElMessage.success(t('git.switchSuccess', { name: localName }));
      } catch (e2: any) {
        ElMessage.error(t('git.operationFailed', { error: String(e2) }));
      }
    }
  } else if (contextMenu.value.type === 'tag') {
    try {
      await gitStore.checkout(props.project.id, props.project.path, name);
      ElMessage.success(t('git.switchSuccess', { name }));
    } catch (e: any) {
      ElMessage.error(t('git.operationFailed', { error: String(e) }));
    }
  } else {
    try {
      await gitStore.checkout(props.project.id, props.project.path, name);
      ElMessage.success(t('git.switchSuccess', { name }));
    } catch (e: any) {
      ElMessage.error(t('git.operationFailed', { error: String(e) }));
    }
  }
}

async function handlePullBranch() {
  closeContextMenu();
  try {
    await gitStore.pull(props.project.id, props.project.path, undefined, contextMenu.value.name);
    ElMessage.success(t('git.pullSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleMergeBranch() {
  closeContextMenu();
  try {
    await gitStore.merge(props.project.id, props.project.path, contextMenu.value.name);
    ElMessage.success(t('git.mergeSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleRebaseBranch() {
  closeContextMenu();
  try {
    await gitStore.rebase(props.project.id, props.project.path, contextMenu.value.name);
    ElMessage.success(t('git.rebaseSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleDeleteBranch() {
  closeContextMenu();
  const name = contextMenu.value.name;
  try {
    await ElMessageBox.confirm(
      t('git.deleteBranchConfirm', { name }),
      t('git.deleteBranch'),
      { confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel'), type: 'warning' }
    );
    await gitStore.deleteBranch(props.project.id, props.project.path, name);
    ElMessage.success(t('git.deleteBranchSuccess', { name }));
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}

async function handleDeleteTag() {
  closeContextMenu();
  const name = contextMenu.value.name;
  try {
    await ElMessageBox.confirm(
      t('git.deleteTagConfirm', { name }),
      t('git.deleteTag'),
      { confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel'), type: 'warning' }
    );
    await gitStore.deleteTag(props.project.id, props.project.path, name);
    ElMessage.success(t('git.deleteTagSuccess', { name }));
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(t('git.operationFailed', { error: String(e) }));
  }
}
</script>

<template>
  <div class="flex flex-col border-r border-slate-200/80 dark:border-slate-700/30 bg-white/50 dark:bg-[#0f172a]/50 overflow-y-auto custom-scrollbar text-xs">

    <!-- Local Branches -->
    <div class="border-b border-slate-200/60 dark:border-slate-700/20">
      <div @click="toggleSection('branches')"
        class="flex items-center justify-between px-3 py-2 hover:bg-slate-100/60 dark:hover:bg-slate-800/20 cursor-pointer select-none">
        <div class="flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-400">
          <div class="i-mdi-chevron-right text-sm transition-transform duration-150" :class="{ 'rotate-90': expandedSections.branches }" />
          <div class="i-mdi-source-branch text-sm text-blue-500" />
          {{ t('git.localBranches') }}
        </div>
        <span class="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800/50 px-1.5 rounded-full">{{ localBranches.length }}</span>
      </div>
      <div v-if="expandedSections.branches" class="pb-1">
        <div v-for="branch in localBranches" :key="branch.name"
          @click="handleItemClick(branch.name)"
          @contextmenu="handleContextMenu($event, branch.name, 'local', branch.is_current)"
          class="flex items-center justify-between px-3 py-1 ml-3 mr-1 rounded-md hover:bg-slate-100/80 dark:hover:bg-slate-800/30 cursor-pointer transition-colors"
          :class="{ 'text-blue-600 dark:text-blue-400 font-medium': branch.is_current }">
          <div class="flex items-center gap-1.5 truncate flex-1 min-w-0">
            <div v-if="branch.is_current" class="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
            <span class="truncate">{{ branch.name }}</span>
            <span v-if="branch.ahead > 0" class="text-[9px] text-green-500 flex-shrink-0">↑{{ branch.ahead }}</span>
            <span v-if="branch.behind > 0" class="text-[9px] text-orange-500 flex-shrink-0">↓{{ branch.behind }}</span>
          </div>
        </div>
        <div @click="emit('open-branch-dialog', 'create')"
          class="flex items-center gap-1.5 px-3 py-1 ml-3 mr-1 rounded-md hover:bg-slate-100/80 dark:hover:bg-slate-800/30 cursor-pointer text-slate-400 hover:text-blue-500 transition-colors">
          <div class="i-mdi-plus text-xs" />
          {{ t('git.newBranch') }}
        </div>
      </div>
    </div>

    <!-- Remote Branches -->
    <div class="border-b border-slate-200/60 dark:border-slate-700/20">
      <div @click="toggleSection('remoteBranches')"
        class="flex items-center justify-between px-3 py-2 hover:bg-slate-100/60 dark:hover:bg-slate-800/20 cursor-pointer select-none">
        <div class="flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-400">
          <div class="i-mdi-chevron-right text-sm transition-transform duration-150" :class="{ 'rotate-90': expandedSections.remoteBranches }" />
          <div class="i-mdi-cloud-outline text-sm text-purple-500" />
          {{ t('git.remoteBranches') }}
        </div>
        <span class="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800/50 px-1.5 rounded-full">{{ remoteBranches.length }}</span>
      </div>
      <div v-if="expandedSections.remoteBranches" class="pb-1">
        <div v-for="branch in remoteBranches" :key="branch.name"
          @click="handleItemClick(branch.name)"
          @contextmenu="handleContextMenu($event, branch.name, 'remote')"
          class="flex items-center gap-1.5 px-3 py-1 ml-3 mr-1 rounded-md hover:bg-slate-100/80 dark:hover:bg-slate-800/30 cursor-pointer truncate transition-colors">
          <span class="truncate">{{ branch.name }}</span>
        </div>
        <div v-if="remoteBranches.length === 0" class="px-3 py-1 ml-3 text-slate-400 italic">—</div>
      </div>
    </div>

    <!-- Tags -->
    <div class="border-b border-slate-200/60 dark:border-slate-700/20">
      <div @click="toggleSection('tags')"
        class="flex items-center justify-between px-3 py-2 hover:bg-slate-100/60 dark:hover:bg-slate-800/20 cursor-pointer select-none">
        <div class="flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-400">
          <div class="i-mdi-chevron-right text-sm transition-transform duration-150" :class="{ 'rotate-90': expandedSections.tags }" />
          <div class="i-mdi-tag-outline text-sm text-amber-500" />
          {{ t('git.tags') }}
        </div>
        <span class="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800/50 px-1.5 rounded-full">{{ tagList.length }}</span>
      </div>
      <div v-if="expandedSections.tags" class="pb-1">
        <div v-for="tag in tagList" :key="tag.name"
          class="flex items-center gap-1.5 px-3 py-1 ml-3 mr-1 rounded-md hover:bg-slate-100/80 dark:hover:bg-slate-800/30 cursor-pointer truncate transition-colors"
          @click="handleItemClick('tag: ' + tag.name)"
          @contextmenu="handleContextMenu($event, tag.name, 'tag')">
          <span class="truncate">{{ tag.name }}</span>
          <span class="text-[9px] text-slate-400 font-mono ml-auto flex-shrink-0">{{ tag.hash }}</span>
        </div>
        <div v-if="tagList.length === 0" class="px-3 py-1 ml-3 text-slate-400 italic">—</div>
      </div>
    </div>

    <!-- Remotes -->
    <div class="border-b border-slate-200/60 dark:border-slate-700/20">
      <div @click="toggleSection('remotes')"
        class="flex items-center justify-between px-3 py-2 hover:bg-slate-100/60 dark:hover:bg-slate-800/20 cursor-pointer select-none">
        <div class="flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-400">
          <div class="i-mdi-chevron-right text-sm transition-transform duration-150" :class="{ 'rotate-90': expandedSections.remotes }" />
          <div class="i-mdi-server-network text-sm text-teal-500" />
          {{ t('git.remotes') }}
        </div>
        <span class="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800/50 px-1.5 rounded-full">{{ new Set(remoteList.map(r => r.name)).size }}</span>
      </div>
      <div v-if="expandedSections.remotes" class="pb-1">
        <div v-for="remote in remoteList.filter(r => r.remote_type === 'fetch')" :key="remote.name"
          class="flex items-center gap-1.5 px-3 py-1 ml-3 mr-1 rounded-md hover:bg-slate-100/80 dark:hover:bg-slate-800/30 truncate transition-colors">
          <span class="font-medium">{{ remote.name }}</span>
          <span class="text-slate-400 truncate text-[10px]">{{ remote.url }}</span>
        </div>
        <div v-if="remoteList.length === 0" class="px-3 py-1 ml-3 text-slate-400 italic">—</div>
      </div>
    </div>

    <!-- Stashes -->
    <div>
      <div @click="toggleSection('stashes')"
        class="flex items-center justify-between px-3 py-2 hover:bg-slate-100/60 dark:hover:bg-slate-800/20 cursor-pointer select-none">
        <div class="flex items-center gap-1.5 font-medium text-slate-600 dark:text-slate-400">
          <div class="i-mdi-chevron-right text-sm transition-transform duration-150" :class="{ 'rotate-90': expandedSections.stashes }" />
          <div class="i-mdi-package-down text-sm text-indigo-500" />
          {{ t('git.stash') }}
        </div>
        <span class="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800/50 px-1.5 rounded-full">{{ stashList.length }}</span>
      </div>
      <div v-if="expandedSections.stashes" class="pb-1">
        <div v-for="stash in stashList" :key="stash.index"
          class="flex items-center gap-1.5 px-3 py-1 ml-3 mr-1 rounded-md hover:bg-slate-100/80 dark:hover:bg-slate-800/30 cursor-pointer truncate transition-colors"
          @click="emit('open-stash')">
          <span class="truncate">{{ stash.message }}</span>
        </div>
        <div v-if="stashList.length === 0" class="px-3 py-1 ml-3 text-slate-400 italic">{{ t('git.stashEmpty') }}</div>
        <div @click="emit('open-stash')"
          class="flex items-center gap-1.5 px-3 py-1 ml-3 mr-1 rounded-md hover:bg-slate-100/80 dark:hover:bg-slate-800/30 cursor-pointer text-slate-400 hover:text-indigo-500 transition-colors">
          <div class="i-mdi-plus text-xs" />
          {{ t('git.stashSave') }}
        </div>
      </div>
    </div>

    <!-- Context Menu (no icons, vertical) -->
    <Teleport to="body">
      <div v-if="contextMenu.show"
        class="fixed z-[9999] min-w-[140px] py-1 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-[#1e293b] text-xs"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }">

        <!-- Branch context menu -->
        <template v-if="contextMenu.type === 'local' || contextMenu.type === 'remote'">
          <button v-if="!contextMenu.isCurrent" @click="handleCheckout" class="ctx-item">
            {{ t('git.switchBranch') }}
          </button>
          <button v-if="!contextMenu.isCurrent" @click="handlePullBranch" class="ctx-item">
            {{ t('git.pullBranch') }}
          </button>
          <button v-if="!contextMenu.isCurrent" @click="handleMergeBranch" class="ctx-item">
            {{ t('git.mergeBranch') }}
          </button>
          <button v-if="!contextMenu.isCurrent" @click="handleRebaseBranch" class="ctx-item">
            {{ t('git.rebaseBranch') }}
          </button>
          <template v-if="!contextMenu.isCurrent && contextMenu.type === 'local'">
            <div class="border-t border-slate-200/60 dark:border-slate-700/40 my-1" />
            <button @click="handleDeleteBranch" class="ctx-item text-red-500">
              {{ t('git.deleteBranch') }}
            </button>
          </template>
        </template>

        <!-- Tag context menu -->
        <template v-if="contextMenu.type === 'tag'">
          <button @click="handleCheckout" class="ctx-item">
            {{ t('git.checkoutTag') }}
          </button>
          <div class="border-t border-slate-200/60 dark:border-slate-700/40 my-1" />
          <button @click="handleDeleteTag" class="ctx-item text-red-500">
            {{ t('git.deleteTag') }}
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ctx-item {
  @apply w-full px-3 py-1.5 text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/50 cursor-pointer transition-colors block;
}

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
</style>
