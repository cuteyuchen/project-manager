import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { isEditableTarget } from '../src/composables/useAppShortcuts.ts';
import {
  isShortcutEvent,
  shortcutFromKeyboardEvent,
  DEFAULT_FOCUS_SEARCH_SHORTCUT,
  DEFAULT_NEW_PROJECT_SHORTCUT,
  DEFAULT_REFRESH_PROJECTS_SHORTCUT,
  DEFAULT_SIDEBAR_MENU_SHORTCUTS,
  SUPERSEDED_SHORTCUT_DEFAULTS,
} from '../src/utils/shortcut.ts';

/***********************无修饰键必须能被匹配*********************/
// 这是「导航键硬编码」这个决定的技术前提：
// shortcutFromKeyboardEvent（录制）拒绝无修饰键，但 isShortcutEvent（匹配）必须支持，
// 否则 Esc / F5 这类键根本无法绑定。

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

assert(isShortcutEvent(keyEvent({ key: 'Escape' }), 'Escape'), 'Esc 必须能被匹配');
assert(!isShortcutEvent(keyEvent({ key: 'Escape', ctrlKey: true }), 'Escape'), 'Ctrl+Esc 不应命中裸 Esc');
assert(isShortcutEvent(keyEvent({ key: 'F5' }), 'F5'), 'F5 必须能被匹配');
assert(isShortcutEvent(keyEvent({ key: '1', ctrlKey: true }), 'Ctrl+1'), 'Ctrl+1 必须能被匹配');
assert(
  !isShortcutEvent(keyEvent({ key: '1' }), 'Ctrl+1'),
  '缺修饰键不该命中',
);
assert(
  !isShortcutEvent(keyEvent({ key: '2', ctrlKey: true }), 'Ctrl+1'),
  '不同数字键不该互相命中',
);

// 录制侧允许 F5，以便方案中的刷新快捷键可以在设置页配置；Esc 仍是固定导航键。
assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: 'Escape' })), '', 'ShortcutRecorder 无法录制裸 Esc');
assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: 'F5' })), 'F5', 'ShortcutRecorder 应能录制裸 F5');

/***********************方案默认键位*********************/

assert.equal(DEFAULT_FOCUS_SEARCH_SHORTCUT, 'Ctrl+F');
assert.equal(DEFAULT_NEW_PROJECT_SHORTCUT, 'Ctrl+N');
assert.equal(DEFAULT_REFRESH_PROJECTS_SHORTCUT, 'F5');
assert.deepEqual([...DEFAULT_SIDEBAR_MENU_SHORTCUTS], ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5']);

/***********************旧的失效默认值要能迁移*********************/

assert.deepEqual(SUPERSEDED_SHORTCUT_DEFAULTS, {
  focusSearchShortcut: 'Alt+S',
  newProjectShortcut: 'Alt+N',
  refreshProjectsShortcut: 'Alt+R',
});
assert.deepEqual(
  Object.keys(SUPERSEDED_SHORTCUT_DEFAULTS).sort(),
  ['focusSearchShortcut', 'newProjectShortcut', 'refreshProjectsShortcut'],
  '三个可配置键位都要有迁移条目，否则老用户 localStorage 里的失效键位不会被换掉',
);

const settingsStore = readFileSync(resolve(process.cwd(), 'src/stores/settings.ts'), 'utf8');
assert(
  /SUPERSEDED_SHORTCUT_DEFAULTS\[key\]/.test(settingsStore),
  'settings store 必须真的用上迁移表，否则老用户按不动键',
);

/***********************默认键位互不冲突*********************/

const defaults = [
  DEFAULT_FOCUS_SEARCH_SHORTCUT,
  DEFAULT_NEW_PROJECT_SHORTCUT,
  DEFAULT_REFRESH_PROJECTS_SHORTCUT,
  'Ctrl+K', // 已有的快速搜索
  'Escape',
  'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5',
];
assert.equal(new Set(defaults).size, defaults.length, '默认键位不应互相冲突');

/***********************只有「能录入文本」才算可输入*********************/
// 在搜索框里按 Esc 想清空输入，不该把整个工作区退回列表页。
// 但判据必须收紧：Element Plus 的 el-segmented 渲染的是隐藏 <input type="radio">，
// el-select 的焦点承载元素是 readonly 的 combobox input。点过这些控件后
// activeElement 会长期停在上面，若把它们当成「正在打字」，
// 之后所有受保护的快捷键都会静默失效——这是本轮真正被确认的 bug。

// Node 环境没有 DOM，补一个最小的 HTMLElement 供 instanceof 判定使用。
// isEditableTarget 在函数体内引用全局 HTMLElement，所以运行前定义即可。
class StubHTMLElement {
  tagName = 'DIV';
  isContentEditable = false;
  type = '';
  readOnly = false;
  disabled = false;
}
(globalThis as Record<string, unknown>).HTMLElement = StubHTMLElement;

type FakeOpts = {
  contentEditable?: boolean;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
};

function fakeElement(tagName: string, opts: FakeOpts = {}) {
  const el = new StubHTMLElement();
  el.tagName = tagName;
  el.isContentEditable = opts.contentEditable ?? false;
  el.type = opts.type ?? '';
  el.readOnly = opts.readOnly ?? false;
  el.disabled = opts.disabled ?? false;
  return el as unknown as HTMLElement;
}

// 真正的文本录入控件：要保护
assert.equal(isEditableTarget(fakeElement('INPUT', { type: 'text' })), true, '文本框内不应触发裸键');
assert.equal(isEditableTarget(fakeElement('INPUT', { type: '' })), true, 'input 缺省 type 视为 text');
assert.equal(isEditableTarget(fakeElement('INPUT', { type: 'search' })), true, '搜索框内不应触发裸键');
assert.equal(isEditableTarget(fakeElement('INPUT', { type: 'password' })), true, '密码框内不应触发裸键');
assert.equal(isEditableTarget(fakeElement('INPUT', { type: 'number' })), true, '数字框内不应触发裸键');
assert.equal(isEditableTarget(fakeElement('TEXTAREA')), true, 'textarea 内不应触发裸键');
assert.equal(isEditableTarget(fakeElement('DIV', { contentEditable: true })), true, '可编辑区内不应触发裸键');

// 非文本控件：不能算「正在打字」——这几条就是导致快捷键静默失效的元凶
assert.equal(
  isEditableTarget(fakeElement('INPUT', { type: 'radio' })),
  false,
  'el-segmented 的隐藏 radio 不该算可输入，否则点过快捷筛选后快捷键全失效',
);
assert.equal(
  isEditableTarget(fakeElement('INPUT', { type: 'checkbox' })),
  false,
  'el-checkbox / el-switch 的隐藏 checkbox 同理',
);
assert.equal(
  isEditableTarget(fakeElement('INPUT', { type: 'text', readOnly: true })),
  false,
  'el-select 的 readonly combobox 不该算可输入——焦点在上面时打字没有任何效果',
);
assert.equal(
  isEditableTarget(fakeElement('TEXTAREA', { readOnly: true })),
  false,
  'readonly textarea 同理',
);
assert.equal(
  isEditableTarget(fakeElement('INPUT', { type: 'text', disabled: true })),
  false,
  'disabled 输入框没有需要保护的输入行为',
);
assert.equal(isEditableTarget(fakeElement('INPUT', { type: 'range' })), false, 'range 滑块不是文本录入');
assert.equal(isEditableTarget(fakeElement('INPUT', { type: 'file' })), false, 'file 选择器不是文本录入');
assert.equal(isEditableTarget(fakeElement('BUTTON')), false, '按钮上应正常触发快捷键');
assert.equal(isEditableTarget(fakeElement('DIV')), false, '普通元素上应正常触发');
assert.equal(isEditableTarget(null), false, 'target 为空时不应报错');

/***********************源码约束*********************/

const root = process.cwd();
const composable = readFileSync(resolve(root, 'src/composables/useAppShortcuts.ts'), 'utf8');
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const dashboard = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const app = readFileSync(resolve(root, 'src/App.vue'), 'utf8');
const settingsView = readFileSync(resolve(root, 'src/views/Settings.vue'), 'utf8');
const tauriLib = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');

// 有弹窗时导航键必须让位：el-dialog 默认 close-on-press-escape 自己会处理 Esc，
// 两边都响应会让一次 Esc 既关弹窗又退一级页面
assert(
  /el-overlay/.test(composable) && /allowInDialog/.test(composable),
  '必须能识别弹窗打开状态并默认让位，否则 Esc 会同时关弹窗和退页面',
);

// 但判定必须看「是否可见」而不是「是否存在」：
// el-dialog 的遮罩是 vShow 指令 + el-teleport 不懒渲染，
// 只要模板里写了 el-dialog，.el-overlay 从启动起就在 DOM 里（display:none）。
// 用 querySelector 判存在会让 isDialogOpen 恒为 true，把所有快捷键静默吃掉。
assert(
  /checkVisibility/.test(composable),
  'isDialogOpen 必须判元素可见性；判存在会因 vShow 常驻 DOM 而恒为 true，快捷键全失效',
);
assert(
  !/return Boolean\(document\.querySelector/.test(composable),
  'isDialogOpen 不能只用 querySelector 判存在',
);

// KeepAlive 下 deactivate 不触发 onBeforeUnmount：
// App.vue 用 <KeepAlive> 包着 Dashboard 等页面，缺了这两个钩子会让监听器
// 在切到设置页后依然挂在 document 上，Ctrl+N 之类会在别的页面误触发。
assert(
  /onActivated/.test(composable) && /onDeactivated/.test(composable),
  'useAppShortcuts 必须处理 KeepAlive 的 activate/deactivate，否则缓存页面的快捷键会跨页误触发',
);

// 收紧后的可输入判据必须留在代码里，否则「点过筛选按钮快捷键就失效」会回归
assert(
  /TEXT_INPUT_TYPES/.test(composable),
  'isEditableTarget 必须按 input type 白名单判定，只看 tagName 会把隐藏 radio 当成正在打字',
);
assert(
  /readOnly/.test(composable),
  'readonly 输入框（el-select 的 combobox）不该算可输入',
);

// 带修饰键的组合在输入框里不会和打字冲突，应默认放行；
// 否则光标停在 Git 提交信息框里时 Alt+1~5 全都按不动
assert(
  /allowInEditable \?\? hasModifier\(keys\)/.test(composable),
  '带修饰键的组合应默认允许在输入框内触发，裸键才默认拦住',
);

assert(
  /isComposing/.test(composable),
  '输入法组合输入期间不应拦截按键',
);

assert(
  /keys: 'Escape', enabled: \(\) => !!currentNode\.value, handler: handleBack/.test(workspace),
  '工作区应支持 Esc 逐级返回，并在层级为空时不响应',
);

// Windows Tauri 通过 on_webview_ready 关闭 WebView2 浏览器加速键，方案键位可进入页面。
assert(
  /keys: 'Alt\+ArrowLeft'/.test(workspace),
  '工作区应绑定 Alt+← 逐级返回',
);
assert(!/sidebarMenuShortcuts/.test(workspace), '工作区不应占用 Ctrl+1~5，否则会与左侧菜单导航冲突');
assert(
  /SetAreBrowserAcceleratorKeysEnabled\(false\)/.test(tauriLib),
  'Windows WebView2 必须关闭浏览器加速键，否则方案键位到不了前端',
);
assert(
  !/function handleGlobalKeydown\(event: KeyboardEvent\) \{\s*if \(isPlugin\) return;/.test(app)
  && /document\.addEventListener\('keydown', handleGlobalKeydown\)/.test(app),
  '应用内 Ctrl+K 在插件环境也必须注册并响应',
);
assert(
  /<section[^>]*class="settings-section"[^>]*>[\s\S]*?settings\.shortcuts/.test(settingsView)
  && /sidebarMenuShortcuts/.test(settingsView),
  '插件设置页也应能配置应用内快捷键与左侧菜单键位',
);

assert(
  /SIDEBAR_MENU_VIEWS: AppView\[\] = \['dashboard', 'nodes', 'ports', 'commitCalendar', 'settings'\]/.test(app)
  && /settingsStore\.settings\.sidebarMenuShortcuts/.test(app)
  && /DEFAULT_SIDEBAR_MENU_SHORTCUTS/.test(app),
  'Ctrl+1~5 应按视觉顺序全局切换左侧五个菜单',
);
assert(
  /enabled: \(\) => loaded\.value && !quickSearchShortcutRecording/.test(app),
  '录制快捷键时必须暂停左侧菜单导航，避免 Ctrl+数字立即跳页',
);

// 列表页快捷键只在列表页生效：进入工作区后不该再响应
assert(
  /enabled: \(\) => !drilledRootId\.value/.test(dashboard),
  '列表页快捷键应在进入工作区后失效',
);

console.log('appShortcuts tests passed');
