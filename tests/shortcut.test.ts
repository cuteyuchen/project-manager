import {
  formatShortcut,
  isShortcutEvent,
  normalizeShortcut,
  shortcutFromKeyboardEvent,
} from '../src/utils/shortcut.ts';

/***********************测试辅助函数*********************/

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function keyboardEvent(init: Partial<KeyboardEvent> & { key: string }) {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

/***********************快捷键标准化*********************/

assert(normalizeShortcut('ctrl + k') === 'Ctrl+K', 'shortcut should normalize modifier names and key casing');
assert(normalizeShortcut('Command+Shift+P') === 'Meta+Shift+P', 'shortcut should normalize command to Meta');
assert(normalizeShortcut('CmdOrCtrl+Shift+K') === 'CommandOrControl+Shift+K', 'shortcut should normalize cross-platform modifier');
assert(normalizeShortcut('') === '', 'empty shortcut should stay empty');
assert(normalizeShortcut('Ctrl+ArrowUp') === 'Ctrl+ArrowUp', 'named keys should preserve accelerator casing');

/***********************快捷键展示*********************/

assert(formatShortcut('Meta+Shift+P') === 'Cmd+Shift+P', 'Meta should display as Cmd for user-facing text');

/***********************键盘事件匹配*********************/

assert(isShortcutEvent(keyboardEvent({ key: 'k', ctrlKey: true }), 'Ctrl+K'), 'Ctrl+K event should match Ctrl+K shortcut');
assert(isShortcutEvent(keyboardEvent({ key: 'K', ctrlKey: true }), 'Ctrl+K'), 'key matching should ignore letter casing');
assert(isShortcutEvent(keyboardEvent({ key: 'k', metaKey: true, shiftKey: true }), 'CommandOrControl+Shift+K'), 'CommandOrControl should match Meta');
assert(!isShortcutEvent(keyboardEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'Ctrl+K'), 'extra modifiers should not match');
assert(!isShortcutEvent(keyboardEvent({ key: 'k', metaKey: true }), 'Ctrl+K'), 'different modifiers should not match');
assert(shortcutFromKeyboardEvent(keyboardEvent({ key: 'k', ctrlKey: true, shiftKey: true })) === 'Ctrl+Shift+K', 'keyboard event should be recorded as a normalized shortcut');
assert(shortcutFromKeyboardEvent(keyboardEvent({ key: 'k' })) === '', 'single keys should not be recorded without a modifier');
assert(shortcutFromKeyboardEvent(keyboardEvent({ key: 'ArrowUp', altKey: true })) === 'Alt+ArrowUp', 'named keys should be recordable');
assert(shortcutFromKeyboardEvent(keyboardEvent({ key: ' ', ctrlKey: true })) === 'Ctrl+Space', 'space should be recordable');

console.log('shortcut tests passed');
