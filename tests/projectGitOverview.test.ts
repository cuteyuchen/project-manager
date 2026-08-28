import assert from 'node:assert/strict';
import type { GitFileStatus, GitStatusResult } from '../src/types.ts';
import { summarizeGitStatus } from '../src/utils/projectGitOverview.ts';

function file(path: string, status: GitFileStatus['status'], staged = false): GitFileStatus {
  return { path, status, staged };
}

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return { staged: [], unstaged: [], untracked: [], conflicted: [], ...overrides };
}

assert.deepEqual(summarizeGitStatus(status({ unstaged: [file('a.ts', 'modified')] }), true), {
  isGitRepo: true, modified: 1, added: 0, deleted: 0, conflicted: 0, total: 1, clean: false,
});
assert.equal(summarizeGitStatus(status({ staged: [file('a.ts', 'added', true)] }), true)?.added, 1);
assert.equal(summarizeGitStatus(status({ unstaged: [file('a.ts', 'deleted')] }), true)?.deleted, 1);
assert.equal(summarizeGitStatus(status({ conflicted: [file('a.ts', 'conflicted')] }), true)?.conflicted, 1);
assert.equal(
  summarizeGitStatus(status({ staged: [file('a.ts', 'modified', true)], unstaged: [file('a.ts', 'modified')] }), true)?.total,
  1,
  'staged 与 unstaged 同一路径只计一次',
);
assert.equal(summarizeGitStatus(status({ untracked: [file('a.ts', 'untracked')] }), true)?.added, 1);
assert.equal(summarizeGitStatus(status({ staged: [file('a.ts', 'renamed', true)] }), true)?.modified, 1);
assert.equal(summarizeGitStatus(status(), true)?.clean, true);
assert.equal(summarizeGitStatus(undefined, false)?.clean, true);
assert.deepEqual(
  summarizeGitStatus(status({
    staged: [file('same.ts', 'modified', true), file('deleted.ts', 'deleted', true)],
    unstaged: [file('same.ts', 'added'), file('deleted.ts', 'modified')],
    conflicted: [file('conflict.ts', 'conflicted'), file('same.ts', 'conflicted')],
  }), true),
  { isGitRepo: true, modified: 0, added: 0, deleted: 1, conflicted: 2, total: 3, clean: false },
  '跨多个 bucket 时按路径和状态优先级合并',
);

console.log('projectGitOverview tests passed');
