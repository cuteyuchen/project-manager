import assert from 'node:assert/strict';
import {
  gitStatusSelectionKey,
  isGitStatusSelected,
  selectedGitStatusFiles,
} from '../src/utils/gitStatusSelection.ts';

const selected = new Set([
  gitStatusSelectionKey('staged', 'same.ts'),
  gitStatusSelectionKey('unstaged', 'same.ts'),
  gitStatusSelectionKey('unstaged', 'other.ts'),
]);
const files = [
  { path: 'same.ts', staged: true },
  { path: 'other.ts', staged: false },
];

assert.equal(isGitStatusSelected(selected, 'staged', 'same.ts'), true);
assert.equal(isGitStatusSelected(selected, 'unstaged', 'same.ts'), true);
assert.equal(isGitStatusSelected(selected, 'conflicted', 'same.ts'), false);
assert.deepEqual(
  selectedGitStatusFiles(selected, 'staged', files).map(file => file.path),
  ['same.ts'],
);
assert.deepEqual(
  selectedGitStatusFiles(selected, 'unstaged', files).map(file => file.path),
  ['same.ts', 'other.ts'],
);

console.log('gitStatusSelection tests passed');
