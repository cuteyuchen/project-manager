import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const dashboard = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const app = readFileSync(resolve(root, 'src/App.vue'), 'utf8');
const theme = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8');

assert(/navigationDirection = ref<'forward' \| 'back'>/.test(workspace), '父子级导航应记录前进和返回方向');
assert(/workspace-forward-enter-from/.test(workspace), '进入子项目应提供前进方向动画');
assert(/workspace-back-enter-from/.test(workspace), '返回父项目应提供返回方向动画');
assert(/subProjectScrollPositions = new Map<string, number>/.test(workspace), '应按父项目记录子项目列表滚动位置');
assert(/restoreCurrentScrollPosition/.test(workspace), '返回父项目后应恢复此前滚动位置');
assert(/container\.scrollTop = projectListScrollTop\.value/.test(dashboard), '从工作区返回项目列表时应恢复列表位置');
assert(!/name="page-fade"\s+mode="out-in"/.test(app), '功能页切换不应使用会产生空档的 out-in 模式');
assert(/\.page-fade-enter-active\s*\{[^}]*z-index:\s*2/s.test(theme), '新功能页应与旧页面交叠过渡');

console.log('project workspace navigation tests passed');
