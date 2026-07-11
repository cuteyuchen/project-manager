const MODIFIER_ALIASES: Record<string, string> = {
  command: 'Meta',
  cmd: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  windows: 'Meta',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  cmdorcontrol: 'CommandOrControl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
};

const MODIFIER_ORDER = ['CommandOrControl', 'Ctrl', 'Meta', 'Alt', 'Shift'];

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  spacebar: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  backspace: 'Backspace',
  delete: 'Delete',
  enter: 'Enter',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
};

export const DEFAULT_QUICK_SEARCH_APP_SHORTCUT = 'Ctrl+K';
export const DEFAULT_QUICK_SEARCH_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+K';

function normalizeKeyName(key: string) {
  const directAlias = KEY_ALIASES[key.toLowerCase()];
  if (directAlias) return directAlias;
  const trimmed = key.trim();
  if (!trimmed) return '';
  const alias = KEY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (/^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (trimmed.length === 1) return trimmed.toUpperCase();
  return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
}

export function isModifierKey(key: string) {
  return ['Control', 'Meta', 'Alt', 'Shift'].includes(key);
}

function getKeyboardEventKey(event: KeyboardEvent) {
  return normalizeKeyName(event.key);
}

/***********************快捷键标准化*********************/

export function normalizeShortcut(shortcut: string) {
  const parts = shortcut
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);

  const modifiers = new Set<string>();
  let key = '';

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
    } else {
      key = normalizeKeyName(part);
    }
  }

  if (!key) return '';

  return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join('+');
}

export function formatShortcut(shortcut: string) {
  return normalizeShortcut(shortcut).replace('Meta', 'Cmd');
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent) {
  if (isModifierKey(event.key)) return '';

  const key = getKeyboardEventKey(event);
  if (!key || key === '+') return '';

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.metaKey) modifiers.push('Meta');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (modifiers.length === 0) return '';

  return normalizeShortcut([...modifiers, key].join('+'));
}

/***********************键盘事件匹配*********************/

export function isShortcutEvent(event: KeyboardEvent, shortcut: string) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return false;

  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  const usesCommandOrControl = modifiers.has('CommandOrControl');

  return getKeyboardEventKey(event).toLowerCase() === key.toLowerCase()
    && (usesCommandOrControl ? event.ctrlKey !== event.metaKey : event.ctrlKey === modifiers.has('Ctrl'))
    && (usesCommandOrControl ? event.ctrlKey !== event.metaKey : event.metaKey === modifiers.has('Meta'))
    && event.altKey === modifiers.has('Alt')
    && event.shiftKey === modifiers.has('Shift');
}
