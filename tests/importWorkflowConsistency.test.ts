import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const addProjectModal = readFileSync(resolve(root, 'src/components/AddProjectModal.vue'), 'utf8');
const dashboard = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const explorer = readFileSync(resolve(root, 'src/components/dashboard/WorkspaceProjectExplorer.vue'), 'utf8');
const explorerNode = readFileSync(resolve(root, 'src/components/dashboard/ProjectExplorerNode.vue'), 'utf8');
const projectListItem = readFileSync(resolve(root, 'src/components/ProjectListItem.vue'), 'utf8');

/***********************手动导入子项目*********************/

assert(
  /api\.scanSubProjects\(selected, NEW_PROJECT_SUB_DEPTH\)/.test(addProjectModal),
  '手动选择本地目录时应扫描子项目，且按新项目可用层级限制深度',
);

assert(
  /api\.scanSubProjects\(form\.value\.path, NEW_PROJECT_SUB_DEPTH\)/.test(addProjectModal),
  'Git 克隆完成后应重新扫描子项目，同样受可用层级限制',
);

assert(
  /const NEW_PROJECT_SUB_DEPTH = MAX_PROJECT_DEPTH - 1/.test(addProjectModal),
  '新项目是一级项目，其子项目从第 2 层起算，只剩 MAX-1 层可用；'
  + '若按 MAX 扫描会多扫一层，那层挂载时必被截断却已让用户白勾一遍',
);

assert(
  /emit\('add', project, scannedSubProjects\.value\)/.test(addProjectModal),
  '新增项目事件应携带后端返回的嵌套子项目树',
);

/***********************单个添加：弹出层级选择而非直接挂载*********************/

assert(
  !/projectStore\.addProjectTree\(project\.id, subProjectTree\)/.test(dashboard),
  '单个添加不应再直接挂载整棵树，应先让用户选择层级',
);

assert(
  /pendingLevelProject\.value = project/.test(dashboard)
  && /showLevelModal\.value = true/.test(dashboard),
  'Dashboard 添加项目后若扫描到子项目，应打开层级选择弹窗交由用户决定挂载哪几级',
);

assert(
  /<SubProjectScanModal[\s\S]*?:preset-nodes="pendingLevelNodes"/.test(dashboard),
  '层级选择弹窗应复用已扫描的候选树，避免重复请求后端',
);

assert(
  /@closed="handleLevelClosed"/.test(dashboard),
  '应等弹窗关闭动画结束再清理暂存，否则 v-if 会在点确认瞬间截断关闭动画',
);

/***********************编辑页可再次调整层级*********************/

assert(
  /<SubProjectScanModal[\s\S]*?:parent-project="editProject"/.test(addProjectModal),
  '编辑项目时应能再次打开层级管理弹窗调整子项目层级',
);

assert(
  /getProjectDepth\(props\.editProject\.id\) < MAX_PROJECT_DEPTH/.test(addProjectModal),
  '已达最大层级的项目不应再提供添加子项目的入口',
);

/***********************导入入口统一走按层级挂载*********************/

const importScanModal = readFileSync(resolve(root, 'src/components/ImportScanModal.vue'), 'utf8');
const subProjectScanModal = readFileSync(resolve(root, 'src/components/SubProjectScanModal.vue'), 'utf8');

for (const [name, source] of [
  ['ImportScanModal', importScanModal],
  ['SubProjectScanModal', subProjectScanModal],
] as const) {
  assert(
    /addProjectTree\(/.test(source),
    `${name} 应通过 addProjectTree 按层级挂载，避免孙级被平铺到父级`,
  );
  assert(
    !/addSubProjects\(/.test(source),
    `${name} 不应再使用只处理单层的 addSubProjects`,
  );
  assert(
    /pruneSelectedTree\(/.test(source),
    `${name} 应按勾选裁剪嵌套树后再入库`,
  );
}

assert(
  /MAX_PROJECT_DEPTH - parentDepth/.test(subProjectScanModal),
  '扫描已有项目的子项目时应传入剩余可用层级，保证扫描深度与项目树上限对齐',
);

assert(
  /api\.scanSubProjects\(node\.path, MAX_PROJECT_DEPTH - 1\)/.test(importScanModal),
  'ImportScanModal 的 direct 模式下所选目录将成为一级项目，扫描深度同样只剩 MAX-1 层',
);

/***********************批量导入仍直接全部添加*********************/

assert(
  /addProjectTree\(undefined, tree\)/.test(importScanModal),
  '批量导入应直接按层级挂载全部勾选结果，不再额外弹一次层级选择',
);

assert(
  !/SubProjectScanModal/.test(importScanModal),
  '批量导入不应弹出单项目的层级选择弹窗——它本身已有一棵可勾选的候选树',
);

/***********************层级选择弹窗的关闭契约*********************/

assert(
  /@closed="handleClosed"/.test(subProjectScanModal)
  && /emit\('closed'\)/.test(subProjectScanModal),
  '弹窗必须在关闭动画结束后通知调用方，否则用 v-if 承载它的调用方无法安全清理暂存状态',
);

assert(
  /\{ immediate: true \}/.test(subProjectScanModal),
  '调用方可能在挂载时 modelValue 已为 true，watch 需 immediate 才会加载候选树',
);

/***********************完整工作区 Explorer 入口*********************/

assert(
  workspace.includes("import WorkspaceProjectExplorer from './WorkspaceProjectExplorer.vue';")
  && /<WorkspaceProjectExplorer[\s\S]*:root-id="props\.rootId"[\s\S]*:selected-project-id="selectedProject\?\.id \|\| null"/.test(workspace),
  '完整工作区应通过 Explorer 同时承载根项目及其所有子项目',
);

assert(
  /<ProjectExplorerNode[\s\S]*:project="rootProject"/.test(explorer)
  && /<FileTreeNode[\s\S]*:relative-path="entry\.name"/.test(explorerNode),
  'Explorer 应从项目根节点进入真实文件树',
);

assert(
  /displayName\?: string/.test(projectListItem) && /displayName \|\| project\.name/.test(projectListItem),
  '项目列表项应支持只覆盖显示名称而不修改项目数据',
);

/***********************层级弹窗：可增也可减*********************/

assert(
  /allow-remove-existing/.test(subProjectScanModal),
  '层级管理弹窗应允许取消已导入项目的勾选（即移除），而不是只能新增',
);

assert(
  /collectDeselectedExistingPaths\(/.test(subProjectScanModal)
  && /projectStore\.removeProject\(/.test(subProjectScanModal),
  '被取消勾选的已导入项目应在确认时真正被移除',
);

assert(
  /ElMessageBox\.confirm\(/.test(subProjectScanModal),
  '移除会级联删除后代，属于不可撤销操作，必须二次确认',
);

assert(
  /collectDescendantIds\(/.test(subProjectScanModal),
  '二次确认应算出连带删除的后代总数——只报"移除 N 个"会低估真实影响',
);

/***********************已有子树必须并入候选*********************/

assert(
  /mergeExistingSubtree\(/.test(subProjectScanModal)
  && /buildExistingSubtree\(/.test(subProjectScanModal),
  '扫描覆盖不到全部已有子项目（深度用尽、父目录带清单不再递归），'
  + '必须把已入库的子树并入候选，否则那些子项目在弹窗里看不到也就删不掉',
);

assert(
  !/if \(!canAddChildren\.value\) \{\s*nodes\.value = \[\];/.test(subProjectScanModal),
  '已达最大层级时不能清空候选树——那样已有子项目会永远无法被移除',
);

assert(
  !/<el-button v-if="canAddChildren" type="primary"/.test(subProjectScanModal),
  '确认按钮不应被 canAddChildren 挡住，否则三级项目下的子项目无法移除',
);

/***********************批量导入保持纯新增语义*********************/

assert(
  !/allow-remove-existing/.test(importScanModal),
  '批量导入是纯新增语义，不应在一个叫"导入"的弹窗里误删已有项目',
);

/***********************移除作用域必须限定在当前父级的后代*********************/

assert(
  /collectDescendantIds\(props\.parentProject\.id\)/.test(subProjectScanModal),
  '移除作用域必须用 collectDescendantIds 限定在当前父项目的后代范围内',
);

assert(
  !/new Set\(projectStore\.projects\.map\(\(p\) => normalizeProjectPath\(p\.path\)\)\)/.test(subProjectScanModal),
  'existingPaths 不得取自全库项目——他处的同路径项目会显示「已存在」并默认勾选，'
  + '用户一取消就会把不属于本次编辑范围的项目连同其后代一起删掉',
);

assert(
  /scopedProjects/.test(subProjectScanModal)
  && /pathToProjectId[\s\S]{0,200}?scopedProjects/.test(subProjectScanModal),
  'pathToProjectId 同样必须基于作用域内的项目，否则会把他处项目的 id 交给 removeProject',
);

/***********************确认按钮不得因"无变更"而卡住*********************/

assert(
  !/:disabled="!hasChanges"/.test(subProjectScanModal),
  '确认按钮不得在无变更时禁用——用户会把"没什么可保存"读成"这个应用不让我保存"',
);

assert(
  /subProjectNoChanges/.test(subProjectScanModal),
  '无变更时应明确提示"层级没有变化"，而不是静默什么都不做',
);

console.log('import workflow consistency tests passed');
