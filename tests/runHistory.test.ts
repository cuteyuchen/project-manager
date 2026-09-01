import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import type { RunHistoryEntry, RunSession } from '../src/types.ts';
import {
  applyRunHistoryRetention,
  buildRunLogFileName,
  createRunHistoryEntry,
  isHistoryCommandAvailable,
  parseRunHistory,
  serializeRunHistory,
} from '../src/utils/runHistory.ts';

// TauriAdapter reads the current window during construction; provide the minimal
// host shape before loading the runtime adapter in this standalone Node test.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } } } },
});
const { api } = await import('../src/api/index.ts');
const { useRunHistoryStore } = await import('../src/stores/runHistory.ts');

function makeSession(status: RunSession['status'], sessionId = `session-${status}`): RunSession {
  return {
    sessionId,
    commandKey: 'project-a:script:build',
    projectId: 'project-a',
    commandType: 'script',
    commandId: 'build',
    displayName: 'build',
    cwd: 'C:/project-a',
    status,
    startedAt: 1_000,
    endedAt: status === 'starting' || status === 'running' || status === 'stopping' ? undefined : 2_250,
    durationMs: status === 'starting' || status === 'running' || status === 'stopping' ? undefined : 1_250,
    exitCode: status === 'success' ? 0 : status === 'failed' ? 1 : null,
    errorMessage: status === 'failed' ? 'failure detail'.repeat(300) : undefined,
    nodeRuntimeId: 'managed-20',
    nodeVersion: 'v20.19.1',
    nodePath: 'C:/node/v20.19.1/node.exe',
    packageManager: 'npm',
  };
}

function makeEntry(index: number, projectId = 'project-a'): RunHistoryEntry {
  return {
    historyId: `history-${projectId}-${index}`,
    sessionId: `session-${projectId}-${index}`,
    projectId,
    commandKey: `${projectId}:script:build`,
    commandType: 'script',
    commandId: 'build',
    displayName: 'build',
    cwd: `C:/${projectId}`,
    status: index % 3 === 0 ? 'success' : index % 3 === 1 ? 'failed' : 'stopped',
    startedAt: index * 1_000,
    endedAt: index * 1_000 + 500,
    durationMs: 500,
    exitCode: index % 3 === 0 ? 0 : index % 3 === 1 ? 1 : null,
  };
}

/*********************** terminal-only history ***********************/
assert.equal(createRunHistoryEntry(makeSession('starting')), null);
assert.equal(createRunHistoryEntry(makeSession('running')), null);
assert.equal(createRunHistoryEntry(makeSession('stopping')), null);

for (const status of ['success', 'failed', 'stopped'] as const) {
  const entry = createRunHistoryEntry(makeSession(status), 3_000);
  assert(entry, `${status} should create a history entry`);
  assert.equal(entry?.status, status);
  assert.equal(entry?.historyId, entry?.sessionId);
}

const longError = createRunHistoryEntry(makeSession('failed'));
assert(longError?.errorMessage);
assert(longError.errorMessage.length <= 1_500);

/*********************** metadata-only serialization ***********************/
const serialized = serializeRunHistory([{
  ...makeEntry(1),
  sessionLogs: ['secret output'],
  logs: ['secret output'],
  stdout: ['secret output'],
  stderr: ['secret output'],
  partialOutput: 'secret prompt',
  rawLog: 'secret raw log',
} as RunHistoryEntry & Record<string, unknown>]);
const serializedObject = JSON.parse(serialized) as { schemaVersion: number; entries: unknown[] };
assert.equal(serializedObject.schemaVersion, 1);
assert.equal(serializedObject.entries.length, 1);
for (const forbidden of ['sessionLogs', 'logs', 'stdout', 'stderr', 'partialOutput', 'rawLog']) {
  assert(!serialized.includes(forbidden), `run-history.json must not persist ${forbidden}`);
}

/*********************** validation, dedupe and retention ***********************/
const duplicateOlder = makeEntry(2);
const duplicateNewer = { ...duplicateOlder, endedAt: duplicateOlder.endedAt + 10_000, durationMs: 10_500 };
const parsed = parseRunHistory(JSON.stringify({
  schemaVersion: 1,
  entries: [
    duplicateOlder,
    duplicateNewer,
    { ...makeEntry(3), status: 'starting' },
    { broken: true },
  ],
}));
assert.equal(parsed.length, 1, 'duplicate and non-terminal/invalid records should be filtered');
assert.equal(parsed[0].endedAt, duplicateNewer.endedAt);
assert.deepEqual(parseRunHistory('{broken json'), []);
assert.deepEqual(parseRunHistory(JSON.stringify({ schemaVersion: 99, entries: [makeEntry(1)] })), []);

const perProject = applyRunHistoryRetention(Array.from({ length: 25 }, (_, index) => makeEntry(index)));
assert.equal(perProject.length, 20);
assert.deepEqual(perProject.map(entry => entry.endedAt), [...perProject].sort((a, b) => b.endedAt - a.endedAt).map(entry => entry.endedAt));
assert.equal(perProject[0].sessionId, 'session-project-a-24');

const globalEntries = Array.from({ length: 520 }, (_, index) => makeEntry(index, `project-${index}`));
const globallyRetained = applyRunHistoryRetention(globalEntries);
assert.equal(globallyRetained.length, 500, 'global retention cap should be 500');
assert.equal(globallyRetained[0].endedAt, globalEntries[519].endedAt);
assert(!globallyRetained.some(entry => entry.sessionId === 'session-project-0-0'));

/*********************** current configuration controls rerun ***********************/
const project = {
  id: 'project-a',
  name: 'Project A',
  path: 'C:/project-a',
  type: 'node' as const,
  scripts: ['build'],
  customCommands: [{ id: 'lint', name: 'Lint', command: 'npm run lint' }],
};
const historyEntry = makeEntry(4);
assert.equal(isHistoryCommandAvailable(historyEntry, project), true);
assert.equal(isHistoryCommandAvailable({ ...historyEntry, projectId: 'other' }, project), false);
assert.equal(isHistoryCommandAvailable({ ...historyEntry, commandId: 'removed' }, project), false);
assert.equal(isHistoryCommandAvailable({ ...historyEntry, commandType: 'custom', commandId: 'lint' }, project), true);

const filename = buildRunLogFileName('bad:name', 'build/test', 1_735_689_600_000);
assert(!/[<>:"/\\|?*]/.test(filename), 'export filename should be Windows-safe');
assert.match(filename, /\.log$/);

/*********************** independent persistence store ***********************/
const originalReadConfigFile = api.readConfigFile;
const originalWriteConfigFile = api.writeConfigFile;
try {
  const writes: Array<{ filename: string; content: string }> = [];
  api.readConfigFile = async () => '';
  api.writeConfigFile = async (filename, content) => {
    writes.push({ filename, content });
  };

  setActivePinia(createPinia());
  const store = useRunHistoryStore();
  await store.load();
  store.recordCompletedSession(makeSession('success', 'persisted-session'));
  await store.flush();
  await store.flush();

  assert.equal(writes.length, 1, 'history flush should dedupe unchanged payloads');
  assert.equal(writes[0].filename, 'run-history.json');
  assert(!writes[0].content.includes('data.json'));
  assert(!writes[0].content.includes('sessionLogs'));
} finally {
  api.readConfigFile = originalReadConfigFile;
  api.writeConfigFile = originalWriteConfigFile;
}

try {
  let releaseFirstWrite!: () => void;
  const firstWrite = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
  const writes: string[] = [];
  let writeCount = 0;
  api.readConfigFile = async () => '';
  api.writeConfigFile = async (_filename, content) => {
    writes.push(content);
    writeCount += 1;
    if (writeCount === 1) await firstWrite;
  };
  setActivePinia(createPinia());
  const store = useRunHistoryStore();
  await store.load();
  store.recordCompletedSession(makeSession('success', 'race-a'));
  const firstFlush = store.flush();
  store.recordCompletedSession(makeSession('success', 'race-b'));
  releaseFirstWrite();
  await firstFlush;
  await store.flush();
  assert.equal(writes.length, 2, 'a history completion during an in-flight save must be flushed afterwards');
  assert(writes[1].includes('race-b'));
} finally {
  api.readConfigFile = originalReadConfigFile;
  api.writeConfigFile = originalWriteConfigFile;
}

try {
  api.readConfigFile = async () => '{not valid';
  setActivePinia(createPinia());
  const store = useRunHistoryStore();
  await store.load();
  assert.deepEqual(store.entries, [], 'malformed history should recover as empty without blocking app load');
} finally {
  api.readConfigFile = originalReadConfigFile;
}

try {
  const writes: string[] = [];
  api.readConfigFile = async () => '';
  api.writeConfigFile = async (filename) => {
    writes.push(filename);
    throw new Error('history disk unavailable');
  };
  setActivePinia(createPinia());
  const store = useRunHistoryStore();
  await store.load();
  store.recordCompletedSession(makeSession('failed', 'failed-save-session'));
  await store.flush();
  assert.equal(store.lastError, '保存运行历史失败，主配置仍可正常使用。');
  assert.deepEqual(writes, ['run-history.json']);
} finally {
  api.readConfigFile = originalReadConfigFile;
  api.writeConfigFile = originalWriteConfigFile;
}

try {
  const originalWriteConfigFileForClear = api.writeConfigFile;
  api.readConfigFile = async () => JSON.stringify({ schemaVersion: 1, entries: [makeEntry(7)] });
  api.writeConfigFile = async () => undefined;
  setActivePinia(createPinia());
  const store = useRunHistoryStore();
  await store.load();
  store.clearProjectHistory('project-a');
  await store.flush();
  assert.equal(store.projectHistory('project-a').length, 0, 'clear should only remove project history');
  api.writeConfigFile = originalWriteConfigFileForClear;
} finally {
  api.readConfigFile = originalReadConfigFile;
  api.writeConfigFile = originalWriteConfigFile;
}

console.log('runHistory tests passed');
