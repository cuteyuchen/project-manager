import type { ImportCandidate, ProjectInfo, SubProjectCandidate } from '../api/types';
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

  const children = subProjects.map((item) => ({
    name: item.name,
    path: item.path,
    type: toProjectType(item.kind),
    moduleKind: toModuleKind(item.kind),
    scripts: item.scripts,
    packageManager: (item.hasPackageJson ? 'npm' : undefined) as Project['packageManager'],
  }));

  return { root, children };
}
