import assert from 'node:assert/strict';
import type { NodeVersion, Project } from '../src/types';
import { buildNodeRuntimeId } from '../src/utils/nodeRuntime';
import { getProjectsUsingRuntime } from '../src/utils/nodeRuntimeUsage';

const managed: NodeVersion = {
  runtimeId: 'managed:v24.9.0',
  version: 'v24.9.0',
  path: 'C:/managed/v24.9.0',
  source: 'managed',
  status: 'available',
};
const system: NodeVersion = {
  runtimeId: buildNodeRuntimeId('system', 'v22.0.0', 'C:/system/node'),
  version: 'v22.0.0',
  path: 'C:/system/node',
  source: 'system',
  status: 'available',
};
const versions = [managed, system];

function project(index: number, overrides: Partial<Project> = {}): Project {
  return {
    id: `project-${index}`,
    name: `Project ${index}`,
    path: `C:/projects/project-${index}`,
    type: 'node',
    nodeVersion: 'Default',
    ...overrides,
  };
}

const projects = [
  project(1, { nodeRuntimeId: managed.runtimeId }),
  project(2, { nodeVersion: 'v24.9.0' }),
  ...Array.from({ length: 28 }, (_, index) => project(index + 3)),
];
const usages = getProjectsUsingRuntime(projects, managed, versions, {
  runtimeId: managed.runtimeId,
  source: 'managed',
  version: managed.version,
  path: managed.path,
});

assert.equal(usages.length, 30, 'usage lookup should scale to a large project list');
assert.equal(usages[0].reason, 'runtime-id', 'exact runtime bindings should explain the usage');
assert.equal(usages[1].reason, 'version', 'version hints should explain the usage');
assert.equal(usages[2].reason, 'default', 'default resolution should explain the usage');
assert.equal(getProjectsUsingRuntime(projects.slice(0, 1), managed, versions, {
  runtimeId: managed.runtimeId,
  source: 'managed',
  version: managed.version,
  path: managed.path,
}).length, 1, 'usage lookup should handle a single project');
assert.equal(getProjectsUsingRuntime(projects, system, versions, {
  runtimeId: managed.runtimeId,
  source: 'managed',
  version: managed.version,
  path: managed.path,
}).length, 0);

console.log('nodeRuntimeUsage tests passed');
