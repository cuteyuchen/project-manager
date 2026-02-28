<script setup lang="ts">
import { ref } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import { ElMessage } from 'element-plus';
import type { Project } from '../../types';

const props = defineProps<{
  project: Project;
  mode: 'create' | 'delete';
  branchToDelete?: string;
}>();

const visible = defineModel<boolean>();

const { t } = useI18n();
const gitStore = useGitStore();

const branchName = ref('');
const startPoint = ref('');
const forceDelete = ref(false);
const isLoading = ref(false);

async function handleCreate() {
  if (!branchName.value.trim()) return;
  isLoading.value = true;
  try {
    await gitStore.createBranch(
      props.project.id,
      props.project.path,
      branchName.value.trim(),
      startPoint.value.trim() || undefined
    );
    ElMessage.success(t('git.createBranchSuccess', { name: branchName.value.trim() }));
    branchName.value = '';
    startPoint.value = '';
    visible.value = false;
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  } finally {
    isLoading.value = false;
  }
}

async function handleDelete() {
  if (!props.branchToDelete) return;
  isLoading.value = true;
  try {
    await gitStore.deleteBranch(
      props.project.id,
      props.project.path,
      props.branchToDelete,
      forceDelete.value
    );
    ElMessage.success(t('git.deleteBranchSuccess', { name: props.branchToDelete }));
    visible.value = false;
  } catch (e: any) {
    ElMessage.error(t('git.operationFailed', { error: String(e) }));
  } finally {
    isLoading.value = false;
  }
}

function handleClose() {
  branchName.value = '';
  startPoint.value = '';
  forceDelete.value = false;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="mode === 'create' ? t('git.newBranch') : t('git.deleteBranch')"
    width="420px"
    @close="handleClose"
    :close-on-click-modal="false"
  >
    <!-- Create Branch -->
    <div v-if="mode === 'create'" class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
          {{ t('git.branchName') }}
        </label>
        <el-input
          v-model="branchName"
          :placeholder="t('git.branchNamePlaceholder')"
          @keydown.enter="handleCreate"
          autofocus
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
          {{ t('git.startPoint') }}
        </label>
        <el-input
          v-model="startPoint"
          :placeholder="t('git.startPointPlaceholder')"
        />
      </div>
    </div>

    <!-- Delete Branch -->
    <div v-else class="space-y-4">
      <p class="text-sm text-slate-600 dark:text-slate-400">
        {{ t('git.deleteBranchConfirm', { name: branchToDelete }) }}
      </p>
      <el-checkbox v-model="forceDelete" :label="t('git.forceDelete')" />
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
        <el-button 
          v-if="mode === 'create'" 
          type="primary" 
          @click="handleCreate" 
          :loading="isLoading"
          :disabled="!branchName.trim()"
        >
          {{ t('common.confirm') }}
        </el-button>
        <el-button 
          v-else 
          type="danger" 
          @click="handleDelete" 
          :loading="isLoading"
        >
          {{ t('git.deleteBranch') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>
