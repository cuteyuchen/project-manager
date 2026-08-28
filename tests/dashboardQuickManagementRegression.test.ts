import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const listItem = read('src/components/ProjectListItem.vue');
const treeNode = read('src/components/dashboard/ProjectTreeNode.vue');
const group = read('src/components/dashboard/ProjectTreeGroup.vue');
const dialog = read('src/components/dashboard/ProjectManagementDialog.vue');
const panel = read('src/components/dashboard/ProjectManagementPanel.vue');
const workspace = read('src/components/dashboard/ProjectWorkspace.vue');
const dashboard = read('src/views/Dashboard.vue');
const gitStore = read('src/stores/git.ts');

/***********************非 Git 与常驻操作*********************/
assert(!listItem.includes("t('dashboard.noGit')"), '一级项目行不应显示非 Git 的 No Git chip');
assert(/if \(overview\?\.isGitRepo\) result\[project\.id\] = overview/.test(dashboard), 'Dashboard 不应给非 Git 项目传递 Git overview');
assert(!/<el-dropdown/.test(listItem), 'treeMode 不应把主要操作收进更多菜单');
for (const icon of ['i-mdi-pin', 'i-mdi-code-tags', 'i-mdi-console-line', 'i-mdi-folder-open', 'i-mdi-pencil', 'i-mdi-tune-variant', 'i-mdi-open-in-new', 'i-mdi-delete']) {
  assert(listItem.includes(icon), `一级项目行应常驻操作图标：${icon}`);
}

/***********************Dialog 与共享面板*********************/
assert(/align-center/.test(dialog), '快速管理弹窗应使用 Element Plus 居中能力');
assert(/width="min\(80vw, calc\(100vw - 32px\)\)"/.test(dialog), '快速管理弹窗默认宽度应限制为 80vw 与安全边距的较小值');
assert(
  /height: 'min\(80vh, calc\(100vh - 32px\)\)'/.test(dialog)
  && /height: min\(80vh, calc\(100vh - 32px\)\)/.test(dialog),
  '快速管理弹窗应固定为窗口高度的 80%并受安全边距限制',
);
assert(/maxHeight: 'calc\(100vh - 32px\)'/.test(dialog), '快速管理弹窗小窗口时仍应受安全高度限制');
assert(!/margin:\s*0 auto/.test(dialog) && !/margin:\s*-/.test(dialog), 'Dialog 不应覆盖 Element Plus 的居中 margin');
assert(/\.project-management-dialog-body \{[\s\S]*flex: 1 1 auto[\s\S]*height: 100%[\s\S]*min-height: 0/.test(dialog), 'Dialog body 承载层应填满扣除 Header 后的剩余高度');
assert(/\.project-management-dialog-body \{[\s\S]*flex-direction: column/.test(dialog), 'Dialog body 承载层应使用纵向布局分配内容高度');
assert(/\.project-management-dialog-body > \.project-management-panel \{[\s\S]*flex: 1 1 auto[\s\S]*height: 100%[\s\S]*min-height: 0/.test(dialog), '共享管理面板应填满 Dialog body');
assert(/append-to-body 后弹层挂到 body[\s\S]*<style>[\s\S]*\.project-management-dialog\.el-dialog \{/.test(dialog), 'Teleport 弹窗外层样式应放在非 scoped style 中');
assert(/\.project-management-dialog \.el-dialog__body \{[\s\S]*flex: 1 1 0%[\s\S]*height: auto[\s\S]*min-height: 0/.test(dialog), 'Element Plus body 应通过 flex 分配扣除 Header 后的剩余高度');
assert(!/:deep\(\.project-management-dialog/.test(dialog), 'Teleport 弹窗外层样式不应依赖 scoped deep');
assert(dialog.includes('useProjectExternalActions'), 'Dialog Header 应复用外部打开 composable');
assert(dialog.includes("t('dashboard.openInEditor')") && dialog.includes("t('dashboard.openInTerminal')") && dialog.includes("t('dashboard.openInExplorer')"), 'Dialog Header 应提供三个外部快捷入口');
assert(dialog.includes("t('project.editProject')") && dialog.includes("t('dashboard.openFullWorkspace')"), 'Dialog Header 应提供编辑与完整工作区入口');
assert(workspace.includes('flex-1 min-w-0 flex overflow-hidden'), '完整工作区右栏父容器应允许管理面板占满剩余宽度');
assert(/class="project-management-panel flex-1 min-w-0 w-full h-full/.test(panel), '共享管理面板应提供 flex/width/height contract');
assert(/v-if="hasGitRepo"[\s\S]*t\('git\.title'\)/.test(panel), 'Panel 的 Git 页签必须受 Git capability 控制');
assert(/async function initRepo[\s\S]*isGitRepo\.value\[projectId\] = true[\s\S]*refreshSummaryAndStatus/.test(gitStore), '初始化 Git 后 store 应立即更新 capability 并刷新状态');
assert(workspace.includes('<ProjectManagementPanel :project="workspaceProject" />') && dialog.includes('<ProjectManagementPanel'), 'Workspace 与 Dialog 必须共用 ProjectManagementPanel');

/***********************同父级排序与筛选约束*********************/
assert(treeNode.includes('useListDragSort'), '树节点子项目应复用 useListDragSort');
assert(/items: allChildren/.test(treeNode), '每个树节点的排序源应是直接子节点');
assert(/class="project-tree-children"[\s\S]*draggable-list/.test(treeNode), '展开节点应把直接子节点作为独立 draggable-list');
assert(/:drag-handler="draggable \? handleChildDragStart : undefined"/.test(treeNode), '子项目拖拽处理器应沿父级传递');
assert(/:draggable="draggable"/.test(treeNode), 'child 与 grandchild 在允许排序时都应获得 drag handle');
assert(/sortMode\.value === 'default'[\s\S]*!searchQuery\.value\.trim\(\)[\s\S]*activeQuickFilter\.value === 'all'/.test(dashboard), '搜索/筛选时不应启用树内拖拽');
assert(group.includes(':draggable="draggable"'), 'root 分组仍应保留 root drag contract');

console.log('dashboard quick management regression tests passed');
