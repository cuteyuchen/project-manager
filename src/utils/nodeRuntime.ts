import type { AppDefaultNode, NodeVersion, Project } from '../types';
import { findInstalledNodeVersion, normalizeNodeVersion } from './nvm';

const DEFAULT_NODE_VERSION_LABELS = new Set([
  'default',
  'system default',
  '\u9ed8\u8ba4',
]);

const SOURCE_PRIORITY: Record<NodeVersion['source'], number> = {
  managed: 0,
  custom: 1,
  system: 2,
};

function normalizeNodeVersionLabel(value?: string) {
  return (value || '').trim().toLowerCase();
}

function shouldUseDefaultNode(projectNodeVersion?: string) {
  const normalizedVersion = normalizeNodeVersionLabel(projectNodeVersion);
  if (!normalizedVersion) return false;
  if (DEFAULT_NODE_VERSION_LABELS.has(normalizedVersion)) return true;
  return !/\d/.test(normalizedVersion);
}

export function isExplicitNodeVersion(nodeVersion?: string): boolean {
  if (!nodeVersion) return false;
  if (shouldUseDefaultNode(nodeVersion)) return false;
  return normalizeNodeVersion(nodeVersion) !== null;
}

function isUsablePath(path: string | undefined) {
  return !!path && path !== 'System Default';
}

function findVersionByPriority(versions: NodeVersion[], predicate: (v: NodeVersion) => boolean): NodeVersion | undefined {
  const matches = versions.filter(predicate);
  matches.sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
  return matches[0];
}

function appDefaultPath(appDefault: AppDefaultNode | null | undefined, versions: NodeVersion[]) {
  if (!appDefault) return '';
  const matched = versions.find(version =>
    version.source === appDefault.source
    && (version.path === appDefault.path || version.version === appDefault.version),
  );
  if (matched && isUsablePath(matched.path)) return matched.path;
  if (isUsablePath(appDefault.path)) return appDefault.path;
  return '';
}

function systemNodePath(versions: NodeVersion[]) {
  const systemNode = versions.find(version => version.source === 'system');
  return isUsablePath(systemNode?.path) ? systemNode!.path : '';
}

export function resolveProjectNodePath(
  project: Project,
  versions: NodeVersion[],
  appDefault?: AppDefaultNode | null,
) {
  if (!project.nodeVersion) return '';

  if (shouldUseDefaultNode(project.nodeVersion)) {
    return appDefaultPath(appDefault, versions) || systemNodePath(versions);
  }

  const exactMatch = findVersionByPriority(versions, v => v.version === project.nodeVersion);
  if (exactMatch) {
    return isUsablePath(exactMatch.path) ? exactMatch.path : '';
  }

  const normalizedTargetVersion = normalizeNodeVersion(project.nodeVersion);
  if (normalizedTargetVersion) {
    const matchedVersion = findInstalledNodeVersion(
      versions.map(version => version.version),
      normalizedTargetVersion,
    );
    if (matchedVersion) {
      const normalizedMatch = findVersionByPriority(versions, v => v.version === matchedVersion);
      if (normalizedMatch) {
        return isUsablePath(normalizedMatch.path) ? normalizedMatch.path : '';
      }
    }
  }

  return '';
}

export function resolveNodePathFromVersion(
  versionLabel: string | null | undefined,
  versions: NodeVersion[],
  appDefault?: AppDefaultNode | null,
) {
  if (!versionLabel) return '';

  if (shouldUseDefaultNode(versionLabel)) {
    return appDefaultPath(appDefault, versions) || systemNodePath(versions);
  }

  const exactMatch = findVersionByPriority(versions, v => v.version === versionLabel);
  if (exactMatch) {
    return isUsablePath(exactMatch.path) ? exactMatch.path : '';
  }

  const normalizedTargetVersion = normalizeNodeVersion(versionLabel);
  if (normalizedTargetVersion) {
    const matchedVersion = findInstalledNodeVersion(
      versions.map(version => version.version),
      normalizedTargetVersion,
    );
    if (matchedVersion) {
      const normalizedMatch = findVersionByPriority(versions, v => v.version === matchedVersion);
      if (normalizedMatch) {
        return isUsablePath(normalizedMatch.path) ? normalizedMatch.path : '';
      }
    }
  }

  return '';
}

export function shouldInjectTerminalNode(project: Project): boolean {
  return project.type === 'node' && project.terminalInjectNode !== false;
}

/** 项目管理器默认 Node：app default，没有则回退 System。 */
export function resolveAppDefaultNodePath(
  versions: NodeVersion[],
  appDefault?: AppDefaultNode | null,
): string {
  return appDefaultPath(appDefault, versions) || systemNodePath(versions);
}
