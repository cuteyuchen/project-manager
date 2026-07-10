import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const views = [
  'src/views/Dashboard.vue',
  'src/views/NodeManager.vue',
  'src/views/PortManager.vue',
  'src/views/CommitCalendar.vue',
  'src/views/Settings.vue',
];

for (const view of views) {
  const source = read(view);
  assert(/app-page-header/.test(source), `${view} 应使用统一页面头部`);
  assert(/app-page-header-main/.test(source), `${view} 应使用统一标题与操作布局`);
  assert(/app-content-container/.test(source), `${view} 的头部应使用统一内容宽度`);
  assert(/app-page-title/.test(source), `${view} 应使用统一标题样式`);
}

const theme = read('src/styles/theme.css');
assert(/\.app-page-header-main\s*\{/.test(theme), '主题应提供统一头部布局');
assert(/\.app-page-actions\s*\{/.test(theme), '主题应提供统一操作区布局');
assert(/\.app-page-header-extra\s*\{/.test(theme), '主题应提供统计和筛选扩展区');

console.log('page header consistency tests passed');
