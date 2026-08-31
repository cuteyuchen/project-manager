import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project } from '../src/types.ts';
import { buildProjectSearchEntry, projectSearchEntryMatches } from '../src/utils/projectSearch.ts';
import { collectVisibleProjectIds } from '../src/utils/projectTreeView.ts';
import { computeManualOrderAssignments } from '../src/utils/projectTree.ts';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const switcher = read('src/components/dashboard/ProjectSwitcherPopover.vue');
const dialog = read('src/components/dashboard/ProjectManagementDialog.vue');
const panel = read('src/components/dashboard/ProjectManagementPanel.vue');
const dashboard = read('src/views/Dashboard.vue');
const listItem = read('src/components/ProjectListItem.vue');
const treeNode = read('src/components/dashboard/ProjectTreeNode.vue');

const projects: Project[] = [
  { id: 'root', name: '小流域', path: 'E:\\projects\\basin', type: 'other' },
  { id: 'child', name: 'backend', path: 'E:\\projects\\basin\\backend', type: 'other', parentId: 'root' },
  { id: 'grandchild', name: 'frontend', path: 'E:\\projects\\basin\\backend\\frontend', type: 'node', parentId: 'child' },
  { id: 'other', name: '个人项目', path: 'E:\\projects\\personal', type: 'other' },
];

/***********************项目搜索*********************/
assert(projectSearchEntryMatches(buildProjectSearchEntry(projects[0]), '小流域'), '应支持搜索 root 项目名称');
assert(projectSearchEntryMatches(buildProjectSearchEntry(projects[1]), 'backend'), '应支持搜索 child 项目名称');
assert(projectSearchEntryMatches(buildProjectSearchEntry(projects[2]), 'frontend'), '应支持搜索 grandchild 项目名称');
assert(projectSearchEntryMatches(buildProjectSearchEntry({
  ...projects[0],
  name: '前端服务',
}), 'qd'), '应支持拼音首字母搜索');
assert(projectSearchEntryMatches(buildProjectSearchEntry({
  ...projects[0],
  description: '内部管理后台',
}), '管理后台'), '应支持搜索描述');

assert.deepEqual(
  [...collectVisibleProjectIds(projects, ['grandchild'])].sort(),
  ['child', 'grandchild', 'root'],
  '搜索深层项目时应保留必要祖先路径',
);

/***********************切换器结构与状态*********************/
assert(/projects: readonly Project\[\]/.test(switcher), '切换器应接收全部已登记项目');
assert(/collectVisibleProjectIds/.test(switcher), '切换器应复用树搜索祖先保留逻辑');
assert(/collectAutoExpandedProjectIds/.test(switcher), '切换器应复用祖先自动展开逻辑');
assert(/visit\(undefined, 0\)/.test(switcher), '切换器应从 root 开始构建层级行');
assert(/row\.depth \* 18/.test(switcher), '切换器应通过深度缩进展示 child / grandchild');
assert(/expandedProjectIds/.test(switcher) && /effectiveExpandedProjectIds/.test(switcher), '切换器应维护独立的展开状态');
assert(/project-switcher-tree-toggle/.test(switcher) && /toggleExpanded/.test(switcher), '子项目应通过独立按钮展开/收起');
assert(/hasChildren\(project\.id\)[\s\S]*effectiveExpandedProjectIds\.value\.has\(project\.id\)/.test(switcher), '切换器默认不应递归铺开所有子项目');
assert(/currentProjectId/.test(switcher) && /project-switcher-row-active/.test(switcher), '当前项目应有选中态');
assert(!switcher.includes('dashboard.noGit'), '非 Git 项目不应显示 No Git');
assert(/project-switcher-git-dirty/.test(switcher), '切换器应支持缓存中的 Git dirty 简要状态');
assert(/emit\('select', project\)/.test(switcher), '切换器选择项目应 emit 项目对象');

assert(/select-project/.test(dialog), 'Dialog 应接收切换器选择事件');
assert(/:current-project-id="project\?\.id"/.test(dialog), '切换器当前项目应绑定 Dialog 当前项目');
assert(/managementProjectId = \$event\.id/.test(dashboard), 'Dashboard 应继续持有唯一 managementProjectId 数据源');
assert(/:projects="projectStore\.projects"/.test(dashboard), 'Dialog 应接收全部项目列表');

/***********************Tab 保持与 capability*********************/
assert(/gitCapabilityKnown/.test(panel), '切换 Tab 前应区分 Git capability 未确认与非 Git');
assert(/preferredTab = firstActivation \? props\.initialTab : activeTab\.value/.test(panel), '切换项目时应优先保留当前 Tab');
assert(/forceGitCheck: pathChanged/.test(panel), '项目路径变化时应强制重新确认 Git capability');
assert(/void activate\(requestedTab\)/.test(panel), 'requestedRightTab 应经过统一 capability fallback');
assert(/v-if="hasGitRepo"[\s\S]*t\('git\.title'\)/.test(panel), 'Git Tab 只能在 Git capability 可用时渲染');

/***********************同父级排序*********************/
assert(/project\.parentId !== props\.project\.id/.test(treeNode), '子项目拖拽必须校验直接 parentId');
assert(/ordered\.filter\(child => child\.parentId === props\.project\.id\)/.test(treeNode), '排序写回前必须只接受同父级兄弟');

const siblings = [
  { id: 'child-a', parentId: 'root' },
  { id: 'child-b', parentId: 'root' },
  { id: 'foreign', parentId: 'other-root' },
];
const reordered = [siblings[1], siblings[0]];
const assignments = computeManualOrderAssignments(reordered);
assert.deepEqual(assignments.map(item => [item.id, item.sortOrder]), [
  ['child-b', 0],
  ['child-a', 1],
]);
assert(reordered.every(project => project.parentId === 'root'), '同父级排序不应改变 parentId');
assert(!/<el-dropdown/.test(listItem), '树模式主要操作不应藏进更多菜单');

console.log('projectSwitcher tests passed');
