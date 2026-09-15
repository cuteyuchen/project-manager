---
feature: editor-experience
status: delivered
updated: 2026-09-14
branch: main
commits: b77da0e4ef158896a7f943393f9d3ec70efec5fc..working-tree
---

# Editor Experience

## Report

**What was built** — 工作区编辑器体验五项改进：1) 打开 Git 仓库中的文件时，CodeMirror 行号槽按 staged/unstaged 统一 diff 标出变更：新增/修改为整行色条，删除为两行交界处的短红线（`editorGitMarkers` + gutter 装饰）；2) Git 变更列表三分区文件行双击可跳到应用内编辑器并切换页签（二进制走系统打开）；3) 控制台在会话结束或会话被清理后仍保留「重新运行」，`handleRerun` 不再依赖 `currentSession`；4) 新增路径索引 + 有界并发全文搜索，`Ctrl/Cmd+P` 快速找文件、`Ctrl/Cmd+Shift+F` 全文搜索，跳过 node_modules 等依赖目录并限制扫描规模；5) 资源管理器去玻璃半透明，与 CodeMirror 一并改用全局 surface CSS 变量，消除左右背景割裂。

**Verification** — `npm run build` PASS（vue-tsc + vite）；`npm run test:ts` PASS（含新增 `tests/editorGitMarkers.test.ts`）；评审后针对 major（深度剪枝中断、全文候选预筛）与部分 minor（语义色变量、可编辑控件快捷键、StateField 直接 return）已修复并复跑 build/相关单测。

**Journey log** — 1) 索引 walk 曾用同一布尔值表达「超深」与「达上限」，导致任意深层分支整树中断；已改为超深只剪枝。2) 全文搜索原先按 walk 顺序截断，大仓库会漏搜路径相关文件；已按路径/文件名命中优先排序。3) CM `gutterLineClass` 需要 `RangeSet<GutterMarker>`，不能直接复用 `Decoration` field，拆成两个 StateField。4) 背景统一不能只改资源管理器：CM 硬编码色与 `--app-surface` 不一致时仍会割裂，需一并切 CSS 变量。5) 字号基线测试禁止 9–11px，搜索预览曾误用 11px 被拦下。

## [S1] Problem

工作区编辑器相关体验有五处缺口：

1. 编辑器行号槽看不出文件相对 Git 的修改行。
2. Git 变更列表单击只看 Diff，双击无法跳到应用内编辑器。
3. 命令运行页在部分会话状态下「重新运行」按钮消失，无法一键重跑。
4. 编辑器缺少 WebStorm 风格的快速找文件 / 全文搜索；大型依赖目录不应被索引。
5. 左侧 PROJECT EXPLORER 半透明背景与右侧编辑区实色背景割裂。

## [S2] Design

### S2.1 Gutter Git 修改标记

- 打开/聚焦文本文档时，取当前文件 staged + unstaged unified diff，解析为行号集合（合并为近似坐标）。
- CodeMirror 通过 `gutterLineClass` + line decoration 显示：
  - 新增：`--app-success` 整行左侧色条
  - 修改：`--app-warning` 整行左侧色条
  - 删除：`--app-danger` **短划线画在两行交界**（上一行底边；文件开头画在首行顶边），不整行高亮
- 无 Git 仓库或 Diff 失败时不显示标记，不阻塞编辑。

实现落点：
- `src/utils/editorGitMarkers.ts`
- `LightweightEditor.vue`（`lineMarkers` prop）
- `WorkspaceEditor.vue`（拉取 diff 并传入）

### S2.2 Git 变更双击打开编辑器

- `GitStatusPanel.vue` 文件行 `@dblclick`：`editorStore.openFile` + `projectStore.requestRightTab('editor')`。
- 与资源管理器一致：二进制系统打开，文本应用内打开。
- 单击仍加载 Diff。

### S2.3 控制台「重新运行」恢复

- 会话结束后会话头保留「重新运行」。
- `activeScript` 存在但 `currentSession` 为空时，工具栏仍显示「重新运行」。
- `handleRerun` 不要求 session 存在。

### S2.4 编辑器快捷搜索（文件 + 全文）

- `Ctrl/Cmd+P` 快速打开文件；`Ctrl/Cmd+Shift+F` 全文搜索；工具栏按钮等价。
- 路径索引：懒加载、60s TTL、深度剪枝（超深只跳过分支）、上限 20000；跳过依赖/构建/点目录。
- 全文：不预索引；路径命中候选优先；有界并发 8、扫描上限 1500、结果上限 500、单文件 >1MB 跳过、可取消。
- 不写磁盘索引。

### S2.5 资源管理器与编辑器背景统一

- 资源管理器实色 `var(--app-surface)`，header `var(--app-surface-soft)`。
- CodeMirror 主题背景/行号槽改用同一套 CSS 变量。

## [S3] Out of Scope

- 不做跨项目全局搜索、正则/替换、索引持久化到磁盘。
- 不做 Diff 跳转到编辑器具体行号（首版只打开文件）。
- 不新增 Rust 侧搜索命令。
- 不改 uTools/ZTools 适配层。
- 不重做运行历史抽屉 UI。

## Tasks

- [x] T1: 实现 `editorGitMarkers` 解析与 CodeMirror gutter 装饰 — acceptance: 对含修改的文件打开编辑器后行号槽出现绿/红/橙标记；无 git 时无标记 (covers: S2.1)
- [x] T2: Git 状态文件行双击打开应用内编辑器并切换页签 — acceptance: 在 Git 变更列表双击文本文件，自动切到编辑器页并打开该文件；二进文件用系统打开 (covers: S2.2)
- [x] T3: 控制台会话结束后与无会话时均保留重新运行 — acceptance: 命令跑完后工具栏有「重新运行」且可再次执行；会话被清后选中命令页签仍可重跑 (covers: S2.3)
- [x] T4: 实现路径索引与快速文件搜索 UI — acceptance: Ctrl+P 打开搜索框，输入文件名片段能列出并打开文件；node_modules 等不出现 (covers: S2.4)
- [x] T5: 实现全文搜索（有界并发、排除依赖、可取消） — acceptance: Ctrl+Shift+F 能搜到源码字符串并列出路径/行号；大依赖目录结果为 0 (covers: S2.4)
- [x] T6: 资源管理器背景改为与编辑区一致的实色 — acceptance: 左侧资源管理器与右侧编辑区底色无明显割裂，暗色主题下对齐 (covers: S2.5)
- [x] T7: 补齐 i18n 文案与快捷键提示，并跑 `npm run build` 类型检查 — acceptance: zh/en 均有搜索相关文案；vue-tsc 通过 (covers: S2.4; depends: T4)
