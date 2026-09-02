import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const persistence = readFileSync(resolve(root, 'src/utils/persistence.ts'), 'utf8');
const app = readFileSync(resolve(root, 'src/App.vue'), 'utf8');

assert(
  /export type PersistenceState = 'loading' \| 'ready' \| 'read-only'/.test(persistence),
  '持久化模块必须区分读取中、可写和只读保护状态',
);
assert(
  /export function scheduleSaveData\(\) \{\s*if \(persistenceState !== 'ready'\) return;/.test(persistence),
  '只读保护或加载中时不得安排后台保存',
);
assert(
  /function saveData[\s\S]{0,180}?if \(persistenceState !== 'ready'\)[\s\S]{0,180}?throw readOnlyError/.test(persistence),
  '强制保存也必须拒绝在只读保护状态写盘',
);
assert(
  /catch \(error\) \{[\s\S]{0,160}?enterReadOnly\('load', error\)/.test(persistence),
  '读取或 JSON 解析失败时必须进入只读保护，不能吞掉错误后回写空状态',
);
assert(
  app.includes('flushBeforeLifecycle')
    && app.includes('flushPendingSave')
    && app.includes('runHistoryStore.flushStrict')
    && app.includes('await api.exitApp()'),
  '退出应用前必须等待最后一次持久化完成',
);
assert(
  /retrySave[\s\S]{0,800}?exitAnyway/.test(app),
  '退出保存失败时必须允许重试或由用户明确选择继续退出',
);

console.log('persistence protection tests passed');
