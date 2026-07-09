import assert from 'node:assert/strict';
import type { Project } from '../src/types.ts';
import { collectProjectTags, normalizeProjectTags, projectMatchesSelectedTags } from '../src/utils/projectTags.ts';

function project(id: string, tags?: string[]): Project {
  return {
    id,
    name: id,
    path: `F:/${id}`,
    type: 'other',
    tags,
  };
}

/***********************共享标签聚合与筛选*********************/

const projects = [
  project('a', [' 富阳 ', '前端']),
  project('b', ['富阳', '后台']),
  project('c', ['钱塘江']),
];

assert.deepEqual(
  normalizeProjectTags([' 富阳 ', '富阳', '', ' 前端 ']),
  ['富阳', '前端'],
  '标签应去除首尾空格、去重并丢弃空值',
);

assert.deepEqual(
  collectProjectTags(projects),
  ['前端', '后台', '富阳', '钱塘江'],
  '所有项目标签应聚合成可复用的筛选选项',
);

assert.deepEqual(
  projects.filter((item) => projectMatchesSelectedTags(item, ['富阳'])).map((item) => item.id),
  ['a', 'b'],
  '两个项目填入同一个标签后，应能通过该标签一起筛选出来',
);

assert.deepEqual(
  projects.filter((item) => projectMatchesSelectedTags(item, ['富阳', '前端'])).map((item) => item.id),
  ['a'],
  '多标签筛选仍应要求项目同时包含所有选中标签',
);

console.log('projectTags tests passed');
