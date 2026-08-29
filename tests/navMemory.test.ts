import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { setActivePinia, createPinia } from 'pinia';
import { useNavMemoryStore } from '../src/stores/navMemory.ts';

setActivePinia(createPinia());
const nav = useNavMemoryStore();

/***********************页签记忆*********************/

assert.equal(nav.getLeafTab('leaf-1'), null, '没有记忆时应返回 null，由调用方回落默认页签');

nav.rememberLeafTab('leaf-1', 'git');
assert.equal(nav.getLeafTab('leaf-1'), 'git');
assert.equal(nav.getLeafTab('leaf-2'), null, '不同叶子的记忆互不影响');

nav.rememberLeafTab('leaf-1', 'files');
assert.equal(nav.getLeafTab('leaf-1'), 'files', '后写的应覆盖先写的');

/***********************层级选中记忆*********************/

const alwaysUsable = () => true;
const neverUsable = () => false;

assert.equal(nav.getLevelLeaf('level-1', alwaysUsable), null, '没有记忆时返回 null');

nav.rememberLevelLeaf('level-1', 'child-a');
assert.equal(nav.getLevelLeaf('level-1', alwaysUsable), 'child-a');

// null 是**有效**记忆，表示「选中的是父项目入口卡本身」，
// 不能和「没有记忆」混为一谈
nav.rememberLevelLeaf('level-2', null);
assert.equal(nav.getLevelLeaf('level-2', neverUsable), null, '记的是父项目自身时不该去跑叶子校验');
assert.equal('level-2' in nav.memory.levelLeaf, true, '父项目自身这条记忆不应被误删');

/***********************失效记忆的惰性自愈*********************/

nav.rememberLevelLeaf('level-3', 'deleted-child');
assert.equal(nav.getLevelLeaf('level-3', neverUsable), null, '校验失败应返回 null');
assert.equal(
  'level-3' in nav.memory.levelLeaf,
  false,
  '校验失败时应顺手删掉这条记忆——这是覆盖「项目被搬到别的父级」的唯一路径',
);

/***********************项目删除后的裁剪*********************/

nav.clearAll();
nav.rememberLeafTab('alive', 'git');
nav.rememberLeafTab('gone', 'console');
nav.rememberLevelLeaf('alive-level', 'alive');
nav.rememberLevelLeaf('gone-level', 'gone');
nav.rememberLevelLeaf('alive-level-2', 'gone');
nav.rememberLevelLeaf('self-level', null);

nav.cleanupRemovedProjects(['alive', 'alive-level', 'alive-level-2', 'self-level']);

assert.equal(nav.getLeafTab('alive'), 'git', '存活项目的页签记忆应保留');
assert.equal(nav.getLeafTab('gone'), null, '已删除项目的页签记忆应裁掉');
assert.equal(nav.getLevelLeaf('alive-level', alwaysUsable), 'alive');
assert.equal('gone-level' in nav.memory.levelLeaf, false, '层级本身被删应裁掉');
assert.equal(
  'alive-level-2' in nav.memory.levelLeaf,
  false,
  '层级还在但它记住的叶子被删，这条记忆也该裁掉',
);
assert.equal('self-level' in nav.memory.levelLeaf, true, '「选中父项目自身」的记忆不该被裁掉');

/***********************clearAll*********************/

nav.clearAll();
assert.deepEqual(nav.memory.leafTab, {});
assert.deepEqual(nav.memory.levelLeaf, {});

/***********************源码约束*********************/

const root = process.cwd();
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const managementPanel = readFileSync(resolve(root, 'src/components/dashboard/ProjectManagementPanel.vue'), 'utf8');
const projectStore = readFileSync(resolve(root, 'src/stores/project.ts'), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const workspaceCode = stripComments(workspace);
const managementPanelCode = stripComments(managementPanel);

assert(
  /useNavMemoryStore\(\)/.test(workspaceCode)
  && /navMemory\.getLevelLeaf\(root\.id[\s\S]{0,500}?isProjectInWorkspace/.test(workspaceCode),
  '完整工作区应按 root 恢复仍属于该工作区的选中项目',
);

assert(
  /navMemory\.rememberLevelLeaf\(root\.id[\s\S]{0,180}?nextProjectId/.test(workspaceCode)
  && /function selectProject[\s\S]{0,260}?navMemory\.rememberLevelLeaf/.test(workspaceCode),
  'Explorer 选择项目后应更新该 root 的导航记忆',
);

// 恢复出的页签必须再过一次可用性判据，规则只有一份
assert(
  /resolveInitialTab[\s\S]{0,300}?resolveWorkspaceTabFallback/.test(managementPanelCode),
  '共享管理面板恢复页签后应复用 resolveWorkspaceTabFallback 校验，不要另写一份规则',
);

assert(
  /watch\([\s\S]{0,220}?props\.rootId[\s\S]{0,220}?resolveSelection/.test(workspaceCode)
  && /selectedProjectId\.value = nextProjectId/.test(workspaceCode),
  '切换工作区 root 时必须重新解析选中项目，避免上一个 root 的选择泄漏',
);

assert(
  /useNavMemoryStore\(\)\.cleanupRemovedProjects/.test(projectStore),
  '项目删除时应裁掉导航记忆',
);

console.log('navMemory tests passed');
