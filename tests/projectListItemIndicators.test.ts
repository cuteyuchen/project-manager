import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const projectListItem = readFileSync(resolve(root, 'src/components/ProjectListItem.vue'), 'utf8');
const dashboard = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const theme = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8');

/***********************项目卡片左上角图标布局*********************/

const leadingSlotIndex = projectListItem.indexOf('<slot name="leading" />');
const healthBadgeIndex = projectListItem.indexOf('<HealthBadge');

assert(
  leadingSlotIndex >= 0,
  'ProjectListItem should expose a leading slot for the drag handle',
);
assert(
  healthBadgeIndex > leadingSlotIndex,
  'HealthBadge should render next to the leading drag handle in the same row',
);
assert(
  !/<HealthBadge[^>]*class="[^"]*absolute/.test(projectListItem),
  'HealthBadge should not be absolutely positioned away from the drag handle',
);
assert(
  /<template\s+#leading>[\s\S]*class="drag-handle"/.test(dashboard),
  'Dashboard should pass the drag handle through the ProjectListItem leading slot',
);
// 拖拽样式已移到 styles/theme.css，与工作区的子项目列表共用一份
assert(
  /\.drag-handle\s*\{/.test(theme),
  '拖拽手柄样式应放在共享的 theme.css，供项目列表与子项目列表共用',
);
assert(
  !/\.drag-handle\s*\{[^}]*position:\s*absolute/.test(theme),
  'Drag handle should participate in the title-row layout instead of absolute positioning',
);

console.log('projectListItemIndicators tests passed');
