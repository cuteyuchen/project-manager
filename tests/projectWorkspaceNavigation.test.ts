import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const explorer = readFileSync(resolve(root, 'src/components/dashboard/WorkspaceProjectExplorer.vue'), 'utf8');
const dashboard = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const app = readFileSync(resolve(root, 'src/App.vue'), 'utf8');
const theme = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8');

assert(workspace.includes("import WorkspaceProjectExplorer from './WorkspaceProjectExplorer.vue';"), '工作区应使用统一 Project Explorer');
assert(workspace.includes("import ProjectSwitcherPopover from './ProjectSwitcherPopover.vue';"), '工作区头部应复用项目快捷切换器');
assert(/:root-id="props\.rootId"/.test(workspace) && /:target-project-id="workspaceTargetProjectId"/.test(dashboard), '工作区应接收 root 与 targetProjectId 定位');
assert(/v-model:visible="switcherVisible"/.test(workspace) && /:projects="projectStore\.projects"/.test(workspace), '工作区项目名称应打开完整项目切换弹层');
assert(/function selectSwitcherProject/.test(workspace) && /emit\('open-project', project\)/.test(workspace), '工作区切换其它根项目应交给 Dashboard 重新定位');
assert(/@open-project="openProjectWorkspace"/.test(dashboard), 'Dashboard 应接收工作区快捷切换项目事件');
assert(/expandTargetAncestors/.test(explorer), 'Explorer 应自动展开目标项目的祖先');
assert(!/drillStack|navigationDirection|subProjectScrollPositions/.test(workspace), 'R1 工作区不应再依赖逐级钻取状态');
assert(/key="workspace"/.test(dashboard), '工作区应保持静态 key 以保留完整面板缓存');
assert(/container\.scrollTop = projectListScrollTop\.value/.test(dashboard), '从工作区返回项目列表时应恢复列表位置');
assert(!/name="page-fade"\s+mode="out-in"/.test(app), '功能页切换不应使用会产生空档的 out-in 模式');
assert(/\.page-fade-enter-active\s*\{[^}]*z-index:\s*2/s.test(theme), '新功能页应与旧页面交叠过渡');

console.log('project workspace navigation tests passed');
