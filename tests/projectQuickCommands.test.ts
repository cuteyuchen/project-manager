import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project } from '../src/types.ts';
import {
  getAvailableProjectQuickCommands,
  getDefaultProjectQuickCommands,
  resolveProjectQuickCommands,
} from '../src/utils/projectQuickCommands.ts';

const project: Project = {
  id: 'project',
  name: 'project',
  path: '/project',
  type: 'node',
  scripts: ['dev', 'build', 'preview'],
  visibleScripts: ['dev', 'build'],
  customCommands: [{ id: 'custom-dev', name: 'dev', command: 'node server.js' }],
};

assert.deepEqual(getAvailableProjectQuickCommands(project), [
  { type: 'script', id: 'dev' },
  { type: 'script', id: 'build' },
  { type: 'custom', id: 'custom-dev' },
]);
assert.deepEqual(getDefaultProjectQuickCommands(project), [
  { type: 'script', id: 'dev' },
  { type: 'script', id: 'build' },
  { type: 'custom', id: 'custom-dev' },
]);
assert.deepEqual(resolveProjectQuickCommands({
  ...project,
  quickCommands: [
    { type: 'custom', id: 'custom-dev' },
    { type: 'script', id: 'dev' },
    { type: 'script', id: 'dev' },
    { type: 'script', id: 'missing' },
  ],
}), [
  { type: 'custom', id: 'custom-dev' },
  { type: 'script', id: 'dev' },
], '同名 script/custom 不冲突，删除命令后自动失效并去重');
assert.equal(resolveProjectQuickCommands({ ...project, quickCommands: [
  { type: 'script', id: 'dev' },
  { type: 'script', id: 'build' },
  { type: 'custom', id: 'custom-dev' },
  { type: 'script', id: 'preview' },
] }).length, 3, '快捷命令最多 3 个');

/***********************快捷命令运行/停止入口*********************/
const projectListItem = readFileSync(resolve(process.cwd(), 'src/components/ProjectListItem.vue'), 'utf8');
assert(
  /if \(isQuickCommandRunning\(command\)\)\s*\{[\s\S]*?stopProject\(props\.project, command\.id, command\.type\)/.test(projectListItem),
  '快捷命令运行中时应复用带类型的 stopProject',
);
assert(/store\.runProject\(props\.project, command\.id\)/.test(projectListItem), 'script 快捷命令应复用 runProject');
assert(/store\.runCustomCommand\(props\.project, command\.id\)/.test(projectListItem), 'custom 快捷命令应复用 runCustomCommand');

console.log('projectQuickCommands tests passed');
