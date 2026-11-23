import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project } from '../src/types.ts';
import { buildProjectSearchEntry, projectSearchEntryMatches } from '../src/utils/projectSearch.ts';
import { collectVisibleProjectIds } from '../src/utils/projectTreeView.ts';
import { collectSubProjectRows, computeManualOrderAssignments } from '../src/utils/projectTree.ts';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const switcher = read('src/components/dashboard/ProjectSwitcherPopover.vue');
const subSwitcher = read('src/components/dashboard/SubProjectSwitcher.vue');
const dialog = read('src/components/dashboard/ProjectManagementDialog.vue');
const workspace = read('src/components/dashboard/ProjectWorkspace.vue');
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

/***********************下拉框：只列一级项目*********************/
assert(/projects: readonly Project\[\]/.test(switcher), '切换器应接收全部已登记项目');
assert(/\.filter\(project => !project\.parentId\)/.test(switcher), '下拉框只应列出一级项目（parentId 为空）');
assert(!/project-switcher-tree-toggle/.test(switcher), '下拉框不应再提供树形展开按钮');
assert(!/row\.depth \* 18/.test(switcher), '下拉框不应再按深度缩进子项目');
assert(!/toggleExpanded/.test(switcher), '下拉框应放弃本地展开状态');
assert(/currentRootId/.test(switcher) && /project-switcher-row-active/.test(switcher), '当前所在的一级项目应有选中态');
assert(/current\.parentId/.test(switcher), '当前项目是子项目时应回溯到所在的一级项目');
assert(!switcher.includes('dashboard.noGit'), '非 Git 项目不应显示 No Git');
assert(/project-switcher-git-dirty/.test(switcher), '切换器应支持缓存中的 Git dirty 简要状态');
assert(/emit\('select', project\)/.test(switcher), '切换器选择项目应 emit 项目对象');
assert(/scrollToActive/.test(switcher), '切换器应支持自动定位当前激活项目');
assert(/visible\?: boolean/.test(switcher), '切换器应支持 visible 响应式属性以在展示时触发定位');
assert(/defineExpose\(\{\s*scrollToActive,?\s*\}\)/.test(switcher), '切换器应暴露 scrollToActive 方法');
assert(/handleSwitcherShow/.test(workspace) && /scrollToActive/.test(workspace), '工作区面包屑下拉展开时应安全触发自动定位');
assert(/handleDialogSwitcherShow/.test(dialog) && /scrollToActive/.test(dialog), '管理弹窗切换器展开时应安全触发自动定位');

/***********************子级项目切换器（弹窗右侧）*********************/
assert(/collectSubProjectRows/.test(subSwitcher), '子级切换器应复用子项目平铺工具');
assert(/is-depth-2/.test(subSwitcher) && /is-depth-3/.test(subSwitcher), '不同层级的子项目应有颜色区分');
assert(/@click\.stop="emit\('select', chip\.project\)"/.test(subSwitcher), '点击子项目胶囊应切换项目');
assert(/runningCountByProjectId/.test(subSwitcher) && /sub-project-chip-running/.test(subSwitcher), '运行中的子项目应在胶囊上标出状态');
assert(/ensureSummaryAndStatus/.test(subSwitcher) && /getSummary\(/.test(subSwitcher), '分支应复用 git summary 缓存并在胶囊出现时按需拉取');
assert(/sub-project-chip-branch/.test(subSwitcher), '胶囊应展示子项目当前分支');

assert(/<SubProjectSwitcher/.test(dialog), '弹窗应在一级项目下拉右侧渲染子级项目切换器');
assert(/:root-id="rootProject\?\.id \|\| null"/.test(dialog), '子级切换器应绑定当前一级项目');
assert(/:current-project-id="project\?\.id"/.test(dialog), '子级切换器应高亮当前项目');
assert(
  (dialog.match(/:running-count-by-project-id="runningCountByProjectId"/g) || []).length === 2,
  '下拉与子级切换器都应接收运行中计数',
);
assert(/const rootProject = computed<Project \| null>/.test(dialog), '弹窗应回溯出当前项目所属的一级项目');
assert(!/SubProjectSwitcher/.test(workspace), '项目详情页不渲染子级项目切换器（左侧文件树已可选择）');

assert(/select-project/.test(dialog), 'Dialog 应接收切换器选择事件');
assert(/managementProjectId = \$event\.id/.test(dashboard), 'Dashboard 应继续持有唯一 managementProjectId 数据源');
assert(/:projects="projectStore\.projects"/.test(dashboard), 'Dialog 应接收全部项目列表');

/***********************子项目平铺：层级与顺序*********************/
assert.deepEqual(
  collectSubProjectRows(projects, 'root').map(row => [row.project.id, row.depth]),
  [['child', 2], ['grandchild', 3]],
  '二级套三级时二级容器与三级项目都要平铺出来，并按层级标注 depth',
);
assert.deepEqual(collectSubProjectRows(projects, null), [], '没有一级项目时不应有子项目');
assert.deepEqual(collectSubProjectRows(projects, 'other'), [], '没有子项目的一级项目应为空');

/***********************Tab 保持与 capability*********************/
assert(/gitCapabilityKnown/.test(panel), '切换 Tab 前应区分 Git capability 未确认与非 Git');
assert(/preferredTab = projectChanged[\s\S]*rememberedTab/.test(panel), '切换项目时应优先恢复目标项目上次选中的 Tab');
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
