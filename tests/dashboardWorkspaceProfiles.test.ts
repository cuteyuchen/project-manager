import {
  decodeWorkspaceProfileSelection,
  encodeWorkspaceProfileSelection,
  normalizeProjectGroupId,
} from '../src/utils/dashboardProfiles';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

/***********************启动组条目编码/解码*********************/

{
  const encoded = encodeWorkspaceProfileSelection('project', 'dev');
  assertEq(encoded, 'project:dev', '项目脚本应带上 project 前缀');
}

{
  const encoded = encodeWorkspaceProfileSelection('custom', 'cmd-1');
  assertEq(encoded, 'custom:cmd-1', '自定义命令应带上 custom 前缀');
}

{
  const item = decodeWorkspaceProfileSelection('project-1', 'project:dev');
  assert(item !== null, '项目脚本应成功解码');
  assertEq(item?.type, 'project', '项目脚本应解码为 project 类型');
  assertEq(item?.projectId, 'project-1', '项目脚本应保留项目 id');
  assertEq(item?.nameOrCommandId, 'dev', '项目脚本应保留脚本名');
}

{
  const item = decodeWorkspaceProfileSelection('project-1', 'custom:cmd-1');
  assert(item !== null, '自定义命令应成功解码');
  assertEq(item?.type, 'custom', '自定义命令应解码为 custom 类型');
  assertEq(item?.projectId, 'project-1', '自定义命令应保留项目 id');
  assertEq(item?.nameOrCommandId, 'cmd-1', '自定义命令应保留命令 id');
}

{
  const item = decodeWorkspaceProfileSelection('project-1', 'unknown:value');
  assertEq(item, null, '未知前缀不应生成启动组条目');
}

/***********************分组 id 归一化*********************/

{
  assertEq(normalizeProjectGroupId('group-1'), 'group-1', '有效分组 id 应原样保留');
}

{
  assertEq(normalizeProjectGroupId(''), undefined, '空字符串应归一化为 undefined');
}

{
  assertEq(normalizeProjectGroupId('   '), undefined, '纯空白字符串应归一化为 undefined');
}

console.log('dashboardWorkspaceProfiles tests passed');
