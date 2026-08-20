import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  readDiffSelection,
  writeDiffSelection,
  clearDiffSelection,
  pruneDiffSelections,
  isSameDiffSource,
  EMPTY_DIFF_SELECTION,
  MAX_DIFF_SELECTION_BUCKETS,
  type GitDiffSelectionByProject,
} from '../src/utils/gitDiffSelection.ts';

/***********************读：缺失时返回共享空桶*********************/

{
  const buckets: GitDiffSelectionByProject = {};
  const a = readDiffSelection(buckets, 'p1');
  const b = readDiffSelection(buckets, 'p2');
  assert.equal(a, EMPTY_DIFF_SELECTION, '没有桶时应返回共享常量');
  assert.equal(a, b, '两次读应返回同一个对象引用，避免下游 computed 无谓失效');
  assert.equal(a.file, '');
  assert.equal(a.content, '');
}

/***********************两个项目的桶互不干扰*********************/
// 这是分桶的全部意义：原先是全局单值，A 的 diff 会被切到 B 时清掉

{
  const buckets: GitDiffSelectionByProject = {};
  const order: string[] = [];

  writeDiffSelection(buckets, order, 'A', { content: 'diff-A', file: 'a.ts', staged: false, source: 'worktree' });
  writeDiffSelection(buckets, order, 'B', { content: 'diff-B', file: 'b.ts', staged: true, source: 'worktree' });

  assert.equal(readDiffSelection(buckets, 'A').content, 'diff-A');
  assert.equal(readDiffSelection(buckets, 'A').file, 'a.ts');
  assert.equal(readDiffSelection(buckets, 'B').content, 'diff-B');
  assert.equal(readDiffSelection(buckets, 'B').staged, true, 'staged 应按项目独立保存');

  // 清 A 不该影响 B
  clearDiffSelection(buckets, order, 'A');
  assert.equal(readDiffSelection(buckets, 'A').content, '', 'A 清完应回到空态');
  assert.equal('A' in buckets, false, '应 delete 键而不是留一个空对象长期占位');
  assert.equal(readDiffSelection(buckets, 'B').content, 'diff-B', '清 A 不应动到 B');
  assert.equal(order.includes('A'), false, '清桶应同时移出最近使用队列');
}

/***********************写：与既有值合并*********************/

{
  const buckets: GitDiffSelectionByProject = {};
  const order: string[] = [];
  writeDiffSelection(buckets, order, 'A', { content: 'v1', file: 'a.ts', staged: true, source: 'worktree' });
  writeDiffSelection(buckets, order, 'A', { content: 'v2' });

  const selection = readDiffSelection(buckets, 'A');
  assert.equal(selection.content, 'v2');
  assert.equal(selection.file, 'a.ts', '只传 content 时其余字段应保留');
  assert.equal(selection.staged, true);
}

// 空桶常量不能被写坏
{
  const buckets: GitDiffSelectionByProject = {};
  const order: string[] = [];
  writeDiffSelection(buckets, order, 'A', { content: 'x' });
  assert.equal(EMPTY_DIFF_SELECTION.content, '', '共享空桶必须保持不变');
  assert.equal(EMPTY_DIFF_SELECTION.file, '');
}

/***********************超限淘汰：只丢正文，留住文件名*********************/

{
  const buckets: GitDiffSelectionByProject = {};
  const order: string[] = [];
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];

  for (const id of ids) {
    writeDiffSelection(buckets, order, id, {
      content: `diff-${id}`,
      file: `${id}.ts`,
      staged: false,
      source: 'worktree',
    });
  }

  assert(order.length <= MAX_DIFF_SELECTION_BUCKETS, '最近使用队列不应超过上限');

  // 最久未用的应被丢掉正文，但仍记得看的是哪个文件——
  // 这样切回去时能按需重取，而不是显示成「什么都没选」
  const evicted = readDiffSelection(buckets, 'p1');
  assert.equal(evicted.content, '', '被淘汰的桶应丢掉正文');
  assert.equal(evicted.file, 'p1.ts', '被淘汰的桶应保留文件名以便重取');

  // 最近写的那个必须完好
  const latest = readDiffSelection(buckets, 'p5');
  assert.equal(latest.content, 'diff-p5');
}

// 重复访问同一项目会把它移到队尾，不该被自己挤掉
{
  const buckets: GitDiffSelectionByProject = {};
  const order: string[] = [];
  for (let i = 0; i < MAX_DIFF_SELECTION_BUCKETS + 3; i++) {
    writeDiffSelection(buckets, order, 'same', { content: `v${i}`, file: 'f.ts', staged: false, source: 'worktree' });
  }
  assert.equal(readDiffSelection(buckets, 'same').content, `v${MAX_DIFF_SELECTION_BUCKETS + 2}`);
  assert.equal(order.length, 1, '同一项目重复写不应在队列里堆积');
}

/***********************项目删除后裁剪*********************/

{
  const buckets: GitDiffSelectionByProject = {};
  const order: string[] = [];
  writeDiffSelection(buckets, order, 'alive', { content: 'x', file: 'a.ts', staged: false, source: 'worktree' });
  writeDiffSelection(buckets, order, 'gone', { content: 'y', file: 'b.ts', staged: false, source: 'worktree' });

  pruneDiffSelections(buckets, order, ['alive']);

  assert.equal('gone' in buckets, false, '已删除项目的桶应被裁掉');
  assert.equal(order.includes('gone'), false, '最近使用队列也要裁');
  assert.equal(readDiffSelection(buckets, 'alive').content, 'x', '存活项目不受影响');
}

/***********************来源比较*********************/

assert.equal(isSameDiffSource('worktree', 'worktree'), true);
assert.equal(isSameDiffSource('worktree', { commit: 'abc' }), false);
assert.equal(isSameDiffSource({ commit: 'abc' }, { commit: 'abc' }), true);
assert.equal(isSameDiffSource({ commit: 'abc' }, { commit: 'def' }), false);

/***********************源码约束：不再有全局单值与空参 clearDiff*********************/

const root = process.cwd();
const gitStore = readFileSync(resolve(root, 'src/stores/git.ts'), 'utf8');
const gitView = readFileSync(resolve(root, 'src/components/git/GitView.vue'), 'utf8');
const gitHistory = readFileSync(resolve(root, 'src/components/git/GitHistory.vue'), 'utf8');
const consoleView = readFileSync(resolve(root, 'src/components/ConsoleView.vue'), 'utf8');
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');

/**
 * 剥掉注释再做断言。
 * 这些文件的注释里会引用被删掉的旧写法（说明为什么删），
 * 直接对原文匹配会把解释性注释当成真实代码报错。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const gitStoreCode = stripComments(gitStore);
const gitViewCode = stripComments(gitView);
const gitHistoryCode = stripComments(gitHistory);
const consoleViewCode = stripComments(consoleView);

assert(
  !/const selectedDiff\b/.test(gitStoreCode) && !/selectedDiffFile/.test(gitStoreCode),
  'diff 选中态必须按 projectId 分桶，不能再有全局单值 ref',
);

assert(
  !/clearDiff\(\)/.test(gitStoreCode)
  && !/clearDiff\(\)/.test(gitViewCode)
  && !/clearDiff\(\)/.test(gitHistoryCode),
  'clearDiff 必须带 projectId：空参会清掉别的项目那一桶',
);

assert(
  /prune\(selectedCommitHash\.value\)/.test(gitStoreCode) && /pruneDiffSelections/.test(gitStoreCode),
  '项目删除后应裁掉 git store 的分桶缓存，否则会永久驻留',
);

/***********************源码约束：两个视图必须 props 驱动*********************/
// 读全局 activeProjectId 会让被 KeepAlive 缓存的实例跟着一起变，
// 于是停用中的实例也去跑「切项目」副作用，清掉新项目的状态。

assert(
  /defineProps<\{ project: Project \}>/.test(gitViewCode),
  'GitView 必须由 props 传入项目，不能读全局 activeProjectId',
);
assert(
  /defineProps<\{ project: Project \}>/.test(consoleViewCode),
  'ConsoleView 必须由 props 传入项目，不能读全局 activeProjectId',
);
assert(
  !/useProjectStore/.test(gitViewCode),
  'GitView 不应再依赖 project store',
);
assert(
  !/watch\(activeProject\b/.test(gitViewCode) && !/watch\(activeProject\b/.test(consoleViewCode),
  'props 冻结后 watch(activeProject) 永不触发，应删除而不是留着误导后人',
);
assert(
  /:project="activeLeaf"/.test(workspace),
  'ProjectWorkspace 必须把当前叶子项目传给 GitView / ConsoleView',
);

console.log('gitDiffSelection tests passed');
