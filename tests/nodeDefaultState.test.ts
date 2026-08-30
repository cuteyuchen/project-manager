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

  assert(result[0].source === 'system', 'system row should stay at the first position');
  assert(result[0].version === 'v20.11.1', 'system row version should be updated');
  assert(result[0].path === 'C:/system/current', 'system row path should be updated');
  assert(result.filter(item => item.source === 'system').length === 1, 'system row should not be duplicated');
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

  assert(result[0].source === 'system', 'missing system row should be inserted at the first position');
  assert(result[0].version === 'v18.19.0', 'inserted system row should use incoming version');
  assert(result.filter(item => item.source === 'system').length === 1, 'inserted system row should appear once');
}

{
  const result = sortNodeVersions([
    createNode('v16.20.2', 'C:/runtimes/v16.20.2', 'managed'),
    createNode('v20.11.1', 'C:/custom/v20.11.1', 'custom'),
    createNode('v18.19.0', 'C:/system/current', 'system'),
    createNode('v22.0.0', 'C:/runtimes/v22.0.0', 'managed'),
  ]);

  assert(result[0].source === 'system', 'system row should always be first after sorting');
  assert(result[1].version === 'v22.0.0', 'managed rows should keep version-desc order after system');
}

{
  const merged = mergeNodeRuntimes({
    system: createNode('v22.0.0', 'C:/system/node', 'system'),
    managed: [
      createNode('v20.11.1', 'C:/app/runtimes/node/v20.11.1', 'managed'),
      createNode('v20.11.1', 'C:/app/runtimes/node/v20.11.1', 'managed'),
    ],
    custom: [createNode('v18.19.0', 'D:/node', 'custom')],
  });
  assert(merged.filter(item => item.source === 'managed').length === 1, 'merge must not duplicate managed runtimes');
  assert(merged.some(item => item.source === 'custom'), 'custom runtimes must be kept');
}

assert.equal(migrateLegacyNodeSource('nvm'), 'custom');
assert.equal(migrateLegacyNodeSource('managed'), 'managed');
assert.equal(migrateLegacyNodeSource('system'), 'system');

console.log('nodeDefaultState tests passed');
