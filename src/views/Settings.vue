<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toRaw } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useProjectStore } from '../stores/project';
import { useNodeStore } from '../stores/node';
import { api } from '../api';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import type { AiServiceConfig, EditorConfig, NodeVersion, Project, Settings } from '../types';
import { isAiServiceConfigured, normalizeAiApiType, requestAiText } from '../utils/ai';
import { mergeDetectedEditors } from '../utils/editorDetection';
import { isAbortError } from '../utils/network';
import { ensureNodeInstallCommand } from '../utils/projectCommands';
import { createTerminalConfig, getTerminalDuplicateKey, normalizeTerminalConfigs } from '../utils/terminalConfig';

type ImportChoice = 'keep' | 'incoming';
type ImportDiff = { key: string; label: string; current: string; incoming: string };
type ProjectConflict = { existingIndex: number; existing: Project; incoming: Project; choice: ImportChoice; diffs: ImportDiff[] };
type NodeConflict = { existingIndex: number; existing: NodeVersion; incoming: NodeVersion; choice: ImportChoice; diffs: ImportDiff[] };
type SettingsConflict = { key: keyof Settings; label: string; current: string; incoming: string; choice: ImportChoice; incomingValue: unknown };
type ImportPlan = {
  projectAdds: Project[];
  projectConflicts: ProjectConflict[];
  nodeAdds: NodeVersion[];
  nodeConflicts: NodeConflict[];
  settingsConflicts: SettingsConflict[];
};

function createDefaultAiService(overrides: Partial<AiServiceConfig> = {}): AiServiceConfig {
  return {
    apiType: 'chat_completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

function normalizeAiServiceConfig(value: unknown, fallback: AiServiceConfig): AiServiceConfig {
  if (!value || typeof value !== 'object') {
    return createDefaultAiService(fallback);
  }

  const service = value as Partial<AiServiceConfig>;
  return createDefaultAiService({
    apiType: normalizeAiApiType(service.apiType || fallback.apiType),
    baseUrl: typeof service.baseUrl === 'string' ? service.baseUrl : fallback.baseUrl,
    apiKey: typeof service.apiKey === 'string' ? service.apiKey : fallback.apiKey,
    model: typeof service.model === 'string' ? service.model : fallback.model,
  });
}

function normalizeAiSettings(settings: Settings): Settings {
  return {
    ...settings,
    gitAiPrimaryService: normalizeAiServiceConfig(settings.gitAiPrimaryService, createDefaultAiService({
      baseUrl: settings.gitAiBaseUrl || 'https://api.openai.com/v1',
      apiKey: settings.gitAiApiKey || '',
      model: settings.gitAiModel || 'gpt-4o-mini',
    })),
    gitAiStream: typeof settings.gitAiStream === 'boolean' ? settings.gitAiStream : true,
  };
}

const { t } = useI18n();
const settingsStore = useSettingsStore();
const projectStore = useProjectStore();
const nodeStore = useNodeStore();
const appVersion = ref('');
const target = import.meta.env.VITE_TARGET;
const isPlugin = target === 'utools' || target === 'ztools';
const contextMenuEnabled = ref(false);
const contextMenuSupported = ref(false);
const autoLaunchEnabled = ref(false);
const aiTestLoading = ref(false);
const aiTestResult = ref<{ success: boolean; message: string } | null>(null);
const updateCheckLoading = ref(false);
const importDialogVisible = ref(false);
const importPlan = ref<ImportPlan | null>(null);
const importSourceName = ref('');
const editorScanLoading = shallowRef(false);
const editorDialogVisible = shallowRef(false);
const editingEditorIndex = shallowRef<number | null>(null);
const editorEditForm = ref<EditorConfig>({ id: '', name: '', path: '' });

const deepClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const draft = ref<Settings>(normalizeDefaultTerminalId(normalizeAiSettings(deepClone(toRaw(settingsStore.settings)))));
const isDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(settingsStore.settings));

const importSummary = computed(() => {
  const plan = importPlan.value;
  return {
    addedProjects: plan?.projectAdds.length || 0,
    conflictedProjects: plan?.projectConflicts.length || 0,
    addedNodes: plan?.nodeAdds.length || 0,
    conflictedNodes: plan?.nodeConflicts.length || 0,
    conflictedSettings: plan?.settingsConflicts.length || 0,
  };
});

function resetDraft() {
  draft.value = normalizeDefaultTerminalId(normalizeAiSettings(deepClone(toRaw(settingsStore.settings))));
}

function handleSave() {
  Object.assign(settingsStore.settings, normalizeDefaultTerminalId(normalizeAiSettings(deepClone(toRaw(draft.value)))));
  ElMessage.success(t('common.success'));
}

function handleCancel() {
  resetDraft();
}

onMounted(async () => {
  appVersion.value = await api.getAppVersion();
  if (settingsStore.availableTerminals.length === 0) {
    settingsStore.fetchAvailableTerminals();
  }
  if (!isPlugin) {
    contextMenuSupported.value = await api.isContextMenuSupported();
    if (contextMenuSupported.value) contextMenuEnabled.value = await api.checkContextMenu();
    await refreshAutoLaunchState();
  }
  window.addEventListener('manual-check-update-result', handleManualUpdateResult as EventListener);
});

onBeforeUnmount(() => {
  window.removeEventListener('manual-check-update-result', handleManualUpdateResult as EventListener);
});

async function toggleContextMenu(val: boolean) {
  try {
    await api.setContextMenu(val, draft.value.locale);
    ElMessage.success(t('common.success'));
  } catch (error) {
    ElMessage.error(`${t('common.error')}: ${error}`);
    contextMenuEnabled.value = !val;
  }
}

async function toggleAutoLaunch(val: boolean) {
  try {
    const autostart = await import('@tauri-apps/plugin-autostart');
    if (val) await autostart.enable();
    else await autostart.disable();
    autoLaunchEnabled.value = val;
    settingsStore.settings.autoLaunch = val;
    ElMessage.success(t('common.success'));
  } catch (error) {
    ElMessage.error(`${t('common.error')}: ${error}`);
    autoLaunchEnabled.value = !val;
  }
}

async function refreshAutoLaunchState() {
  try {
    const autostart = await import('@tauri-apps/plugin-autostart');
    autoLaunchEnabled.value = await autostart.isEnabled();
  } catch (error) {
    console.error('Failed to read auto-launch state:', error);
    autoLaunchEnabled.value = false;
  }
}

async function selectExecutable() {
  try {
    const selected = await api.openDialog({
      multiple: false,
      filters: [{ name: 'Executable', extensions: ['exe', 'cmd', 'bat', 'sh', ''] }],
    });
    return typeof selected === 'string' ? selected : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function addEditor() {
  if (!draft.value.editors) draft.value.editors = [];
  draft.value.editors.push({ id: crypto.randomUUID(), name: '', path: '' });
  if (!draft.value.defaultEditorId) {
    draft.value.defaultEditorId = draft.value.editors[0].id;
  }
  openEditorDialog(draft.value.editors.length - 1);
}

function removeEditor(index: number) {
  if (!draft.value.editors || draft.value.editors.length <= 1) return;
  const removedId = draft.value.editors[index].id;
  draft.value.editors.splice(index, 1);
  if (draft.value.defaultEditorId === removedId && draft.value.editors.length > 0) {
    draft.value.defaultEditorId = draft.value.editors[0].id;
  }
}

/***********************编辑器扫描与维护*********************/
async function scanAvailableEditors() {
  editorScanLoading.value = true;
  try {
    const currentEditors = draft.value.editors || [];
    const detectedEditors = await api.detectAvailableEditors();
    const mergedEditors = mergeDetectedEditors(currentEditors, detectedEditors);
    const addedCount = mergedEditors.length - currentEditors.length;
    draft.value.editors = mergedEditors;
    normalizeDefaultEditorId(draft.value);
    ElMessage.success(t('settings.editorScanDone', { count: addedCount }));
  } catch (error) {
    console.error(error);
    ElMessage.error(t('settings.editorScanFailed'));
  } finally {
    editorScanLoading.value = false;
  }
}

function openEditorDialog(index: number) {
  const editor = draft.value.editors?.[index];
  if (!editor) return;
  editingEditorIndex.value = index;
  editorEditForm.value = { ...editor };
  editorDialogVisible.value = true;
}

async function browseEditorDialogPath() {
  const selected = await selectExecutable();
  if (!selected) return;
  editorEditForm.value.path = selected;
  if (!editorEditForm.value.name) {
    editorEditForm.value.name = selected.split(/[/\\]/).pop()?.replace(/\.\w+$/, '') || '';
  }
}

function saveEditorDialog() {
  const index = editingEditorIndex.value;
  if (index === null || !draft.value.editors?.[index]) return;
  draft.value.editors[index] = {
    ...editorEditForm.value,
    name: editorEditForm.value.name.trim() || 'Editor',
    path: editorEditForm.value.path.trim(),
  };
  editorDialogVisible.value = false;
}

function removeEditingEditor() {
  const index = editingEditorIndex.value;
  if (index === null) return;
  removeEditor(index);
  editorDialogVisible.value = false;
}

function getEditorInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'E';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

async function openFileWithEditor(editor: EditorConfig) {
  const selected = await api.openDialog({ multiple: false });
  if (!selected || typeof selected !== 'string') return;
  await api.openInEditor(selected, editor.path);
}

async function openDirectoryWithEditor(editor: EditorConfig) {
  const selected = await api.openDialog({ directory: true, multiple: false });
  if (!selected || typeof selected !== 'string') return;
  await api.openInEditor(selected, editor.path);
}

/***********************自定义终端配置*********************/

function isDuplicateCustomTerminalPath(path: string, currentId?: string) {
  const duplicateKey = getTerminalDuplicateKey(path);
  return (draft.value.customTerminals || []).some(item =>
    item.id !== currentId && getTerminalDuplicateKey(item.path) === duplicateKey,
  );
}

async function addCustomTerminal() {
  const selected = await selectExecutable();
  if (!selected) return;
  if (!draft.value.customTerminals) draft.value.customTerminals = [];
  if (isDuplicateCustomTerminalPath(selected)) {
    ElMessage.warning(t('settings.terminalAlreadyExists'));
    return;
  }
  draft.value.customTerminals.push(createTerminalConfig(selected));
}

async function browseCustomTerminalPath(index: number) {
  const selected = await selectExecutable();
  const terminal = draft.value.customTerminals?.[index];
  if (!selected || !terminal) return;
  if (isDuplicateCustomTerminalPath(selected, terminal.id)) {
    ElMessage.warning(t('settings.terminalAlreadyExists'));
    return;
  }

  terminal.path = selected;
  if (!terminal.name) {
    terminal.name = selected.split(/[/\\]/).pop()?.replace(/\.\w+$/, '') || '';
  }
}

function removeCustomTerminal(id: string) {
  if (!draft.value.customTerminals) return;
  draft.value.customTerminals = draft.value.customTerminals.filter(item => item.id !== id);
  if (draft.value.defaultTerminal === id) {
    draft.value.defaultTerminal = settingsStore.availableTerminals[0]?.id || draft.value.customTerminals[0]?.id || 'cmd';
  }
}

function createExportPayload() {
  return {
    projects: deepClone(toRaw(projectStore.projects)),
    settings: deepClone(toRaw(settingsStore.settings)),
    customNodes: deepClone(toRaw(nodeStore.versions.filter(item => item.source === 'custom'))),
  };
}

async function exportData() {
  try {
    const selected = await api.saveDialog({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      defaultPath: 'frontend-manager-backup.json',
    });
    if (!selected) return;
    await api.writeTextFile(selected, JSON.stringify(createExportPayload(), null, 2));
    ElMessage.success(t('settings.exportSuccess'));
  } catch (error) {
    console.error(error);
    ElMessage.error(`${t('settings.exportError')}: ${error}`);
  }
}

function normalizeProject(project: any): Project | null {
  if (!project || !project.path) return null;
  return ensureNodeInstallCommand({
    id: typeof project.id === 'string' && project.id ? project.id : crypto.randomUUID(),
    name: project.name || project.path.split(/[\\/]/).pop() || 'Untitled',
    path: project.path,
    type: project.type === 'other' ? 'other' : 'node',
    gitRemoteUrl: typeof project.gitRemoteUrl === 'string' && project.gitRemoteUrl ? project.gitRemoteUrl : undefined,
    gitBranch: typeof project.gitBranch === 'string' && project.gitBranch ? project.gitBranch : undefined,
    gitConfigured: typeof project.gitConfigured === 'boolean' ? project.gitConfigured : undefined,
    nodeVersion: project.nodeVersion || undefined,
    packageManager: project.packageManager || 'npm',
    scripts: Array.isArray(project.scripts) ? project.scripts : [],
    visibleScripts: Array.isArray(project.visibleScripts) ? project.visibleScripts : undefined,
    customCommands: Array.isArray(project.customCommands) ? project.customCommands : [],
    projectFiles: Array.isArray(project.projectFiles) ? project.projectFiles : [],
    memo: typeof project.memo === 'string' ? project.memo : '',
    pinned: project.pinned ?? false,
    pinOrder: project.pinOrder ?? undefined,
    editorId: project.editorId || undefined,
  }, t('project.installDependencies'));
}

function normalizeSettingsPayload(settings: any): Settings {
  const hasCustomTerminals = Boolean(settings) && Object.prototype.hasOwnProperty.call(settings, 'customTerminals');
  return normalizeDefaultTerminalId(normalizeAiSettings({
    ...deepClone(toRaw(settingsStore.settings)),
    ...settings,
    customTerminals: hasCustomTerminals
      ? normalizeTerminalConfigs(settings?.customTerminals)
      : deepClone(toRaw(settingsStore.settings.customTerminals || [])),
  }));
}

function normalizeCustomNode(node: any): NodeVersion | null {
  if (!node || !node.path) return null;
  return { version: String(node.version || ''), path: String(node.path), source: 'custom' };
}

type ImportValueOptions = {
  currentEditors?: Settings['editors'];
  incomingEditors?: Settings['editors'];
};

function resolveEditorReference(editorId: unknown, editors?: Settings['editors']) {
  if (!editorId || typeof editorId !== 'string' || !editors?.length) return null;
  const editor = editors.find(item => item.id === editorId);
  if (!editor) return null;
  return {
    name: editor.name || editor.path || 'Editor',
    path: editor.path || '',
  };
}

function normalizeImportValue(
  key: string,
  value: unknown,
  side: 'current' | 'incoming',
  options: ImportValueOptions = {},
): unknown {
  if (key === 'defaultEditorId' || key === 'editorId') {
    const editors = side === 'current' ? options.currentEditors : options.incomingEditors;
    return normalizeImportValue('editorRef', resolveEditorReference(value, editors), side, options);
  }

  if (value === undefined || value === null || value === '') return null;

  if (Array.isArray(value)) {
    const normalizedItems = value
      .map(item => normalizeImportValue(key, item, side, options))
      .filter(item => item !== null);

    if (normalizedItems.length === 0) return null;

    return normalizedItems.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  if (typeof value === 'object') {
    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([entryKey]) => entryKey !== 'id')
      .map(([entryKey, entryValue]) => {
        const normalizedEntryValue = entryKey.toLowerCase().includes('apikey') && entryValue
          ? '******'
          : normalizeImportValue(entryKey, entryValue, side, options);
        return [entryKey, normalizedEntryValue] as const;
      })
      .filter(([, entryValue]) => entryValue !== null)
      .sort(([a], [b]) => a.localeCompare(b));

    if (normalizedEntries.length === 0) return null;
    return Object.fromEntries(normalizedEntries);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  return value;
}

function formatImportValue(
  key: string,
  value: unknown,
  side: 'current' | 'incoming',
  options: ImportValueOptions = {},
) {
  const normalizedValue = normalizeImportValue(key, value, side, options);
  if (key.toLowerCase().includes('apikey') && typeof normalizedValue === 'string' && normalizedValue) return '******';
  if (normalizedValue === null) return '-';
  if (typeof normalizedValue === 'string') return normalizedValue;
  if (typeof normalizedValue === 'number' || typeof normalizedValue === 'boolean') return String(normalizedValue);
  return JSON.stringify(normalizedValue, null, 2);
}

function buildDiffs<T extends Record<string, any>>(
  current: T,
  incoming: T,
  fields: Array<{ key: keyof T | string; label: string }>,
  options: ImportValueOptions = {},
) {
  return fields
    .filter(field => {
      const key = String(field.key);
      return JSON.stringify(normalizeImportValue(key, current[key], 'current', options))
        !== JSON.stringify(normalizeImportValue(key, incoming[key], 'incoming', options));
    })
    .map(field => ({
      key: String(field.key),
      label: field.label,
      current: formatImportValue(String(field.key), current[String(field.key)], 'current', options),
      incoming: formatImportValue(String(field.key), incoming[String(field.key)], 'incoming', options),
    }));
}

function sortNodes(nodes: NodeVersion[]) {
  return [...nodes].sort((a, b) => {
    if (a.source === 'system') return -1;
    if (b.source === 'system') return 1;
    const parse = (version: string) => version.replace(/^v/, '').split('.').map(Number);
    const aParts = parse(a.version);
    const bParts = parse(b.version);
    for (let index = 0; index < 3; index += 1) {
      if (aParts[index] !== bParts[index]) return (bParts[index] || 0) - (aParts[index] || 0);
    }
    return a.path.localeCompare(b.path);
  });
}

function normalizeDefaultEditorId(settings: Settings): Settings {
  const editors = settings.editors || [];
  if (!editors.length) {
    settings.defaultEditorId = undefined;
    return settings;
  }

  if (!settings.defaultEditorId || !editors.some(editor => editor.id === settings.defaultEditorId)) {
    settings.defaultEditorId = editors[0].id;
  }

  return settings;
}

function normalizeDefaultTerminalId(settings: Settings): Settings {
  const customTerminals = settings.customTerminals || [];
  const customTerminalIds = new Set(customTerminals.map(item => item.id));
  const defaultTerminal = settings.defaultTerminal?.trim();

  if (!defaultTerminal) {
    settings.defaultTerminal = settingsStore.allTerminals[0]?.id || 'cmd';
    return settings;
  }

  if (customTerminalIds.has(defaultTerminal)) {
    return settings;
  }

  settings.defaultTerminal = defaultTerminal;
  return settings;
}

function buildImportPlan(payload: any): ImportPlan {
  const projectFields = [
    { key: 'name', label: t('project.name') },
    { key: 'type', label: t('project.type') },
    { key: 'gitRemoteUrl', label: t('project.gitRepoUrl') },
    { key: 'gitBranch', label: t('project.gitBranch') },
    { key: 'gitConfigured', label: t('project.gitConfigured') },
    { key: 'nodeVersion', label: t('project.nodeVersion') },
    { key: 'packageManager', label: t('project.packageManager') },
    { key: 'scripts', label: t('project.scripts') },
    { key: 'visibleScripts', label: t('project.scripts') },
    { key: 'customCommands', label: t('project.customCommands') },
    { key: 'projectFiles', label: t('dashboard.files') },
    { key: 'memo', label: t('dashboard.memo') },
    { key: 'editorId', label: t('project.editor') },
  ];
  const settingsFields: Array<{ key: keyof Settings; label: string }> = [
    { key: 'editors', label: t('settings.editors') },
    { key: 'defaultEditorId', label: t('settings.defaultEditor') },
    { key: 'defaultTerminal', label: t('settings.defaultTerminal') },
    { key: 'customTerminals', label: t('settings.customTerminals') },
    { key: 'locale', label: t('settings.language') },
    { key: 'themeMode', label: t('settings.theme') },
    { key: 'autoUpdate', label: t('settings.autoUpdate') },
    { key: 'trayEnabled', label: t('settings.trayEnabled') },
    { key: 'closeAction', label: t('settings.closeAction') },
    { key: 'gitAiEnabled', label: t('settings.gitAiEnabled') },
    { key: 'gitAiPrimaryService', label: t('settings.gitAiPrimaryService') },
    { key: 'gitAiStream', label: t('settings.gitAiStream') },
    { key: 'gitAiPromptTemplate', label: t('settings.gitAiPromptTemplate') },
  ];
  const normalizedProjects = Array.isArray(payload.projects) ? payload.projects.map(normalizeProject).filter(Boolean) as Project[] : [];
  const normalizedNodes = Array.isArray(payload.customNodes) ? payload.customNodes.map(normalizeCustomNode).filter(Boolean) as NodeVersion[] : [];
  const normalizedSettings = payload.settings ? normalizeSettingsPayload(payload.settings) : null;
  const currentEditors = settingsStore.settings.editors || [];
  const incomingEditors = normalizedSettings?.editors || [];
  const plan: ImportPlan = { projectAdds: [], projectConflicts: [], nodeAdds: [], nodeConflicts: [], settingsConflicts: [] };

  normalizedProjects.forEach((incomingProject) => {
    const existingIndex = projectStore.projects.findIndex(project => project.path === incomingProject.path);
    if (existingIndex === -1) return void plan.projectAdds.push(incomingProject);
    const existingProject = projectStore.projects[existingIndex];
    const diffs = buildDiffs(existingProject as Record<string, any>, incomingProject as Record<string, any>, projectFields, {
      currentEditors,
      incomingEditors,
    });
    if (diffs.length) plan.projectConflicts.push({ existingIndex, existing: existingProject, incoming: incomingProject, choice: 'incoming', diffs });
  });

  if (normalizedSettings) {
    settingsFields.forEach((field) => {
      const currentValue = (settingsStore.settings as any)[field.key];
      const incomingValue = (normalizedSettings as any)[field.key];
      if (
        JSON.stringify(normalizeImportValue(String(field.key), currentValue, 'current', { currentEditors, incomingEditors })) ===
        JSON.stringify(normalizeImportValue(String(field.key), incomingValue, 'incoming', { currentEditors, incomingEditors }))
      ) return;
      plan.settingsConflicts.push({
        key: field.key,
        label: field.label,
        current: formatImportValue(String(field.key), currentValue, 'current', { currentEditors, incomingEditors }),
        incoming: formatImportValue(String(field.key), incomingValue, 'incoming', { currentEditors, incomingEditors }),
        choice: 'incoming',
        incomingValue,
      });
    });
  }

  const currentCustomNodes = nodeStore.versions.filter(item => item.source === 'custom');
  normalizedNodes.forEach((incomingNode) => {
    const existingIndex = currentCustomNodes.findIndex(item => item.path === incomingNode.path);
    if (existingIndex === -1) return void plan.nodeAdds.push(incomingNode);
    const existingNode = currentCustomNodes[existingIndex];
    const diffs = buildDiffs(existingNode as Record<string, any>, incomingNode as Record<string, any>, [
      { key: 'version', label: t('nodes.version') },
      { key: 'source', label: t('nodes.source') },
    ]);
    if (diffs.length) plan.nodeConflicts.push({ existingIndex, existing: existingNode, incoming: incomingNode, choice: 'incoming', diffs });
  });

  return plan;
}

async function importData() {
  try {
    const selected = await api.openDialog({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!selected || typeof selected !== 'string') return;
    const content = await api.readTextFile(selected);
    const plan = buildImportPlan(JSON.parse(content));
    const hasChanges = plan.projectAdds.length + plan.projectConflicts.length + plan.nodeAdds.length + plan.nodeConflicts.length + plan.settingsConflicts.length > 0;
    if (!hasChanges) return void ElMessage.info(t('settings.importNoChanges'));
    importPlan.value = plan;
    importSourceName.value = selected.split(/[/\\]/).pop() || selected;
    importDialogVisible.value = true;
  } catch (error) {
    console.error(error);
    ElMessage.error(`${t('settings.importError')}: ${error}`);
  }
}

function applyImportPlan() {
  const plan = importPlan.value;
  if (!plan) return;

  const nextProjects = deepClone(toRaw(projectStore.projects));
  plan.projectAdds.forEach(project => {
    if (!nextProjects.some(item => item.path === project.path)) nextProjects.push(project);
  });
  plan.projectConflicts.forEach((conflict) => {
    if (conflict.choice !== 'incoming') return;
    nextProjects[conflict.existingIndex] = { ...deepClone(conflict.incoming), id: nextProjects[conflict.existingIndex].id };
  });
  projectStore.projects = nextProjects;

  const nextSettings = deepClone(toRaw(settingsStore.settings));
  plan.settingsConflicts.forEach((conflict) => {
    if (conflict.choice === 'incoming') (nextSettings as any)[conflict.key] = deepClone(conflict.incomingValue);
  });
  settingsStore.settings = normalizeDefaultEditorId(normalizeAiSettings(nextSettings));

  const systemNodes = nodeStore.versions.filter(item => item.source !== 'custom');
  const customNodes = deepClone(toRaw(nodeStore.versions.filter(item => item.source === 'custom')));
  plan.nodeAdds.forEach(node => {
    if (!customNodes.some(item => item.path === node.path)) customNodes.push(node);
  });
  plan.nodeConflicts.forEach((conflict) => {
    if (conflict.choice === 'incoming') customNodes[conflict.existingIndex] = deepClone(conflict.incoming);
  });
  nodeStore.versions = sortNodes([...systemNodes, ...customNodes]);

  resetDraft();
  importDialogVisible.value = false;
  importPlan.value = null;
  importSourceName.value = '';
  ElMessage.success(t('settings.importApplied'));
}

function cancelImportPreview() {
  importDialogVisible.value = false;
  importPlan.value = null;
  importSourceName.value = '';
}

function applyAllKeep() {
  const plan = importPlan.value;
  if (!plan) return;
  plan.projectConflicts.forEach(c => c.choice = 'keep');
  plan.nodeConflicts.forEach(c => c.choice = 'keep');
  plan.settingsConflicts.forEach(c => c.choice = 'keep');
}

function applyAllIncoming() {
  const plan = importPlan.value;
  if (!plan) return;
  plan.projectConflicts.forEach(c => c.choice = 'incoming');
  plan.nodeConflicts.forEach(c => c.choice = 'incoming');
  plan.settingsConflicts.forEach(c => c.choice = 'incoming');
}

function openReleases() {
  api.openUrl('https://github.com/cuteyuchen/project-manager/releases');
}

function triggerManualUpdateCheck() {
  updateCheckLoading.value = true;
  window.dispatchEvent(new CustomEvent('manual-check-update'));
}

function handleManualUpdateResult(event: Event) {
  const customEvent = event as CustomEvent<{ status: 'available' | 'latest' | 'error'; version?: string; error?: string }>;
  updateCheckLoading.value = false;
  if (customEvent.detail.status === 'latest') return void ElMessage.success(t('settings.alreadyLatest'));
  if (customEvent.detail.status === 'available') return void ElMessage.info(t('settings.updateAvailable', { version: customEvent.detail.version || '' }));
  ElMessage.error(t('settings.updateCheckFailed', { error: customEvent.detail.error || t('common.error') }));
}

async function testAiConnection() {
  const service = draft.value.gitAiPrimaryService;
  if (!isAiServiceConfigured(service)) {
    aiTestResult.value = { success: false, message: t('settings.gitAiTestMissingConfig') };
    return;
  }

  aiTestLoading.value = true;
  aiTestResult.value = null;
  try {
    await requestAiText({
      apiType: service.apiType,
      baseUrl: service.baseUrl,
      apiKey: service.apiKey,
      model: service.model,
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      maxTokens: normalizeAiApiType(service.apiType) === 'responses' ? 64 : 32,
      temperature: 0,
      stream: draft.value.gitAiStream,
      timeoutMs: 15000,
    });
    aiTestResult.value = { success: true, message: t('settings.gitAiTestSuccess') };
  } catch (error: any) {
    if (isAbortError(error)) aiTestResult.value = { success: false, message: t('settings.gitAiTestTimeout') };
    else if (String(error?.message || '').includes('(401 ') || String(error?.message || '').includes('(403 ')) aiTestResult.value = { success: false, message: t('settings.gitAiTestAuthError') };
    else if (String(error?.message || '').includes('(404 ')) aiTestResult.value = { success: false, message: t('settings.gitAiTestModelNotFound') };
    else if (String(error?.message || '').includes('(429 ')) aiTestResult.value = { success: false, message: t('settings.gitAiTestRateLimit') };
    else if (error.message?.includes('fetch') || error.message?.includes('network') || error.message?.includes('Failed')) aiTestResult.value = { success: false, message: t('settings.gitAiTestUnreachable') };
    else aiTestResult.value = { success: false, message: t('settings.gitAiTestError', { error: String(error).slice(0, 200) }) };
  } finally {
    aiTestLoading.value = false;
  }
}
</script>

<template>
  <div class="settings-page h-full overflow-y-auto">
    <div class="settings-container">
      <header class="settings-header">
        <div class="flex items-center gap-3">
          <h1 class="settings-title">{{ t('settings.title') }}</h1>
          <span v-if="isDirty" class="settings-dirty">{{ t('settings.unsavedChanges') }}</span>
        </div>
        <div class="settings-actions">
          <el-button :disabled="!isDirty" @click="handleCancel">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" :disabled="!isDirty" @click="handleSave">
            <div class="i-mdi-content-save text-sm mr-1" />
            {{ t('common.save') }}
          </el-button>
        </div>
      </header>

      <section class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-white-balance-sunny settings-section-icon" />
          {{ t('settings.appearance') }}
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.theme') }}</div>
            <div class="settings-row-desc">{{ t('settings.themeHint') }}</div>
          </div>
          <el-segmented
            v-model="draft.themeMode"
            :options="[
              { label: t('settings.themeMode.light'), value: 'light' },
              { label: t('settings.themeMode.dark'), value: 'dark' },
              { label: t('settings.themeMode.system'), value: 'auto' },
            ]"
          />
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.language') }}</div>
            <div class="settings-row-desc">{{ t('settings.languageHint') }}</div>
          </div>
          <el-select v-model="draft.locale" class="settings-control">
            <el-option label="中文" value="zh" />
            <el-option label="English" value="en" />
          </el-select>
        </div>
      </section>

      <section v-if="!isPlugin" class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-dock-window settings-section-icon" />
          {{ t('settings.windowBehavior') }}
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.closeAction') }}</div>
            <div class="settings-row-desc">{{ t('settings.closeActionHint') }}</div>
          </div>
          <el-segmented
            v-model="draft.closeAction"
            :disabled="!draft.trayEnabled"
            :options="[
              { label: t('settings.closeActionOptions.ask'), value: 'ask' },
              { label: t('settings.closeActionOptions.tray'), value: 'tray' },
              { label: t('settings.closeActionOptions.exit'), value: 'exit' },
            ]"
          />
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.trayEnabled') }}</div>
            <div class="settings-row-desc">{{ t('settings.trayEnabledHint') }}</div>
          </div>
          <el-switch v-model="draft.trayEnabled" />
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.autoLaunch') }}</div>
            <div class="settings-row-desc">{{ t('settings.autoLaunchHint') }}</div>
          </div>
          <el-switch v-model="autoLaunchEnabled" @change="toggleAutoLaunch" />
        </div>
        <div v-if="contextMenuSupported" class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.contextMenu') }}</div>
            <div class="settings-row-desc">{{ t('settings.contextMenuHint') }}</div>
          </div>
          <el-switch v-model="contextMenuEnabled" @change="toggleContextMenu" />
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-keyboard-outline settings-section-icon" />
          {{ t('settings.shortcuts') }}
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.quickSearchShortcut') }}</div>
            <div class="settings-row-desc">{{ t('settings.quickSearchShortcutHint') }}</div>
          </div>
          <kbd class="settings-shortcut">Ctrl+K</kbd>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-monitor settings-section-icon" />
          {{ t('settings.editorManagement') }}
        </div>
        <div class="settings-section-head">
          <div class="settings-row-desc">{{ t('settings.editorManagementHint') }}</div>
          <el-button :loading="editorScanLoading" @click="scanAvailableEditors">
            <div v-if="!editorScanLoading" class="i-mdi-refresh text-sm mr-1" />
            {{ t('settings.rescanEditors') }}
          </el-button>
        </div>
        <div class="editor-list">
          <div v-for="(editor, index) in (draft.editors || [])" :key="editor.id" class="editor-card">
            <div class="editor-avatar">{{ getEditorInitials(editor.name || editor.path) }}</div>
            <div class="editor-main">
              <div class="editor-name">{{ editor.name || editor.path }}</div>
              <div class="editor-path">{{ editor.path }}</div>
            </div>
            <div class="editor-actions">
              <el-tag type="success" effect="light" round>{{ t('settings.editorInstalled') }}</el-tag>
              <el-button v-if="draft.defaultEditorId !== editor.id" @click="draft.defaultEditorId = editor.id">
                {{ t('settings.setAsDefault') }}
              </el-button>
              <el-tag v-else type="primary" effect="light" round>{{ t('settings.defaultEditorCurrent') }}</el-tag>
              <el-button @click="openFileWithEditor(editor)">{{ t('settings.openFile') }}</el-button>
              <el-button @click="openDirectoryWithEditor(editor)">{{ t('settings.openDirectory') }}</el-button>
              <el-button class="editor-icon-button" :title="t('common.edit')" @click="openEditorDialog(index)">
                <div class="i-mdi-pencil-outline text-base" />
              </el-button>
            </div>
          </div>
          <button class="editor-add-button" type="button" @click="addEditor">
            <span>+ {{ t('settings.addEditor') }}</span>
          </button>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-console settings-section-icon" />
          {{ t('settings.terminalManagement') }}
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.defaultTerminal') }}</div>
            <div class="settings-row-desc">{{ t('settings.terminalHint') }}</div>
          </div>
          <div class="settings-inline-control">
            <el-select v-model="draft.defaultTerminal" class="settings-control">
              <el-option-group :label="t('settings.detectedTerminals')">
                <el-option v-for="term in settingsStore.availableTerminals" :key="term.id" :label="term.name" :value="term.id" />
              </el-option-group>
              <el-option-group v-if="draft.customTerminals?.length" :label="t('settings.customTerminals')">
                <el-option v-for="term in draft.customTerminals" :key="term.id" :label="term.name || term.path" :value="term.id" />
              </el-option-group>
            </el-select>
            <el-button @click="addCustomTerminal"><div class="i-mdi-plus text-sm" /></el-button>
          </div>
        </div>
        <div v-if="draft.customTerminals?.length" class="terminal-list">
          <div v-for="(term, index) in draft.customTerminals" :key="term.id" class="terminal-row">
            <el-input v-model="term.name" :placeholder="t('settings.terminalName')" />
            <el-input v-model="term.path" readonly :placeholder="t('settings.terminalPathPlaceholder')">
              <template #append><el-button @click="browseCustomTerminalPath(index)">{{ t('settings.selectFile') }}</el-button></template>
            </el-input>
            <el-button v-if="draft.defaultTerminal !== term.id" @click="draft.defaultTerminal = term.id">
              {{ t('settings.setAsDefault') }}
            </el-button>
            <el-tag v-else type="primary" effect="light" round>{{ t('settings.defaultEditorCurrent') }}</el-tag>
            <el-button type="danger" text @click="removeCustomTerminal(term.id)">
              <el-icon><div class="i-mdi-close" /></el-icon>
            </el-button>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-update settings-section-icon" />
          {{ t('settings.update') }}
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.autoUpdate') }}</div>
            <div class="settings-row-desc">{{ t('settings.autoUpdateHint') }}</div>
          </div>
          <el-switch v-if="!isPlugin" v-model="draft.autoUpdate" />
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.version') }}</div>
            <div class="settings-row-desc">v{{ appVersion }}</div>
          </div>
          <div class="settings-inline-control">
            <el-button v-if="!isPlugin" :loading="updateCheckLoading" @click="triggerManualUpdateCheck">
              {{ updateCheckLoading ? t('settings.checkingUpdate') : t('settings.checkNow') }}
            </el-button>
            <el-button link type="primary" @click="openReleases">{{ t('settings.releases') }}</el-button>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-database-sync-outline settings-section-icon" />
          {{ t('settings.dataBackup') }}
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.export') }}</div>
            <div class="settings-row-desc">{{ t('settings.dataHint') }}</div>
          </div>
          <el-button type="primary" @click="exportData">{{ t('settings.export') }}</el-button>
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.import') }}</div>
            <div class="settings-row-desc">{{ t('settings.importHint') }}</div>
          </div>
          <el-button @click="importData">{{ t('settings.import') }}</el-button>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <div class="i-mdi-auto-fix settings-section-icon" />
          {{ t('settings.gitAi') }}
        </div>
        <div class="settings-row-line">
          <div>
            <div class="settings-row-title">{{ t('settings.gitAiEnabled') }}</div>
            <div class="settings-row-desc">{{ t('settings.gitAiPrimaryService') }}</div>
          </div>
          <el-switch v-model="draft.gitAiEnabled" />
        </div>
        <div v-if="draft.gitAiEnabled" class="ai-settings">
          <el-select v-model="draft.gitAiPrimaryService!.apiType">
            <el-option :label="t('settings.gitAiApiTypeChat')" value="chat_completions" />
            <el-option :label="t('settings.gitAiApiTypeResponses')" value="responses" />
          </el-select>
          <el-input v-model="draft.gitAiPrimaryService!.baseUrl" :placeholder="t('settings.gitAiBaseUrlPlaceholder')" clearable />
          <el-input v-model="draft.gitAiPrimaryService!.model" :placeholder="t('settings.gitAiModelPlaceholder')" clearable />
          <el-input v-model="draft.gitAiPrimaryService!.apiKey" type="password" show-password :placeholder="t('settings.gitAiApiKeyPlaceholder')" />
          <el-input v-model="draft.gitAiPromptTemplate" type="textarea" :rows="4" :placeholder="t('settings.gitAiPromptPlaceholder')" />
          <div class="settings-row-line settings-row-compact">
            <div>
              <div class="settings-row-title">{{ t('settings.gitAiStream') }}</div>
              <div class="settings-row-desc">{{ draft.gitAiStream ? t('settings.gitAiStreamEnabledHint') : t('settings.gitAiStreamDisabledHint') }}</div>
            </div>
            <el-switch v-model="draft.gitAiStream" />
          </div>
          <div class="flex items-center gap-3">
            <el-button :loading="aiTestLoading" type="primary" plain @click="testAiConnection()">{{ t('settings.gitAiTestBtn') }}</el-button>
            <div v-if="aiTestResult" class="text-sm flex items-center gap-1">
              <div v-if="aiTestResult.success" class="i-mdi-check-circle text-green-500" />
              <div v-else class="i-mdi-close-circle text-red-500" />
              <span :class="aiTestResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ aiTestResult.message }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <el-dialog
      v-model="editorDialogVisible"
      :title="t('settings.editEditor')"
      width="520px"
      align-center
      append-to-body
      class="app-centered-dialog"
    >
      <div class="space-y-4">
        <el-form-item :label="t('settings.editorName')">
          <el-input v-model="editorEditForm.name" :placeholder="t('settings.editorName')" />
        </el-form-item>
        <el-form-item :label="t('settings.editorPath')">
          <el-input v-model="editorEditForm.path" readonly :placeholder="t('settings.editorPathPlaceholder')">
            <template #append>
              <el-button @click="browseEditorDialogPath">{{ t('settings.selectFile') }}</el-button>
            </template>
          </el-input>
        </el-form-item>
      </div>
      <template #footer>
        <div class="flex justify-between gap-2">
          <el-button
            type="danger"
            text
            :disabled="(draft.editors?.length || 0) <= 1"
            @click="removeEditingEditor"
          >
            {{ t('common.delete') }}
          </el-button>
          <div class="flex gap-2">
            <el-button @click="editorDialogVisible = false">{{ t('common.cancel') }}</el-button>
            <el-button type="primary" @click="saveEditorDialog">{{ t('common.save') }}</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="importDialogVisible"
      :title="t('settings.importPreviewTitle')"
      width="960px"
      destroy-on-close
      align-center
      class="import-preview-dialog"
    >
      <div v-if="importPlan" class="space-y-5 import-dialog-content">
        <div class="panel">
          <div class="setting-label">{{ t('settings.importSource') }}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">{{ importSourceName }}</div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div class="summary-tile"><div class="summary-label">{{ t('settings.importProjectsAdded') }}</div><div class="summary-value">{{ importSummary.addedProjects }}</div></div>
          <div class="summary-tile"><div class="summary-label">{{ t('settings.importProjectsConflict') }}</div><div class="summary-value">{{ importSummary.conflictedProjects }}</div></div>
          <div class="summary-tile"><div class="summary-label">{{ t('settings.importNodesAdded') }}</div><div class="summary-value">{{ importSummary.addedNodes }}</div></div>
          <div class="summary-tile"><div class="summary-label">{{ t('settings.importNodesConflict') }}</div><div class="summary-value">{{ importSummary.conflictedNodes }}</div></div>
          <div class="summary-tile"><div class="summary-label">{{ t('settings.importSettingsConflict') }}</div><div class="summary-value">{{ importSummary.conflictedSettings }}</div></div>
        </div>
        <div v-if="importSummary.conflictedProjects + importSummary.conflictedNodes + importSummary.conflictedSettings > 0" class="flex items-center gap-2">
          <span class="text-xs text-slate-500 dark:text-slate-400">{{ t('settings.importBatchApply') }}</span>
          <el-button size="small" @click="applyAllKeep">{{ t('settings.importApplyAllCurrent') }}</el-button>
          <el-button size="small" type="primary" @click="applyAllIncoming">{{ t('settings.importApplyAllIncoming') }}</el-button>
        </div>
        <div v-if="importPlan.projectConflicts.length" class="space-y-3">
          <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ t('settings.importProjectConflictTitle') }}</div>
          <div v-for="conflict in importPlan.projectConflicts" :key="conflict.existing.path" class="conflict-card">
            <div class="flex flex-col gap-3 mb-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div class="font-medium text-slate-700 dark:text-slate-200">{{ conflict.existing.name }}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400 font-mono break-all">{{ conflict.existing.path }}</div>
              </div>
              <el-radio-group v-model="conflict.choice" class="w-full md:w-auto">
                <el-radio-button label="keep">{{ t('settings.importKeepCurrent') }}</el-radio-button>
                <el-radio-button label="incoming">{{ t('settings.importUseImported') }}</el-radio-button>
              </el-radio-group>
            </div>
            <div class="space-y-2">
              <div v-for="diff in conflict.diffs" :key="diff.key" class="space-y-2">
                <div class="text-xs font-semibold text-slate-500 dark:text-slate-300">{{ diff.label }}</div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div class="diff-box"><div class="diff-title">{{ t('settings.importCurrent') }}</div><pre class="diff-content">{{ diff.current }}</pre></div>
                  <div class="diff-box"><div class="diff-title">{{ t('settings.importIncoming') }}</div><pre class="diff-content">{{ diff.incoming }}</pre></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div v-if="importPlan.nodeConflicts.length" class="space-y-3">
          <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ t('settings.importNodeConflictTitle') }}</div>
          <div v-for="conflict in importPlan.nodeConflicts" :key="conflict.existing.path" class="conflict-card">
            <div class="flex flex-col gap-3 mb-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div class="font-medium text-slate-700 dark:text-slate-200">{{ conflict.existing.version || conflict.incoming.version }}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400 font-mono break-all">{{ conflict.existing.path }}</div>
              </div>
              <el-radio-group v-model="conflict.choice" class="w-full md:w-auto">
                <el-radio-button label="keep">{{ t('settings.importKeepCurrent') }}</el-radio-button>
                <el-radio-button label="incoming">{{ t('settings.importUseImported') }}</el-radio-button>
              </el-radio-group>
            </div>
            <div class="space-y-2">
              <div v-for="diff in conflict.diffs" :key="diff.key" class="space-y-2">
                <div class="text-xs font-semibold text-slate-500 dark:text-slate-300">{{ diff.label }}</div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div class="diff-box"><div class="diff-title">{{ t('settings.importCurrent') }}</div><pre class="diff-content">{{ diff.current }}</pre></div>
                  <div class="diff-box"><div class="diff-title">{{ t('settings.importIncoming') }}</div><pre class="diff-content">{{ diff.incoming }}</pre></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div v-if="importPlan.settingsConflicts.length" class="space-y-3">
          <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ t('settings.importSettingsConflictTitle') }}</div>
          <div class="conflict-card space-y-3">
            <div v-for="conflict in importPlan.settingsConflicts" :key="String(conflict.key)" class="rounded-lg border border-slate-200 dark:border-slate-700/60 p-3">
              <div class="flex flex-col gap-3 mb-3 md:flex-row md:items-start md:justify-between">
                <div class="font-medium text-slate-700 dark:text-slate-200">{{ conflict.label }}</div>
                <el-radio-group v-model="conflict.choice" class="w-full md:w-auto">
                  <el-radio-button label="keep">{{ t('settings.importKeepCurrent') }}</el-radio-button>
                  <el-radio-button label="incoming">{{ t('settings.importUseImported') }}</el-radio-button>
                </el-radio-group>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div class="diff-box"><div class="diff-title">{{ t('settings.importCurrent') }}</div><pre class="diff-content">{{ conflict.current }}</pre></div>
                <div class="diff-box"><div class="diff-title">{{ t('settings.importIncoming') }}</div><pre class="diff-content">{{ conflict.incoming }}</pre></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="cancelImportPreview">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" @click="applyImportPlan">{{ t('settings.importApply') }}</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-page {
  min-height: 100%;
  background: var(--app-bg-muted);
  color: var(--app-text);
}

.settings-container {
  width: min(1050px, calc(100vw - 80px));
  margin: 0 auto;
  padding: 28px 0 44px;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 30px;
}

.settings-title {
  margin: 0;
  font-size: 30px;
  line-height: 1.2;
  font-weight: 800;
  color: var(--app-text);
}

.settings-dirty {
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-warning) 12%, transparent);
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-warning);
}

.settings-actions,
.settings-inline-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-section {
  margin-bottom: 18px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-lg);
  background: var(--app-surface);
  padding: 16px 20px 18px;
  box-shadow: var(--app-shadow-sm);
}

.settings-section:last-child {
  margin-bottom: 0;
}

.settings-section-title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 0;
  border-bottom: 1px solid var(--app-border);
  padding-bottom: 14px;
  font-size: 22px;
  font-weight: 800;
  color: var(--app-text);
}

.settings-section-icon {
  font-size: 22px;
  color: var(--app-text-secondary);
}

.settings-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--app-border);
  padding: 14px 0;
}

.settings-row-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 72px;
  padding: 12px 0;
}

.settings-section-title + .settings-row-line {
  margin-top: 4px;
}

.settings-row-line + .settings-row-line {
  border-top: 1px solid var(--app-border);
}

.settings-row-line > :first-child {
  min-width: 0;
  max-width: 560px;
}

.settings-row-compact {
  min-height: 0;
  padding: 8px 0;
}

.settings-row-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--app-text);
}

.settings-row-desc {
  margin-top: 4px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--app-text-secondary);
}

.settings-control {
  width: 280px;
}

.settings-shortcut {
  width: 172px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-surface-soft);
  padding: 10px 16px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--app-text-secondary);
}

.editor-list,
.terminal-list,
.ai-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.editor-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  background: var(--app-surface-soft);
  padding: 10px 16px;
  transition:
    border-color var(--app-duration-fast) var(--app-ease),
    background-color var(--app-duration-fast) var(--app-ease),
    box-shadow var(--app-duration-fast) var(--app-ease);
}

.editor-card:hover {
  border-color: var(--app-border-strong);
  background: var(--app-surface);
  box-shadow: var(--app-shadow-sm);
}

.editor-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: var(--app-radius-md);
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 14px;
  font-weight: 800;
}

.editor-main {
  min-width: 0;
}

.editor-name {
  overflow: hidden;
  color: var(--app-text);
  font-size: 17px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-path {
  overflow: hidden;
  margin-top: 3px;
  color: var(--app-text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  max-width: 500px;
}

.editor-actions :deep(.el-button) {
  margin-left: 0;
}

.editor-icon-button {
  width: 38px;
  padding-right: 0;
  padding-left: 0;
}

.editor-add-button {
  width: 100%;
  min-height: 44px;
  border: 1px dashed var(--app-border-strong);
  border-radius: var(--app-radius-md);
  background: transparent;
  color: var(--app-primary);
  font-size: 15px;
  cursor: pointer;
  transition:
    border-color var(--app-duration-fast) var(--app-ease),
    background-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease);
}

.editor-add-button:hover {
  border-color: color-mix(in srgb, var(--app-primary) 48%, transparent);
  background: var(--app-primary-soft);
}

.terminal-row {
  display: grid;
  grid-template-columns: minmax(120px, 180px) minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  background: var(--app-surface-soft);
  padding: 10px;
}

.settings-section :deep(.el-segmented) {
  --el-segmented-bg-color: var(--app-surface-soft);
  --el-segmented-item-selected-bg-color: var(--app-surface);
  --el-segmented-item-selected-color: var(--app-text);
  padding: 4px;
}

.settings-section :deep(.el-button + .el-button) {
  margin-left: 0;
}

@media (max-width: 900px) {
  .settings-container {
    width: min(100% - 32px, 1050px);
    padding-top: 24px;
  }

  .settings-header,
  .settings-row-line,
  .settings-section-head {
    align-items: stretch;
    flex-direction: column;
  }

  .settings-actions,
  .settings-inline-control {
    justify-content: flex-start;
  }

  .settings-control {
    width: 100%;
  }

  .editor-card {
    grid-template-columns: 42px minmax(0, 1fr);
  }

  .editor-actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
    max-width: none;
  }

  .terminal-row {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .settings-title {
    font-size: 28px;
  }

  .settings-section-title {
    font-size: 21px;
  }

  .settings-row-line {
    min-height: 0;
  }

  .editor-card {
    grid-template-columns: 1fr;
    padding: 14px;
  }

  .editor-avatar {
    width: 40px;
    height: 40px;
  }
}

.settings-card {
  box-shadow: var(--app-shadow-sm);
  border-radius: var(--app-radius-lg);
  border: 1px solid var(--app-border) !important;
  background: var(--app-surface) !important;
}
.section-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.setting-row, .panel, .summary-tile, .conflict-card, .diff-box {
  border-radius: var(--app-radius-lg);
  border: 1px solid var(--app-border);
  background: var(--app-surface-soft);
}
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; }
.panel, .conflict-card, .diff-box, .summary-tile { padding: 14px; }
.setting-label { font-size: 14px; font-weight: 600; color: var(--app-text-secondary); }
.setting-desc, .summary-label, .diff-title { font-size: 12px; color: var(--app-text-muted); }
.summary-value { margin-top: 8px; font-size: 24px; line-height: 1; font-weight: 700; color: var(--app-text); }
.diff-box { overflow: hidden; }
.diff-content { margin: 0; max-height: 240px; overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--app-text-secondary); font-family: var(--font-mono); }
.import-dialog-content { max-height: 72vh; overflow-y: auto; padding-right: 4px; }
:deep(.el-card__header) { padding: 14px 18px; }
:deep(.el-card__body) { padding: 18px; }
:deep(.import-preview-dialog .el-dialog) {
  width: min(960px, calc(100vw - 32px));
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
:deep(.import-preview-dialog .el-dialog__body) {
  min-height: 0;
  overflow: hidden;
  padding-top: 12px;
}
:deep(.import-preview-dialog .el-dialog__footer) { padding-top: 12px; }
</style>
