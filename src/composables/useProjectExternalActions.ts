import { toValue, type MaybeRefOrGetter } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import type { Project } from '../types';
import { api } from '../api';
import { useNodeStore } from '../stores/node';
import { useSettingsStore } from '../stores/settings';
import { resolveNodePathFromVersion, resolveProjectNodePath, isExplicitNodeVersion } from '../utils/nodeRuntime';
import { normalizeNvmVersion } from '../utils/nvm';
import { resolveTerminalCommand } from '../utils/terminalConfig';

/***********************项目外部打开操作*********************/
/**
 * 列表行和快速管理弹窗共用的外部工具打开能力。
 * 这里保留现有 Node 版本解析与终端参数注入流程，不引入新的运行时行为。
 */
export function useProjectExternalActions(projectSource: MaybeRefOrGetter<Project | null | undefined>) {
  const { t } = useI18n();
  const nodeStore = useNodeStore();
  const settingsStore = useSettingsStore();

  function getProject(): Project | null {
    return toValue(projectSource) ?? null;
  }

  /***********************编辑器路径解析*********************/
  function resolveEditorPath(project: Project): string {
    let editorPath = settingsStore.settings.editorPath;
    if (project.editorId && settingsStore.settings.editors?.length) {
      const selectedEditor = settingsStore.settings.editors.find(editor => editor.id === project.editorId);
      if (selectedEditor) editorPath = selectedEditor.path;
    } else if (settingsStore.settings.editors?.length) {
      const defaultEditor = settingsStore.settings.defaultEditorId
        ? settingsStore.settings.editors.find(editor => editor.id === settingsStore.settings.defaultEditorId)
        : undefined;
      editorPath = (defaultEditor || settingsStore.settings.editors[0]).path;
    }
    return editorPath;
  }

  async function openEditor(): Promise<void> {
    const project = getProject();
    if (!project) return;
    try {
      await api.openInEditor(project.path, resolveEditorPath(project));
    } catch (error) {
      console.error(error);
      ElMessage.error(`${t('common.error')}: ${error}`);
    }
  }

  /***********************终端参数解析*********************/
  async function resolveTerminalOptions(project: Project): Promise<{
    terminalCommand: string;
    nodePath: string;
    packageManager: string;
  }> {
    if (project.type === 'node') {
      await nodeStore.loadNvmNodes();
    }

    let nodePath = '';
    if (project.type === 'node') {
      nodePath = resolveProjectNodePath(project, nodeStore.versions);

      if (!nodePath && isExplicitNodeVersion(project.nodeVersion)) {
        const version = normalizeNvmVersion(project.nodeVersion!)!;
        try {
          ElMessage.info(t('project.autoInstallStart', { version }));
          await nodeStore.installNode(version);
          ElMessage.success(t('project.autoInstallSuccess', { version }));
          nodePath = resolveProjectNodePath(project, nodeStore.versions);
        } catch (installError) {
          ElMessage.error(`${t('project.autoInstallFailed', { version })}: ${String(installError)}`);
          console.error('Failed to auto-install node version for terminal', installError);
        }
      }

      if (!nodePath) {
        try {
          const info = await api.scanProject(project.path);
          nodePath = resolveNodePathFromVersion(info.nvmVersion, nodeStore.versions);
        } catch (scanError) {
          console.warn('Failed to scan project for terminal node version', scanError);
        }
      }
    }

    return {
      terminalCommand: resolveTerminalCommand(
        settingsStore.settings.defaultTerminal,
        settingsStore.settings.customTerminals,
      ),
      nodePath,
      // 非 node 项目不注入 Node/包管理器版本，只做 cd。
      packageManager: project.type === 'node' ? (project.packageManager || 'npm') : '',
    };
  }

  async function openTerminal(): Promise<void> {
    const project = getProject();
    if (!project) return;
    try {
      const options = await resolveTerminalOptions(project);
      await api.openInTerminal(project.path, options.terminalCommand, options.nodePath, options.packageManager);
    } catch (error) {
      console.error(error);
      ElMessage.error(`${t('common.error')}: ${error}`);
    }
  }

  /***********************文件夹打开*********************/
  async function openFolder(): Promise<void> {
    const project = getProject();
    if (!project) return;
    try {
      await api.openFolder(project.path);
    } catch (error) {
      console.error(error);
      ElMessage.error(`${t('common.error')}: ${error}`);
    }
  }

  return {
    resolveEditorPath,
    resolveTerminalOptions,
    openEditor,
    openTerminal,
    openFolder,
  };
}
