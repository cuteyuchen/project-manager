import type { NodeVersion } from '../src/types';
import { mergeNodeRuntimes, migrateLegacyNodeSource, sortNodeVersions, upsertSystemNodeVersion } from '../src/utils/nodeDefaultState';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function createNode(version: string, path: string, source: NodeVersion['source']): NodeVersion {
  return { version, path, source };
}

{
  const versions = [
    createNode('v18.19.0', 'C:/runtimes/v18.19.0', 'managed'),
    createNode('v16.20.2', 'C:/runtimes/v16.20.2', 'managed'),
    createNode('v14.21.3', 'C:/system/old', 'system'),
  ];

  const result = upsertSystemNodeVersion(versions, {
    version: 'v20.11.1',
    path: 'C:/system/current',
  });

  assert(result.every(item => item.source !== 'system'), 'System Node must not be persisted as a Runtime row');
  assert(result[0].version === 'v18.19.0', 'registry rows should remain sorted after detector refresh');
}

{
  const versions = [
    createNode('v18.19.0', 'C:/runtimes/v18.19.0', 'managed'),
    createNode('v16.20.2', 'C:/runtimes/v16.20.2', 'managed'),
  ];

  const result = upsertSystemNodeVersion(versions, {
    version: 'v18.19.0',
    path: 'C:/system/current',
  });

  assert(result.length === 2, 'System detection must not add a synthetic Runtime row');
  assert(result.every(item => item.source !== 'system'));
}

{
  const result = sortNodeVersions([
    createNode('v16.20.2', 'C:/runtimes/v16.20.2', 'managed'),
    createNode('v20.11.1', 'C:/custom/v20.11.1', 'custom'),
    createNode('v22.0.0', 'C:/runtimes/v22.0.0', 'managed'),
  ]);

  assert(result[0].version === 'v22.0.0', 'managed rows should keep version-desc order');
}

{
  const merged = mergeNodeRuntimes({
    managed: [
      createNode('v20.11.1', 'C:/app/runtimes/node/v20.11.1', 'managed'),
      createNode('v20.11.1', 'C:/app/runtimes/node/v20.11.1', 'managed'),
    ],
    custom: [createNode('v18.19.0', 'D:/node', 'custom')],
  });
  assert(merged.filter(item => item.source === 'managed').length === 1, 'merge must not duplicate managed runtimes');
  assert(merged.some(item => item.source === 'custom'), 'custom runtimes must be kept');
}

assert(migrateLegacyNodeSource('nvm') === 'custom', 'legacy nvm source should migrate to custom');
assert(migrateLegacyNodeSource('managed') === 'managed', 'managed source should stay managed');
assert(migrateLegacyNodeSource('system') === 'system', 'system source should stay system');

console.log('nodeDefaultState tests passed');
