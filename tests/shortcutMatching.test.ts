import assert from 'node:assert/strict';
import { isShortcutEvent, normalizeShortcut } from '../src/utils/shortcut.ts';

/***********************假键盘事件*********************/
// isShortcutEvent 只读 key 与四个修饰键布尔量，不需要真实 DOM。

type Mods = Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>;

function ev(key: string, mods: Mods = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  } as KeyboardEvent;
}

/***********************归一化*********************/

assert.equal(normalizeShortcut('Escape'), 'Escape', '无修饰键应能归一化');
assert.equal(normalizeShortcut('Ctrl+1'), 'Ctrl+1');
assert.equal(normalizeShortcut('Ctrl+F'), 'Ctrl+F');
assert.equal(normalizeShortcut('Ctrl+N'), 'Ctrl+N');
assert.equal(normalizeShortcut('F5'), 'F5');

/***********************实际在用的键位逐个匹配*********************/
// 方案键位由前端匹配，Windows Tauri 另行关闭 WebView2 浏览器加速键。

assert(isShortcutEvent(ev('Escape'), 'Escape'), 'Escape 应匹配');

for (let i = 1; i <= 5; i++) {
  assert(
    isShortcutEvent(ev(String(i), { ctrlKey: true }), `Ctrl+${i}`),
    `Ctrl+${i} 应匹配`,
  );
}

assert(isShortcutEvent(ev('f', { ctrlKey: true }), 'Ctrl+F'), 'Ctrl+F 小写 key 应匹配');
assert(isShortcutEvent(ev('F', { ctrlKey: true }), 'Ctrl+F'), 'Ctrl+F 大写 key 应匹配');
assert(isShortcutEvent(ev('n', { ctrlKey: true }), 'Ctrl+N'), 'Ctrl+N 应匹配');
assert(isShortcutEvent(ev('F5'), 'F5'), 'F5 应匹配');

/***********************历史键位：逻辑能匹配，但被宿主吃掉*********************/
// 保留这几条是为了记录「匹配逻辑没问题」这个结论——
// 将来若有人想把默认值改回 Ctrl+F/F5，会先在 appShortcuts.test.ts 的加速键断言上撞墙。

assert(isShortcutEvent(ev('1', { ctrlKey: true }), 'Ctrl+1'), 'Ctrl+1 的匹配逻辑本身是对的');
assert(isShortcutEvent(ev('ArrowLeft', { altKey: true }), 'Alt+ArrowLeft'), 'Alt+← 的匹配逻辑本身是对的');
assert(isShortcutEvent(ev('F5'), 'F5'), 'F5 的匹配逻辑本身是对的');

/***********************不该误匹配的情况*********************/

assert(!isShortcutEvent(ev('1'), 'Alt+1'), '缺修饰键不应匹配');
assert(!isShortcutEvent(ev('1', { altKey: true, shiftKey: true }), 'Alt+1'), '多余 Shift 不应匹配');
assert(!isShortcutEvent(ev('1', { altKey: true, ctrlKey: true }), 'Alt+1'), '多余 Ctrl 不应匹配');
assert(!isShortcutEvent(ev('1', { ctrlKey: true }), 'Alt+1'), '修饰键不同不应匹配');
assert(!isShortcutEvent(ev('2', { altKey: true }), 'Alt+1'), '不同数字不应匹配');
assert(!isShortcutEvent(ev('Escape', { altKey: true }), 'Escape'), '带修饰键不应命中裸 Escape');

/***********************数字小键盘*********************/
// 小键盘数字键的 event.key 与主键行一致（都是 '1'），
// 但开了 NumLock 才是数字，否则是 'End'/'ArrowDown' 之类。这里只确认数字形态可用。
assert(isShortcutEvent(ev('1', { altKey: true }), 'Alt+1'), '小键盘数字 key 形态相同，应匹配');

console.log('shortcutMatching tests passed');
