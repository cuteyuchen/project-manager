import assert from 'node:assert/strict';
import type { NodeVersion, Project } from '../src/types';
import { isExplicitNodeVersion, resolveProjectNodePath, shouldInjectTerminalNode } from '../src/utils/nodeRuntime';
import { projectNodeVersionHint } from '../src/utils/nvm';

function node(version: string, path: string, source: NodeVersion['source']): NodeVersion {
  return { version, path, source, status: 'available' };
}

const versions: NodeVersion[] = [
  node('v22.11.0', 'C:/system/node', 'system'),
  node('v20.11.1', 'C:/app/runtimes/node/v20.11.1', 'managed'),
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
  resolveProjectNodePath(project({ nodeVersion: 'Default' }), versions, {
    source: 'managed',
    version: 'v20.11.1',
    path: 'C:/app/runtimes/node/v20.11.1',
  }),
  'C:/app/runtimes/node/v20.11.1',
  'default label uses app default, not system PATH',
);

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
