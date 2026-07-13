import type { ImportCandidate, ImportNode, ProjectInfo, SubProjectCandidate } from '../api/types';
import type { Project, ProjectModuleKind } from '../types';
import { createProjectId } from './projectId.ts';

type BuildImportProjectTreeOptions = {
  createId?: () => string;
  nodeVersion?: string;
};

type ImportProjectTree = {
  root: Project;
  children: Omit<Project, 'id' | 'parentId'>[];
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

export function convertSubProjectCandidates(
  subProjects: SubProjectCandidate[],
): Omit<Project, 'id' | 'parentId'>[] {
  return subProjects.map((item) => ({
    name: item.name,
    path: item.path,
    type: toProjectType(item.kind),
    moduleKind: toModuleKind(item.kind),
    scripts: item.scripts,
    packageManager: (item.hasPackageJson ? 'npm' : undefined) as Project['packageManager'],
  }));
}

/***********************批量导入项目树构建*********************/

export function buildImportProjectTree(
  candidate: ImportCandidate,
  info: ProjectInfo | null,
  subProjects: SubProjectCandidate[],
  options: BuildImportProjectTreeOptions = {},
): ImportProjectTree {
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

  const children = convertSubProjectCandidates(subProjects);

  return { root, children };
}

/***********************嵌套导入树构建*********************/

/** 将 ImportNode 递归展开为扁平的 Project 列表（父在前、子在后）。
 * 每个 Project 已含 id 与指向其父的 parentId，调用方可按顺序逐个 addProject 入库。 */
export function flattenImportNodeTree(
  nodes: ImportNode[],
  parentId: string | undefined,
  options: { createId?: () => string } = {},
): Project[] {
  const createId = options.createId || createProjectId;
  const out: Project[] = [];
  const walk = (node: ImportNode, parent: string | undefined) => {
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
    for (const child of node.children) walk(child, project.id);
  };
  for (const node of nodes) walk(node, parentId);
  return out;
}
