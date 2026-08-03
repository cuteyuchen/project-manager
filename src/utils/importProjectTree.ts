import type { ImportCandidate, ImportNode, ProjectInfo } from '../api/types';
import type { Project, ProjectModuleKind } from '../types';
import { createProjectId } from './projectId.ts';

type BuildImportRootProjectOptions = {
  createId?: () => string;
  nodeVersion?: string;
};

/***********************模块类型转换*********************/

function toModuleKind(kind: string): ProjectModuleKind {
  const validKinds: ProjectModuleKind[] = [
    'frontend',
    'backend',
    'node',
    'go',
    'rust',
    'python',
    'dotnet',
    'static',
    'unknown',
  ];
  return (validKinds as string[]).includes(kind) ? (kind as ProjectModuleKind) : 'unknown';
}

function toProjectType(kind: string): Project['type'] {
  return kind === 'node' || kind === 'frontend' || kind === 'static' ? 'node' : 'other';
}

/***********************批量导入根项目构建*********************/

/**
 * 由一个导入候选构建其一级（根）项目。
 * 子项目不在此处构建——它们由后端扫描出的嵌套树经
 * `flattenImportNodeTree` 按真实层级挂载，避免层级被压平。
 */
export function buildImportRootProject(
  candidate: ImportCandidate,
  info: ProjectInfo | null,
  options: BuildImportRootProjectOptions = {},
): Project {
  const createId = options.createId || createProjectId;
  const isNodeProject = info?.projectType === 'node';
  const root: Project = {
    id: createId(),
    // 批量导入的一级列表展示用户选中的顶级文件夹，而不是 package.json 中的包名。
    name: candidate.name,
    path: candidate.path,
    type: isNodeProject ? 'node' : 'other',
  };

  if (isNodeProject) {
    root.nodeVersion = options.nodeVersion;
    root.packageManager = info?.packageManager || 'npm';
    root.scripts = info?.scripts || [];
  }

  return root;
}

/***********************嵌套导入树构建*********************/

type FlattenImportNodeTreeOptions = {
  createId?: () => string;
  /**
   * 判断某路径是否已存在于项目库中。返回既有项目 id 时：
   * 该节点**不会**产出新的 Project（避免重复导入），但其子节点仍以该 id
   * 作为 parentId 继续挂载——否则父项目已存在时，孙级会被挂到错误的层级上。
   */
  resolveExistingId?: (path: string) => string | undefined;
  /** 本次展开允许的最大层级数；超出的节点直接丢弃，不会上提压平到父级 */
  maxDepth?: number;
};

/** 将 ImportNode 递归展开为扁平的 Project 列表（父在前、子在后）。
 * 每个 Project 已含 id 与指向其父的 parentId，调用方可按顺序逐个 addProject 入库。 */
export function flattenImportNodeTree(
  nodes: ImportNode[],
  parentId: string | undefined,
  options: FlattenImportNodeTreeOptions = {},
): Project[] {
  const createId = options.createId || createProjectId;
  const resolveExistingId = options.resolveExistingId;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;

  const out: Project[] = [];

  /** depth 为该节点在本次展开中的层级，顶层节点为 1 */
  const walk = (node: ImportNode, parent: string | undefined, depth: number) => {
    // 超出层级直接截断丢弃，其子孙一并不再处理。
    if (depth > maxDepth) return;

    const existingId = resolveExistingId?.(node.path);
    if (existingId) {
      // 已存在的项目复用其 id 作为后代的父级，自身不重复入库。
      for (const child of node.children) walk(child, existingId, depth + 1);
      return;
    }

    const moduleKind = toModuleKind(node.kind);
    const project: Project = {
      id: createId(),
      parentId: parent,
      name: node.name,
      path: node.path,
      type: toProjectType(node.kind),
      moduleKind,
    };
    if (node.hasPackageJson) {
      project.packageManager = 'npm' as Project['packageManager'];
      project.scripts = node.scripts;
    }
    if (node.kind === 'node' || node.kind === 'frontend' || node.kind === 'static') {
      // 嵌套扫描未携带 nvm 版本信息，统一使用 Default
      project.nodeVersion = 'Default';
    }
    out.push(project);
    for (const child of node.children) walk(child, project.id, depth + 1);
  };

  for (const node of nodes) walk(node, parentId, 1);
  return out;
}
