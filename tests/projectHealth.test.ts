import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  countProjectHealth,
  getRealHealthIssues,
  hasHealthIssues,
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
assert.equal(counts.unhealthy, 4, '脏改动 + 路径缺失 + 包管理器异常都算健康异常');
assert.equal(counts.running, 1, '运行中按项目自身会话计数，父项目不应被重复聚合');

/*********************** 未加载快照不误判 ***********************/

const pending = countProjectHealth([{ id: 'a' }, { id: 'b' }], () => undefined);
assert.deepEqual(pending, { running: 0, dirty: 0, unhealthy: 0, missing: 0 }, '快照未加载时不应误报异常');

/*********************** 非 Git 项目不算异常 ***********************/

const notGit = snapshot({ projectId: 'plain', hasGit: false, issues: [{ code: 'not_git', level: 'warn', message: '未初始化 Git' }] });
assert.equal(getRealHealthIssues(notGit).length, 0, 'not_git 属于提示，不是异常');
assert.equal(hasHealthIssues(notGit), false, '非 Git 项目不应算健康异常');
assert.equal(hasHealthIssues(undefined), false, '没有快照时不应算异常');

/*********************** 路径缺失优先归入异常 ***********************/

const missing = snapshot({ projectId: 'gone', pathExists: false, issues: [] });
assert.equal(hasHealthIssues(missing), true, '路径不存在必须算异常');

/*********************** 接线回归 ***********************/

const dashboard = readFileSync(resolve(process.cwd(), 'src/views/Dashboard.vue'), 'utf8');
assert(
  /countProjectHealth\(\s*projectStore\.projects/.test(dashboard),
  'Dashboard 的计数必须覆盖整棵树，不能只传一级项目',
);

const healthStore = readFileSync(resolve(process.cwd(), 'src/stores/projectHealth.ts'), 'utf8');
assert(
  !/summary\.ahead|summary\.behind/.test(healthStore),
  '仅领先/落后远端不应算作 Git 改动，否则与列表 M/A/D 徽标对不上',
);

console.log('projectHealth tests passed');
