import assert from 'node:assert/strict';
import type { RunHistoryEntry, RunSession } from '../src/types.ts';
import { aggregateRunSummaryForSubtree, getProjectRunSummary } from '../src/utils/projectRunSummary.ts';

const projects = [
  { id: 'root', name: 'Root', path: 'C:/root', type: 'node' as const },
  { id: 'child-a', name: 'Child A', path: 'C:/root/a', type: 'node' as const, parentId: 'root' },
  { id: 'child-b', name: 'Child B', path: 'C:/root/b', type: 'node' as const, parentId: 'root' },
  { id: 'other', name: 'Other', path: 'C:/other', type: 'node' as const },
];

function session(
  sessionId: string,
  projectId: string,
  status: RunSession['status'],
  startedAt: number,
  endedAt?: number,
): RunSession {
  return {
    sessionId,
    commandKey: `${projectId}:script:${sessionId}`,
    projectId,
    commandType: 'script',
    commandId: sessionId,
    displayName: sessionId,
    cwd: `C:/${projectId}`,
    status,
    startedAt,
    endedAt,
    durationMs: endedAt === undefined ? undefined : endedAt - startedAt,
    exitCode: status === 'success' ? 0 : status === 'failed' ? 1 : status === 'stopped' ? null : undefined,
  };
}

function history(
  sessionId: string,
  projectId: string,
  status: RunHistoryEntry['status'],
  endedAt: number,
): RunHistoryEntry {
  return {
    historyId: sessionId,
    sessionId,
    projectId,
    commandKey: `${projectId}:script:${sessionId}`,
    commandType: 'script',
    commandId: sessionId,
    displayName: sessionId,
    cwd: `C:/${projectId}`,
    status,
    startedAt: endedAt - 100,
    endedAt,
    durationMs: 100,
    exitCode: status === 'success' ? 0 : status === 'failed' ? 1 : null,
  };
}

/*********************** active takes precedence ***********************/
{
  const sessions = {
    activeA: session('active-a', 'child-a', 'running', 4_000),
    activeB: session('active-b', 'child-b', 'starting', 5_000),
  };
  const summary = aggregateRunSummaryForSubtree('root', projects, sessions, [history('old-failure', 'root', 'failed', 9_000)]);
  assert(summary);
  assert.equal(summary.status, 'running');
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.projectId, 'child-b');
  assert.equal(summary.displayName, 'active-b');
  assert.equal(summary.endedAt, undefined);
}

/*********************** latest terminal result wins ***********************/
{
  const summary = getProjectRunSummary(
    'root',
    projects,
    {},
    [
      history('failed', 'root', 'failed', 10_000),
      history('success', 'root', 'success', 11_000),
      history('stopped', 'root', 'stopped', 9_000),
    ],
  );
  assert(summary);
  assert.equal(summary.status, 'success');
  assert.equal(summary.displayName, 'success');
  assert.equal(summary.exitCode, 0);
}

/*********************** live terminal and persisted duplicate ***********************/
{
  const live = session('same', 'root', 'failed', 1_000, 12_000);
  const summary = getProjectRunSummary('root', projects, { same: live }, [
    history('same', 'root', 'success', 13_000),
    history('other', 'root', 'stopped', 11_000),
  ]);
  assert(summary);
  assert.equal(summary.status, 'failed', 'live and history with the same session id must dedupe to live metadata');
  assert.equal(summary.endedAt, 12_000);
}

/*********************** subtree and missing project ***********************/
{
  const summary = aggregateRunSummaryForSubtree('root', projects, {}, [history('child', 'child-a', 'stopped', 20_000)]);
  assert(summary);
  assert.equal(summary.projectId, 'child-a');
  assert.equal(summary.status, 'stopped');
  assert.equal(getProjectRunSummary('missing', projects, {}, []), null);
  assert.equal(aggregateRunSummaryForSubtree('missing', projects, {}, []), null);
}

console.log('projectRunSummary tests passed');
