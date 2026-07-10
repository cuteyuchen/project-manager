import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const projectListItem = readFileSync(resolve(root, 'src/components/ProjectListItem.vue'), 'utf8');
const projectWorkspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');

/***********************子项目列表卡片布局*********************/

assert(
  /layout\?:\s*'inline'\s*\|\s*'stacked'/.test(projectListItem),
  'ProjectListItem 应提供 stacked 布局用于窄侧栏',
);

assert(
  /project-row-stacked/.test(projectListItem),
  'ProjectListItem stacked 模式应有独立样式类',
);

assert(
  /(?:\:layout="['"]stacked['"]"|layout="stacked")/.test(projectWorkspace),
  'ProjectWorkspace 的子项目列表应启用 stacked 卡片布局',
);

assert(
  /project-row-actions/.test(projectListItem),
  'ProjectListItem 应把操作按钮收敛到可重排的 actions 容器',
);

assert(
  /class="w-80 shrink-0 flex flex-col/.test(projectWorkspace),
  '子项目列表应加宽到 w-80，减少名称和路径截断',
);

assert(
  !/\.project-row-stacked\s+\.project-row-title\s*\{[^}]*flex-basis:\s*100%/.test(projectListItem),
  'stacked 模式下项目名称不应独占整行，应与收藏图标同一行显示',
);

console.log('subProjectListLayout tests passed');
