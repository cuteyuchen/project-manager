import { defineStore } from 'pinia';
import { ref, onMounted } from 'vue';
import { api } from '../api';
import type { AppDefaultNode, NodeInstallProgress, NodeVersion } from '../types';
import { mergeNodeRuntimes, migrateLegacyNodeSource, sortNodeVersions } from '../utils/nodeDefaultState';

const SYSTEM_NODE_PLACEHOLDER = 'System Default';
const APP_DEFAULT_KEY = 'app_default_node';
const CUSTOM_NODES_KEY = 'custom_nodes';
const LEGACY_SYSTEM_PATH_KEY = 'system_node_path';

function normalizeVersionLabel(version: string): string {
  const trimmed = version.trim();
  return trimmed.toLowerCase().startsWith('v') ? `v${trimmed.slice(1)}` : `v${trimmed}`;
}

function readCustomNodes(): NodeVersion[] {
  const stored = localStorage.getItem(CUSTOM_NODES_KEY);
  if (!stored) return [];
  try {
    const custom: NodeVersion[] = JSON.parse(stored);
    return custom
      .filter(node => node && node.path && node.version)
      .map(node => {
        const source = migrateLegacyNodeSource(node.source);
        return {
          version: node.version,
          path: node.path,
          source: source === 'system' ? 'custom' as const : source,
          status: node.status || 'available',
        };
      });
  } catch (error) {
    console.error('Failed to load custom nodes', error);
    return [];
  }
}

function readAppDefault(): AppDefaultNode | null {
  const stored = localStorage.getItem(APP_DEFAULT_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as AppDefaultNode;
      if (parsed?.path && parsed?.version && parsed?.source) return parsed;
    } catch (error) {
      console.error('Failed to load app default node', error);
    }
  }

  const legacyPath = localStorage.getItem(LEGACY_SYSTEM_PATH_KEY);
  if (legacyPath && legacyPath !== SYSTEM_NODE_PLACEHOLDER) {
    return { source: 'system', version: '', path: legacyPath };
  }
  return null;
}

export const useNodeStore = defineStore('node', () => {
  const versions = ref<NodeVersion[]>([]);
  const loading = ref(false);
  const managedSupported = ref(true);
  const appDefault = ref<AppDefaultNode | null>(null);
  const installProgress = ref<Record<string, NodeInstallProgress>>({});
  let progressUnlisten: (() => void) | null = null;

  function persistCustomNodes() {
    const custom = versions.value.filter(v => v.source === 'custom');
    localStorage.setItem(CUSTOM_NODES_KEY, JSON.stringify(custom));
  }

  function persistAppDefault() {
    if (!appDefault.value) {
      localStorage.removeItem(APP_DEFAULT_KEY);
      return;
    }
    localStorage.setItem(APP_DEFAULT_KEY, JSON.stringify(appDefault.value));
  }

  function markDefault(list: NodeVersion[]): NodeVersion[] {
    const current = appDefault.value;
    return list.map(node => ({
      ...node,
      isDefault: !!current && node.source === current.source && (
        node.path === current.path || (!!current.version && node.version === current.version)
      ),
    }));
  }

  function applyMerged(parts: {
    system?: NodeVersion | null;
    managed?: NodeVersion[];
    custom?: NodeVersion[];
  }) {
    versions.value = markDefault(mergeNodeRuntimes({
      system: parts.system ?? (versions.value.find(v => v.source === 'system') || null),
      managed: parts.managed ?? versions.value.filter(v => v.source === 'managed'),
      custom: parts.custom ?? versions.value.filter(v => v.source === 'custom'),
    }));
  }

  const loadCustomNodes = () => {
    applyMerged({ custom: readCustomNodes() });
  };

  const syncSystemNode = async (options: {
    preferredVersion?: string;
    preferredPath?: string;
  } = {}) => {
    let resolvedPath = options.preferredPath || '';
    if (!resolvedPath) {
      try {
        resolvedPath = await api.getSystemNodePath();
      } catch (error) {
        console.error('Failed to detect system node path', error);
      }
    }
    if (!resolvedPath) resolvedPath = SYSTEM_NODE_PLACEHOLDER;

    let resolvedVersion = options.preferredVersion || 'System';
    let status: NodeVersion['status'] = resolvedPath === SYSTEM_NODE_PLACEHOLDER ? 'broken' : 'available';
    if (resolvedPath !== SYSTEM_NODE_PLACEHOLDER) {
      try {
        const detectedVersion = await api.getNodeVersion(resolvedPath);
        if (detectedVersion) resolvedVersion = detectedVersion;
        else status = 'broken';
      } catch (error) {
        console.error('Failed to detect system node version', error);
        status = 'broken';
      }
    }

    applyMerged({
      system: {
        version: resolvedVersion,
        path: resolvedPath,
        source: 'system',
        status,
      },
    });
  };

  const refreshManagedRuntimes = async () => {
    try {
      const managed = await api.listInstalledNodeRuntimes();
      applyMerged({
        managed: managed.map(node => ({
          ...node,
          source: 'managed' as const,
          status: node.status || 'available',
        })),
      });
    } catch (error) {
      console.error('Failed to load managed node runtimes', error);
    }
  };

  const loadRuntimes = async () => {
    loading.value = true;
    try {
      try {
        managedSupported.value = await api.managedNodeRuntimeSupported();
      } catch {
        managedSupported.value = true;
      }
      await syncSystemNode();
      loadCustomNodes();
      await refreshManagedRuntimes();
      versions.value = sortNodeVersions(markDefault(versions.value));
    } finally {
      loading.value = false;
    }
  };

  /** @deprecated 使用 loadRuntimes */
  const loadNvmNodes = loadRuntimes;

  const addCustomNode = (node: NodeVersion) => {
    applyMerged({
      custom: [
        ...versions.value.filter(v => v.source === 'custom' && v.path !== node.path),
        { ...node, source: 'custom', status: node.status || 'available' },
      ],
    });
    persistCustomNodes();
  };

  const removeNode = (path: string) => {
    applyMerged({
      custom: versions.value.filter(v => v.source === 'custom' && v.path !== path),
    });
    persistCustomNodes();
    if (appDefault.value?.path === path) {
      appDefault.value = null;
      persistAppDefault();
      versions.value = markDefault(versions.value);
    }
  };

  const setAppDefaultNode = async (node: NodeVersion) => {
    appDefault.value = {
      source: node.source,
      version: node.version,
      path: node.path,
    };
    persistAppDefault();
    localStorage.removeItem(LEGACY_SYSTEM_PATH_KEY);
    versions.value = markDefault(versions.value);
  };

  /** @deprecated 使用 setAppDefaultNode；不再调用 nvm use / 改系统 PATH */
  const setDefaultNode = setAppDefaultNode;

  const updateSystemNode = async (newPath: string, preferredVersion?: string) => {
    await syncSystemNode({ preferredPath: newPath, preferredVersion });
  };

  function applyProgress(progress: NodeInstallProgress) {
    const version = normalizeVersionLabel(progress.version);
    const nextProgress = { ...progress, version };
    installProgress.value = { ...installProgress.value, [version]: nextProgress };
    if (progress.phase === 'complete') {
      const next = { ...installProgress.value };
      delete next[version];
      installProgress.value = next;
    }
  }

  async function ensureProgressListener() {
    if (progressUnlisten || !api.onNodeRuntimeProgress) return;
    progressUnlisten = await api.onNodeRuntimeProgress(applyProgress);
  }

  const installManagedNode = async (version: string, operationId?: string) => {
    await ensureProgressListener();
    const normalized = normalizeVersionLabel(version);
    applyProgress({
      operationId: operationId || `install-${normalized}`,
      version: normalized,
      phase: 'resolving',
      percent: 0,
    });
    try {
      loading.value = true;
      await api.installManagedNode(version, operationId);
      await refreshManagedRuntimes();
      const exists = versions.value.some(v =>
        v.source === 'managed' && normalizeVersionLabel(v.version) === normalized && v.status !== 'broken',
      );
      if (!exists) {
        throw new Error('Node version not found after installation.');
      }
      return true;
    } finally {
      const next = { ...installProgress.value };
      delete next[normalized];
      installProgress.value = next;
      loading.value = false;
    }
  };

  /** @deprecated 使用 installManagedNode */
  const installNode = installManagedNode;

  const cancelManagedNodeInstall = async (operationId: string) => {
    await api.cancelManagedNodeInstall(operationId);
  };

  const uninstallManagedNode = async (version: string) => {
    loading.value = true;
    try {
      await api.uninstallManagedNode(version);
      await refreshManagedRuntimes();
      const normalized = normalizeVersionLabel(version);
      const exists = versions.value.some(v =>
        v.source === 'managed' && normalizeVersionLabel(v.version) === normalized,
      );
      if (exists) {
        throw new Error('Node version still exists after uninstallation.');
      }
      if (appDefault.value?.source === 'managed' && normalizeVersionLabel(appDefault.value.version) === normalized) {
        appDefault.value = null;
        persistAppDefault();
        versions.value = markDefault(versions.value);
      }
      return true;
    } finally {
      loading.value = false;
    }
  };

  /** @deprecated 使用 uninstallManagedNode */
  const uninstallNode = uninstallManagedNode;

  onMounted(async () => {
    appDefault.value = readAppDefault();
    await loadRuntimes();
    if (appDefault.value && !appDefault.value.version) {
      const matched = versions.value.find(v => v.path === appDefault.value?.path);
      if (matched) {
        appDefault.value = { source: matched.source, version: matched.version, path: matched.path };
        persistAppDefault();
        versions.value = markDefault(versions.value);
      }
    }
    await ensureProgressListener();
  });

  return {
    versions,
    loading,
    managedSupported,
    appDefault,
    installProgress,
    loadRuntimes,
    loadNvmNodes,
    refreshManagedRuntimes,
    loadCustomNodes,
    addCustomNode,
    removeNode,
    updateSystemNode,
    syncSystemNode,
    setAppDefaultNode,
    setDefaultNode,
    installManagedNode,
    installNode,
    cancelManagedNodeInstall,
    uninstallManagedNode,
    uninstallNode,
  };
});
