import assert from 'node:assert/strict';
import { resolveActiveConsoleTab } from '../src/utils/consoleTabs.ts';

/*********************** 场景：build 结束，dev 仍在运行 ***********************/
// 用户正在看 npm run build；它刚结束（会话还在，状态是 success），
// dev 仍在 running。修复前这里会跳到 dev，用户看不到构建结果。
assert.equal(
  resolveActiveConsoleTab({
    activeTab: 'script:build',
    openTabs: ['script:dev', 'script:build'],
    runningTabs: ['script:dev'],
    activeTabHasSession: true,
  }),
  'script:build',
  '当前页签的会话结束后必须留在原地',
);

/*********************** 新启动的命令仍然抢焦点 ***********************/
assert.equal(
  resolveActiveConsoleTab({
    activeTab: 'script:build',
    openTabs: ['script:build', 'script:dev'],
    runningTabs: ['script:dev'],
    startedTab: 'script:dev',
    activeTabHasSession: true,
  }),
  'script:dev',
  '用户刚启动 dev 时应切到 dev',
);

/*********************** 没有选中页签时补一个 ***********************/
assert.equal(
  resolveActiveConsoleTab({
    activeTab: null,
    openTabs: ['script:test', 'script:dev'],
    runningTabs: ['script:dev'],
  }),
  'script:dev',
  '没有选中页签时优先落到运行中的页签',
);

assert.equal(
  resolveActiveConsoleTab({
    activeTab: null,
    openTabs: ['script:test'],
    runningTabs: [],
  }),
  'script:test',
  '都结束后落到最新打开的页签',
);

/*********************** 当前页签被关闭 / 会话被清理 ***********************/
assert.equal(
  resolveActiveConsoleTab({
    activeTab: 'script:gone',
    openTabs: ['script:dev'],
    runningTabs: ['script:dev'],
    activeTabHasSession: false,
  }),
  'script:dev',
  '页签已关闭时切到仍在运行的页签',
);

assert.equal(
  resolveActiveConsoleTab({
    activeTab: 'script:stale',
    openTabs: ['script:stale'],
    runningTabs: [],
    activeTabHasSession: false,
  }),
  'script:stale',
  '唯一页签的会话被清理时不要清空选中态',
);

assert.equal(
  resolveActiveConsoleTab({
    activeTab: null,
    openTabs: [],
    runningTabs: [],
  }),
  null,
);

console.log('consoleTabSelection tests passed');
