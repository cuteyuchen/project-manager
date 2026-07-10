<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, h } from 'vue';
import { api } from './api';
import { ElMessageBox, ElMessage, ElLoading } from 'element-plus';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useI18n } from 'vue-i18n';
import Sidebar from './components/Sidebar.vue';
import Dashboard from './views/Dashboard.vue';
import Settings from './views/Settings.vue';
import NodeManager from './views/NodeManager.vue';
import PortManager from './views/PortManager.vue';
import CommitCalendar from './views/CommitCalendar.vue';
import TitleBar from './components/TitleBar.vue';
import UpdateProgress from './components/UpdateProgress.vue';
import ProjectQuickSearch from './components/ProjectQuickSearch.vue';
import { loadData, scheduleSaveData, flushPendingSave } from './utils/persistence';
import { useProjectStore } from './stores/project';
import { useSettingsStore } from './stores/settings';
import { useNodeStore } from './stores/node';
import { useGitStore } from './stores/git';
import { useUsageStore } from './stores/usage';
import type { Project } from './types';
import { normalizeNvmVersion, findInstalledNodeVersion } from './utils/nvm';
import { DEFAULT_NETWORK_TIMEOUT_MS, fetchWithTimeout, isAbortError } from './utils/network';
import { ensureNodeInstallCommand } from './utils/projectCommands';
import { selectReleaseAsset } from './utils/updateReleaseAsset';
import {
  DEFAULT_QUICK_SEARCH_APP_SHORTCUT,
  DEFAULT_QUICK_SEARCH_GLOBAL_SHORTCUT,
  isShortcutEvent,
  normalizeShortcut,
} from './utils/shortcut';

const target = import.meta.env.VITE_TARGET;
const isPlugin = target === 'utools' || target === 'ztools';

const { t } = useI18n();
const currentView = ref<'dashboard' | 'settings' | 'nodes' | 'ports' | 'commitCalendar'>('dashboard');
const loaded = ref(false);
const isDragging = ref(false);
let unlistenDragEnter: UnlistenFn | null = null;
let unlistenDragLeave: UnlistenFn | null = null;
let unlistenDragDrop: UnlistenFn | null = null;
let unlistenSingleInstance: UnlistenFn | null = null;
let manualUpdateCheckListener: (() => void) | null = null;

const showUpdateProgress = ref(false);
const downloadProgress = ref(0);
const showQuickSearch = ref(false);
const processedImportInstallVersions = new Set<string>();
const closeBehaviorDialogVisible = ref(false);
const rememberCloseAction = ref(false);
let trayIcon: { close?: () => Promise<void> } | null = null;
let pendingCloseResolver: ((action: 'tray' | 'exit' | 'cancel') => void) | null = null;
let unlistenCloseRequested: UnlistenFn | null = null;
let registeredQuickSearchGlobalShortcut = '';
let allowWindowClose = false;
let traySetupToken = 0;
let exiting = false;


async function handleImportProject(path: string) {
  const store = useProjectStore();
  if (store.projects.some(p => p.path === path)) {
    ElMessage.warning(t('project.alreadyExists') || 'Project already exists');
    return;
  }

  const loading = ElLoading.service({
    lock: true,
    text: 'Scanning...',
    background: 'color-mix(in srgb, black 70%, transparent)',
  });

  try {
    const info = await api.scanProject(path);
    let nodeVersion = '';

    const normalizedNvmVersion = normalizeNvmVersion(info.nvmVersion);
    if (normalizedNvmVersion) {
      let currentNodeVersions: string[] = [];
      try {
        const nvmList = await api.getNvmList();
        currentNodeVersions = nvmList.map(v => v.version);
      } catch (nvmErr) {
        console.error('Failed to load node versions for import', nvmErr);
      }

      let installed = findInstalledNodeVersion(currentNodeVersions, normalizedNvmVersion);

      if (!installed && !processedImportInstallVersions.has(normalizedNvmVersion)) {
        processedImportInstallVersions.add(normalizedNvmVersion);
        try {
          ElMessage.info(t('project.autoInstallStart', { version: normalizedNvmVersion }));
          await api.installNode(normalizedNvmVersion);
          ElMessage.success(t('project.autoInstallSuccess', { version: normalizedNvmVersion }));

          const latestList = await api.getNvmList();
          currentNodeVersions = latestList.map(v => v.version);
          installed = findInstalledNodeVersion(currentNodeVersions, normalizedNvmVersion);
        } catch (installErr) {
          ElMessage.error(`${t('project.autoInstallFailed', { version: normalizedNvmVersion })}: ${String(installErr)}`);
          console.error('Failed to auto-install node version while importing project', installErr);
        }
      }

      if (!installed) {
        installed = findInstalledNodeVersion(currentNodeVersions, normalizedNvmVersion);
      }

      if (installed) {
        nodeVersion = installed;
      }
    } else if (info.nvmVersion) {
      ElMessage.warning(t('project.invalidNvmrc'));
      console.warn('Invalid .nvmrc version while importing project', info.nvmVersion);
    }

    const project: Project = {
      id: crypto.randomUUID(),
      name: info.name || path.split(/[\\/]/).pop() || 'Untitled',
      path: path,
      type: info.projectType === 'node' ? 'node' : 'other',
    };

    if (info.projectType === 'node') {
      project.nodeVersion = nodeVersion;
      project.packageManager = info.packageManager || 'npm';
      project.scripts = info.scripts;
    }

    store.addProject(ensureNodeInstallCommand(project, t('project.installDependencies')));
    ElMessage.success(t('dashboard.addProject') + ' Success');
  } catch (e) {
    ElMessage.error('Failed to import: ' + e);
  } finally {
    loading.close();
  }
}

/***********************快速搜索快捷键*********************/

function openQuickSearch() {
  showQuickSearch.value = true;
}

async function openQuickSearchFromGlobalShortcut() {
  await showMainWindow();
  openQuickSearch();
}

async function unregisterQuickSearchGlobalShortcut() {
  if (!registeredQuickSearchGlobalShortcut) return;
  const shortcut = registeredQuickSearchGlobalShortcut;
  registeredQuickSearchGlobalShortcut = '';
  try {
    const { unregister } = await import('@tauri-apps/plugin-global-shortcut');
    await unregister(shortcut);
  } catch (error) {
    console.error('Failed to unregister quick search global shortcut:', error);
  }
}

async function syncQuickSearchGlobalShortcut() {
  if (isPlugin) return;

  const enabled = settingsStore.settings.quickSearchGlobalShortcutEnabled === true;
  const shortcut = normalizeShortcut(
    settingsStore.settings.quickSearchGlobalShortcut || DEFAULT_QUICK_SEARCH_GLOBAL_SHORTCUT,
  );

  if (!enabled || !shortcut) {
    await unregisterQuickSearchGlobalShortcut();
    return;
  }

  if (registeredQuickSearchGlobalShortcut === shortcut) return;

  await unregisterQuickSearchGlobalShortcut();
  try {
    const { register } = await import('@tauri-apps/plugin-global-shortcut');
    await register(shortcut, (event) => {
      if (event.state === 'Pressed') {
        void openQuickSearchFromGlobalShortcut();
      }
    });
    registeredQuickSearchGlobalShortcut = shortcut;
  } catch (error) {
    console.error('Failed to register quick search global shortcut:', error);
    ElMessage.warning(t('settings.quickSearchGlobalShortcutRegisterFailed'));
  }
}

/** 应用内键盘事件处理：按设置项打开快速搜索 */
function handleGlobalKeydown(event: KeyboardEvent) {
  const shortcut = settingsStore.settings.quickSearchAppShortcut || DEFAULT_QUICK_SEARCH_APP_SHORTCUT;
  if (isShortcutEvent(event, shortcut)) {
    event.preventDefault();
    openQuickSearch();
    return;
  }

  if (event.key === 'Escape' && showQuickSearch.value) {
    event.preventDefault();
    showQuickSearch.value = false;
  }
}

/** 快速搜索选中项目 */
function handleQuickSearchSelect(projectId: string) {
  const store = useProjectStore();
  store.activeProjectId = projectId;
  currentView.value = 'dashboard';
  showQuickSearch.value = false;
}

/** 快速搜索选中脚本 */
function handleQuickSearchSelectScript(projectId: string, _scriptName: string) {
  const store = useProjectStore();
  store.activeProjectId = projectId;
  currentView.value = 'dashboard';
  showQuickSearch.value = false;
}

function compareVersions(v1: string, v2: string) {
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = p1[i] ?? 0;
    const n2 = p2[i] ?? 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

type ManualUpdateResult = {
  status: 'available' | 'latest' | 'error';
  version?: string;
  error?: string;
};

function dispatchManualUpdateResult(detail: ManualUpdateResult) {
  window.dispatchEvent(new CustomEvent<ManualUpdateResult>('manual-check-update-result', { detail }));
}

async function checkUpdate(manual = false) {
  try {
    // Use /releases list instead of /releases/latest to avoid missing pre-release tagged versions
    const response = await fetchWithTimeout(
      'https://api.github.com/repos/cuteyuchen/project-manager/releases?per_page=10',
      {},
      { timeoutMs: DEFAULT_NETWORK_TIMEOUT_MS },
    );
    if (!response.ok) {
      if (manual) {
        dispatchManualUpdateResult({
          status: 'error',
          error: `HTTP ${response.status}`
        });
      }
      return;
    }
    const releases = await response.json();
    // Find the highest-version non-draft release (regardless of pre-release flag)
    const validReleases = (releases as any[]).filter((r) => !r.draft && r.tag_name);
    if (validReleases.length === 0) {
      if (manual) {
        dispatchManualUpdateResult({ status: 'latest' });
      }
      return;
    }
    const latestRelease = validReleases.reduce((best: any, cur: any) =>
      compareVersions(cur.tag_name.replace(/^v/, ''), best.tag_name.replace(/^v/, '')) > 0 ? cur : best
    );
    const latestTag: string = latestRelease.tag_name;
    const remoteVersion = latestTag.replace(/^v/, '');
    const localVersion = await api.getAppVersion();

    if (compareVersions(remoteVersion, localVersion) > 0) {
      if (manual) {
        dispatchManualUpdateResult({ status: 'available', version: latestTag });
      }
      ElMessageBox.confirm(
        h('div', null, [
          h('p', null, t('update.message', { version: latestTag })),
          h('div', { class: 'mt-2' }, [
            h('a', {
              class: 'text-blue-500 hover:text-blue-600 cursor-pointer underline',
              onClick: (e: Event) => {
                e.preventDefault();
                api.openUrl('https://github.com/cuteyuchen/project-manager/releases');
              }
            }, t('update.openDownloadPage'))
          ])
        ]),
        t('update.title'),
        {
          confirmButtonText: t('update.confirm'),
          cancelButtonText: t('update.cancel'),
          type: 'info',
        }
      ).then(async () => {
        showUpdateProgress.value = true;
        downloadProgress.value = 0;

        let unlisten: (() => void) | undefined;

        try {
          unlisten = await api.onDownloadProgress((percentage) => {
             downloadProgress.value = percentage;
          });

          const { os, arch } = await api.getPlatformInfo();
          /***********************更新安装包选择*********************/
          const matchedAsset = selectReleaseAsset(
            { os, arch },
            Array.isArray(latestRelease.assets) ? latestRelease.assets : [],
          );

          if (!matchedAsset?.browser_download_url) {
            throw new Error(`No release asset found for ${os}/${arch}`);
          }

          await api.installUpdate(matchedAsset.browser_download_url);
        } catch (error: any) {
          if (error && error.toString().includes('cancelled')) {
             ElMessage.info(t('update.cancelled') || 'Update cancelled');
          } else {
             ElMessage.error(t('update.error', { error }));
          }
          showUpdateProgress.value = false;
        } finally {
          if (unlisten) unlisten();
          // Don't hide progress immediately on success, let the app restart
          // But if it failed/cancelled, we hide it (handled in catch or here)
          // If successful, the app will close.
        }
      }).catch(() => { });
      return;
    }

    if (manual) {
      dispatchManualUpdateResult({ status: 'latest', version: latestTag });
    }
  } catch (e) {
    console.error('Failed to check for updates:', e);
    if (manual) {
      dispatchManualUpdateResult({
        status: 'error',
        error: isAbortError(e) ? t('common.requestTimeout') : String(e),
      });
    }
  }
}

function handleCancelUpdate() {
  api.cancelUpdate();
  showUpdateProgress.value = false;
}

function handleBackgroundUpdate() {
  showUpdateProgress.value = false;
}

function getCloseAction() {
  if (isPlugin) return 'exit';
  if (settingsStore.settings.trayEnabled === false) return 'exit';
  return settingsStore.settings.closeAction || 'ask';
}

async function showMainWindow() {
  useGitStore().setColdStorage(false);
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const currentWindow = getCurrentWindow();
  await currentWindow.show();
  await currentWindow.unminimize().catch(() => undefined);
  await currentWindow.setFocus().catch(() => undefined);
}

async function hideToTray() {
  useGitStore().setColdStorage(true);
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
}

async function destroyTray() {
  if (!trayIcon) return;
  await trayIcon.close?.().catch(() => undefined);
  trayIcon = null;
}

async function exitApp() {
  if (exiting) return;
  exiting = true;

  try {
    useGitStore().setColdStorage(true);
    await destroyTray();
    await api.exitApp();
  } finally {
    exiting = false;
  }
}

function promptCloseAction(): Promise<'tray' | 'exit' | 'cancel'> {
  rememberCloseAction.value = false;
  closeBehaviorDialogVisible.value = true;
  return new Promise((resolve) => {
    pendingCloseResolver = resolve;
  });
}

function resolveCloseDialog(action: 'tray' | 'exit' | 'cancel') {
  closeBehaviorDialogVisible.value = false;
  if (action !== 'cancel' && rememberCloseAction.value) {
    settingsStore.settings.closeAction = action;
  }
  if (pendingCloseResolver) {
    pendingCloseResolver(action);
    pendingCloseResolver = null;
  }
}

async function setupTray() {
  if (isPlugin || !loaded.value) return;

  const currentToken = ++traySetupToken;
  await destroyTray();
  if (currentToken !== traySetupToken) return;

  if (settingsStore.settings.trayEnabled === false) {
    return;
  }

  const [{ TrayIcon }, { Menu }, { MenuItem }, { defaultWindowIcon }] = await Promise.all([
    import('@tauri-apps/api/tray'),
    import('@tauri-apps/api/menu'),
    import('@tauri-apps/api/menu'),
    import('@tauri-apps/api/app'),
  ]);

  const showItem = await MenuItem.new({
    id: 'tray-show',
    text: t('settings.trayShowApp'),
    action: () => { void showMainWindow(); },
  });
  const hideItem = await MenuItem.new({
    id: 'tray-hide',
    text: t('settings.trayHideApp'),
    action: () => { void hideToTray(); },
  });
  const exitItem = await MenuItem.new({
    id: 'tray-exit',
    text: t('settings.trayExitApp'),
    action: () => { void exitApp(); },
  });
  const menu = await Menu.new({
    items: [showItem, hideItem, { item: 'Separator' }, exitItem],
  });
  const icon = await defaultWindowIcon();

  const nextTrayIcon = await TrayIcon.new({
    id: 'project-manager-tray',
    tooltip: t('common.title'),
    menu,
    showMenuOnLeftClick: false,
    icon: icon || undefined,
    action: (event) => {
      if (
        (event.type === 'Click' && event.button === 'Left' && event.buttonState === 'Up')
        || event.type === 'DoubleClick'
      ) {
        void showMainWindow();
      }
    },
  });

  if (currentToken !== traySetupToken) {
    await nextTrayIcon.close?.().catch(() => undefined);
    return;
  }

  trayIcon = nextTrayIcon;
}

async function setupCloseRequestedHandler() {
  if (isPlugin || !loaded.value) return;

  if (unlistenCloseRequested) {
    unlistenCloseRequested();
    unlistenCloseRequested = null;
  }

  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  unlistenCloseRequested = await getCurrentWindow().onCloseRequested(async (event) => {
    if (allowWindowClose || exiting) return;

    const closeAction = getCloseAction();
    if (closeAction === 'exit') {
      event.preventDefault();
      await exitApp();
      return;
    }

    event.preventDefault();
    const resolvedAction = closeAction === 'ask' ? await promptCloseAction() : closeAction;

    if (resolvedAction === 'tray') {
      await hideToTray();
      return;
    }

    if (resolvedAction === 'exit') {
      await exitApp();
    }
  });
}

onMounted(async () => {
  await loadData();
  loaded.value = true;

  // Handle Startup Args / uTools/ZTools Plugin Enter
  if (isPlugin) {
    const pluginApi = (window as any).ztools || (window as any).utools;
    if (pluginApi) {
      pluginApi.onPluginEnter(({ code, type, payload }: any) => {
        if (code === 'import_project' && type === 'files' && payload.length > 0) {
          handleImportProject(payload[0].path);
        }
      });
    }

    // Web/uTools Drag and Drop
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        isDragging.value = true;
      }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) {
        isDragging.value = false;
      }
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging.value = false;
      dragCounter = 0;

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
           const file = files[i] as any;
           // In Electron/uTools, File object has a 'path' property
           if (file.path) {
             await handleImportProject(file.path);
           }
        }
      }
    });
  } else {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const args = await invoke<string[]>('get_startup_args');
      if (args && args.length > 1) {
        const potentialPath = args[1];
        if (!potentialPath.startsWith('-')) {
          handleImportProject(potentialPath);
        }
      }
    } catch (e) {
      console.error('Failed to get startup args:', e);
    }

    // Setup Drag and Drop Listeners
    try {
      const { listen } = await import('@tauri-apps/api/event');

      unlistenDragEnter = await listen('tauri://drag-enter', () => {
        isDragging.value = true;
      });

      unlistenDragLeave = await listen('tauri://drag-leave', () => {
        isDragging.value = false;
      });

      unlistenDragDrop = await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        isDragging.value = false;
        if (event.payload.paths && event.payload.paths.length > 0) {
           for (const path of event.payload.paths) {
             handleImportProject(path);
           }
        }
      });

      // 监听单实例事件
      unlistenSingleInstance = await listen<string>('single-instance-args', (event) => {
        const path = event.payload;
        if (path) {
          handleImportProject(path);
        }
      });
    } catch (e) {
      console.error('Failed to setup drag listeners', e);
    }
  }

  // Default to true if undefined (legacy support)
  if (!isPlugin && useSettingsStore().settings.autoUpdate !== false) {
    checkUpdate();
  }

  // Restore auto-launch state after reinstall
  if (!isPlugin) {
    try {
      const settingsStore = useSettingsStore();
      if (settingsStore.settings.autoLaunch === true) {
        const autostart = await import('@tauri-apps/plugin-autostart');
        const isEnabled = await autostart.isEnabled();
        if (!isEnabled) {
          await autostart.enable();
        }
      }
    } catch (e) {
      console.error('Failed to restore auto-launch state:', e);
    }
  }

  // Listen for manual update check from Settings page
  const handleManualUpdateCheck = () => checkUpdate(true);
  manualUpdateCheckListener = () => window.removeEventListener('manual-check-update', handleManualUpdateCheck);
  window.addEventListener('manual-check-update', handleManualUpdateCheck);

  // 注册全局 Ctrl+K 快捷键
  document.addEventListener('keydown', handleGlobalKeydown);
});

onUnmounted(() => {
  if (unlistenDragEnter) unlistenDragEnter();
  if (unlistenDragLeave) unlistenDragLeave();
  if (unlistenDragDrop) unlistenDragDrop();
  if (unlistenSingleInstance) unlistenSingleInstance();
  if (manualUpdateCheckListener) manualUpdateCheckListener();
  if (unlistenCloseRequested) unlistenCloseRequested();
  document.removeEventListener('keydown', handleGlobalKeydown);
  void unregisterQuickSearchGlobalShortcut();
  void destroyTray();
  void flushPendingSave();
});

// Watch stores and save
const projectStore = useProjectStore();
const settingsStore = useSettingsStore();
const nodeStore = useNodeStore();
const usageStore = useUsageStore();

const triggerSave = () => {
  scheduleSaveData();
};

watch(() => projectStore.projects, triggerSave, { deep: true });
watch(() => projectStore.projectGroups, triggerSave, { deep: true });
watch(() => settingsStore.settings, triggerSave, { deep: true });
watch(() => nodeStore.versions, triggerSave, { deep: true });
watch(() => usageStore.usageData, triggerSave, { deep: true });

watch(
  () => [loaded.value, settingsStore.settings.trayEnabled, settingsStore.settings.locale],
  async ([isLoaded]) => {
    if (!isLoaded || isPlugin) return;
    await setupTray();
  }
);

watch(
  () => [loaded.value, settingsStore.settings.trayEnabled, settingsStore.settings.closeAction],
  async ([isLoaded]) => {
    if (!isLoaded || isPlugin) return;
    await setupCloseRequestedHandler();
  }
);

watch(
  () => [
    loaded.value,
    settingsStore.settings.quickSearchGlobalShortcutEnabled,
    settingsStore.settings.quickSearchGlobalShortcut,
  ],
  async ([isLoaded]) => {
    if (!isLoaded || isPlugin) return;
    await syncQuickSearchGlobalShortcut();
  }
);
</script>

<template>
  <div class="app-shell">
    <TitleBar v-if="!isPlugin" />

    <div class="app-layout">
      <Sidebar @navigate="v => currentView = v" />
      <main class="app-main">
        <div class="app-view-stack">
          <Transition name="page-fade" mode="out-in">
          <KeepAlive>
            <Dashboard v-if="currentView === 'dashboard'" key="dashboard" />
            <CommitCalendar v-else-if="currentView === 'commitCalendar'" key="commitCalendar" />
            <Settings v-else-if="currentView === 'settings'" key="settings" />
            <NodeManager v-else-if="currentView === 'nodes'" key="nodes" />
            <PortManager v-else-if="currentView === 'ports'" key="ports" />
          </KeepAlive>
          </Transition>
        </div>

        <!-- Drag Overlay -->
        <div v-if="isDragging" class="app-drag-overlay">
          <div class="text-center">
             <div class="text-6xl mb-4 text-blue-500 dark:text-blue-300 flex justify-center">
               <div class="i-mdi-folder-upload" />
             </div>
             <h2 class="text-2xl font-bold">{{ t('dashboard.dropToImport') || 'Drop folder to import' }}</h2>
          </div>
        </div>
      </main>
    </div>

    <UpdateProgress
      v-if="showUpdateProgress"
      :percentage="downloadProgress"
      @cancel="handleCancelUpdate"
      @background="handleBackgroundUpdate"
    />

    <el-dialog
      v-if="!isPlugin"
      v-model="closeBehaviorDialogVisible"
      :title="t('settings.closeActionTitle')"
      width="420px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
      append-to-body
      align-center
      class="app-centered-dialog"
    >
      <div class="space-y-3 text-sm text-slate-600 dark:text-slate-300">
        <p>{{ t('settings.closeActionPrompt') }}</p>
        <el-checkbox v-model="rememberCloseAction">
          {{ t('settings.rememberCloseAction') }}
        </el-checkbox>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="resolveCloseDialog('cancel')">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" plain @click="resolveCloseDialog('tray')">
            {{ t('settings.closeActionOptions.tray') }}
          </el-button>
          <el-button type="danger" @click="resolveCloseDialog('exit')">
            {{ t('settings.closeActionOptions.exit') }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <!-- Ctrl+K 快速搜索覆盖层 -->
    <ProjectQuickSearch
      v-if="showQuickSearch"
      @close="showQuickSearch = false"
      @select="handleQuickSearchSelect"
      @selectScript="handleQuickSearchSelectScript"
    />
  </div>
</template>
