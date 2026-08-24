import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const component = readFileSync(resolve(root, 'src/components/UpdateProgress.vue'), 'utf8');

assert(/<Teleport to="body">/.test(component), '更新进度浮层必须挂到 body，避免被应用壳定位规则覆盖');
assert(/<el-card\b/.test(component), '更新进度应使用 Element Plus 卡片承载');
assert(/<el-progress\b/.test(component), '更新进度应使用 Element Plus 进度条');
assert(/<el-tooltip\b/.test(component), '更新操作按钮应提供 Element Plus 工具提示');
assert(/<el-button\b[\s\S]{0,180}?@click="\$emit\('background'\)"/.test(component), '后台下载操作必须保留');
assert(/<el-button\b[\s\S]{0,180}?@click="\$emit\('cancel'\)"/.test(component), '取消下载操作必须保留');
assert(/\.update-progress-panel\s*\{[\s\S]{0,180}?position:\s*fixed;/.test(component), '浮层必须使用视口固定定位');

console.log('update progress tests passed');
