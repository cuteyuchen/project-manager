import { computed, shallowRef } from 'vue';
import { api } from '../api';
import { useProjectStore } from '../stores/project';
import {
  buildCommitCalendarDays,
  groupCommitCalendarItemsByDate,
  resolveCurrentMonthRange,
  type CommitCalendarDay,
  type CommitCalendarItem,
} from '../utils/commitCalendar';
import type { Project } from '../types';

export interface CommitCalendarSkippedProject {
  projectId: string;
  projectName: string;
  reason: 'not_git' | 'identity_missing' | 'load_failed';
}

function normalizeSkipReason(error: unknown): CommitCalendarSkippedProject['reason'] {
  const message = String(error || '').toLowerCase();
  if (message.includes('identity') || message.includes('user.name') || message.includes('user.email')) {
    return 'identity_missing';
  }
  return 'load_failed';
}

export function useCommitCalendar() {
  const projectStore = useProjectStore();
  const loading = shallowRef(false);
  const loaded = shallowRef(false);
  const items = shallowRef<CommitCalendarItem[]>([]);
  const skippedProjects = shallowRef<CommitCalendarSkippedProject[]>([]);
  const range = shallowRef(resolveCurrentMonthRange());

  const groupedItems = computed(() =>
    groupCommitCalendarItemsByDate(items.value, range.value.startDate, range.value.endDate)
  );

  const calendarDays = computed<CommitCalendarDay[]>(() =>
    buildCommitCalendarDays(range.value.year, range.value.month, groupedItems.value)
  );

  const totalCommits = computed(() => items.value.length);

  /***********************跨项目提交加载*********************/

  async function loadProjectCommits(project: Project): Promise<CommitCalendarItem[]> {
    let isGitRepo = false;
    try {
      isGitRepo = await api.gitCheck(project.path);
    } catch {
      skippedProjects.value = [
        ...skippedProjects.value,
        { projectId: project.id, projectName: project.name, reason: 'not_git' },
      ];
      return [];
    }

    if (!isGitRepo) {
      skippedProjects.value = [
        ...skippedProjects.value,
        { projectId: project.id, projectName: project.name, reason: 'not_git' },
      ];
      return [];
    }

    try {
      const result = await api.gitOwnCommits(project.path, range.value.startDate, range.value.endDate);
      return result.commits.map(commit => ({
        ...commit,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
      }));
    } catch (error) {
      skippedProjects.value = [
        ...skippedProjects.value,
        { projectId: project.id, projectName: project.name, reason: normalizeSkipReason(error) },
      ];
      return [];
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    range.value = resolveCurrentMonthRange();
    skippedProjects.value = [];

    try {
      const results = await Promise.all(projectStore.projects.map(project => loadProjectCommits(project)));
      items.value = results.flat().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  return {
    loading,
    loaded,
    range,
    items,
    skippedProjects,
    calendarDays,
    totalCommits,
    refresh,
  };
}
