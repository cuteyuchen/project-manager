import type { NodeVersion, SystemNodeState } from '../types';
import { getNodeRuntimeId, normalizeRuntimePath } from './nodeRuntime';

function isExecutablePath(path: string): boolean {
  return /(?:^|[\\/])node(?:\.exe)?$/i.test(path.trim());
}

export function runtimeExecutablePath(runtime: NodeVersion): string {
  return runtimeExecutableCandidates(runtime)[0];
}

function runtimeExecutableCandidates(runtime: NodeVersion): string[] {
  const path = runtime.path.trim();
  if (!path || isExecutablePath(path)) return [path];
  const root = path.replace(/[\\/]+$/, '');
  return [
    `${root}/node.exe`,
    `${root}/bin/node.exe`,
    `${root}/node`,
    `${root}/bin/node`,
  ];
}

function samePath(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return normalizeRuntimePath(left) === normalizeRuntimePath(right);
}

function findExactExecutableRuntime(state: SystemNodeState, runtimes: NodeVersion[], source: NodeVersion['source']): NodeVersion | undefined {
  if (!state.nodePath) return undefined;
  return runtimes.find(runtime =>
    runtime.source === source && runtimeExecutableCandidates(runtime).some(path => samePath(path, state.nodePath)),
  );
}

/** Map the OS-resolved executable to an existing source-specific Runtime record. */
export function mapSystemNodeStateToRuntime(
  state: SystemNodeState,
  runtimes: NodeVersion[],
): SystemNodeState {
  if (!state.available || !state.nodePath) {
    return { ...state, runtimeId: undefined, source: state.source || 'unknown' };
  }

  const sourceRuntimes = runtimes.filter(runtime => runtime.source !== 'system');
  const managed = findExactExecutableRuntime(state, sourceRuntimes, 'managed');
  const nvmByTarget = state.nvmTargetPath
    ? sourceRuntimes.find(runtime => runtime.source === 'nvm' && samePath(runtime.path, state.nvmTargetPath))
    : undefined;
  const nvmByExecutable = findExactExecutableRuntime(state, sourceRuntimes, 'nvm');
  const custom = findExactExecutableRuntime(state, sourceRuntimes, 'custom');
  const runtime = managed || nvmByTarget || nvmByExecutable || custom;

  if (!runtime) {
    return {
      ...state,
      runtimeId: undefined,
      source: state.source === 'unknown' ? 'system' : state.source,
    };
  }

  return {
    ...state,
    runtimeId: getNodeRuntimeId(runtime),
    source: runtime.source,
  };
}

export function isRuntimeSystemCurrent(runtime: NodeVersion, state: SystemNodeState | null | undefined): boolean {
  if (!state?.available) return false;
  if (state.runtimeId && getNodeRuntimeId(runtime) === state.runtimeId) return true;
  return runtime.source === 'system'
    && runtimeExecutableCandidates(runtime).some(path => samePath(path, state.nodePath));
}
