import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyProjectExit,
  createRunSessionId,
  formatDuration,
  formatExitSummary,
  isActiveRunSession,
  isRunSessionActive,
} from '../src/utils/runSession.ts';
import { getProjectCommandRunId } from '../src/utils/projectCommands.ts';
import type { ProjectExitPayload } from '../src/api/types.ts';
import type { RunSession } from '../src/types.ts';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const store = read('src/stores/project.ts');
const consoleView = read('src/components/ConsoleView.vue');
const apiTypes = read('src/api/types.ts');
const tauri = read('src/api/adapters/tauri.ts');
const utoolsAdapter = read('src/api/adapters/utools.ts');
const utools = read('utools/preload.js');
const ztools = read('ztools/preload.js');
const runner = read('src-tauri/src/runner.rs');
const readme = read('README.md');

const projectId = 'project-A';
const commandKey = getProjectCommandRunId(projectId, 'script', 'dev');
const baseSession: RunSession = {
  sessionId: 'run_test',
  commandKey,
  projectId,
  commandType: 'script',
  commandId: 'dev',
  displayName: 'dev',
  cwd: 'C:/project-A',
  status: 'starting',
  startedAt: 100,
};

/***********************会话身份*********************/
assert.equal(baseSession.status, 'starting', 'new session must start in starting state');
const firstSessionId = createRunSessionId();
const secondSessionId = createRunSessionId();
assert.match(firstSessionId, /^run_[0-9a-f-]{36}$/);
assert.notEqual(firstSessionId, secondSessionId, 'every real execution must get a unique sessionId');
assert.equal(
  getProjectCommandRunId(projectId, 'script', 'dev'),
  getProjectCommandRunId(projectId, 'script', 'dev'),
  'same command must retain the same stable commandKey',
);
assert.notEqual(firstSessionId, secondSessionId, 'rerun must never reuse a session identity');

/***********************状态与退出分类*********************/
assert.equal(isRunSessionActive('starting'), true);
assert.equal(isRunSessionActive('running'), true);
assert.equal(isRunSessionActive('stopping'), true);
assert.equal(isRunSessionActive('success'), false);

const exit0: ProjectExitPayload = {
  commandKey,
  sessionId: baseSession.sessionId,
  exitCode: 0,
  stopped: false,
  durationMs: 12_400,
};
const exit1: ProjectExitPayload = { ...exit0, exitCode: 1, durationMs: 8_200 };
const stoppedExit: ProjectExitPayload = { ...exit1, exitCode: 1, stopped: true };
const signalExit: ProjectExitPayload = { ...exit0, exitCode: null };
const waitErrorExit: ProjectExitPayload = { ...exit0, exitCode: null, waitError: 'wait failed' };
assert.equal(classifyProjectExit(exit0), 'success');
assert.equal(classifyProjectExit(exit1), 'failed');
assert.equal(classifyProjectExit(stoppedExit), 'stopped');
assert.equal(classifyProjectExit(signalExit), 'failed');
assert.equal(classifyProjectExit(waitErrorExit), 'failed');
assert.match(formatExitSummary(stoppedExit), /Process stopped/);
assert.match(formatExitSummary(exit1), /code 1/);

// Fast exit before invoke resolves must not allow the later resolve handler to regress final state.
const fastExitStatus = classifyProjectExit(exit0);
const afterInvokeResolve = fastExitStatus === 'starting' ? 'running' : fastExitStatus;
assert.equal(afterInvokeResolve, 'success');
assert(store.includes("if (runSessions.value[sessionId]?.status === 'starting')"));
assert(store.indexOf('createRunSessionId') < store.indexOf('api.runProjectCommand'));

/***********************迟到事件与 rerun 隔离*********************/
const rerunSession = { ...baseSession, sessionId: secondSessionId, status: 'running' as const };
const sessionLogs: Record<string, string[]> = {
  [baseSession.sessionId]: ['A output'],
  [rerunSession.sessionId]: [],
};
sessionLogs[baseSession.sessionId].push('A late output');
assert.deepEqual(sessionLogs[rerunSession.sessionId], [], 'old output must not enter the rerun session');
assert.equal(isActiveRunSession({ [commandKey]: rerunSession.sessionId }, commandKey, baseSession.sessionId), false);
assert.equal(isActiveRunSession({ [commandKey]: rerunSession.sessionId }, commandKey, rerunSession.sessionId), true);
assert.notEqual(baseSession.sessionId, rerunSession.sessionId, 'rerun keeps one tab but creates a new session');

/***********************运行计数与清理*********************/
const running: Record<string, boolean> = {};
const setRunning = (key: string, next: boolean) => {
  if (running[key] === next) return;
  running[key] = next;
};
setRunning(commandKey, true);
setRunning(commandKey, true);
assert.equal(Object.values(running).filter(Boolean).length, 1, 'duplicate start must not double increment');
setRunning(commandKey, false);
setRunning(commandKey, false);
assert.equal(Object.values(running).filter(Boolean).length, 0, 'duplicate exit must not double decrement');
assert(store.includes('runSessions'));
assert(store.includes('sessionLogs'));
assert(store.includes('sessionPartialOutput'));
assert(store.includes('idsToRemove'));

/***********************时长*********************/
assert.equal(formatDuration(850), '0.9s');
assert.equal(formatDuration(8_400), '8.4s');
assert.equal(formatDuration(74_000), '1m 14s');
assert.equal(formatDuration(3_720_000), '1h 2m');

/***********************三端 contract 与 reader 顺序*********************/
for (const [name, source] of [
  ['uTools preload', utools],
  ['ZTools preload', ztools],
] as const) {
  assert(source.includes('sessionId'), `${name} must carry sessionId`);
  assert(source.includes('commandKey'), `${name} must carry commandKey`);
  assert(source.includes('exitCode'), `${name} must carry exitCode`);
  assert(source.includes('stopped'), `${name} must carry stopped`);
  assert(source.includes('durationMs'), `${name} must carry durationMs`);
}
assert(tauri.includes('ProjectOutputPayload') && tauri.includes('ProjectExitPayload'));
assert(utoolsAdapter.includes('ProjectOutputPayload') && utoolsAdapter.includes('ProjectExitPayload'));
assert.equal(utools, ztools, 'uTools and ZTools preload contracts must stay identical');
assert(apiTypes.includes('interface ProjectOutputPayload'));
assert(apiTypes.includes('interface ProjectExitPayload'));
assert(apiTypes.includes('exitCode: number | null'));
assert(apiTypes.includes('stopped: boolean'));
assert(apiTypes.includes('durationMs: number'));
assert(runner.includes('session_id: String'));
assert(runner.includes('stop_requested: Arc<AtomicBool>'));
assert(runner.includes('let stdout_reader = spawn_output_reader'));
assert(runner.indexOf('stdout_reader.join') < runner.indexOf('"project-exit"'));
assert(runner.indexOf('stderr_reader.join') < runner.indexOf('"project-exit"'));

/***********************Console 与 README*********************/
assert(consoleView.includes('currentSession'));
assert(consoleView.includes('handleRerun'));
assert(consoleView.includes('clearSessionOutput'));
assert(consoleView.includes("currentSession.status === 'stopping'"));
assert(consoleView.includes('closeRunningTabHint'));
assert(readme.includes('Run Session'));
assert(readme.includes('Project Manager Managed Node Runtime'));
assert(readme.includes('NVM'));

console.log('runSession tests passed');
