import type { ProjectHealthIssue, ProjectHealthSnapshot } from '../types';

export interface ProjectHealthCounts {
  running: number;
  dirty: number;
  envIssue: number;
  missing: number;
}

/**
 * 不计入「异常」的问题码。
 *
 * - `not_git`：非 Git 项目只是提示，不是故障
 * - `git_dirty`：工作区有未提交改动，属于当前状态而非环境问题；
 *   总览里已有独立的「Git 改动」计数，再算进异常会让同一个项目被数两次，
 *   用户也分不清「有点脏」和「真的坏了」
 */
const NON_ISSUE_CODES: ReadonlySet<ProjectHealthIssue['code']> = new Set(['not_git', 'git_dirty']);

/** 会阻断或影响使用的环境问题（路径缺失、检测失败、依赖工具不可用） */
export function getEnvironmentIssues(
  snapshot: ProjectHealthSnapshot | undefined,
): ProjectHealthIssue[] {
  if (!snapshot) return [];
  return snapshot.issues.filter(issue => !NON_ISSUE_CODES.has(issue.code));
}

/** 兼容旧命名：等价于 getEnvironmentIssues */
export const getRealHealthIssues = getEnvironmentIssues;

/**
 * 项目是否存在环境异常。
 *
 * 只看「能不能用」，不看「脏不脏」：路径缺失、Git 检测失败、
 * 包管理器 / Node 运行时不可用才算异常。
 */
export function hasEnvironmentIssue(snapshot: ProjectHealthSnapshot | undefined): boolean {
  if (!snapshot) return false;
  if (!snapshot.pathExists) return true;
  return getEnvironmentIssues(snapshot).length > 0;
}

/** 兼容旧命名：语义已收窄为「环境异常」 */
export const hasHealthIssues = hasEnvironmentIssue;

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
  let envIssue = 0;
  let missing = 0;

  for (const project of projects) {
    const snapshot = getSnapshot(project.id);

    if (getRunningCount(project.id) > 0) running += 1;
    if (snapshot?.gitDirty) dirty += 1;

    if (snapshot?.pathExists === false) {
      missing += 1;
      envIssue += 1;
      continue;
    }
    if (hasEnvironmentIssue(snapshot)) envIssue += 1;
  }

  return { running, dirty, envIssue, missing };
}

/**
 * 健康等级（决定卡片圆点颜色）。
 *
 * 与「环境异常」筛选同口径：Git 有改动不会让圆点变黄，
 * 否则圆点和筛选数字会各说各话。
 */
export function resolveHealthLevel(
  snapshot: ProjectHealthSnapshot | undefined,
): 'healthy' | 'warn' | 'error' | 'unknown' {
  if (!snapshot) return 'unknown';
  if (!snapshot.pathExists) return 'error';

  const issues = getEnvironmentIssues(snapshot);
  if (issues.some(issue => issue.level === 'error')) return 'error';
  if (issues.length > 0) return 'warn';
  return 'healthy';
}
