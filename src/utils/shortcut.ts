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

export const DEFAULT_QUICK_SEARCH_APP_SHORTCUT = 'Ctrl+K';
export const DEFAULT_QUICK_SEARCH_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+K';

function normalizeKeyName(key: string) {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length === 1) return trimmed.toUpperCase();
  return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
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

/***********************键盘事件匹配*********************/

export function isShortcutEvent(event: KeyboardEvent, shortcut: string) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return false;

  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  const usesCommandOrControl = modifiers.has('CommandOrControl');

  return event.key.toLowerCase() === key.toLowerCase()
    && (usesCommandOrControl ? event.ctrlKey !== event.metaKey : event.ctrlKey === modifiers.has('Ctrl'))
    && (usesCommandOrControl ? event.ctrlKey !== event.metaKey : event.metaKey === modifiers.has('Meta'))
    && event.altKey === modifiers.has('Alt')
    && event.shiftKey === modifiers.has('Shift');
}
