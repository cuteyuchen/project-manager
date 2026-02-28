<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { Project } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const visible = defineModel<boolean>();

const { t } = useI18n();
const gitStore = useGitStore();

const stashMessage = ref('');
const isLoading = ref(false);

const stashList = computed(() => gitStore.stashes[props.project.id] || []);

async function handleStashSave() {
  isLoading.value = true;
  try {
    await gitStore.stashSave(props.project.id, props.project.path, stashMessage.value.trim() || undefined);
    stashMessage.value = '';
    ElMessage.success(t('git.stashSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  } finally {
    isLoading.value = false;
  }
}

async function handleStashPop(index: number) {
  isLoading.value = true;
  try {
    await gitStore.stashPop(props.project.id, props.project.path, index);
    ElMessage.success(t('git.stashPopSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  } finally {
    isLoading.value = false;
  }
}

async function handleStashApply(index: number) {
  isLoading.value = true;
  try {
    await gitStore.stashApply(props.project.id, props.project.path, index);
    ElMessage.success(t('git.stashPopSuccess'));
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  } finally {
    isLoading.value = false;
  }
}

async function handleStashDrop(index: number) {
  try {
    await ElMessageBox.confirm(
      t('git.stashDropConfirm'),
      t('git.stashDrop'),
      { confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel'), type: 'warning' }
    );
    isLoading.value = true;
    await gitStore.stashDrop(props.project.id, props.project.path, index);
    ElMessage.success(t('common.success'));
  } catch (e: any) {
    if (e !== 'cancel') {
      ElMessage.error(t('git.operationFailed', { error: String(e) }));
    }
  } finally {
    isLoading.value = false;
  }
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('git.stash')"
    width="520px"
    :close-on-click-modal="false"
  >
    <!-- Stash save -->
    <div class="mb-4 pb-4 border-b border-slate-200 dark:border-slate-700/50">
      <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
        {{ t('git.stashSave') }}
      </label>
      <div class="flex gap-2">
        <el-input
          v-model="stashMessage"
          :placeholder="t('git.stashMessagePlaceholder')"
          class="flex-1"
          @keydown.enter="handleStashSave"
        />
        <el-button type="primary" @click="handleStashSave" :loading="isLoading">
          {{ t('git.stashSave') }}
        </el-button>
      </div>
    </div>

    <!-- Stash list -->
    <div class="space-y-2 max-h-80 overflow-y-auto">
      <div v-if="stashList.length === 0" class="text-center py-8 text-slate-400 text-sm">
        <div class="i-mdi-package-down text-4xl opacity-20 mx-auto mb-2" />
        {{ t('git.stashEmpty') }}
      </div>

      <div v-for="stash in stashList" :key="stash.index"
        class="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">
            {{ stash.message || ('stash@{' + stash.index + '}') }}
          </div>
          <div class="text-xs text-slate-400 mt-0.5">
            {{ formatDate(stash.date) }}
          </div>
        </div>
        <div class="flex items-center gap-1 ml-2 flex-shrink-0">
          <el-button size="small" @click="handleStashApply(stash.index)" :loading="isLoading">
            {{ t('git.stashApply') }}
          </el-button>
          <el-button size="small" type="primary" @click="handleStashPop(stash.index)" :loading="isLoading">
            {{ t('git.stashPop') }}
          </el-button>
          <el-button size="small" type="danger" @click="handleStashDrop(stash.index)" :loading="isLoading">
            <div class="i-mdi-delete-outline" />
          </el-button>
        </div>
      </div>
    </div>
  </el-dialog>
</template>
