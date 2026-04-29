import type { NodeVersion } from '../src/types';
import { sortNodeVersions, upsertSystemNodeVersion } from '../src/utils/nodeDefaultState';

/***********************测试数据辅助函数*********************/

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function createNode(version: string, path: string, source: NodeVersion['source']): NodeVersion {
  return { version, path, source };
}

/***********************默认 Node 行更新*********************/

{
  const versions = [
    createNode('v18.19.0', 'C:/nvm/v18.19.0', 'nvm'),
    createNode('v16.20.2', 'C:/nvm/v16.20.2', 'nvm'),
    createNode('v14.21.3', 'C:/system/old', 'system'),
  ];

  const result = upsertSystemNodeVersion(versions, {
    version: 'v20.11.1',
    path: 'C:/nvm/current',
  });

  assert(result[0].source === 'system', 'system row should stay at the first position');
  assert(result[0].version === 'v20.11.1', 'system row version should be updated');
  assert(result[0].path === 'C:/nvm/current', 'system row path should be updated');
  assert(result.filter(item => item.source === 'system').length === 1, 'system row should not be duplicated');
}

/***********************缺少默认 Node 行时自动补齐*********************/

{
  const versions = [
    createNode('v18.19.0', 'C:/nvm/v18.19.0', 'nvm'),
    createNode('v16.20.2', 'C:/nvm/v16.20.2', 'nvm'),
  ];

  const result = upsertSystemNodeVersion(versions, {
    version: 'v18.19.0',
    path: 'C:/nvm/current',
  });

  assert(result[0].source === 'system', 'missing system row should be inserted at the first position');
  assert(result[0].version === 'v18.19.0', 'inserted system row should use incoming version');
  assert(result.filter(item => item.source === 'system').length === 1, 'inserted system row should appear once');
}

/***********************排序规则保持默认项首行*********************/

{
  const result = sortNodeVersions([
    createNode('v16.20.2', 'C:/nvm/v16.20.2', 'nvm'),
    createNode('v20.11.1', 'C:/custom/v20.11.1', 'custom'),
    createNode('v18.19.0', 'C:/system/current', 'system'),
    createNode('v22.0.0', 'C:/nvm/v22.0.0', 'nvm'),
  ]);

  assert(result[0].source === 'system', 'system row should always be first after sorting');
  assert(result[1].version === 'v22.0.0', 'non-system rows should keep version-desc order');
}

console.log('nodeDefaultState tests passed');
