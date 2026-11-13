import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 回归：在快速管理弹窗里把 Git 模块切到「提交历史」，点「进入完整工作区」后，
 * 完整工作区也必须停在提交历史，而不是回落到默认的「文件状态」。
 *
 * 根因是子页签存在 GitView 的局部 ref 里，而弹窗与完整工作区是两个独立实例
 * （ProjectManagementPanel 的 :key 也按项目绑定），局部状态无法跨实例传递。
 * 修复方式是把子页签放进 git store，按项目分桶。
 */

const gitStore = readFileSync(resolve(process.cwd(), 'src/stores/git.ts'), 'utf8');
assert(
  /const subTab = ref<Record<string, GitSubTab>>\(\{\}\)/.test(gitStore),
  'Git 子页签必须按项目存在 store 里，否则两个实例无法共享',
);
assert(
  /function getSubTab\(projectId: string\): GitSubTab/.test(gitStore),
  'store 应暴露 getSubTab 读取当前子页签',
);
assert(
  /function rememberSubTab\(projectId: string, tab: GitSubTab\): void/.test(gitStore),
  'store 应暴露 rememberSubTab 写入子页签',
);
assert(
  /return subTab\.value\[projectId\] \?\? 'changes'/.test(gitStore),
  '未选择过时应回落到「文件状态」',
);
assert(
  /prune\(subTab\.value\)/.test(gitStore),
  '项目删除后应清理子页签记录，避免 Record 无限增长',
);

const gitView = readFileSync(resolve(process.cwd(), 'src/components/git/GitView.vue'), 'utf8');
assert(
  !/const activeTab = ref<'changes' \| 'history'>\('changes'\)/.test(gitView),
  '子页签不能再用组件局部 ref，否则弹窗与工作区各存一份',
);
assert(
  /get: \(\) => gitStore\.getSubTab\(props\.project\.id\)/.test(gitView),
  'GitView 应从 store 读取子页签',
);
assert(
  /set: \(tab\) => gitStore\.rememberSubTab\(props\.project\.id, tab\)/.test(gitView),
  'GitView 切换子页签时应写回 store，供另一个实例读取',
);

// 弹窗切页签不应清掉另一个实例正在显示的 diff
assert(
  /if \(isViewActive\.value\) \{\s*gitStore\.clearDiff\(props\.project\.id\)/.test(gitView),
  '共享子页签后，只有可见实例才能清 diff，否则会清掉对方正在看的内容',
);

const types = readFileSync(resolve(process.cwd(), 'src/types.ts'), 'utf8');
assert(
  /export type GitSubTab = 'changes' \| 'history'/.test(types),
  '子页签类型应集中定义，避免字符串字面量散落',
);

console.log('gitSubTabSync tests passed');
