import assert from 'node:assert/strict';
import { createProjectId } from '../src/utils/projectId.ts';

/***********************项目 ID 生成*********************/

const originalCrypto = globalThis.crypto;

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {},
});

const fallbackId = createProjectId();
assert.match(fallbackId, /^project-[a-z0-9]+-[a-z0-9]+$/, '缺少 crypto.randomUUID 时应降级生成可用项目 ID');

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    randomUUID: () => 'stable-random-uuid',
  },
});

assert.equal(createProjectId(), 'stable-random-uuid', '可用时应优先使用 crypto.randomUUID');

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: originalCrypto,
});

console.log('projectId tests passed');
