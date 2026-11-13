import { computed, watch } from 'vue';
import type { Ref } from 'vue';
import { useProjectHealthStore } from '../../stores/projectHealth';
import { useProjectStore } from '../../stores/project';
import { countProjectHealth, resolveHealthLevel } from '../../utils/projectHealth';
import type { Project, ProjectHealthSnapshot } from '../../types';

/**
 * 项目健康状态 composable：监听可见项目变化，按需触发健康刷新，
 * 并对外暴露汇总统计。
 */
export function useProjectHealth(options: {
  filteredProjects: Ref<Project[]>;
}) {
  const healthStore = useProjectHealthStore();
  const projectStore = useProjectStore();

  /** 是否正在刷新 */
  const healthRefreshing = computed(() => healthStore.refreshing.size > 0);

  /** 获取指定项目的健康快照 */
  function getHealth(projectId: string): ProjectHealthSnapshot | undefined {
    return healthStore.get(projectId);
  }

  /** 手动触发对所有可见项目的健康刷新 */
  async function refreshVisible() {
    await healthStore.refreshMany(options.filteredProjects.value);
  }

  /**
   * 汇总统计。
   *
   * 复用 countProjectHealth，避免这里再手写一遍判定导致口径分叉
   * （历史上就因为两份实现，「异常」把 Git 改动也算进去了）。
   */
  const healthSummary = computed(() => {
    const allProjects = projectStore.projects;
    const counts = countProjectHealth(
      allProjects,
      id => healthStore.snapshots[id],
      id => projectStore.runningProjectCount[id] ?? 0,
    );
    return { total: allProjects.length, ...counts };
  });

  /** 健康状态对应的颜色标识（与「环境异常」筛选同口径） */
  function healthLevel(
    snapshot: ProjectHealthSnapshot | undefined,
  ): 'healthy' | 'warn' | 'error' | 'unknown' {
    return resolveHealthLevel(snapshot);
  }

  /** 防抖刷新定时器 */
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** 当可见项目列表变化时，延迟触发健康扫描（防抖 1s） */
  watch(
    () => options.filteredProjects.value.map((p) => p.id),
    () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        healthStore.refreshMany(options.filteredProjects.value);
      }, 1000);
    },
    { immediate: true }
  );

  return {
    healthRefreshing,
    getHealth,
    refreshVisible,
    healthSummary,
    healthLevel,
  };
}
