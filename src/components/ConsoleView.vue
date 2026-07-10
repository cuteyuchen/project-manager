<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useProjectStore } from '../stores/project';
import { useI18n } from 'vue-i18n';
import { AnsiUp } from 'ansi_up';
import { api } from '../api';
import { getCustomCommandDisplayName } from '../utils/projectCommands';

const { t } = useI18n();
const projectStore = useProjectStore();
const ansiUp = new AnsiUp();

function parseAnsi(text: string) {
    const urlPlaceholders: { [key: string]: string } = {};
    let placeholderIndex = 0;
    
    // Regex to match URL allowing ANSI codes inside
    const urlRegex = /(https?:\/\/(?:[^\s\x1b]|(?:\x1b\[[0-9;]*[mK]))+)/g;
    
    let processedText = text.replace(urlRegex, (match) => {
        let urlWithAnsi = match;
        const trailingRegex = /([.,;!?'"\])])((\x1b\[[0-9;]*[mK])*)$/;
        let finalUrl = urlWithAnsi;
        let strippedSuffix = "";
        
        while (true) {
             const m = finalUrl.match(trailingRegex);
             if (m) {
                 const punct = m[1];
                 const ansi = m[2];
                 strippedSuffix = punct + strippedSuffix;
                 finalUrl = finalUrl.slice(0, -m[0].length) + ansi;
             } else {
                 break;
             }
        }

        const placeholder = `__URL_PLACEHOLDER_${placeholderIndex++}__`;
        urlPlaceholders[placeholder] = finalUrl;
        return placeholder + strippedSuffix;
    });
    
    const html = ansiUp.ansi_to_html(processedText);
    
    return html.replace(/__URL_PLACEHOLDER_(\d+)__/g, (match) => {
        const urlWithAnsi = urlPlaceholders[match];
        if (urlWithAnsi) {
            const cleanUrl = urlWithAnsi.replace(/\x1b\[[0-9;]*[mK]/g, '');
            const displayHtml = ansiUp.ansi_to_html(urlWithAnsi);
            return `<span class="log-link text-blue-400 hover:underline cursor-pointer" data-url="${cleanUrl.replace(/"/g, '&quot;')}" title="Ctrl + Click to open">${displayHtml}</span>`;
        }
        return match;
    });
}

function handleLogClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    // Find the closest log-link element, as the click might be on a nested span inside the link
    const linkElement = target.closest('.log-link') as HTMLElement;
    
    if (linkElement) {
        const url = linkElement.dataset.url;
        if (url && (event.ctrlKey || event.metaKey)) {
             api.openUrl(url);
        }
    }
}

const activeProject = computed(() =>
    projectStore.projects.find(p => p.id === projectStore.activeProjectId)
);

const activeScript = ref<string | null>(null);
const logContainer = ref<HTMLElement | null>(null);
const parsedLogCache = new Map<string, string>();
const MAX_PARSED_LOG_CACHE_SIZE = 2000;
const LOG_BOTTOM_THRESHOLD = 48;
const shouldFollowLogs = ref(true);
let scrollToBottomToken = 0;

function getCachedParsedAnsi(text: string) {
    const cached = parsedLogCache.get(text);
    if (cached) return cached;

    const parsed = parseAnsi(text);
    parsedLogCache.set(text, parsed);

    if (parsedLogCache.size > MAX_PARSED_LOG_CACHE_SIZE) {
        const oldestKey = parsedLogCache.keys().next().value;
        if (oldestKey) {
            parsedLogCache.delete(oldestKey);
        }
    }

    return parsed;
}

// Keep track of active tabs explicitly
// We'll use a local state to track which tabs are "open"
// Tabs are opened when:
// 1. A script starts running
// 2. A script is manually clicked in the sidebar (ProjectListItem) -> wait, clicking there just runs it.
// 3. What if I want to see logs of a stopped script? 
// The user said: "After executing command on left, add tab on right".
// So we should add to 'openTabs' when runningStatus changes to true.

const openTabs = ref<Set<string>>(new Set());

const activeRunningTabs = computed(() => {
    if (!activeProject.value) return [];
    const prefix = `${activeProject.value.id}:`;

    return Object.entries(projectStore.runningStatus)
        .filter(([key, running]) => running && key.startsWith(prefix))
        .map(([key]) => key.substring(prefix.length));
});

watch(activeRunningTabs, (runningTabs) => {
    for (const script of runningTabs) {
        openTabs.value.add(script);
    }
    // Only switch when the currently viewed command has ended
    if (activeScript.value && !runningTabs.includes(activeScript.value)) {
        if (runningTabs.length > 0) {
            activeScript.value = runningTabs[runningTabs.length - 1];
        }
    }
    // Initialize activeScript if not set
    if (!activeScript.value && runningTabs.length > 0) {
        activeScript.value = runningTabs[runningTabs.length - 1];
    }
}, { immediate: true });

// Also populate openTabs from existing logs/running on mount/project change
watch(activeProject, (newP) => {
    openTabs.value.clear();
    activeScript.value = null;

    if (newP) {
        // Check node scripts
        if (newP.scripts) {
            newP.scripts.forEach(s => {
                const key = `${newP.id}:${s}`;
                if (projectStore.runningStatus[key] || (projectStore.logs[key] && projectStore.logs[key].length > 0)) {
                    openTabs.value.add(s);
                }
            });
        }

        // Check custom commands
        if (newP.customCommands) {
            newP.customCommands.forEach(c => {
                const key = `${newP.id}:${c.id}`;
                if (projectStore.runningStatus[key] || (projectStore.logs[key] && projectStore.logs[key].length > 0)) {
                    openTabs.value.add(c.id);
                }
            });
        }

        // Auto select first available
        if (openTabs.value.size > 0) {
            // Prefer running ones
            const running = Array.from(openTabs.value).find(s => projectStore.runningStatus[`${newP.id}:${s}`]);
            activeScript.value = running || Array.from(openTabs.value)[0];
        }
    }
}, { immediate: true });

const availableTabs = computed(() => {
    return Array.from(openTabs.value);
});

/** *********************可运行命令列表（无输出 tab 时展示）*********************/

/** 可见脚本（遵循 visibleScripts 白名单） */
const runnableScripts = computed(() => {
    const project = activeProject.value;
    if (!project || project.type !== 'node' || !project.scripts?.length) return [];
    if (project.visibleScripts?.length) {
        return project.scripts.filter(s => project.visibleScripts!.includes(s));
    }
    return project.scripts;
});

/** 自定义命令 */
const runnableCustomCommands = computed(() => activeProject.value?.customCommands ?? []);

/** 是否有任何可运行命令 */
const hasRunnableCommands = computed(() =>
    runnableScripts.value.length > 0 || runnableCustomCommands.value.length > 0
);

function isCommandRunning(id: string): boolean {
    if (!activeProject.value) return false;
    return !!projectStore.runningStatus[`${activeProject.value.id}:${id}`];
}

function getCustomCmdLabel(cmd: { name: string; builtinId?: 'install_dependencies' }): string {
    return getCustomCommandDisplayName(cmd, t);
}

function getTabLabel(tabId: string): string {
    if (!activeProject.value) return tabId;
    const customCmd = activeProject.value.customCommands?.find(c => c.id === tabId);
    if (customCmd) return getCustomCommandDisplayName(customCmd, t);
    return tabId;
}

const logs = computed(() => {
    if (!activeProject.value || !activeScript.value) return [];
    // Use Object.freeze to avoid deep reactivity overhead on large arrays
    const allLogs = projectStore.logs[`${activeProject.value.id}:${activeScript.value}`] || [];
    // Return a frozen slice
    return allLogs.slice(-500);
});

const renderedLogs = computed(() => {
    return logs.value.map((line, index) => ({
        key: `${index}:${line}`,
        html: getCachedParsedAnsi(line),
    }));
});

const isRunning = computed(() => {
    if (!activeProject.value || !activeScript.value) return false;
    return projectStore.runningStatus[`${activeProject.value.id}:${activeScript.value}`] || false;
});

function isNearLogBottom() {
    if (!logContainer.value) return true;

    const { scrollTop, clientHeight, scrollHeight } = logContainer.value;
    return scrollHeight - (scrollTop + clientHeight) <= LOG_BOTTOM_THRESHOLD;
}

function handleLogScroll() {
    shouldFollowLogs.value = isNearLogBottom();
}

function resumeLogFollow() {
    shouldFollowLogs.value = true;
    void scheduleScrollToBottom();
}

// Auto-scroll logic
// We want to scroll to bottom when new logs arrive, BUT only if we are already near bottom
// or if it's the first render.
// User requirement: "Always display the latest output at the bottom" (Run project always show newest output).
// This implies forcing scroll to bottom.

const scrollToBottom = () => {
    if (logContainer.value) {
        logContainer.value.scrollTop = logContainer.value.scrollHeight;
    }
};

async function scheduleScrollToBottom() {
    const token = ++scrollToBottomToken;

    await nextTick();
    if (token !== scrollToBottomToken || !shouldFollowLogs.value) return;
    scrollToBottom();

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (token !== scrollToBottomToken || !shouldFollowLogs.value) return;
    scrollToBottom();

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (token !== scrollToBottomToken || !shouldFollowLogs.value) return;
    scrollToBottom();
}

const renderedLogWindowSignature = computed(() => {
    const currentLogs = logs.value;
    const first = currentLogs[0] || '';
    const last = currentLogs[currentLogs.length - 1] || '';
    return `${activeScript.value || ''}:${currentLogs.length}:${first}:${last}`;
});

watch(renderedLogWindowSignature, () => {
    if (!shouldFollowLogs.value) return;
    void scheduleScrollToBottom();
}, { flush: 'post' });

// Force scroll on script switch - INSTANTLY
watch(activeScript, () => {
    void resumeLogFollow();
});

watch(activeProject, () => {
    parsedLogCache.clear();
    shouldFollowLogs.value = true;
});

function handleStop() {
    if (activeProject.value && activeScript.value) {
        projectStore.stopProject(activeProject.value, activeScript.value);
    }
}

async function handleRestart() {
    if (activeProject.value && activeScript.value) {
        const runId = `${activeProject.value.id}:${activeScript.value}`;
        
        // 如果已经在运行，先停止
        if (projectStore.runningStatus[runId]) {
            await projectStore.stopProject(activeProject.value, activeScript.value);
            
            // 等待进程真正退出
            const maxWait = 5000;
            const startTime = Date.now();
            while (projectStore.runningStatus[runId] && (Date.now() - startTime) < maxWait) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // 启动
        if (activeProject.value && activeScript.value) {
            const customCmd = activeProject.value.customCommands?.find(c => c.id === activeScript.value);
            if (customCmd) {
                projectStore.runCustomCommand(activeProject.value, customCmd.id);
            } else {
                projectStore.runProject(activeProject.value, activeScript.value);
            }
        }
    }
}

function handleClear() {
    if (activeProject.value && activeScript.value) {
        projectStore.clearLog(`${activeProject.value.id}:${activeScript.value}`);
    }
}

function handleRun(script: string) {
    if (activeProject.value) {
        // Check if it's a custom command id
        const customCmd = activeProject.value.customCommands?.find(c => c.id === script);
        if (customCmd) {
            projectStore.runCustomCommand(activeProject.value, customCmd.id);
        } else {
            projectStore.runProject(activeProject.value, script);
        }
    }
}

/** 启动器点击：运行中则停止，否则运行 */
function toggleRun(id: string) {
    if (!activeProject.value) return;
    if (isCommandRunning(id)) {
        projectStore.stopProject(activeProject.value, id);
    } else {
        handleRun(id);
        // 运行后自动切到该命令的输出标签
        activeScript.value = id;
    }
}

function handleCloseTab(script: string) {
    // Stop the script if running
    if (activeProject.value && projectStore.runningStatus[`${activeProject.value.id}:${script}`]) {
        projectStore.stopProject(activeProject.value, script);
    }

    openTabs.value.delete(script);
    if (activeScript.value === script) {
        activeScript.value = Array.from(openTabs.value)[0] || null;
    }
}
</script>

<template>
    <div class="app-page absolute inset-0">
        <!-- 可运行命令启动器（常驻显示）-->
        <div v-if="activeProject && hasRunnableCommands" class="command-launcher app-panel-toolbar flex flex-wrap items-center gap-1.5 px-3 py-2 border-b">
            <span class="text-[11px] text-slate-400 dark:text-slate-500 mr-1 shrink-0">{{ t('dashboard.runnableCommands') }}</span>
            <!-- 自定义命令 -->
            <button
                v-for="cmd in runnableCustomCommands"
                :key="cmd.id"
                @click="toggleRun(cmd.id)"
                class="launcher-btn"
                :class="isCommandRunning(cmd.id) ? 'launcher-btn-running' : 'launcher-btn-custom'"
            >
                <div :class="isCommandRunning(cmd.id) ? 'i-mdi-stop' : 'i-mdi-play'" class="text-[11px]" />
                {{ getCustomCmdLabel(cmd) }}
            </button>
            <!-- node 脚本 -->
            <button
                v-for="script in runnableScripts"
                :key="script"
                @click="toggleRun(script)"
                class="launcher-btn"
                :class="isCommandRunning(script)
                    ? 'launcher-btn-running'
                    : (script === 'dev' || script === 'start' || script === 'serve' ? 'launcher-btn-primary' : 'launcher-btn-muted')"
            >
                <div :class="isCommandRunning(script) ? 'i-mdi-stop' : 'i-mdi-play'" class="text-[11px]" />
                {{ script }}
            </button>
        </div>

        <!-- Header -->
        <div v-if="activeProject"
            class="app-panel-toolbar flex flex-col z-10">
            <!-- Tabs for outputs -->
            <div v-if="availableTabs.length > 0" class="flex px-3 gap-0.5 overflow-x-auto custom-scrollbar pt-1.5">
                <div v-for="script in availableTabs" :key="script" @click="activeScript = script"
                    class="group relative px-3 py-1.5 text-xs font-medium rounded-t-md border-t border-x transition-all duration-150 cursor-pointer select-none flex items-center gap-2 min-w-[90px] justify-between"
                    :class="activeScript === script 
                        ? 'bg-[var(--app-bg-muted)] text-[var(--app-primary)] border-[var(--app-border)] border-b-transparent z-10'
                        : 'bg-[var(--app-surface)] text-muted hover:text-secondary border-[var(--app-border)] hover:bg-[var(--app-surface-soft)]'">
                    <div class="flex items-center gap-1.5">
                        <span v-if="projectStore.runningStatus[`${activeProject.id}:${script}`]"
                            class="console-status-dot console-status-dot-running"></span>
                        <span v-else class="console-status-dot"></span>
                        {{ getTabLabel(script) }}
                    </div>

                    <button @click.stop="handleCloseTab(script)"
                        class="app-icon-btn !h-5 !min-w-5 opacity-0 group-hover:opacity-100 !rounded">
                        <div class="i-mdi-close text-[10px]" />
                    </button>
                </div>
            </div>
        </div>

        <!-- Logs Control Bar (only if script selected) -->
        <div v-if="activeScript"
            class="app-panel-toolbar flex items-center justify-between px-3 py-1.5">
            <div class="text-[11px] text-slate-400 dark:text-slate-500 font-mono flex items-center gap-2">
                <span>{{ getTabLabel(activeScript) }}</span>
                <span v-if="isRunning" class="text-emerald-500 flex items-center gap-1">
                    <div class="i-mdi-loading animate-spin text-[10px]" /> {{ t('dashboard.running') }}
                </span>
                <span v-else class="text-slate-300 dark:text-slate-600">{{ t('dashboard.stopped') }}</span>
            </div>
            <div class="flex gap-1.5">
                <button @click="handleClear" class="app-icon-btn !h-6 !min-w-6 !rounded"
                    title="Clear Logs">
                    <div class="i-mdi-delete-sweep text-sm" />
                </button>
                <button v-if="isRunning" @click="handleRestart"
                    class="px-2 py-0.5 bg-amber-500/8 hover:bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/15 rounded text-[11px] flex items-center gap-1 transition-all duration-150">
                    <div class="i-mdi-restart text-[10px]" /> {{ t('dashboard.restart') }}
                </button>
                <button v-if="isRunning" @click="handleStop"
                    class="px-2 py-0.5 bg-rose-500/8 hover:bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/15 rounded text-[11px] flex items-center gap-1 transition-all duration-150">
                    <div class="i-mdi-stop text-[10px]" /> {{ t('dashboard.stop') }}
                </button>
                <button v-else @click="handleRun(activeScript!)"
                    class="px-2 py-0.5 bg-blue-500/8 hover:bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/15 rounded text-[11px] flex items-center gap-1 transition-all duration-150">
                    <div class="i-mdi-play text-[10px]" /> {{ t('dashboard.start') }}
                </button>
            </div>
        </div>

        <!-- Logs -->
        <div v-if="activeScript" ref="logContainer" @click="handleLogClick" @scroll="handleLogScroll"
            class="flex-1 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap select-text relative min-h-0">
            <div :key="activeScript" class="p-3">
                <div
                    v-for="item in renderedLogs"
                    :key="item.key"
                    class="console-log-row break-all border-l-2 border-transparent pl-2 -ml-2 transition-colors duration-100 py-px"
                    v-html="item.html">
                </div>
            </div>

            <div v-if="logs.length === 0"
                class="h-full flex flex-col items-center justify-center text-slate-300 dark:text-slate-700 absolute inset-0 pointer-events-none">
                <div class="i-mdi-console-line text-5xl mb-3 opacity-20" />
                <p class="text-xs">{{ t('dashboard.waitingForOutput') }}</p>
            </div>

            <button
                v-if="!shouldFollowLogs && logs.length > 0"
                @click.stop="resumeLogFollow"
                class="app-primary-action absolute right-4 bottom-4 z-10 !min-h-0 rounded-full px-3 py-1.5 text-[11px]">
                <div class="i-mdi-arrow-down-circle text-sm" />
                <span>{{ t('dashboard.scrollToBottom') }}</span>
            </button>
        </div>

        <!-- Empty State -->
        <div v-else class="flex-1 flex flex-col items-center justify-center text-slate-300 dark:text-slate-600">
            <div class="w-20 h-20 rounded-full flex items-center justify-center mb-4" style="background: var(--app-surface-soft);">
                <div class="i-mdi-monitor-dashboard text-4xl opacity-25" />
            </div>
            <p class="text-sm font-medium text-slate-500 dark:text-slate-500">
                {{ !activeProject ? t('dashboard.selectScript') : (hasRunnableCommands ? t('dashboard.clickRunHint') : t('dashboard.noRunnableCommands')) }}
            </p>
        </div>
    </div>
</template>

<style scoped>
/* Custom Scrollbar for Webkit (Chrome, Safari, Edge) */
.overflow-y-auto::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 52%, transparent);
  border-radius: 4px;
}

.overflow-y-auto::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--app-text-muted) 74%, transparent);
}

.console-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-text-muted);
}

.console-status-dot-running {
  background: var(--app-success);
  box-shadow: 0 0 4px color-mix(in srgb, var(--app-success) 54%, transparent);
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.console-log-row:hover {
  background: color-mix(in srgb, var(--app-text-muted) 10%, transparent);
  border-left-color: var(--app-border);
}

/* 命令启动器按钮 */
.launcher-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: var(--app-radius-md);
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background-color var(--app-duration-fast) var(--app-ease), color var(--app-duration-fast) var(--app-ease);
}
.launcher-btn-custom {
  background: color-mix(in srgb, var(--app-primary) 8%, transparent);
  color: var(--app-primary);
  border-color: color-mix(in srgb, var(--app-primary) 18%, transparent);
  border-style: dashed;
}
.launcher-btn-custom:hover {
  background: color-mix(in srgb, var(--app-primary) 16%, transparent);
}
.launcher-btn-primary {
  background: color-mix(in srgb, var(--app-success) 10%, transparent);
  color: var(--app-success);
  border-color: color-mix(in srgb, var(--app-success) 20%, transparent);
}
.launcher-btn-primary:hover {
  background: color-mix(in srgb, var(--app-success) 18%, transparent);
}
.launcher-btn-muted {
  background: var(--app-surface-soft);
  color: var(--app-text-secondary);
  border-color: var(--app-border);
}
.launcher-btn-muted:hover {
  background: var(--app-surface);
  color: var(--app-text);
}
.launcher-btn-running {
  background: color-mix(in srgb, var(--app-danger, #ef4444) 12%, transparent);
  color: var(--app-danger, #ef4444);
  border-color: color-mix(in srgb, var(--app-danger, #ef4444) 22%, transparent);
}

/* 可运行命令 chip */
.run-cmd-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: var(--app-radius-md);
  border: 1px solid var(--app-border);
  background: var(--app-surface);
  color: var(--app-text-secondary);
  font-size: 12px;
  font-weight: 600;
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease),
    border-color var(--app-duration-fast) var(--app-ease);
}
.run-cmd-chip:hover {
  color: var(--app-primary);
  border-color: color-mix(in srgb, var(--app-primary) 40%, transparent);
  background: var(--app-primary-soft);
}
.run-cmd-chip-primary {
  color: var(--app-success);
  border-color: color-mix(in srgb, var(--app-success) 30%, transparent);
  background: color-mix(in srgb, var(--app-success) 8%, transparent);
}
.run-cmd-chip-running {
  color: var(--app-success);
  border-color: color-mix(in srgb, var(--app-success) 40%, transparent);
  background: color-mix(in srgb, var(--app-success) 12%, transparent);
}
</style>
