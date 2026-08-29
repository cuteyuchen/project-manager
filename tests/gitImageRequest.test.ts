import assert from 'node:assert/strict';
import { isCurrentGitImageRequest, type GitImageRequestIdentity } from '../src/utils/gitImageRequest';

const imageA: GitImageRequestIdentity = {
  projectId: 'A', projectPath: 'C:/a', source: 'worktree', staged: false, file: 'a.png', oldPath: '',
};
const imageB = { ...imageA, file: 'b.png' };

assert.equal(isCurrentGitImageRequest(1, 2, imageA, imageB), false, 'slow A must not overwrite fast B');
assert.equal(isCurrentGitImageRequest(1, 1, imageA, imageB), false, 'failed B must invalidate A by selection identity');
assert.equal(isCurrentGitImageRequest(2, 2, imageA, { ...imageA, file: 'a.ts' }), false, 'image to text must invalidate image result');
assert.equal(isCurrentGitImageRequest(3, 3, imageA, { ...imageA, projectId: 'B', projectPath: 'C:/b' }), false, 'project switch must invalidate old result');
assert.equal(isCurrentGitImageRequest(4, 4, imageB, imageB), true, 'matching request may update the view');

console.log('gitImageRequest tests passed');
