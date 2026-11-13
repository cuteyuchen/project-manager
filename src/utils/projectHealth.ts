import type { ProjectHealthIssue, ProjectHealthSnapshot } from '../types';

export interface ProjectHealthCounts {
  running: number;
  dirty: number;
  unhealthy: number;
  missing: number;
}

/** 非 Git 项目不算异常，“未初始化 Git”只是提示 */
export function getRealHealthIssues(snapshot: ProjectHealthSnapshot | undefined): ProjectHealthIssue[] {
  if (!snapshot) return [];
  return snapshot.issues.filter(issue => issue.code !== 'not_git');
}

/** 路径缺失或存在真实健康问题（含 Git 未提交改动） */
export function hasHealthIssues(snapshot: ProjectHealthSnapshot | undefined): boolean {
  if (!snapshot) return false;
  if (!snapshot.pathExists) return true;
  return getRealHealthIssues(snapshot).length > 0;
}

/**
 * 统计健康分类计数。
 *
 * 必须覆盖整棵项目树：筛选本身也匹配子项目，只统计一级项目会出现
 * 「下面很多条 Git 改动，计数却只有 1」的错位。
 * 运行中按项目自身的会话计数，避免父项目聚合子项目后被重复统计。
 */
export function countProjectHealth(
  projects: readonly { id: string }[],
  getSnapshot: (projectId: string) => ProjectHealthSnapshot | undefined,
  getRunningCount: (projectId: string) => number = () => 0,
): ProjectHealthCounts {
  let running = 0;
  let dirty = 0;
  let unhealthy = 0;
  let missing = 0;

  for (const project of projects) {
    const snapshot = getSnapshot(project.id);

    if (getRunningCount(project.id) > 0) running += 1;
    if (snapshot?.gitDirty) dirty += 1;

    if (snapshot?.pathExists === false) {
      missing += 1;
      unhealthy += 1;
      continue;
    }
    if (hasHealthIssues(snapshot)) unhealthy += 1;
  }

  return { running, dirty, unhealthy, missing };
}
