import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const addProjectModal = readFileSync(resolve(root, 'src/components/AddProjectModal.vue'), 'utf8');
const dashboard = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const projectListItem = readFileSync(resolve(root, 'src/components/ProjectListItem.vue'), 'utf8');

/***********************手动导入子项目*********************/

assert(
  /api\.scanSubProjects\(selected\)/.test(addProjectModal),
  '手动选择本地目录时应扫描子项目',
);

assert(
  /api\.scanSubProjects\(form\.value\.path\)/.test(addProjectModal),
  'Git 克隆完成后应重新扫描子项目',
);

assert(
  /emit\('add', project, convertSubProjectCandidates\(scannedSubProjects\.value\)\)/.test(addProjectModal),
  '新增项目事件应携带统一转换后的子项目',
);

assert(
  /projectStore\.addSubProjects\(project\.id, children\)/.test(dashboard),
  'Dashboard 添加根项目后应挂载扫描到的子项目',
);

/***********************父项目虚拟入口*********************/

assert(
  /v-if="currentNode"[\s\S]*?parentProjectEntry/.test(workspace),
  '存在子项目时应始终显示父项目入口',
);

assert(
  /selectedLeafId\.value = currentNode\.value\.id/.test(workspace),
  '选择父项目入口后应将父项目作为活动项目',
);

assert(
  /displayName\?: string/.test(projectListItem) && /displayName \|\| project\.name/.test(projectListItem),
  '项目列表项应支持只覆盖显示名称而不修改项目数据',
);

console.log('import workflow consistency tests passed');
