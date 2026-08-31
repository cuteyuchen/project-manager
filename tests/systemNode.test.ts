import assert from 'node:assert/strict';
import type { NodeVersion, SystemNodeState } from '../src/types';
import { buildNodeRuntimeId } from '../src/utils/nodeRuntime';
import { isRuntimeSystemCurrent, mapSystemNodeStateToRuntime } from '../src/utils/systemNode';
import { resolveAppDefaultRuntime } from '../src/utils/nodeRuntime';

function runtime(source: NodeVersion['source'], version: string, path: string): NodeVersion {
  return {
    runtimeId: buildNodeRuntimeId(source, version, path),
    source,
    version,
    path,
    status: 'available',
  };
}

function state(overrides: Partial<SystemNodeState>): SystemNodeState {
  return {
    available: true,
    version: 'v24.20.0',
    nodePath: 'C:/Program Files/nodejs/node.exe',
    source: 'unknown',
    candidates: [],
    pathScope: 'machine',
    ...overrides,
  };
}

const managed = runtime('managed', 'v24.20.0', 'C:/managed/v24.20.0');
const nvm = runtime('nvm', 'v24.20.0', 'D:/nvm/v24.20.0');
const custom = runtime('custom', 'v24.20.0', 'E:/custom/v24.20.0');

{
  const mapped = mapSystemNodeStateToRuntime(
    state({
      nodePath: 'C:/managed/v24.20.0/node.exe',
      pathScope: 'user',
    }),
    [managed, nvm, custom],
  );
  assert.equal(mapped.source, 'managed');
  assert.equal(mapped.runtimeId, managed.runtimeId);
}

{
  const mapped = mapSystemNodeStateToRuntime(
    state({
      version: 'v24.20.0',
      nodePath: 'D:/node/node.exe',
      pathScope: 'nvm',
      nvmSymlink: 'D:/node',
      nvmTargetPath: 'D:/nvm/v24.20.0',
      canonicalNodePath: 'D:/nvm/v24.20.0/node.exe',
      candidates: [{ path: 'D:/node/node.exe', version: 'v24.20.0', canonicalPath: 'D:/nvm/v24.20.0/node.exe' }],
    }),
    [managed, nvm, custom],
  );
  assert.equal(mapped.source, 'nvm');
  assert.equal(mapped.runtimeId, nvm.runtimeId);
}

{
  const mapped = mapSystemNodeStateToRuntime(
    state({
      nodePath: 'E:/custom/v24.20.0/node.exe',
      pathScope: 'user',
    }),
    [managed, nvm, custom],
  );
  assert.equal(mapped.source, 'custom');
  assert.equal(mapped.runtimeId, custom.runtimeId);
}

{
  const mapped = mapSystemNodeStateToRuntime(
    state({
      nodePath: 'D:/node/node.exe',
      pathScope: 'nvm',
      nvmTargetPath: undefined,
    }),
    [nvm],
  );
  assert.equal(mapped.source, 'external', 'same version alone must not identify an NVM Runtime');
  assert.equal(mapped.runtimeId, undefined);
}

{
  const system = state({
    version: 'v24.20.0',
    nodePath: 'C:/managed/v24.20.0/node.exe',
    runtimeId: managed.runtimeId,
    source: 'managed',
  });
  assert.equal(isRuntimeSystemCurrent(managed, system), true);
  assert.equal(isRuntimeSystemCurrent(nvm, system), false);
}

{
  const versions = [
    runtime('nvm', 'v20.19.1', 'D:/nvm/v20.19.1'),
    runtime('managed', 'v24.20.0', 'C:/managed/v24.20.0'),
    runtime('system', 'v24.20.0', 'C:/managed/v24.20.0/node.exe'),
  ];
  const resolved = resolveAppDefaultRuntime(versions, {
    runtimeId: versions[0].runtimeId,
    source: 'nvm',
    version: 'v20.19.1',
    path: 'D:/nvm/v20.19.1',
  });
  assert.equal(resolved.runtime?.source, 'nvm');
  assert.equal(resolved.runtime?.version, 'v20.19.1');
  assert.equal(
    isRuntimeSystemCurrent(versions[1], state({
      version: 'v24.20.0',
      nodePath: 'C:/managed/v24.20.0/node.exe',
      runtimeId: versions[1].runtimeId,
      source: 'managed',
    })),
    true,
  );
}

console.log('systemNode tests passed');
