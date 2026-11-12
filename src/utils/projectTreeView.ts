import { MAX_PROJECT_DEPTH } from './projectTree';

/***********************树筛选辅助*********************/
export interface ProjectTreeRelation {
  id: string;
  parentId?: string;
}

function collectProjectAncestorIdsFromMap(
  byId: ReadonlyMap<string, ProjectTreeRelation>,
  projectId: string,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(projectId);
  while (current?.parentId && result.length < MAX_PROJECT_DEPTH - 1 && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    result.unshift(parent.id);
    current = parent;
  }
  return result;
}

/** 返回节点到根的祖先链，不包含节点自身，最多回溯项目树允许的层级。 */
export function collectProjectAncestorIds(
  projects: readonly ProjectTreeRelation[],
  projectId: string,
): string[] {
  const byId = new Map(projects.map(project => [project.id, project]));
  return collectProjectAncestorIdsFromMap(byId, projectId);
}

/** 匹配任意层级时保留匹配节点及其所有祖先，为树提供完整路径上下文。 */
export function collectVisibleProjectIds(
  projects: readonly ProjectTreeRelation[],
  matchingIds: Iterable<string>,
): Set<string> {
  const visible = new Set<string>();
  const byId = new Map(projects.map(project => [project.id, project]));
  for (const id of matchingIds) {
    visible.add(id);
    for (const ancestorId of collectProjectAncestorIdsFromMap(byId, id)) {
      visible.add(ancestorId);
    }
  }
  return visible;
}

/** 搜索/筛选时自动展开匹配节点的祖先链；用户手动展开集合由调用方另行保存。 */
export function collectAutoExpandedProjectIds(
  projects: readonly ProjectTreeRelation[],
  matchingIds: Iterable<string>,
): Set<string> {
  const expanded = new Set<string>();
  const byId = new Map(projects.map(project => [project.id, project]));
  for (const id of matchingIds) {
    for (const ancestorId of collectProjectAncestorIdsFromMap(byId, id)) {
      expanded.add(ancestorId);
    }
  }
  return expanded;
}

/***********************临时展开状态*********************/
export interface TemporaryProjectTreeExpansionState {
  expandedIds: Set<string>;
  savedExpandedIds: Set<string> | null;
  constrained: boolean;
}

export function createProjectTreeExpansionState(initialIds: Iterable<string> = []): TemporaryProjectTreeExpansionState {
  return {
    expandedIds: new Set(initialIds),
    savedExpandedIds: null,
    constrained: false,
  };
}

/** 进入搜索/筛选模式时保存用户折叠状态，退出时恢复快照。 */
export function setProjectTreeConstraint(
  state: TemporaryProjectTreeExpansionState,
  constrained: boolean,
): void {
  if (constrained && !state.constrained) {
    state.savedExpandedIds = new Set(state.expandedIds);
  } else if (!constrained && state.constrained && state.savedExpandedIds) {
    state.expandedIds = new Set(state.savedExpandedIds);
    state.savedExpandedIds = null;
  }
  state.constrained = constrained;
}

/***********************手动折叠覆盖*********************/

export interface ProjectTreeExpansionInput {
  /** 用户手动展开的项目 */
  expandedIds: ReadonlySet<string>;
  /** 用户手动折叠的项目：优先级高于筛选态的自动展开 */
  collapsedIds: ReadonlySet<string>;
  /** 筛选/搜索命中的祖先链，由系统自动展开 */
  autoExpandedIds: ReadonlySet<string>;
}

export interface ProjectTreeExpansionResult {
  expandedIds: Set<string>;
  collapsedIds: Set<string>;
}

/** 当前实际上是否展开：自动展开也要算，并且手动折叠优先 */
export function isProjectTreeExpanded(
  state: ProjectTreeExpansionInput,
  projectId: string,
): boolean {
  if (state.collapsedIds.has(projectId)) return false;
  return state.expandedIds.has(projectId) || state.autoExpandedIds.has(projectId);
}

/**
 * 切换单个项目的展开状态。
 *
 * 筛选/搜索态下命中节点的祖先链会被自动展开，若只看 expandedIds，
 * 折叠动作会被自动展开立刻抵消 —— 这正是「最近使用」里层级关不掉的根因。
 * 所以折叠时额外记一笔「手动折叠」，由有效展开集合把它减掉。
 */
export function toggleProjectTreeExpansion(
  state: ProjectTreeExpansionInput,
  projectId: string,
): ProjectTreeExpansionResult {
  const expanded = new Set(state.expandedIds);
  const collapsed = new Set(state.collapsedIds);

  if (isProjectTreeExpanded(state, projectId)) {
    expanded.delete(projectId);
    collapsed.add(projectId);
  } else {
    expanded.add(projectId);
    collapsed.delete(projectId);
  }

  return { expandedIds: expanded, collapsedIds: collapsed };
}

/** 有效展开集合：手动展开 ∪ 自动展开，再减去手动折叠 */
export function resolveExpandedProjectIds(state: ProjectTreeExpansionInput): Set<string> {
  const result = new Set<string>([...state.expandedIds, ...state.autoExpandedIds]);
  for (const projectId of state.collapsedIds) {
    result.delete(projectId);
  }
  return result;
}
