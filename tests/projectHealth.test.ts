import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  countProjectHealth,
  getEnvironmentIssues,
  hasEnvironmentIssue,
  resolveHealthLevel,
} from '../src/utils/projectHealth.ts';
import type { ProjectHealthSnapshot } from '../src/types.ts';

function snapshot(overrides: Partial<ProjectHealthSnapshot> & { projectId: string }): ProjectHealthSnapshot {
  return {
    running: false,
    hasGit: true,
    gitDirty: false,
    pmResolved: true,
    pathExists: true,
    issues: [],
    updatedAt: 0,
    ...overrides,
  };
}

/*********************** 计数必须覆盖子项目 ***********************/
// 回归：一级项目自己没有改动、子项目有改动时，筛选项不能再显示 0/1。

const projects = [
  { id: 'root' },
  { id: 'child-dirty-1' },
  { id: 'child-dirty-2' },
  { id: 'child-missing' },
  { id: 'child-warn' },
  { id: 'child-clean' },
];

const snapshots: Record<string, ProjectHealthSnapshot> = {
  root: snapshot({ projectId: 'root', hasGit: false, issues: [{ code: 'not_git', level: 'warn', message: '未初始化 Git' }] }),
  'child-dirty-1': snapshot({ projectId: 'child-dirty-1', gitDirty: true, issues: [{ code: 'git_dirty', level: 'warn', message: 'Git 有未提交的改动' }] }),
  'child-dirty-2': snapshot({ projectId: 'child-dirty-2', gitDirty: true, issues: [{ code: 'git_dirty', level: 'warn', message: 'Git 有未提交的改动' }] }),
  'child-missing': snapshot({ projectId: 'child-missing', pathExists: false, issues: [{ code: 'path_missing', level: 'error', message: '项目路径不存在' }] }),
  'child-warn': snapshot({ projectId: 'child-warn', pmResolved: false, issues: [{ code: 'pm_unresolved', level: 'warn', message: '包管理器不可用' }] }),
  'child-clean': snapshot({ projectId: 'child-clean' }),
};

const counts = countProjectHealth(
  projects,
  id => snapshots[id],
  id => (id === 'child-dirty-1' ? 1 : 0),
);

assert.equal(counts.dirty, 2, '两个子项目有 Git 改动，计数应为 2 而不是 0/1');
assert.equal(counts.missing, 1, '子项目路径缺失要计入');
assert.equal(
  counts.envIssue,
  2,
  '只有路径缺失与包管理器不可用算环境异常；Git 改动有独立计数，不能重复计入',
);
assert.equal(counts.running, 1, '运行中按项目自身会话计数，父项目不应被重复聚合');

/*********************** 未加载快照不误判 ***********************/

const pending = countProjectHealth([{ id: 'a' }, { id: 'b' }], () => undefined);
assert.deepEqual(
  pending,
  { running: 0, dirty: 0, envIssue: 0, missing: 0 },
  '快照未加载时不应误报异常',
);

/*********************** Git 改动不再算异常 ***********************/
// 这是本次语义收窄的核心：以前 git_dirty 会让项目同时出现在「Git 改动」和
// 「健康异常」两个数字里，用户点进去分不清是「有点脏」还是「真的坏了」。

const dirtyOnly = snapshot({
  projectId: 'dirty',
  gitDirty: true,
  issues: [{ code: 'git_dirty', level: 'warn', message: 'Git 有未提交的改动' }],
});
assert.equal(getEnvironmentIssues(dirtyOnly).length, 0, 'Git 改动属于状态，不是环境异常');
assert.equal(hasEnvironmentIssue(dirtyOnly), false, '仅有 Git 改动不应判为环境异常');
assert.equal(
  resolveHealthLevel(dirtyOnly),
  'healthy',
  '圆点不能因为 Git 有改动就变黄，否则与「环境异常」筛选口径不一致',
);

/*********************** 非 Git 项目不算异常 ***********************/

const notGit = snapshot({ projectId: 'plain', hasGit: false, issues: [{ code: 'not_git', level: 'warn', message: '未初始化 Git' }] });
assert.equal(getEnvironmentIssues(notGit).length, 0, 'not_git 属于提示，不是异常');
assert.equal(hasEnvironmentIssue(notGit), false, '非 Git 项目不应算环境异常');
assert.equal(hasEnvironmentIssue(undefined), false, '没有快照时不应算异常');

/*********************** Git 检测失败必须算异常 ***********************/
// git 进程没跑起来（PATH 未就绪 / 外置盘未挂载）以前被压成 not_git，
// 于是被排除在异常之外，项目显示成健康的绿点。

const gitFailed = snapshot({
  projectId: 'broken',
  hasGit: false,
  issues: [{ code: 'git_check_failed', level: 'warn', message: 'Git 检测失败：spawn failed' }],
});
assert.equal(hasEnvironmentIssue(gitFailed), true, 'Git 检测失败是环境问题，不能静默吞掉');
assert.equal(resolveHealthLevel(gitFailed), 'warn', '检测失败应显示为告警圆点');

/*********************** 路径缺失优先归入异常 ***********************/

const missing = snapshot({ projectId: 'gone', pathExists: false, issues: [] });
assert.equal(hasEnvironmentIssue(missing), true, '路径不存在必须算异常');
assert.equal(resolveHealthLevel(missing), 'error', '路径缺失应为错误级圆点');

/*********************** 等级判定 ***********************/

assert.equal(resolveHealthLevel(undefined), 'unknown', '未扫描时不应假装健康');
assert.equal(resolveHealthLevel(snapshot({ projectId: 'ok' })), 'healthy');
assert.equal(
  resolveHealthLevel(snapshot({
    projectId: 'err',
    issues: [{ code: 'path_missing', level: 'error', message: 'x' }],
  })),
  'error',
  '存在 error 级问题时应为红色',
);

/*********************** 接线回归 ***********************/

const dashboard = readFileSync(resolve(process.cwd(), 'src/views/Dashboard.vue'), 'utf8');
assert(
  /countProjectHealth\(\s*projectStore\.projects/.test(dashboard),
  'Dashboard 的计数必须覆盖整棵树，不能只传一级项目',
);
assert(
  /hasEnvironmentIssue\(/.test(dashboard),
  'Dashboard 的筛选必须复用统一的异常判定，不能自己再写一套',
);
assert(
  !/'unhealthy'/.test(dashboard),
  '「健康异常」语义已收窄为环境异常，不应残留旧筛选键',
);

const healthStore = readFileSync(resolve(process.cwd(), 'src/stores/projectHealth.ts'), 'utf8');
assert(
  !/summary\.ahead|summary\.behind/.test(healthStore),
  '仅领先/落后远端不应算作 Git 改动，否则与列表 M/A/D 徽标对不上',
);
assert(
  /git_check_failed/.test(healthStore),
  'Git 检测失败必须单独记问题码，不能被当成 not_git 吞掉',
);

const composable = readFileSync(
  resolve(process.cwd(), 'src/composables/dashboard/useProjectHealth.ts'),
  'utf8',
);
assert(
  /countProjectHealth\(/.test(composable),
  '汇总统计应复用统一工具函数，避免第二份实现导致口径分叉',
);

console.log('projectHealth tests passed');
