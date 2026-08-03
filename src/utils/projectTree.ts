/***********************项目树共享常量与工具*********************/

/**
 * 项目树最大层级：一级 → 二级 → 三级。
 *
 * 该值与后端 `MAX_SCAN_DEPTH`（src-tauri/src/project.rs）以及
 * uTools/ZTools preload.js 中的同名常量保持一致——扫描深度必须与
 * 项目树能承载的层级对齐，否则会扫出无处安放的深层目录。
 */
export const MAX_PROJECT_DEPTH = 3;

/**
 * 路径归一化：统一分隔符、去掉末尾斜杠、转小写。
 * 用于跨平台的路径去重与"是否已存在于项目库"的匹配。
 */
export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 从完整路径中取最后一段作为显示名 */
export function projectFolderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * 为按层级展开的项目分配 sortOrder。
 *
 * 关键点：**每个父级独立计数**，各自从该父级已有子项目数量续号。
 * 若像单层的 addSubProjects 那样共用一个计数器，多层挂载时不同父级下的
 * 子项目会拿到互相穿插的序号，导致列表顺序错乱。
 *
 * @param projects 已按"父在前、子在后"排好序的项目列表
 * @param existingChildCount 返回某父级当前已有的直接子项目数量
 */
export function assignSortOrders<T extends { parentId?: string }>(
  projects: T[],
  existingChildCount: (parentId: string) => number,
): (T & { sortOrder: number })[] {
  const nextOrderByParent = new Map<string, number>();

  return projects.map((project) => {
    // 一级项目（无 parentId）统一归入空串这一桶，从 0 起算
    const key = project.parentId ?? '';
    if (!nextOrderByParent.has(key)) {
      nextOrderByParent.set(key, project.parentId ? existingChildCount(project.parentId) : 0);
    }
    const sortOrder = nextOrderByParent.get(key)!;
    nextOrderByParent.set(key, sortOrder + 1);
    return { ...project, sortOrder };
  });
}
