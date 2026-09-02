import assert from 'node:assert/strict';
import { formatErrorDetails, getSafeErrorMessage } from '../src/utils/errorDetails.ts';
import {
  CONFIG_FILE_NAME,
  assertSafeConfigFilename,
  configBackupFilename,
  isPersistedDataShape,
  parsePersistedData,
} from '../src/utils/configSafety.ts';
import { assertSafeExternalUrl } from '../src/utils/externalUrl.ts';
import { createPersistenceSaveQueue } from '../src/utils/persistenceQueue.ts';

assert.equal(CONFIG_FILE_NAME, 'data.json');
assert.equal(assertSafeConfigFilename('run-history.json'), 'run-history.json');
assert.equal(configBackupFilename('data.json'), 'data.json.bak');
for (const unsafe of ['../data.json', '..\\data.json', '/tmp/data.json', 'C:\\data.json', 'data.json:stream', '', '.', '..']) {
  assert.throws(() => assertSafeConfigFilename(unsafe), /Invalid config filename/);
}

const valid = { projects: [], settings: {}, customNodes: [] };
assert.equal(isPersistedDataShape(valid), true);
assert.deepEqual(parsePersistedData(JSON.stringify(valid)), valid);
assert.throws(() => parsePersistedData('{broken'), /Unexpected|JSON/);
assert.throws(() => parsePersistedData(JSON.stringify({ projects: [] })), /Invalid persisted data shape/);
assert.equal(assertSafeExternalUrl(' https://example.com/path '), 'https://example.com/path');
assert.throws(() => assertSafeExternalUrl('javascript:alert(1)'), /Only http and https/);
assert.throws(() => assertSafeExternalUrl('file:///tmp/data.json'), /Only http and https/);

let primary = JSON.stringify({ version: 'A' });
let backup = '';
const writes: string[] = [];
const queue = createPersistenceSaveQueue(async serialized => {
  backup = primary;
  primary = serialized;
  writes.push(serialized);
});
queue.markPersisted(primary);
await queue.enqueue(JSON.stringify({ version: 'B' }));
await queue.enqueue(JSON.stringify({ version: 'C' }));
assert.deepEqual(JSON.parse(primary), { version: 'C' });
assert.deepEqual(JSON.parse(backup), { version: 'B' });
assert.equal(writes.length, 2);

const details = formatErrorDetails(new Error('token=secret-value; ordinary failure'), {
  appVersion: '1.6.2',
  target: 'utools',
  platform: 'win32/x64',
  currentView: 'settings',
  timestamp: '2026-09-01T00:00:00.000Z',
});
assert(details.includes('App version: 1.6.2'));
assert(details.includes('Current view: settings'));
assert(!details.includes('secret-value'));
assert(details.includes('[REDACTED]'));
const privateDetails = formatErrorDetails(new Error('Authorization: Bearer jwt-secret https://example.com/?api_key=url-secret'), {
  appVersion: '1.6.2',
  target: 'utools',
  platform: 'win32/x64',
  currentView: 'settings',
  timestamp: '2026-09-01T00:00:00.000Z',
});
assert(!privateDetails.includes('jwt-secret'));
assert(!privateDetails.includes('url-secret'));
const jsonPrivateDetails = formatErrorDetails(new Error('request failed: {"apiKey":"json-secret","accessToken":"token-secret","clientSecret":"client-secret"}'), {
  appVersion: '1.6.2',
  target: 'utools',
  platform: 'win32/x64',
  currentView: 'settings',
  timestamp: '2026-09-01T00:00:00.000Z',
});
assert(!jsonPrivateDetails.includes('json-secret'));
assert(!jsonPrivateDetails.includes('token-secret'));
assert(!jsonPrivateDetails.includes('client-secret'));
assert.equal(getSafeErrorMessage(new Error('token=secret-value; ordinary failure')), 'token=[REDACTED]; ordinary failure');
assert(getSafeErrorMessage(new Error('x'.repeat(300))).length <= 240);

const persistenceSource = await (await import('node:fs/promises')).readFile('src/utils/persistence.ts', 'utf8');
const appSource = await (await import('node:fs/promises')).readFile('src/App.vue', 'utf8');
const tauriSource = await (await import('node:fs/promises')).readFile('src-tauri/src/lib.rs', 'utf8');
const nodeRuntimeSource = await (await import('node:fs/promises')).readFile('src-tauri/src/node_runtime.rs', 'utf8');
const projectMemoSource = await (await import('node:fs/promises')).readFile('src/components/ProjectMemo.vue', 'utf8');
assert(persistenceSource.includes('inspectBackup'));
assert(persistenceSource.includes('restoreConfigBackup'));
assert(persistenceSource.includes('parsePersistedData'));
assert.match(persistenceSource, /if \(!content\)[\s\S]{0,180}?api\.hasConfigBackup\(FILE_NAME\)/);
assert.match(persistenceSource, /normalizedDataChanged\s*\|\|=\s*data\.settings\.workspaceExplorerWidth/);
assert.match(persistenceSource, /normalizedDataChanged\s*\|\|=\s*JSON\.stringify\(managedLocation\)/);
assert(appSource.includes('persistence.corruptedMessage'));
assert(appSource.includes('persistence.restoreBackup'));
assert.match(tauriSource, /restore_config_backup_paths\(&primary, &backup, &filename\)\?;[\s\S]*fs::read_to_string\(&backup\)/);
assert(nodeRuntimeSource.includes('crate::write_config_with_backup(&path, &serialized)'));
assert(!nodeRuntimeSource.includes('crate::atomic_write_config(&path, &serialized)'));
assert(projectMemoSource.includes("import { isSafeExternalUrl } from '../utils/externalUrl';"));
assert.match(projectMemoSource, /e\.preventDefault\(\);[\s\S]*isSafeExternalUrl\(href\)/);
console.log('persistenceRecovery tests passed');
