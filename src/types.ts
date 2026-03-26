export interface Project {
  id: string;
  name: string;
  path: string;
  type: 'node' | 'static';
  nodeVersion: string;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'cnpm';
  scripts: string[];
}

export interface Settings {
  editorPath: string; // e.g. "code" or absolute path
  defaultTerminal: 'cmd' | 'powershell' | 'git-bash' | 'zsh' | 'bash';
  locale: 'zh' | 'en';
  themeMode: 'dark' | 'light' | 'auto';
  autoUpdate: boolean;
}

export interface NodeVersion {
  version: string;
  path: string;
  source: 'nvm' | 'custom' | 'system';
}

// ─── Git Types ───────────────────────────────────────────────────────────────

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'copied';
  staged: boolean;
  old_path?: string;
}

export interface GitStatusResult {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
  conflicted: GitFileStatus[];
}

export interface GitBranch {
  name: string;
  is_remote: boolean;
  is_current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  parents: string[];
  refs: string[];
}

export interface GitRemote {
  name: string;
  url: string;
  remote_type: string;
}

export interface GitSummary {
  branch: string;
  is_detached: boolean;
  ahead: number;
  behind: number;
  has_remote: boolean;
  remote_name?: string;
}
