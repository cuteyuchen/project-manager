import type { Project, RunHistoryEntry, RunHistoryStatus, RunSession } from '../types';
import { isRunSessionActive } from './runSession';

export interface ProjectRunSummary {
  projectId: string;
  status: 'running' | RunHistoryStatus;
  activeCount: number;
  sessionId?: string;
  commandKey: string;
  commandType: 'script' | 'custom';
  commandId: string;
  displayName: string;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  errorMessage?: string;
}

function compareEnded(left: { endedAt?: number; sessionId?: string }, right: { endedAt?: number; sessionId?: string }): number {
  return (right.endedAt ?? -Infinity) - (left.endedAt ?? -Infinity)
    || (left.sessionId || '').localeCompare(right.sessionId || '');
}

function collectSubtreeIds(rootId: string, projects: readonly Project[]): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (project.parentId && ids.has(project.parentId) && !ids.has(project.id)) {
        ids.add(project.id);
        changed = true;
      }
    }
  }
  return ids;
}

function buildSummary(
  projectIds: ReadonlySet<string>,
  sessions: Readonly<Record<string, RunSession>>,
  history: readonly RunHistoryEntry[],
): ProjectRunSummary | null {
  const active = Object.values(sessions)
    .filter(session => projectIds.has(session.projectId) && isRunSessionActive(session.status));
  if (active.length > 0) {
    const latest = [...active].sort((left, right) => right.startedAt - left.startedAt || left.sessionId.localeCompare(right.sessionId))[0];
    return {
      projectId: latest.projectId,
      status: 'running',
      activeCount: active.length,
      sessionId: latest.sessionId,
      commandKey: latest.commandKey,
      commandType: latest.commandType,
      commandId: latest.commandId,
      displayName: latest.displayName,
    };
  }

  const terminalBySession = new Map<string, RunSession | RunHistoryEntry>();
  for (const session of Object.values(sessions)) {
    if (!projectIds.has(session.projectId) || isRunSessionActive(session.status) || session.endedAt === undefined) continue;
    if (session.status !== 'success' && session.status !== 'failed' && session.status !== 'stopped') continue;
    terminalBySession.set(session.sessionId, session);
  }
  for (const entry of history) {
    if (!projectIds.has(entry.projectId) || terminalBySession.has(entry.sessionId)) continue;
    terminalBySession.set(entry.sessionId, entry);
  }

  const latest = [...terminalBySession.values()].sort(compareEnded)[0];
  if (!latest) return null;
  return {
    projectId: latest.projectId,
    status: latest.status as RunHistoryStatus,
    activeCount: 0,
    sessionId: latest.sessionId,
    commandKey: latest.commandKey,
    commandType: latest.commandType,
    commandId: latest.commandId,
    displayName: latest.displayName,
    endedAt: latest.endedAt,
    durationMs: latest.durationMs,
    exitCode: latest.exitCode,
    errorMessage: latest.errorMessage,
  };
}

export function getProjectRunSummary(
  projectId: string,
  projects: readonly Project[],
  sessions: Readonly<Record<string, RunSession>>,
  history: readonly RunHistoryEntry[],
): ProjectRunSummary | null {
  if (!projects.some(project => project.id === projectId)) return null;
  return buildSummary(new Set([projectId]), sessions, history);
}

export function aggregateRunSummaryForSubtree(
  rootProjectId: string,
  projects: readonly Project[],
  sessions: Readonly<Record<string, RunSession>>,
  history: readonly RunHistoryEntry[],
): ProjectRunSummary | null {
  if (!projects.some(project => project.id === rootProjectId)) return null;
  return buildSummary(collectSubtreeIds(rootProjectId, projects), sessions, history);
}
