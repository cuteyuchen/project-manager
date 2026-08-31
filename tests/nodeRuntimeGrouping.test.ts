import assert from 'node:assert/strict';
import type { NodeVersion, SystemNodeState } from '../src/types';
import { buildNodeRuntimeId } from '../src/utils/nodeRuntime';
import {
  buildNodeVersionEntries,
  canonicalizeNodeRuntimes,
  groupNodeRuntimesByVersion,
  summarizeRuntimeSources,
} from '../src/utils/nodeRuntimeGrouping';

function runtime(
  version: string,
  path: string,
  source: NodeVersion['source'],
  canonicalPath?: string,
): NodeVersion {
  return {
    runtimeId: buildNodeRuntimeId(source, version, path),
    version,
    path,
    canonicalPath,
    source,
    status: 'available',
  };
}

const groups = groupNodeRuntimesByVersion([
  runtime('v18.20.0', 'C:/managed/v18.20.0', 'managed'),
  runtime('24.9.0', 'C:/managed/v24.9.0', 'managed'),
  runtime('v24.9.0', 'C:/nvm/one/v24.9.0', 'nvm'),
  runtime('v24.9.0', 'C:/nvm/two/v24.9.0', 'nvm'),
  runtime('v24.9.0', 'C:/system/node', 'system'),
]);

assert.equal(groups.length, 2, 'same version records should render as one group');
assert.equal(groups[0].version, 'v24.9.0', 'versions should be normalized and sorted descending');
assert.deepEqual(groups[0].sources, ['managed', 'nvm']);
assert.equal(groups[0].runtimes.length, 3, 'System is state, not a normal Runtime row');
assert.deepEqual(
  groups[0].runtimes.map(item => item.path),
  ['C:/managed/v24.9.0', 'C:/nvm/one/v24.9.0', 'C:/nvm/two/v24.9.0'],
);
assert.deepEqual(
  summarizeRuntimeSources(groups[0].runtimes),
  [
    { source: 'managed', count: 1 },
    { source: 'nvm', count: 2 },
  ],
  'source summaries should count physical canonical runtimes without System aliases',
);

{
  const alias = runtime(
    'v24.9.0',
    'D:/node/node.exe',
    'system',
    'D:/nvm/nvm/v24.9.0/node.exe',
  );
  const physical = runtime(
    'v24.9.0',
    'D:/nvm/nvm/v24.9.0',
    'nvm',
    'D:/nvm/nvm/v24.9.0',
  );
  const state: SystemNodeState = {
    available: true,
    version: 'v24.9.0',
    nodePath: 'D:/node/node.exe',
    canonicalNodePath: 'D:/nvm/nvm/v24.9.0/node.exe',
    source: 'unknown',
    candidates: [{ path: 'D:/node/node.exe', canonicalPath: 'D:/nvm/nvm/v24.9.0/node.exe', version: 'v24.9.0' }],
    pathScope: 'nvm',
  };
  const canonical = canonicalizeNodeRuntimes([alias, physical], { systemNodeState: state });
  assert.equal(canonical.length, 1, 'a system link and its physical Runtime must canonicalize together');
  assert.equal(canonical[0].version, 'v24.9.0');
  assert.equal(canonical[0].preferredSource, 'nvm');
  assert.equal(canonical[0].isSystemCurrent, true);
  assert.equal(canonical[0].aliases.length, 2);
}

{
  const entries = buildNodeVersionEntries([
    runtime('v20.19.1', 'D:/Managed/v20.19.1', 'managed', 'D:/Managed/v20.19.1'),
    runtime('v20.19.1', 'D:/nvm/v20.19.1', 'nvm', 'D:/nvm/v20.19.1'),
  ]);
  assert.equal(entries.length, 1, 'different physical sources of one version still render one entry');
  assert.equal(entries[0].runtimes.length, 2, 'canonical physical runtimes remain available internally');
  assert.equal(entries[0].effectiveRuntime.source, 'managed', 'Managed is the deterministic default preference');
}

{
  const managed = runtime('v20.19.1', 'D:/Managed/v20.19.1', 'managed', 'D:/Managed/v20.19.1');
  const nvm = runtime('v20.19.1', 'D:/nvm/v20.19.1', 'nvm', 'D:/nvm/v20.19.1');
  const entries = buildNodeVersionEntries([managed, nvm], {
    appDefault: {
      runtimeId: nvm.runtimeId,
      source: 'nvm',
      version: nvm.version,
      path: nvm.path,
    },
  });
  assert.equal(entries[0].effectiveRuntime.source, 'nvm', 'an exact Project Manager default wins within a version');
  assert.equal(entries[0].isProjectManagerDefault, true);
}

{
  const managed = runtime('v20.19.1', 'D:/Managed/v20.19.1', 'managed', 'D:/nvm/v20.19.1');
  const nvm = runtime('v20.19.1', 'D:/nvm/v20.19.1', 'nvm', 'D:/nvm/v20.19.1');
  const entries = buildNodeVersionEntries([managed, nvm], {
    appDefault: {
      runtimeId: nvm.runtimeId,
      source: 'nvm',
      version: nvm.version,
      path: nvm.path,
    },
  });
  assert.equal(entries[0].runtimes.length, 1, 'aliases of one physical Runtime stay canonicalized');
  assert.equal(entries[0].effectiveRuntime.source, 'nvm', 'exact NVM default must survive a Managed alias');
  assert.equal(entries[0].effectiveRuntime.path, nvm.path);
}

{
  const managed = runtime('v20.19.1', 'D:/Managed/v20.19.1', 'managed', 'D:/nvm/v20.19.1');
  const nvm = runtime('v20.19.1', 'D:/nvm/v20.19.1', 'nvm', 'D:/nvm/v20.19.1');
  const systemState: SystemNodeState = {
    available: true,
    version: 'v20.19.1',
    nodePath: 'D:/node/node.exe',
    canonicalNodePath: 'D:/nvm/v20.19.1/node.exe',
    source: 'nvm',
    candidates: [{
      path: 'D:/node/node.exe',
      canonicalPath: 'D:/nvm/v20.19.1/node.exe',
      version: 'v20.19.1',
    }],
    pathScope: 'nvm',
  };
  const entries = buildNodeVersionEntries([managed, nvm], { systemNodeState: systemState });
  assert.equal(entries[0].effectiveRuntime.source, 'nvm', 'system current must select its exact NVM variant');
  assert.equal(entries[0].effectiveRuntime.path, nvm.path);
  assert.equal(entries[0].isSystemCurrent, true);
}

{
  const managed = runtime('v20.19.1', 'D:/Managed/v20.19.1', 'managed', 'D:/Managed/v20.19.1');
  const nvm = runtime('v20.19.1', 'D:/nvm/v20.19.1', 'nvm', 'D:/nvm/v20.19.1');
  const entries = buildNodeVersionEntries([managed, nvm], {
    appDefault: {
      runtimeId: managed.runtimeId,
      source: 'managed',
      version: managed.version,
      path: managed.path,
    },
    systemNodeState: {
      available: true,
      version: 'v20.19.1',
      nodePath: 'D:/node/node.exe',
      canonicalNodePath: 'D:/nvm/v20.19.1/node.exe',
      runtimeId: nvm.runtimeId,
      source: 'nvm',
      candidates: [{
        path: 'D:/node/node.exe',
        canonicalPath: 'D:/nvm/v20.19.1/node.exe',
        version: 'v20.19.1',
      }],
      pathScope: 'nvm',
    },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].effectiveRuntime.source, 'managed', 'App Default remains the effective operation target');
  assert.equal(entries[0].isProjectManagerDefault, true);
  assert.equal(entries[0].isSystemCurrent, true, 'System Current is version-level state, independent of effectiveRuntime');
}

console.log('nodeRuntimeGrouping tests passed');
