import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const projectListItem = readFileSync(resolve(root, 'src/components/ProjectListItem.vue'), 'utf8');
const projectWorkspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const explorer = readFileSync(resolve(root, 'src/components/dashboard/WorkspaceProjectExplorer.vue'), 'utf8');
const managementPanel = readFileSync(resolve(root, 'src/components/dashboard/ProjectManagementPanel.vue'), 'utf8');

/***********************子项目列表卡片布局*********************/

assert(
  /layout\?:\s*'inline'\s*\|\s*'stacked'/.test(projectListItem),
  'ProjectListItem 应提供 stacked 布局用于窄侧栏',
);

assert(
  /project-row-stacked/.test(projectListItem),
  'ProjectListItem stacked 模式应有独立样式类',
);

assert(/<WorkspaceProjectExplorer/.test(projectWorkspace), 'ProjectWorkspace 应渲染统一 Project Explorer');

assert(
  /project-row-actions/.test(projectListItem),
  'ProjectListItem 应把操作按钮收敛到可重排的 actions 容器',
);

assert(
  /class="workspace-project-explorer[^\"]*w-80/.test(explorer),
  'Project Explorer 左栏应保持 w-80 宽度，减少名称和路径截断',
);

assert(
  /:selected-project-id="selectedProject\?\.id \|\| null"/.test(projectWorkspace)
  && /class="explorer-tree min-h-0 flex-1 overflow-y-auto/.test(explorer),
  'Explorer 应把项目选择与文件树滚动区域分离',
);

assert(
  /<KeepAlive :max="KEEP_ALIVE_MAX">/.test(managementPanel),
  '共享管理面板的 KeepAlive 必须设上限，否则缓存实例会随访问过的子项目数线性增长',
);

assert(
  !/\.project-row-stacked\s+\.project-row-title\s*\{[^}]*flex-basis:\s*100%/.test(projectListItem),
  'stacked 模式下项目名称不应独占整行，应与收藏图标同一行显示',
);

assert(
  /\.project-row-stacked\s+\.project-row-leading\s*\{[^}]*padding-top:\s*4px/.test(projectListItem),
  'stacked 模式下收藏图标应与项目名称保持视觉基线对齐',
);

console.log('subProjectListLayout tests passed');
