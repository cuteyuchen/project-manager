import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api';
import type {
  GitStatusResult,
  GitBranch,
  GitCommit,
  GitSummary,
} from '../types';

export const useGitStore = defineStore('git', () => {
  // ─── State ───────────────────────────────────────────────────────────────
  const isGitRepo = ref<Record<string, boolean>>({});
  const summary = ref<Record<string, GitSummary>>({});
  const status = ref<Record<string, GitStatusResult>>({});
  const history = ref<Record<string, GitCommit[]>>({});
  const branches = ref<Record<string, GitBranch[]>>({});

  // Current diff (not project-scoped – just the currently viewed diff)
  const selectedDiff = ref('');
  const selectedDiffFile = ref('');
  const selectedDiffStaged = ref(false);

  // Loading states
  const loading = ref(false);
  const operationLoading = ref(false);

  // ─── Getters ─────────────────────────────────────────────────────────────

  function getSummary(projectId: string): GitSummary | undefined {
    return summary.value[projectId];
  }

  function getStatus(projectId: string): GitStatusResult | undefined {
    return status.value[projectId];
  }

  function getBranches(projectId: string): GitBranch[] {
    return branches.value[projectId] || [];
  }

  function getLocalBranches(projectId: string): GitBranch[] {
    return getBranches(projectId).filter(b => !b.is_remote);
  }

  function getRemoteBranches(projectId: string): GitBranch[] {
    return getBranches(projectId).filter(b => b.is_remote);
  }

  function getTotalChanges(projectId: string): number {
    const s = status.value[projectId];
    if (!s) return 0;
    return s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length;
  }

  // ─── Refresh Actions (on-demand) ────────────────────────────────────────

  async function checkGitRepo(projectId: string, path: string): Promise<boolean> {
    try {
      const result = await api.gitCheck(path);
      isGitRepo.value[projectId] = result;
      return result;
    } catch {
      isGitRepo.value[projectId] = false;
      return false;
    }
  }

  async function initRepo(projectId: string, path: string): Promise<void> {
    await api.gitInit(path);
    isGitRepo.value[projectId] = true;
    await refreshSummaryAndStatus(projectId, path);
  }

  async function refreshSummary(projectId: string, path: string): Promise<void> {
    try {
      summary.value[projectId] = await api.gitSummary(path);
    } catch (e) {
      console.error('Failed to get git summary:', e);
    }
  }

  async function refreshStatus(projectId: string, path: string): Promise<void> {
    try {
      status.value[projectId] = await api.gitStatus(path);
    } catch (e) {
      console.error('Failed to get git status:', e);
    }
  }

  async function refreshSummaryAndStatus(projectId: string, path: string): Promise<void> {
    loading.value = true;
    try {
      await Promise.all([
        refreshSummary(projectId, path),
        refreshStatus(projectId, path),
      ]);
    } finally {
      loading.value = false;
    }
  }

  async function refreshHistory(projectId: string, path: string, maxCount?: number): Promise<void> {
    try {
      history.value[projectId] = await api.gitHistory(path, maxCount);
    } catch (e) {
      console.error('Failed to get git history:', e);
    }
  }

  async function refreshBranches(projectId: string, path: string): Promise<void> {
    try {
      branches.value[projectId] = await api.gitListBranches(path);
    } catch (e) {
      console.error('Failed to get branches:', e);
    }
  }

  // ─── Git Operations ──────────────────────────────────────────────────────

  async function stageFiles(projectId: string, path: string, files: string[]): Promise<void> {
    await api.gitStage(path, files);
    await refreshStatus(projectId, path);
  }

  async function unstageFiles(projectId: string, path: string, files: string[]): Promise<void> {
    await api.gitUnstage(path, files);
    await refreshStatus(projectId, path);
  }

  async function stageAll(projectId: string, path: string): Promise<void> {
    await api.gitStageAll(path);
    await refreshStatus(projectId, path);
  }

  async function unstageAll(projectId: string, path: string): Promise<void> {
    await api.gitUnstageAll(path);
    await refreshStatus(projectId, path);
  }

  async function commit(projectId: string, path: string, message: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitCommit(path, message);
      await refreshSummaryAndStatus(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function pull(projectId: string, path: string, remote?: string, branch?: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitPull(path, remote, branch);
      await refreshSummaryAndStatus(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function push(projectId: string, path: string, remote?: string, branch?: string, force?: boolean, setUpstream?: boolean): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitPush(path, remote, branch, force, setUpstream);
      await refreshSummary(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function fetch(projectId: string, path: string, remote?: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitFetch(path, remote);
      await refreshSummary(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function switchBranch(projectId: string, path: string, branch: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitSwitchBranch(path, branch);
      await refreshSummaryAndStatus(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function createAndSwitchBranch(projectId: string, path: string, name: string, startPoint?: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitCreateAndSwitchBranch(path, name, startPoint);
      await refreshSummaryAndStatus(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function deleteBranch(projectId: string, path: string, name: string, force?: boolean): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitDeleteBranch(path, name, force);
      await refreshBranches(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function renameBranch(projectId: string, path: string, oldName: string, newName: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitRenameBranch(path, oldName, newName);
      await refreshSummary(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function getDiff(path: string, file?: string, staged?: boolean): Promise<string> {
    const result = await api.gitDiff(path, file, staged);
    selectedDiff.value = result;
    selectedDiffFile.value = file || '';
    selectedDiffStaged.value = staged || false;
    return result;
  }

  async function getDiffCommit(path: string, hash: string): Promise<string> {
    const result = await api.gitDiffCommit(path, hash);
    selectedDiff.value = result;
    return result;
  }

  async function discardFiles(projectId: string, path: string, files: string[]): Promise<void> {
    await api.gitDiscard(path, files);
    await refreshStatus(projectId, path);
  }

  async function discardUntracked(projectId: string, path: string, files: string[]): Promise<void> {
    await api.gitDiscardUntracked(path, files);
    await refreshStatus(projectId, path);
  }

  function clearDiff(): void {
    selectedDiff.value = '';
    selectedDiffFile.value = '';
    selectedDiffStaged.value = false;
  }

  return {
    // State
    isGitRepo,
    summary,
    status,
    history,
    branches,
    selectedDiff,
    selectedDiffFile,
    selectedDiffStaged,
    loading,
    operationLoading,

    // Getters
    getSummary,
    getStatus,
    getBranches,
    getLocalBranches,
    getRemoteBranches,
    getTotalChanges,

    // Refresh
    checkGitRepo,
    initRepo,
    refreshSummary,
    refreshStatus,
    refreshSummaryAndStatus,
    refreshHistory,
    refreshBranches,

    // Operations
    stageFiles,
    unstageFiles,
    stageAll,
    unstageAll,
    commit,
    pull,
    push,
    fetch,
    switchBranch,
    createAndSwitchBranch,
    deleteBranch,
    renameBranch,
    getDiff,
    getDiffCommit,
    discardFiles,
    discardUntracked,
    clearDiff,
  };
});
