import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyUiSizeToRoot,
  DEFAULT_UI_SIZE,
  normalizeUiSize,
  UI_SIZE_VALUES,
} from '../src/utils/uiSize.ts';

const root = process.cwd();
const settingsStore = readFileSync(resolve(root, 'src/stores/settings.ts'), 'utf8');
const persistence = readFileSync(resolve(root, 'src/utils/persistence.ts'), 'utf8');
const settingsView = readFileSync(resolve(root, 'src/views/Settings.vue'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const types = readFileSync(resolve(root, 'src/types.ts'), 'utf8');

assert.deepEqual(UI_SIZE_VALUES, ['compact', 'standard', 'comfortable']);
assert.equal(DEFAULT_UI_SIZE, 'standard');
assert.equal(normalizeUiSize(undefined), 'standard');
assert.equal(normalizeUiSize(null), 'standard');
assert.equal(normalizeUiSize('invalid'), 'standard');
assert.equal(normalizeUiSize('compact'), 'compact');
assert.equal(normalizeUiSize('standard'), 'standard');
assert.equal(normalizeUiSize('comfortable'), 'comfortable');

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const documentRoot = { dataset: {} as Record<string, string> };
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: documentRoot },
});
assert.equal(applyUiSizeToRoot('comfortable'), 'comfortable');
assert.equal(documentRoot.dataset.uiSize, 'comfortable');
assert.equal(applyUiSizeToRoot('bad-value'), 'standard');
assert.equal(documentRoot.dataset.uiSize, 'standard');
if (previousDocument) {
  Object.defineProperty(globalThis, 'document', previousDocument);
} else {
  delete (globalThis as { document?: unknown }).document;
}

assert.match(types, /uiSize\?: UiSize/);
assert.match(settingsStore, /uiSize: DEFAULT_UI_SIZE/);
assert.match(settingsStore, /parsed\.uiSize = normalizeUiSize\(parsed\.uiSize\)/);
assert.match(settingsStore, /settings\.value\.uiSize = normalizeUiSize\(settings\.value\.uiSize\)/);
assert.match(persistence, /Object\.prototype\.hasOwnProperty\.call\(data\.settings, 'uiSize'\)/);
assert.match(persistence, /merged\.uiSize = normalizeUiSize\(undefined\)/);
assert.match(main, /applyUiSizeToRoot\(normalizeUiSize\(storedUiSize\)\)/);
assert.match(settingsView, /v-model="draft\.uiSize"/);
assert.match(settingsView, /value: 'compact'/);
assert.match(settingsView, /value: 'standard'/);
assert.match(settingsView, /value: 'comfortable'/);
assert.match(settingsView, /settingsStore\.applyUiSize\(\)/);

console.log('uiSize tests passed');
