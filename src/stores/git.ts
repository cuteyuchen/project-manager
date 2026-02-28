import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api';
import type {
  GitStatusResult,
  GitBranch,
  GitCommit,
  GitRemote,
  GitStashEntry,
  GitTag,
} from '../types';

export const useGitStore = defineStore('git', () => {
  // ─── State ───────────────────────────────────────────────────────────────
  const isGitRepo = ref<Record<string, boolean>>({});
  const status = ref<Record<string, GitStatusResult>>({});
  const branches = ref<Record<string, GitBranch[]>>({});
  const commits = ref<Record<string, GitCommit[]>>({});
  const currentBranch = ref<Record<string, string>>({});
  const remotes = ref<Record<string, GitRemote[]>>({});
  const stashes = ref<Record<string, GitStashEntry[]>>({});
  const tags = ref<Record<string, GitTag[]>>({});
  const selectedDiff = ref<string>('');
  const selectedDiffFile = ref<string>('');
  const selectedDiffStaged = ref<boolean>(false);

  // Loading states
  const loading = ref(false);
  const statusLoading = ref(false);
  const commitLoading = ref(false);
  const operationLoading = ref(false);

  // ─── Getters ─────────────────────────────────────────────────────────────
  function getStatus(projectId: string): GitStatusResult | undefined {
    return status.value[projectId];
  }

  function getBranches(projectId: string): GitBranch[] {
    return branches.value[projectId] || [];
  }

  function getCommits(projectId: string): GitCommit[] {
    return commits.value[projectId] || [];
  }

  function getCurrentBranch(projectId: string): string {
    return currentBranch.value[projectId] || '';
  }

  function getLocalBranches(projectId: string): GitBranch[] {
    return (branches.value[projectId] || []).filter(b => !b.is_remote);
  }

  function getRemoteBranches(projectId: string): GitBranch[] {
    return (branches.value[projectId] || []).filter(b => b.is_remote);
  }

  function getTotalChanges(projectId: string): number {
    const s = status.value[projectId];
    if (!s) return 0;
    return s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length;
  }

  // ─── Actions ─────────────────────────────────────────────────────────────

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
    await refreshAll(projectId, path);
  }

  async function refreshStatus(projectId: string, path: string): Promise<void> {
    statusLoading.value = true;
    try {
      const result = await api.gitStatus(path);
      status.value[projectId] = result;
    } catch (e) {
      console.error('Failed to get git status:', e);
    } finally {
      statusLoading.value = false;
    }
  }

  async function refreshBranches(projectId: string, path: string): Promise<void> {
    try {
      const [branchList, current] = await Promise.all([
        api.gitBranches(path),
        api.gitCurrentBranch(path),
      ]);
      branches.value[projectId] = branchList;
      currentBranch.value[projectId] = current;
    } catch (e) {
      console.error('Failed to get branches:', e);
    }
  }

  async function refreshLog(projectId: string, path: string, maxCount?: number): Promise<void> {
    commitLoading.value = true;
    try {
      const result = await api.gitLog(path, maxCount);
      commits.value[projectId] = result;
    } catch (e) {
      console.error('Failed to get git log:', e);
    } finally {
      commitLoading.value = false;
    }
  }

  async function refreshRemotes(projectId: string, path: string): Promise<void> {
    try {
      remotes.value[projectId] = await api.gitRemoteList(path);
    } catch (e) {
      console.error('Failed to get remotes:', e);
    }
  }

  async function refreshStashes(projectId: string, path: string): Promise<void> {
    try {
      stashes.value[projectId] = await api.gitStashList(path);
    } catch (e) {
      console.error('Failed to get stashes:', e);
    }
  }

  async function refreshTags(projectId: string, path: string): Promise<void> {
    try {
      tags.value[projectId] = await api.gitTags(path);
    } catch (e) {
      console.error('Failed to get tags:', e);
    }
  }

  async function refreshAll(projectId: string, path: string): Promise<void> {
    loading.value = true;
    try {
      await Promise.all([
        refreshStatus(projectId, path),
        refreshBranches(projectId, path),
        refreshLog(projectId, path),
        refreshRemotes(projectId, path),
        refreshStashes(projectId, path),
        refreshTags(projectId, path),
      ]);
    } finally {
      loading.value = false;
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
      await Promise.all([
        refreshStatus(projectId, path),
        refreshLog(projectId, path),
        refreshBranches(projectId, path),
      ]);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function pull(projectId: string, path: string, remote?: string, branch?: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitPull(path, remote, branch);
      await refreshAll(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function push(projectId: string, path: string, remote?: string, branch?: string, force?: boolean, setUpstream?: boolean): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitPush(path, remote, branch, force, setUpstream);
      await refreshBranches(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function fetch(projectId: string, path: string, remote?: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitFetch(path, remote);
      await Promise.all([
        refreshBranches(projectId, path),
        refreshLog(projectId, path),
      ]);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function checkout(projectId: string, path: string, branch: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitCheckout(path, branch);
      await refreshAll(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function createBranch(projectId: string, path: string, name: string, startPoint?: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitCreateBranch(path, name, startPoint);
      await refreshBranches(projectId, path);
      await refreshLog(projectId, path);
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

  async function merge(projectId: string, path: string, branch: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitMerge(path, branch);
      await refreshAll(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function rebase(projectId: string, path: string, branch: string): Promise<string> {
    operationLoading.value = true;
    try {
      const result = await api.gitRebase(path, branch);
      await refreshAll(projectId, path);
      return result;
    } finally {
      operationLoading.value = false;
    }
  }

  async function rmCached(projectId: string, path: string, files: string[]): Promise<void> {
    await api.gitRmCached(path, files);
    await refreshStatus(projectId, path);
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

  async function stashSave(projectId: string, path: string, message?: string): Promise<void> {
    await api.gitStashSave(path, message);
    await Promise.all([
      refreshStatus(projectId, path),
      refreshStashes(projectId, path),
    ]);
  }

  async function stashPop(projectId: string, path: string, index?: number): Promise<void> {
    await api.gitStashPop(path, index);
    await Promise.all([
      refreshStatus(projectId, path),
      refreshStashes(projectId, path),
    ]);
  }

  async function stashApply(projectId: string, path: string, index?: number): Promise<void> {
    await api.gitStashApply(path, index);
    await Promise.all([
      refreshStatus(projectId, path),
      refreshStashes(projectId, path),
    ]);
  }

  async function stashDrop(projectId: string, path: string, index: number): Promise<void> {
    await api.gitStashDrop(path, index);
    await refreshStashes(projectId, path);
  }

  function clearDiff(): void {
    selectedDiff.value = '';
    selectedDiffFile.value = '';
    selectedDiffStaged.value = false;
  }

  async function applyPatch(projectId: string, path: string, patch: string, cached?: boolean, reverse?: boolean): Promise<void> {
    await api.gitApplyPatch(path, patch, cached, reverse);
    await refreshStatus(projectId, path);
  }

  async function deleteTag(projectId: string, path: string, name: string): Promise<void> {
    await api.gitDeleteTag(path, name);
    await refreshTags(projectId, path);
  }

  return {
    // State
    isGitRepo,
    status,
    branches,
    commits,
    currentBranch,
    remotes,
    stashes,
    tags,
    selectedDiff,
    selectedDiffFile,
    selectedDiffStaged,
    loading,
    statusLoading,
    commitLoading,
    operationLoading,

    // Getters
    getStatus,
    getBranches,
    getCommits,
    getCurrentBranch,
    getLocalBranches,
    getRemoteBranches,
    getTotalChanges,

    // Actions
    checkGitRepo,
    initRepo,
    refreshStatus,
    refreshBranches,
    refreshLog,
    refreshRemotes,
    refreshStashes,
    refreshTags,
    refreshAll,
    stageFiles,
    unstageFiles,
    stageAll,
    unstageAll,
    commit,
    pull,
    push,
    fetch,
    checkout,
    createBranch,
    deleteBranch,
    merge,
    rebase,
    rmCached,
    getDiff,
    getDiffCommit,
    discardFiles,
    discardUntracked,
    stashSave,
    stashPop,
    stashApply,
    stashDrop,
    clearDiff,
    applyPatch,
    deleteTag,
  };
});
