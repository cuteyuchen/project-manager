import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const nodeManager = readFileSync(resolve(root, 'src/views/NodeManager.vue'), 'utf8');
const zh = readFileSync(resolve(root, 'src/locales/zh.ts'), 'utf8');
const en = readFileSync(resolve(root, 'src/locales/en.ts'), 'utf8');

assert.equal(
  (nodeManager.match(/command="details"/g) || []).length,
  3,
  'table, compact-table, and card layouts should expose Runtime Details',
);
assert.match(nodeManager, /canonicalRuntimeUsages/);
assert.match(nodeManager, /canonical\.isProjectManagerDefault/);
assert.match(nodeManager, /canonical\.isSystemCurrent/);
assert.match(nodeManager, /canonical\.preferredSource === 'managed'/);
assert.match(nodeManager, /canonical\.preferredSource === 'custom'/);
assert.doesNotMatch(
  nodeManager,
  /v-if="canonical\.preferredSource === 'nvm'"[^>]*removeRuntime/,
  'NVM details must not expose a removal action',
);
assert.match(zh, /runtimeDetails: 'Runtime 详情'/);
assert.match(en, /runtimeDetails: 'Runtime Details'/);

console.log('nodeRuntimeDetails tests passed');
