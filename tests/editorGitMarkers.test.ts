import assert from 'node:assert/strict';
import {
  isEmptyLineMarkers,
  mergeLineMarkers,
  parseUnifiedDiffLineMarkers,
  toDisplayLineMarkers,
} from '../src/utils/editorGitMarkers.ts';

// Git unified diff → 行号标记解析的回归测试
const sampleDiff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' line1',
  '-old line2',
  '+new line2',
  '+added line3',
  ' line4',
  ' line5',
].join('\n');

const markers = parseUnifiedDiffLineMarkers(sampleDiff);
assert.equal(markers.modified.has(2), true, 'line2 should be modified');
assert.equal(markers.added.has(3), true, 'line3 should be added');
assert.equal(markers.deleted.size, 0, 'delete+add pair is modified, not deleted');
assert.equal(isEmptyLineMarkers(markers), false);

// 纯删除：标在删除块前一行底边（两行之间）
// context keep (1), delete, context tail → 删除发生在 line1 与 tail 之间 → deleted=1
const pureDeleteDiff = [
  '@@ -1,3 +1,2 @@',
  ' keep',
  '-remove me',
  ' tail',
].join('\n');
const deleted = parseUnifiedDiffLineMarkers(pureDeleteDiff);
assert.equal(deleted.deleted.has(1), true, 'delete tick sits on previous line bottom');

// 文件开头纯删除 → deleted=0（首行顶边）
const startDelete = parseUnifiedDiffLineMarkers('@@ -1,2 +1,1 @@\n-remove first\n keep\n');
assert.equal(startDelete.deleted.has(0), true, 'file-start delete uses 0');

// 文末纯删除 → deleted=最后存活行
const endDelete = parseUnifiedDiffLineMarkers('@@ -1,2 +1,1 @@\n keep\n-remove last\n');
assert.equal(endDelete.deleted.has(1), true, 'file-end delete ticks under last line');

const display = toDisplayLineMarkers(markers);
assert.equal(display.added.has(3), true);
assert.equal(display.modified.has(2), true);
assert.equal(display.deleted.size, 0);

const empty = parseUnifiedDiffLineMarkers('');
assert.equal(isEmptyLineMarkers(empty), true);

const merged = mergeLineMarkers(
  parseUnifiedDiffLineMarkers('@@ -1,1 +1,1 @@\n-a\n+b\n'),
  parseUnifiedDiffLineMarkers('@@ -1,1 +1,2 @@\n c\n+x\n'),
);
assert.equal(merged.modified.has(1), true);
assert.equal(merged.added.has(2), true);

console.log('editorGitMarkers.test.ts: all assertions passed');
