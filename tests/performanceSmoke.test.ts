import assert from 'node:assert/strict';
import type { Project, RunHistoryEntry, RunSession } from '../src/types.ts';
import { createProjectRunSummaryIndex } from '../src/utils/projectRunSummary.ts';
import { collectVisibleProjectIds } from '../src/utils/projectTreeView.ts';
import { applyRunHistoryRetention } from '../src/utils/runHistory.ts';

const projects: Project[] = Array.from({ length: 500 }, (_, index) => ({
  id: `project-${index}`,
  name: `Project ${index}`,
  path: `C:/fixture/project-${index}`,
  type: 'node',
  tags: [`tag-${index % 20}`, `tag-${index % 7}`],
  parentId: index === 0
    ? undefined
    : index <= 250
      ? 'project-0'
      : `project-${1 + ((index - 251) % 250)}`,
}));

const history: RunHistoryEntry[] = Array.from({ length: 500 }, (_, index) => ({
  historyId: `history-${index}`,
  sessionId: `history-session-${index}`,
  projectId: `project-${index}`,
  commandKey: `project-${index}:script:build`,
  commandType: 'script',
  commandId: 'build',
  displayName: 'build',
  cwd: `C:/fixture/project-${index}`,
  status: index % 2 === 0 ? 'success' : 'failed',
  startedAt: index,
  endedAt: index + 1,
  durationMs: 1,
  exitCode: index % 2 === 0 ? 0 : 1,
}));

const sessions: Record<string, RunSession> = {
  active: {
    sessionId: 'active',
    commandKey: 'project-1:script:dev',
    projectId: 'project-1',
    commandType: 'script',
    commandId: 'dev',
    displayName: 'dev',
    cwd: 'C:/fixture/project-1',
    status: 'running',
    startedAt: 10_000,
  },
};

const startedAt = Date.now();
const index = createProjectRunSummaryIndex(projects, sessions, history);
const summaries = projects.map(project => index.getSubtreeSummary(project.id));
const elapsed = Date.now() - startedAt;
assert.equal(summaries.length, 500);
assert.equal(summaries[0]?.status, 'running');
assert.equal(summaries[0]?.activeCount, 1);
assert.equal(summaries[1]?.sessionId, 'active');
assert(elapsed < 5_000, `summary index fixture took too long: ${elapsed}ms`);

const visible = collectVisibleProjectIds(projects, ['project-499']);
assert(visible.has('project-499'));
assert(visible.has('project-0'));
assert.equal(applyRunHistoryRetention(history).length, 500);
console.log(`performance smoke passed (${elapsed}ms)`);
