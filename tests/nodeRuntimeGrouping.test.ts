import assert from 'node:assert/strict';
import type { NodeVersion } from '../src/types';
import { buildNodeRuntimeId } from '../src/utils/nodeRuntime';
import { groupNodeRuntimesByVersion, summarizeRuntimeSources } from '../src/utils/nodeRuntimeGrouping';

function runtime(version: string, path: string, source: NodeVersion['source']): NodeVersion {
  return {
    runtimeId: buildNodeRuntimeId(source, version, path),
    version,
    path,
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
assert.deepEqual(groups[0].sources, ['managed', 'nvm', 'system']);
assert.equal(groups[0].runtimes.length, 4, 'source-specific records must not be discarded');
assert.deepEqual(
  groups[0].runtimes.map(item => item.path),
  ['C:/managed/v24.9.0', 'C:/nvm/one/v24.9.0', 'C:/nvm/two/v24.9.0', 'C:/system/node'],
);
assert.deepEqual(
  summarizeRuntimeSources(groups[0].runtimes),
  [
    { source: 'managed', count: 1 },
    { source: 'nvm', count: 2 },
    { source: 'system', count: 1 },
  ],
  'source summaries should count records without merging source-specific runtimes',
);

console.log('nodeRuntimeGrouping tests passed');
