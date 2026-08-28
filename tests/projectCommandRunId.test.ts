import assert from 'node:assert/strict';
import {
  getProjectCommandKey,
  getProjectCommandRunId,
  parseProjectCommandKey,
} from '../src/utils/projectCommands.ts';

/***********************同名命令运行标识*********************/
const scriptKey = getProjectCommandKey('script', 'dev');
const customKey = getProjectCommandKey('custom', 'dev');

assert.notEqual(scriptKey, customKey, '同名 script/custom command 的 UI key 必须不同');
assert.notEqual(
  getProjectCommandRunId('project', 'script', 'dev'),
  getProjectCommandRunId('project', 'custom', 'dev'),
  '同名 script/custom command 的运行状态和日志桶必须不同',
);
assert.deepEqual(parseProjectCommandKey(scriptKey), { type: 'script', id: 'dev' });
assert.deepEqual(parseProjectCommandKey(customKey), { type: 'custom', id: 'dev' });
assert.deepEqual(parseProjectCommandKey('script:build:prod'), { type: 'script', id: 'build:prod' });

console.log('projectCommandRunId tests passed');
