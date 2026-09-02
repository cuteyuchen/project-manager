# Release Readiness Checklist

这是一份可重复执行的发布 QA 清单。自动化通过不等于真机手测通过；恢复测试只能使用临时 profile、fixture 或真实数据的副本。

## 自动化 Gate

- [ ] Windows CI：`npm ci`
- [ ] Windows CI：`npm run build`
- [ ] Windows CI：`npm run test:ts`
- [ ] Windows CI：`cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- [ ] Windows CI：`cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Ubuntu CI：`npm ci`
- [ ] Ubuntu CI：`npm run build`
- [ ] Ubuntu CI：`npm run test:ts`
- [ ] Ubuntu CI：`cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- [ ] Ubuntu CI：`cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] macOS CI：`npm ci`
- [ ] macOS CI：`npm run build`
- [ ] macOS CI：`npm run test:ts`
- [ ] macOS CI：`cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- [ ] macOS CI：`cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Plugin CI：`npm run build:utools`
- [ ] Plugin CI：`npm run build:ztools`
- [ ] 本地：`npm run release:preflight`
- [ ] 本地发布上下文：`npm run release:preflight -- --strict-local --tag <目标版本>`（仅在干净 `main` 且 `origin/main` 已同步时执行）
- [ ] 版本源全部一致，当前版本为 `1.6.2`
- [ ] `CHANGELOG.md` 含非空 `## Unreleased` 或目标版本 section
- [ ] `npm audit --json` 已按 direct/transitive、runtime/dev、severity、fixAvailable 分级
- [ ] 未执行 `npm audit fix --force`
- [ ] `git diff --check` 通过

## Windows 手工 QA

- [ ] 干净安装并首次启动
- [ ] 从上一版本升级，项目列表和设置仍在
- [ ] 旧数据迁移完成，迁移前 valid primary 有 backup
- [ ] UI Size 保存、重启后保持
- [ ] Node Runtime 安装、扫描和使用
- [ ] System Node 检测与切换
- [ ] Run Session 成功、失败、停止
- [ ] Run History 重启后可见
- [ ] Git status、commit、diff
- [ ] 编辑器打开并保存文件
- [ ] 自定义背景保存并重启保持
- [ ] 关闭到托盘、恢复窗口，运行中的 Session 仍在
- [ ] 真正退出时 data/history flush 完成
- [ ] updater 检查、下载、安装前保存失败可重试或取消
- [ ] 端口管理查看、定位和结束进程
- [ ] Quick Search 快捷键和项目切换
- [ ] Settings export/import
- [ ] 使用临时 profile 验证 backup recovery、corrupt snapshot 和只读保护
- [ ] Windows 125% DPI 下无重叠、无截断

## macOS 手工 QA

- [ ] 安装并启动 `.app`
- [ ] 数据目录位置和读写权限
- [ ] 编辑器、终端打开
- [ ] Git status、commit、diff
- [ ] Run Session 成功、失败、停止
- [ ] Node 扫描与项目运行
- [ ] autostart 开关
- [ ] Quick Search shortcut
- [ ] update check
- [ ] DMG 安装和替换
- [ ] Apple Silicon artifact（`aarch64-apple-darwin`）安装
- [ ] Intel artifact（`x86_64-apple-darwin`）安装
- [ ] Intel 真机未测试时保持 unchecked

## Ubuntu 手工 QA

- [ ] deb 安装、启动、卸载
- [ ] AppImage 启动和数据目录
- [ ] Run Session 成功、失败、停止
- [ ] 终端打开
- [ ] Git status、commit、diff
- [ ] Node 检测与运行
- [ ] 托盘关闭、恢复、退出
- [ ] updater check
- [ ] deb 覆盖升级认证
- [ ] AppImage 原位替换和重启

## uTools QA

- [ ] 插件加载、进入、退出
- [ ] 项目列表、筛选、Quick Search
- [ ] 运行命令和停止命令
- [ ] Git 基础操作
- [ ] Run History 保存与重启加载
- [ ] UI Size 保存
- [ ] settings persistence
- [ ] 临时 profile 中 primary 损坏进入只读
- [ ] backup restore 保留 `data.json.corrupt-*`
- [ ] 宿主不支持打开目录时按钮隐藏或禁用，插件不崩溃

## ZTools QA

- [ ] 插件加载、进入、退出
- [ ] 项目列表、筛选、Quick Search
- [ ] 运行命令和停止命令
- [ ] Git 基础操作
- [ ] Run History 保存与重启加载
- [ ] UI Size 保存
- [ ] settings persistence
- [ ] 临时 profile 中 primary 损坏进入只读
- [ ] backup restore 保留 `data.json.corrupt-*`
- [ ] 宿主不支持打开目录时按钮隐藏或禁用，插件不崩溃

## 生命周期专项

- [ ] double-exit 只执行一次 flush/cleanup
- [ ] 退出保存失败可 Retry
- [ ] 退出保存失败可 Cancel 并继续运行
- [ ] Exit Anyway 后才 cleanup Runner/Git process
- [ ] close-to-tray 不 cleanup Runner/Git process
- [ ] update install/relaunch 前 flush data.json 与 run-history
- [ ] flush 失败时不会开始 install/relaunch

## 数据恢复专项

- [ ] 使用副本执行 `A -> B -> C`
- [ ] primary 为 `B` 时 backup 为 `A`
- [ ] primary 为 `C` 时 backup 为 `B`
- [ ] primary 损坏、backup valid 时保持只读，等待用户确认恢复
- [ ] restore 前验证 JSON 和 PersistedData shape
- [ ] restore 后保留损坏 primary 快照
- [ ] primary 与 backup 都损坏时不显示恢复按钮
- [ ] 无 backup 时不显示恢复按钮
- [ ] run-history 损坏时回退空历史，不影响 data.json
- [ ] 不操作用户真实 `data.json`

## 安全审计

- [ ] 外部 URL 入口只接受 `http` / `https`；项目内容中的其他协议不会交给通用 URL opener
- [ ] 配置文件名拒绝绝对路径、目录分隔符和 `..`
- [ ] Tauri `open_path`、编辑器和文件夹入口继续使用专用路径 API
- [ ] CSP 当前保持 deferred：自定义 AI Base URL、Google Fonts、data URL 背景、Tauri asset/updater 与本地开发 WebSocket 尚未在真机 production 包上取得完整最小白名单；本轮不启用猜测性 CSP
