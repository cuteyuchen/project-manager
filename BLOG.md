# Project Manager：我做了一个开源的开发者项目管理桌面工具

> 把项目、命令、Git、Node.js、终端、端口和开发笔记放进同一个工作台。

随着电脑里的项目越来越多，我发现开发过程中真正消耗时间的，往往不是写代码本身，而是各种重复的环境切换：

- 在资源管理器中寻找项目目录
- 打开编辑器和终端
- 切换项目需要的 Node.js 版本
- 回忆项目应该运行哪条命令
- 查看 Git 改动并整理提交信息
- 排查被占用的本地端口
- 在多个窗口之间寻找项目笔记和常用文件

当项目只有两三个时，这些问题并不明显。但当本地同时维护多个前端、后端、桌面端或开源项目后，每次重新进入一个项目，都需要花时间恢复上下文。

所以我开发了 **Project Manager**。

它不是传统的任务看板，而是一款面向开发者的本地项目管理工具：通过一个桌面应用，统一管理项目目录、运行命令、Git 仓库、Node.js 环境、文件、备忘录和系统工具。

![Project Manager 项目总览](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/project-dashboard.png)

> 项目宣传视频：[点击观看](替换为上传后的视频地址)

## 多层级项目管理，不再把 Monorepo 当成一个文件夹

Project Manager 支持单个添加、批量添加和拖拽导入项目。导入目录时，应用可以继续扫描其中的子项目，形成可逐层进入的多级项目工作区。

例如，一个产品仓库可能同时包含：

```text
product-suite
├─ web
├─ admin
├─ server
└─ desktop
```

在 Project Manager 中，根项目和各个子项目可以保持清晰的父子关系，而不是全部平铺在一个越来越长的列表里。

每个子项目都可以拥有自己独立的：

- 项目路径
- 启动命令
- Git 仓库状态
- Node.js 版本
- 包管理器
- 常用文件
- Markdown 备忘录

进入子项目后，可以直接使用它自己的开发环境；返回上一级时，应用还会恢复之前的浏览位置和滚动状态。

![Project Manager 多级项目工作区](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/project-workspace.png)

项目总览还支持分组、标签、收藏、置顶、最近使用、运行状态、Git 改动和健康状态等筛选方式。常用的筛选条件可以保存成视图，多项目命令也可以组成启动组。

## 全局搜索：用一个快捷键找到项目和命令

项目多了以后，手动翻列表本身也会成为负担。

Project Manager 提供了全局快速搜索，可以通过应用内快捷键呼出；桌面端还支持注册系统级快捷键，即使应用处于后台或最小化状态，也能直接打开搜索窗口。

搜索范围不仅包括项目名称，还包括：

- 项目路径
- 项目描述
- 项目标签
- `package.json` 脚本
- 自定义命令名称与命令内容

中文项目名支持拼音和拼音首字母匹配。找到项目后可以直接进入工作区；找到脚本或自定义命令后，可以快速定位并运行。

没有输入关键词时，搜索窗口会优先显示置顶项目和最近使用的项目，适合把它当成一个开发者专用的项目启动器。

## 一键打开编辑器、终端和项目目录

每个项目都可以一键使用编辑器、终端或文件管理器打开，不需要先复制路径，再手动切换窗口。

应用支持配置多个编辑器，并允许为不同项目指定不同的编辑器。例如，前端项目使用 VS Code，Rust 项目使用其他编辑器，而没有单独配置的项目则使用默认编辑器。

终端同样支持自动检测和自定义配置，包括 PowerShell、PowerShell 7、CMD、Windows Terminal、Git Bash 等常见终端。

真正重要的是：**打开终端时，Project Manager 会根据当前项目注入对应的 Node.js 环境。**

如果项目配置了特定 Node.js 版本，应用会优先从 NVM 的固定版本目录中解析，而不是依赖可能随全局切换变化的系统软链接。如果目标版本尚未安装，还可以自动触发安装。

终端打开后会显示当前的 Node.js 和包管理器版本，方便确认环境是否正确。项目还可以分别配置 npm、yarn、pnpm 或 cnpm，以及包管理器使用当前 Node 环境还是默认 Node 环境。

这意味着从 Project Manager 打开的终端，已经位于正确目录，并准备好了该项目需要的 Node.js 环境。

## 项目命令统一管理

Project Manager 会自动读取 `package.json` 中的 scripts，并为 Node.js 项目补充安装依赖命令。除此之外，也可以为每个项目保存自己的常用命令。

例如：

```bash
npm run dev
npm run build
npm run test
npm run tauri dev
docker compose up -d
```

命令可以直接在项目工作区中启动，运行日志会实时显示。再次点击正在运行的命令即可停止对应进程。

![Project Manager 命令运行](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/command-runner.png)

对于需要同时启动多个服务的项目，可以把多个项目命令组合成启动组，一次启动或停止整套开发环境。

## Git 工作台：从查看 Diff 到完成提交

Project Manager 内置了 Git 图形工作台，覆盖日常开发中常见的仓库操作：

- 查看工作区和暂存区状态
- 查看文件 Diff
- 文件级或 Hunk 级暂存、取消暂存和丢弃
- 多选文件并批量操作
- 查看提交历史和文件变更
- 管理分支和远程仓库
- 查看并切换行内或并排 Diff

![Project Manager Git 工作台](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/git-panel.png)

Git 面板的分栏支持拖拽调整，布局会按百分比保存。窗口尺寸发生变化后，工作区仍能自动适配。

## AI 自动生成提交信息

整理完暂存区后，可以让 AI 根据本次变更自动生成 Commit Message。

AI 只读取已暂存内容的专用 Diff，不会把工作区中尚未准备提交的修改混进上下文。默认生成结果遵循 Conventional Commits 风格，也可以通过提示词模板调整输出规则。

目前支持 OpenAI 兼容接口，可以配置：

- API 类型
- Base URL
- API Key
- 模型名称
- 提示词模板
- 流式输出

![Project Manager AI 提交信息设置](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/ai-commit-settings.png)

对于一次包含多个文件的修改，这项功能可以省去反复阅读 Diff、总结改动和组织提交措辞的过程。

## 提交日历：集中查看所有项目的开发记录

除了单个仓库的 Git 历史，Project Manager 还提供了跨项目提交日历。

应用会读取当前管理项目中属于自己的 Git 提交，并按照日期汇总到月历中。通过日历可以快速了解：

- 本月一共完成了多少次提交
- 哪些日期有开发活动
- 某一天修改了哪些项目
- 每次提交的时间、项目和摘要

点击提交记录后，还可以加载完整提交信息并一键复制。

它不仅是一个类似 GitHub Contributions 的可视化日历，也是一份保存在本地的跨项目开发轨迹。对于同时维护多个私有仓库、公司项目和个人项目的开发者来说，不需要把代码托管到同一个平台，也能统一回顾自己的工作记录。

## 可视化管理 Node.js 与 NVM

不同项目依赖不同 Node.js 版本，是前端开发中非常常见的问题。

Project Manager 提供了独立的 Node.js 管理页面，可以：

- 查看 NVM 中已经安装的版本
- 安装和卸载 Node.js
- 切换版本
- 设置系统默认 Node.js
- 识别系统已有的 Node.js
- 添加自定义 Node.js 可执行路径

![Project Manager Node.js 版本管理](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/node-manager.png)

项目可以单独绑定 Node.js 版本。之后无论是打开终端还是从应用中运行脚本，都会尽可能使用该项目配置的环境，减少“在我电脑上明明可以运行”的版本差异问题。

## 文件管理和 Markdown 项目备忘录

每个项目都可以维护自己的常用文件和 Markdown 备忘录。

备忘录支持编辑、预览和分屏模式，可以记录：

- 启动和部署步骤
- 常用命令
- 测试账号说明
- 待处理事项
- 技术决策
- 项目交接信息

常用文件或文件夹也可以关联到项目工作区中，并快速预览图片和文本内容。

这些信息会跟随当前项目或子项目切换。重新进入一个很久没有维护的项目时，不必再从聊天记录和历史文档中重新寻找上下文。

## 本地端口管理

同时启动多个开发服务时，端口冲突几乎不可避免：

```text
Port 3000 is already in use
```

桌面版 Project Manager 可以查看当前正在使用的 TCP 和 UDP 端口，并显示对应的：

- PID
- 进程名称
- 程序路径
- 启动命令行

发现异常占用后，可以直接结束对应进程，不必再临时打开任务管理器或查询 `netstat`、`lsof`。

![Project Manager 端口管理](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/port-manager.png)

## 背景、主题和界面个性化

开发工具通常会长时间保持打开，所以界面是否舒适同样重要。

Project Manager 提供亮色、暗色和跟随系统三种主题模式。项目总览、设置、Git、文件管理、Node.js 和端口管理等主要页面使用统一的主题变量，避免切换页面后出现风格割裂。

如果希望工作台更有个人风格，还可以选择本地图片作为全局背景，并调节背景显示强度。启用背景后，主要面板会使用半透明和模糊效果，在保留图片氛围的同时维持文字和控件的可读性。

![Project Manager 设置页面](https://raw.githubusercontent.com/cuteyuchen/project-manager/main/docs/images/settings.png)

## 一个典型的使用流程

假设现在需要继续维护一个包含 Web、服务端和桌面端的项目：

1. 使用全局快捷键呼出快速搜索。
2. 输入项目名或拼音首字母，进入对应的多级项目工作区。
3. 选择需要开发的子项目。
4. 一键使用指定编辑器打开代码。
5. 一键打开已经注入正确 Node.js 版本的终端。
6. 从命令面板启动开发服务和依赖服务。
7. 开发完成后，在 Git 工作台查看 Diff 并暂存修改。
8. 使用 AI 根据暂存区变更生成提交信息。
9. 提交完成后，在提交日历中回顾当天的开发记录。

整个过程不需要手动查找目录，也不需要反复确认 Node.js 版本、启动命令和 Git 工具。

## 多端支持

Project Manager 目前提供三种运行形态：

- **Tauri 桌面应用**：功能最完整，适合长期作为本地开发工作台使用
- **uTools 插件**：适合通过启动器快速搜索和打开项目
- **ZTools 插件**：复用同一套项目管理能力

桌面端支持 Windows、macOS 和 Linux。端口管理、系统级快捷键等依赖桌面能力的功能，以 Tauri 版本为主。

## 技术实现

Project Manager 使用以下技术构建：

| 模块 | 技术 |
|---|---|
| 桌面端 | Tauri v2、Rust |
| 前端 | Vue 3、TypeScript、Vite |
| 状态管理 | Pinia |
| UI | Element Plus、UnoCSS |
| 国际化 | vue-i18n |
| 拼音搜索 | pinyin-pro |
| Git Diff | diff2html |

桌面端通过 Rust 处理 Git、进程、终端、文件和系统集成能力；前端通过统一的平台接口适配 Tauri、uTools 和 ZTools，使三种运行形态可以共享主要业务逻辑。

## 下载与体验

Project Manager 当前版本为 **v1.5.3**，项目已经开源。

- GitHub：[cuteyuchen/project-manager](https://github.com/cuteyuchen/project-manager)
- 版本下载：[GitHub Releases](https://github.com/cuteyuchen/project-manager/releases)

如果你也在维护多个本地项目，或者经常需要在编辑器、终端、Git 客户端、Node.js 版本工具和任务管理器之间来回切换，可以试试 Project Manager。

如果项目对你有帮助，欢迎点一个 **Star**。如果遇到问题，或者希望增加新的开发者工具，也欢迎通过 Issue 提交建议。

我也很想知道：你在管理本地开发项目时，最希望被自动化的重复操作是什么？
