import type { FrontendEnvGroup } from './utils/frontendEnvSwitcher';

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
  builtinId?: 'install_dependencies';
}

export interface EditorConfig {
  id: string;
  name: string;
  path: string;
}

export interface TerminalConfig {
  id: string;
  name: string;
  path: string;
}

export interface ProjectFileEntry {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
}

/** 代码模块：项目内识别出的子模块/子项目的快捷入口 */
export interface CodeModule {
  id: string;
  /** 显示名称（通常取目录名或 package.json 的 name） */
  name: string;
  /** 相对于项目根目录的路径 */
  relativePath: string;
  /** 识别到的语言/框架标记 */
  framework: CodeModuleFramework;
  /** 是否置顶 */
  pinned?: boolean;
}

/** 代码模块支持的框架/语言类型 */
export type CodeModuleFramework =
  | 'vue'
  | 'react'
  | 'node'
  | 'java'
  | 'go'
  | 'python'
  | 'dotnet'
  | 'unknown';

/** 子项目模块类型：由特征文件识别得出（前端/后端等），用于类型徽章展示 */
export type ProjectModuleKind =
  | 'frontend'
  | 'backend'
  | 'node'
  | 'go'
  | 'rust'
  | 'python'
  | 'dotnet'
  | 'static'
  | 'unknown';

export interface Project {
  id: string;
  name: string;
  path: string;
  type: 'node' | 'other';
  gitRemoteUrl?: string;
  gitBranch?: string;
  gitConfigured?: boolean;
  nodeVersion?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'cnpm';
  /** 包管理器来源：'project' 使用项目 Node 环境，'default' 借用默认 Node 环境的包管理器入口 */
  packageManagerSource?: 'project' | 'default';
  scripts?: string[];
  visibleScripts?: string[];
  customCommands?: CustomCommand[];
  projectFiles?: ProjectFileEntry[];
  memo?: string;
  pinned?: boolean;
  pinOrder?: number;
  sortOrder?: number;
  editorId?: string;
  description?: string;
  tags?: string[];
  groupId?: string;
  /** 父项目 id：为空表示一级项目（根）；非空表示嵌套子项目，用单向引用建模父子关系 */
  parentId?: string;
  /** 收藏：独立于 pinned（置顶排序），仅用于「收藏」筛选 */
  favorite?: boolean;
  /** 子项目模块类型：由特征文件识别得出，用于列表/卡片上的类型徽章 */
  moduleKind?: ProjectModuleKind;
  /** 子项目扫描时间戳：用于「重新扫描」提示 */
  subScannedAt?: number;
  /** 代码模块列表：扫描到的子模块快捷入口 */
  codeModules?: CodeModule[];
  /** 前端环境变量与 Vite 代理扫描缓存 */
  frontendEnvGroups?: FrontendEnvGroup[];
  /** 前端环境扫描时间 */
  frontendEnvScannedAt?: number;
}

// ─── Project Group Types ────────────────────────────────────────────────────

export interface ProjectGroup {
  id: string;
  name: string;
  sortOrder?: number;
  collapsed?: boolean;
}

export type AiApiType = 'chat_completions' | 'responses';

export interface AiServiceConfig {
  apiType: AiApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  editorPath: string; // legacy fallback
  editors?: EditorConfig[];
  defaultEditorId?: string;
  defaultTerminal: string;
  customTerminals?: TerminalConfig[];
  layoutState?: Record<string, number>;
  locale: 'zh' | 'en';
  themeMode: 'dark' | 'light' | 'auto';
  autoUpdate: boolean;
  trayEnabled?: boolean;
  closeAction?: 'ask' | 'tray' | 'exit';
  autoLaunch?: boolean;
  /** 应用内呼出快速搜索的快捷键 */
  quickSearchAppShortcut?: string;
  /** 是否注册系统级快捷键呼出快速搜索 */
  quickSearchGlobalShortcutEnabled?: boolean;
  /** 系统级呼出快速搜索的快捷键，仅桌面 Tauri 环境生效 */
  quickSearchGlobalShortcut?: string;
  // AI commit message generation
  gitAiEnabled?: boolean;
  gitAiPrimaryService?: AiServiceConfig;
  gitAiStream?: boolean;
  // Legacy fields kept for migration/backup compatibility
  gitAiBaseUrl?: string;
  gitAiApiKey?: string;
  gitAiModel?: string;
  gitAiPromptTemplate?: string;
  // Usage weight sorting
  usageWeightEnabled?: boolean;
  // Sort mode: 'default' (manual drag), 'smart' (usage weight)
  sortMode?: 'default' | 'smart';
  // ─── Project 总控能力 ────────────────────────────────────────────────────
  /** 保存视图：把当前搜索 / 筛选 / 分组 / 标签 / 排序快速调出 */
  projectViewPresets?: ProjectViewPreset[];
  /** 启动组：一键运行一组项目命令 */
  workspaceProfiles?: WorkspaceProfile[];
}

/** 项目列表快捷筛选类型：基础 + 健康状态 */
export type ProjectQuickFilter =
  | 'all'
  | 'pinned'
  | 'recent'
  | 'favorite'
  | 'running'
  | 'dirty'
  | 'unhealthy'
  | 'missing';

/** 保存视图：把当前过滤/排序状态打包命名后保存 */
export interface ProjectViewPreset {
  id: string;
  name: string;
  searchQuery: string;
  quickFilter: ProjectQuickFilter;
  /** null 表示全部分组 */
  groupId: string | null;
  tags: string[];
  sortMode: 'default' | 'smart';
  createdAt: string;
}

/** 启动组中的单条项：项目内脚本或自定义命令 */
export type WorkspaceProfileItemType = 'project' | 'custom';

export interface WorkspaceProfileItem {
  type: WorkspaceProfileItemType;
  projectId: string;
  /**
   * 当 type='project' 时是脚本名（如 'dev' / 'build'）
   * 当 type='custom' 时是 CustomCommand.id
   */
  nameOrCommandId: string;
  /** 可选，显示名（避免脚本被删后无法识别） */
  label?: string;
}

/** 启动组：一组命令可一键启动/停止 */
export interface WorkspaceProfile {
  id: string;
  name: string;
  items: WorkspaceProfileItem[];
  icon?: string;
  createdAt: string;
}

/** 项目健康问题 */
export interface ProjectHealthIssue {
  code: 'path_missing' | 'not_git' | 'git_dirty' | 'pm_unresolved' | 'node_unresolved';
  level: 'warn' | 'error';
  message: string;
}

/** 项目健康快照：缓存最近一次扫描结果 */
export interface ProjectHealthSnapshot {
  projectId: string;
  running: boolean;
  hasGit: boolean;
  gitDirty: boolean;
  pmResolved: boolean;
  pathExists: boolean;
  issues: ProjectHealthIssue[];
  updatedAt: number;
}

export interface NodeVersion {
  version: string;
  path: string;
  source: 'nvm' | 'custom' | 'system';
}

// ─── Usage Weight Types ──────────────────────────────────────────────────────

export interface UsageEvent {
  date: string;    // 'YYYY-MM-DD'
  count: number;
}

export interface ProjectUsage {
  projectId: string;
  events: UsageEvent[];
  addedAt: string; // 'YYYY-MM-DD'
}

export interface UsageData {
  records: Record<string, ProjectUsage>;
  lastWeeklyNormalization: string; // 'YYYY-MM-DD'
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
  committer: string;
  date: string;
  message: string;
  parents: string[];
  refs: string[];
  graph_prefix?: string;
}

export interface GitOwnCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface GitAuthorIdentity {
  name?: string;
  email?: string;
}

export interface GitOwnCommitResult {
  identity: GitAuthorIdentity;
  commits: GitOwnCommit[];
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

export interface GitCommitFile {
  path: string;
  status: string; // 'A' | 'M' | 'D' | 'R' | 'C'
  old_path?: string;
}
