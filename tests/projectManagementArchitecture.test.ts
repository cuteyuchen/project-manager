import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const workspace = read('src/components/dashboard/ProjectWorkspace.vue');
const dialog = read('src/components/dashboard/ProjectManagementDialog.vue');
const panel = read('src/components/dashboard/ProjectManagementPanel.vue');
const dashboard = read('src/views/Dashboard.vue');

/***********************共享管理面板架构*********************/
assert(workspace.includes("import ProjectManagementPanel from './ProjectManagementPanel.vue';"));
assert(/<ProjectManagementPanel :project="workspaceProject"\s*\/>/.test(workspace));
assert(dialog.includes("import ProjectManagementPanel from './ProjectManagementPanel.vue';"));
assert(/<ProjectManagementPanel[\s\S]*:project="project"/.test(dialog));

for (const component of ['ConsoleView', 'GitView', 'FrontendEnvPanel', 'FileManager', 'ProjectMemo']) {
  assert(panel.includes(`import ${component}`), `共享管理面板应集中引用 ${component}`);
}
assert(panel.includes('<KeepAlive :max="KEEP_ALIVE_MAX">'), '共享管理面板应保留有上限的 KeepAlive');
assert(!workspace.includes("import ConsoleView from"), 'ProjectWorkspace 不应复制 ConsoleView 逻辑');
assert(!workspace.includes("import GitView from"), 'ProjectWorkspace 不应复制 GitView 逻辑');

/***********************一级页入口架构*********************/
assert(dashboard.includes("import ProjectTreeGroup from '../components/dashboard/ProjectTreeGroup.vue';"));
assert(dashboard.includes("import ProjectManagementDialog from '../components/dashboard/ProjectManagementDialog.vue';"));
assert(/<ProjectManagementDialog[\s\S]*@open-workspace="openProjectWorkspace"/.test(dashboard));
assert(/<ProjectTreeGroup[\s\S]*@open-git="openProjectManagement\(\$event, 'git'\)"/.test(dashboard));
assert(
  dashboard.includes('visibleProjectMetrics.value.map(metric => metric.project)'),
  '虚拟列表模式的 Git 刷新应只跟随视口内 root 分组，而不是请求全部项目',
);

console.log('projectManagementArchitecture tests passed');
