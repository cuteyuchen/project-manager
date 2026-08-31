import assert from 'node:assert/strict';
import type { NodeVersion, Project } from '../src/types';
import {
  buildNodeRuntimeId,
  getRuntimesByVersion,
  isExplicitNodeVersion,
  resolveAppDefaultRuntime,
  resolveProjectNodePath,
  resolveProjectRuntime,
  shouldInjectTerminalNode,
} from '../src/utils/nodeRuntime';
import { projectNodeVersionHint } from '../src/utils/nvm';

function node(version: string, path: string, source: NodeVersion['source']): NodeVersion {
  return { runtimeId: buildNodeRuntimeId(source, version, path), version, path, source, status: 'available' };
}

const versions: NodeVersion[] = [
  node('v22.11.0', 'C:/system/node', 'system'),
  node('v20.11.1', 'C:/app/runtimes/node/v20.11.1', 'managed'),
  node('v20.11.1', 'C:/Users/test/AppData/Roaming/nvm/v20.11.1', 'nvm'),
  node('v20.11.1', 'D:/custom/node20', 'custom'),
  node('v18.19.0', 'D:/custom/node18', 'custom'),
];

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'demo',
  path: 'C:/demo',
  type: 'node',
  nodeVersion: 'v20.11.1',
  ...overrides,
});

assert.equal(
  resolveProjectNodePath(project(), versions),
  'C:/app/runtimes/node/v20.11.1',
  'explicit version prefers managed over custom/system',
);

assert.equal(
  resolveProjectNodePath(
    project({ nodeRuntimeId: 'nvm:c:/users/test/appdata/roaming/nvm/v20.11.1' }),
    versions,
  ),
  'C:/Users/test/AppData/Roaming/nvm/v20.11.1',
  'exact runtimeId must win over a same-version Managed runtime',
);

assert.equal(getRuntimesByVersion(versions, 'v20.11.1').map(runtime => runtime.source).join(','), 'managed,nvm,custom');

const unavailable = resolveProjectRuntime(
  project({ nodeRuntimeId: 'nvm:c:/missing/v20.11.1' }),
  versions,
);
assert.equal(unavailable.runtime?.source, 'managed', 'a missing exact binding should fall back to the version effective Runtime');
assert.equal(unavailable.unavailable, false);
assert.equal(
  resolveProjectNodePath(project({ nodeRuntimeId: 'nvm:c:/missing/v20.11.1' }), versions),
  'C:/app/runtimes/node/v20.11.1',
);

assert.equal(
  resolveProjectNodePath(project({ nodeVersion: 'Default' }), versions, {
    runtimeId: 'managed:v20.11.1',
    source: 'managed',
    version: 'v20.11.1',
    path: 'C:/app/runtimes/node/v20.11.1',
  }),
  'C:/app/runtimes/node/v20.11.1',
  'default label uses app default, not system PATH',
);

const defaultAfterMigration = resolveAppDefaultRuntime(versions, {
  source: 'managed',
  version: 'v20.11.1',
  path: 'D:/old-location/v20.11.1',
});
assert.equal(defaultAfterMigration.runtime?.path, 'C:/app/runtimes/node/v20.11.1');

assert.equal(
  resolveProjectNodePath(project({ nodeVersion: 'v18.19.0' }), versions),
  'D:/custom/node18',
);

assert.equal(isExplicitNodeVersion('v20.11.1'), true);
assert.equal(isExplicitNodeVersion('Default'), false);
assert.equal(projectNodeVersionHint({ nvmVersion: '20.11.1', nodeVersionHint: 'v20.11.1' }), 'v20.11.1');
assert.equal(projectNodeVersionHint({ nvmVersion: '18.20.0' }), '18.20.0');

assert.equal(shouldInjectTerminalNode(project()), true);
assert.equal(shouldInjectTerminalNode(project({ terminalInjectNode: undefined })), true);
assert.equal(shouldInjectTerminalNode(project({ terminalInjectNode: true })), true);
assert.equal(shouldInjectTerminalNode(project({ terminalInjectNode: false })), false);
assert.equal(shouldInjectTerminalNode(project({ type: 'java' })), false);

console.log('nodeRuntime tests passed');
