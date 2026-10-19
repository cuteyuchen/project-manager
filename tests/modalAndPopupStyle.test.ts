import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const theme = read('src/styles/theme.css');
const titleBar = read('src/components/TitleBar.vue');

assert(/--app-popup-surface:\s*#ffffff/.test(theme), '应定义不透明的浅色弹层背景');
assert(/html\.dark[\s\S]*--app-popup-surface:\s*#111827/.test(theme), '应定义不透明的深色弹层背景');
assert(/--el-bg-color-overlay:\s*var\(--app-popup-surface\)/.test(theme), 'Element Plus overlay 背景应使用不透明弹层色');
assert(/\.el-popper\.is-light\s*\{[\s\S]*background-color:\s*var\(--app-popup-surface\)[\s\S]*opacity:\s*1/.test(theme), '全局浅色下拉/Popover 应强制不透明');
assert(!/isDialogOpen|dialogOpen|MutationObserver/.test(titleBar), '标题栏不应根据弹框状态隐藏窗口控制按钮');
assert(/<div class="flex h-full">/.test(titleBar), '窗口控制按钮组应始终渲染');
assert(/app-shell-with-titlebar/.test(read('src/App.vue')), '桌面应用壳层应标记自定义标题栏');
assert(/body:has\(\.app-shell-with-titlebar\) \.el-overlay\s*\{[\s\S]*top:\s*var\(--app-titlebar-height\)[\s\S]*height:\s*calc\(100% - var\(--app-titlebar-height\)\)/.test(theme), 'Dialog overlay 应从标题栏底部开始铺设');
assert(/body:has\(\.app-shell-with-titlebar\) \.el-overlay-dialog\s*\{[\s\S]*position:\s*absolute[\s\S]*padding-top:\s*0/.test(theme), 'Dialog 应在 overlay 剩余区域内居中');
assert(
  !/z-index:\s*\d+\s*!important/.test(theme),
  '不得用固定层级覆盖 Element Plus 的动态层级，否则子弹窗与确认框会被父弹窗压住',
);
assert(
  !/body:has\(\.project-management-dialog\) \.el-select__popper/.test(theme),
  'Select 应与 Dialog、MessageBox 共用动态层级，不能单独固定置顶',
);

const fileManager = read('src/components/FileManager.vue');
assert(
  /useOverlayZIndex\(\(\) => previewVisible\.value\)/.test(fileManager),
  '文件预览应在打开时申请高于当前弹窗的新层级',
);
assert(
  /useOverlayZIndex\(\(\) => contextMenuVisible\.value\)/.test(fileManager),
  '文件右键菜单应在打开时使用统一动态层级',
);
assert(
  !/z-999/.test(fileManager),
  '文件右键菜单不应再使用 z-999（低于项目弹窗 overlay）',
);

const gitHistory = read('src/components/git/GitHistory.vue');
assert(
  /useOverlayZIndex\(\(\) => ctxMenu\.value !== null\)/.test(gitHistory),
  'Git 提交右键菜单必须随当前弹窗动态分配层级',
);
assert(
  !/z-50/.test(gitHistory),
  'Git 提交右键菜单不应再使用 z-50（会被项目弹窗遮挡）',
);

const updateProgress = read('src/components/UpdateProgress.vue');
assert(
  /useOverlayZIndex\(\(\) => true\)/.test(updateProgress),
  '更新进度条应与其 Tooltip 等浮层共用层级计数',
);

console.log('modal and popup style tests passed');
