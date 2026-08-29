/** Normalize a workspace-relative path without allowing root escapes. */
export function normalizeWorkspaceRelativePath(value: string, allowEmpty = true): string {
  const replaced = value.replace(/\\/g, '/');
  if (replaced.includes('\0') || replaced.startsWith('/') || /^[A-Za-z]:/.test(replaced)) {
    throw new Error(`Invalid workspace-relative path: ${value}`);
  }
  const parts: string[] = [];
  for (const part of replaced.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Path escapes workspace root: ${value}`);
    parts.push(part);
  }
  if (!allowEmpty && parts.length === 0) throw new Error(`Workspace-relative path is required: ${value}`);
  return parts.join('/');
}

export function joinWorkspacePath(...parts: string[]): string {
  return normalizeWorkspaceRelativePath(parts.filter(Boolean).join('/'));
}

export function parentWorkspacePath(value: string): string {
  const normalized = normalizeWorkspaceRelativePath(value);
  const parts = normalized ? normalized.split('/') : [];
  parts.pop();
  return parts.join('/');
}

export function joinAbsolutePath(root: string, relative = ''): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const normalized = normalizeWorkspaceRelativePath(relative);
  if (!normalized) return normalizedRoot;
  const separator = normalizedRoot.includes('\\') ? '\\' : '/';
  return `${normalizedRoot}${separator}${normalized.replace(/\//g, separator)}`;
}

export function normalizeComparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeComparablePath(root);
  const normalizedCandidate = normalizeComparablePath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
