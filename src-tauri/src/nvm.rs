//! 旧 NVM 命令已退出正常业务路径。
//! 保留 invoke 名称仅作 deprecated 别名，实现全部委托给 `node_runtime`。

use tauri::{AppHandle, State};

use crate::node_runtime::{self, NodeRuntimeInfo, NodeRuntimeState};

#[tauri::command]
pub async fn get_nvm_list(
    app: AppHandle,
    state: State<'_, NodeRuntimeState>,
) -> Result<Vec<NodeRuntimeInfo>, String> {
    node_runtime::list_installed_node_runtimes(app, state).await
}

#[tauri::command]
pub async fn install_node(
    app: AppHandle,
    state: State<'_, NodeRuntimeState>,
    version: String,
) -> Result<String, String> {
    node_runtime::install_managed_node(app, state, version, None).await
}

#[tauri::command]
pub async fn uninstall_node(
    app: AppHandle,
    state: State<'_, NodeRuntimeState>,
    version: String,
) -> Result<(), String> {
    node_runtime::uninstall_managed_node(app, state, version).await
}

/// 已废弃：不再调用 nvm use，也不修改系统 PATH。
#[tauri::command]
pub async fn use_node(_version: String) -> Result<String, String> {
    Err("use_node is deprecated; set the Project Manager default Node instead".to_string())
}
