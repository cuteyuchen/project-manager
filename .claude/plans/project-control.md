# 项目总控能力 — 实现规划

## 目标

在已有“分组 / 标签 / 搜索 / 快速筛选 / Git / Node / 命令运行”之上，新增 4 块能力，让项目数量变多之后，用户能：

1. 保存常用视图，秒切筛选条件
2. 批量操作一组项目（打标签、改分组、置顶、刷新、删除…）
3. 一眼看清项目健康状态（路径 / Git / Node / 包管理器 / 运行）
4. 一键启动一组项目任务，并统一停止

第一版不新增后端 Rust 命令，不新增云同步 / 独立数据库，全部复用 `PlatformAPI` + Pinia + `data.json`，保证 Tauri / uTools / ZTools 三端一致。

---

## 一、Settings 新增字段

文件：`src/types.ts`

```ts
export interface ProjectViewPreset {
  id: string;
  name: string;
  searchQuery: string;
  quickFilter: 'all' | 'pinned' | 'recent';
  groupId: string | null;
  tags: string[];
  sortMode: 'default' | 'smart';
  createdAt: string;
}

export interface WorkspaceProfileItem {
  // 'project' 引用项目 + 其一个脚本；'custom' 引用项目里的一条 customCommand
  type: 'project' | 'custom';
  projectId: string;
  // nameOrCommandId: 对 type='project' 是脚本名(如 'dev')；对 type='custom' 是 CustomCommand.id
  nameOrCommandId: string;
}

export interface WorkspaceProfile {
  id: string;
  name: string;
  items: WorkspaceProfileItem[];
  // 启动组运行状态（运行态不入 settings,放内存即可;持久化只放定义）
}

export interface ProjectHealthIssue {
  code: 'path_missing' | 'not_git' | 'git_dirty' | 'pm_unresolved' | 'node_unresolved';
  level: 'warn' | 'error';
  message: string;
}

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

export interface Settings {
  // ...existing
  projectViewPresets?: ProjectViewPreset[];
  workspaceProfiles?: WorkspaceProfile[];
}
```

迁移策略：两个新字段都默认为空数组，由 `settings.ts` 初始化时兜底。

---

## 二、store 改动

### 1. `src/stores/settings.ts`
- `settings.value.projectViewPresets ??= []`
- `settings.value.workspaceProfiles ??= []`

### 2. 新文件 `src/stores/projectHealth.ts`
封装“计算 + 缓存健康状态”的组合式 store，不直接走 UI：

```ts
export const useProjectHealthStore = defineStore('projectHealth', () => {
  const snapshots = ref<Record<string, ProjectHealthSnapshot>>({});
  const refreshing = ref<Set<string>>(new Set());

  async function refreshOne(p: Project) { /* 调包管理器解析 + gitCheck + gitSummary + 路径探测（通过 api） */ }
  async function refreshMany(projects: Project[]) { /* 并发限流 + Promise.allSettled */ }
  function get(id: string) { return snapshots.value[id]; }

  return { snapshots, refreshing, refreshOne, refreshMany, get };
});
```

注意：
- “路径是否存在” 用一个轻量探测：跑一次 `api.listFiles` 或新增 Tauri `pathExists` —— **不要新增**。复用现有的 `scanProject`（项目添加时已扫描过）拿到结果判断；运行期则用 `api.listFiles(p.path, '')` 试探（保持单点失败就视为异常）。
- 并发限流：`Promise.allSettled(projects.map(p => throttle(refreshOne, 4)))`。

### 3. `src/stores/workspaceProfile.ts`（新增）
负责启动组的执行逻辑（不存状态，状态走 project store 的 runningStatus）：

```ts
export const useWorkspaceProfileStore = defineStore('workspaceProfile', () => {
  async function runProfile(profile: WorkspaceProfile) { /* 遍历 items,调 projectStore.runProject / runCustomCommand；已 running 的跳过 */ }
  async function stopAll(profile: WorkspaceProfile) { /* 遍历 items,调 projectStore.stopProject / 找其 runId */ }
  return { runProfile, stopAll };
});
```

### 4. `src/stores/project.ts`（轻动）
- 新增 `selectedIds: Set<string>`：批量模式选中态
- 新增 `batchUpdate(ids, partial: Partial<Project>)`：遍历调 `updateProject`，入参 lenient
- 新增 `batchRemove(ids)`：包裹 `removeProject`（detail 仍提示一次）

---

## 三、Dashboard.vue 拆分

现状 ~34K。规划把下面 4 块逻辑拆出 composable 文件，`<script setup>` 直接调用：

- `src/composables/dashboard/useViewPresets.ts` —— 保存/应用/删除视图
- `src/composables/dashboard/useProjectBatch.ts` —— 选中、批量操作
- `src/composables/dashboard/useProjectHealth.ts` —— 监听可见项目变化触发刷新
- `src/composables/dashboard/useWorkspaceProfiles.ts` —— 启动组 CRUD + 运行

模板改动：
- 顶部筛选区下方加 `<ViewPresetChips />`（横向 chips）
- 列表上方加批量模式开关：进入后左侧列表多一列 checkbox，每个项目卡片右侧出现 ✓，列表底部 sticky 工具条 `BatchActionBar`
- 项目卡片右上角：健康状态点（4 种颜色：绿/黄/红/灰），悬浮显示 issues
- 空工作区（未选中项目）替换为 `<WorkspaceOverview />`，显示 4 张统计卡 + 最近使用 + 常用启动组 + 健康异常 TopN

新增组件文件（保持小）：
- `src/components/dashboard/ViewPresetChips.vue`
- `src/components/dashboard/BatchActionBar.vue`
- `src/components/dashboard/WorkspaceOverview.vue`
- `src/components/dashboard/HealthBadge.vue`
- `src/components/dashboard/WorkspaceProfileMenu.vue`

---

## 四、其他必须动的地方

1. **导入导出** `src/utils/persistence.ts`
   - 显式把 `projectViewPresets` / `workspaceProfiles` 加入导出 JSON 字段白名单；导入时容错缺失。

2. **国际化** `src/locales/zh.ts` / `en.ts`
   - 新增键：
     - `dashboard.saveView` / `dashboard.applyView` / `dashboard.deleteView`
     - `dashboard.batchMode` / `dashboard.batchSelected` / `dashboard.batchTag` / `dashboard.batchUntag` / `dashboard.batchGroup` / `dashboard.batchPin` / `dashboard.batchUnpin` / `dashboard.batchDelete`
     - `dashboard.overviewTitle` / `dashboard.overviewRunning` / `dashboard.overviewDirty` / `dashboard.overviewUnhealthy` / `dashboard.overviewRecent`
     - `dashboard.profilesTitle` / `dashboard.profileNew` / `dashboard.profileRun` / `dashboard.profileStopAll`

3. **类型扩展** `src/types.ts` 由步骤一覆盖。

4. **不新增 Rust 端命令**，避免 Tauri / uTools / ZTools 三端不同步。

---

## 五、Test Plan

构建 / 静态检查：
```bash
npm run build         # vue-tsc + vite production
npx tsc --noEmit      # 类型严格通过
git diff --check
```

手工验收：
1. **保存视图**
   - 输入搜索词 + 选 pinned + 选 1 个 group + 选 2 个 tag + 切 smart 排序 → 保存为“日常开发”
   - 刷新应用，chips 仍在；点击后所有筛选条件回填；删除视图后 chips 消失。
2. **批量模式**
   - 进入批量模式，选 3 个；批量加 tag、改 group、置顶、刷新、删除（带二次确认）。
   - 退出批量模式，普通点击选择项目不受影响。
3. **健康状态**
   - 路径不存在一个项目：红色 error
   - 非 Git 项目：warning “未初始化 Git”
   - 有改动：warning “Git dirty”
   - 包管理器解析失败：warning “包管理器不可用”
   - 卡片显示小圆点；Overview 显示异常数量正确。
4. **启动组**
   - 创建“前端日常”含 2 个项目的 dev 脚本 + 1 个 customCommand；一键启动，3 个日志面板出现，running 计数 +1；重复点运行不会重复起。
   - 点“停止全部”，对应 runId 全部停止。
5. **三端构建**
   ```bash
   npm run build
   npm run build:utools
   npm run build:ztools
   ```
   无新增桌面能力判断分支，uTools / ZTools 构建不报错，settings 新字段对两端的 desktop-only 判断无影响。

---

## 六、文件清单（按重要性排）

新增：
- `src/stores/projectHealth.ts`
- `src/stores/workspaceProfile.ts`
- `src/composables/dashboard/useViewPresets.ts`
- `src/composables/dashboard/useProjectBatch.ts`
- `src/composables/dashboard/useProjectHealth.ts`
- `src/composables/dashboard/useWorkspaceProfiles.ts`
- `src/components/dashboard/ViewPresetChips.vue`
- `src/components/dashboard/BatchActionBar.vue`
- `src/components/dashboard/WorkspaceOverview.vue`
- `src/components/dashboard/HealthBadge.vue`
- `src/components/dashboard/WorkspaceProfileMenu.vue`

修改：
- `src/types.ts`
- `src/stores/settings.ts`
- `src/stores/project.ts`
- `src/utils/persistence.ts`
- `src/locales/zh.ts` / `src/locales/en.ts`
- `src/views/Dashboard.vue`（明显变小）

---

## 七、明确不做（避免范围蔓延）

- ❌ 不做云同步 / 独立数据库
- ❌ 不做全局快捷浮窗 / 全局快捷键
- ❌ 不做“健康巡检定时任务”（首版按需刷新即可）
- ❌ 不把“本地小模型生成提交信息”塞进本批（另立 plan）

---

## 八、风险点

1. **Dashbaord 拆 composables 工作量**：~34K 文件拆 4 个 composable 会有一些迁移改动，需要先在 `useViewPresets` 上跑通端到端再继续拆，避免累积回归。
2. **健康状态并发**：用户切群组时大量项目同时触发 `gitCheck` / `gitSummary`；需做并发限流 + 失败容错（`Promise.allSettled`），避免一个项目路径不存在阻塞整体刷新。
3. **启动组运行状态归属**：用 project store 已有 `runningStatus[runId]` 作为单一事实源，profile store 不另存状态，避免双源歧义。
4. **uTools 端没有 `pathExists`**：完全规避，第一版复用 `listFiles` 试探或基于 `scanProject` 已探测结果。
