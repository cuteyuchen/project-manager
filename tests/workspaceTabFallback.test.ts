import assert from 'node:assert/strict';
import {
  isWorkspaceTabAvailable,
  resolveWorkspaceTabFallback,
  type WorkspaceTab,
  type WorkspaceTabCapabilities,
} from '../src/utils/workspaceTabFallback.ts';

/***********************能力快照构造*********************/

function caps(overrides: Partial<WorkspaceTabCapabilities> = {}): WorkspaceTabCapabilities {
  return {
    leafTabsDisabled: false,
    hasRunnableCommands: true,
    hasFrontendEnv: true,
    ...overrides,
  };
}

const ALL_TABS: WorkspaceTab[] = ['console', 'git', 'files', 'memo', 'env'];

/***********************可用性判定*********************/

// 能力齐全时所有页签都可用
for (const tab of ALL_TABS) {
  assert(isWorkspaceTabAvailable(tab, caps()), `能力齐全时 ${tab} 应可用`);
}

// 命令入口带 v-if，无可运行命令时 console 不可用，其余不受影响
assert(!isWorkspaceTabAvailable('console', caps({ hasRunnableCommands: false })), '无可运行命令时 console 不可用');
assert(isWorkspaceTabAvailable('git', caps({ hasRunnableCommands: false })), 'git 无条件渲染，不受命令影响');
assert(isWorkspaceTabAvailable('env', caps({ hasRunnableCommands: false })), 'env 只看 hasFrontendEnv');

// 环境入口带 v-if，无环境组时 env 不可用
assert(!isWorkspaceTabAvailable('env', caps({ hasFrontendEnv: false })), '无环境配置时 env 不可用');
assert(isWorkspaceTabAvailable('console', caps({ hasFrontendEnv: false })), 'console 只看 hasRunnableCommands');

// 没有活动叶子时，绑定叶子的三个页签都不可用；文件/备忘录仍可用
for (const tab of ['console', 'git', 'env'] as WorkspaceTab[]) {
  assert(!isWorkspaceTabAvailable(tab, caps({ leafTabsDisabled: true })), `无活动叶子时 ${tab} 不可用`);
}
for (const tab of ['files', 'memo'] as WorkspaceTab[]) {
  assert(isWorkspaceTabAvailable(tab, caps({ leafTabsDisabled: true })), `无活动叶子时 ${tab} 仍可用`);
}

/***********************回退目标*********************/

// 可用则原样返回——这是「保住用户已选页签」的关键：
// 用户手动选了 Git，切到别的子项目再切回来必须还是 Git
assert.equal(resolveWorkspaceTabFallback('git', caps()), 'git');
assert.equal(resolveWorkspaceTabFallback('git', caps({ hasRunnableCommands: false })), 'git');
assert.equal(resolveWorkspaceTabFallback('files', caps({ hasRunnableCommands: false, hasFrontendEnv: false })), 'files');
assert.equal(resolveWorkspaceTabFallback('memo', caps()), 'memo');

// 不可用时退到 Git（它无条件渲染，且比文件更常用）
assert.equal(resolveWorkspaceTabFallback('console', caps({ hasRunnableCommands: false })), 'git');
assert.equal(resolveWorkspaceTabFallback('env', caps({ hasFrontendEnv: false })), 'git');

// 没有活动叶子时 Git 自己也渲染不出来，只能退到文件
assert.equal(resolveWorkspaceTabFallback('git', caps({ leafTabsDisabled: true })), 'files');
assert.equal(resolveWorkspaceTabFallback('console', caps({ leafTabsDisabled: true })), 'files');
assert.equal(resolveWorkspaceTabFallback('env', caps({ leafTabsDisabled: true })), 'files');

// 回退结果必须是稳定的：再算一次不应继续变化，否则兜底 watcher 会自激
for (const tab of ALL_TABS) {
  for (const c of [
    caps(),
    caps({ hasRunnableCommands: false }),
    caps({ hasFrontendEnv: false }),
    caps({ hasRunnableCommands: false, hasFrontendEnv: false }),
    caps({ leafTabsDisabled: true }),
  ]) {
    const once = resolveWorkspaceTabFallback(tab, c);
    const twice = resolveWorkspaceTabFallback(once, c);
    assert.equal(twice, once, `回退必须收敛：${tab} 在同一能力下反复求值应稳定`);
  }
}

console.log('workspaceTabFallback tests passed');
