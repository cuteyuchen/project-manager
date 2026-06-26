<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useProjectStore } from '../stores/project';
import { useUsageStore } from '../stores/usage';
import type { Project } from '../types';
import { pinyin } from 'pinyin-pro';

const { t } = useI18n();
const projectStore = useProjectStore();
const usageStore = useUsageStore();

const emit = defineEmits<{
  close: [];
  select: [projectId: string];
}>();

const searchQuery = ref('');
const selectedIndex = ref(0);
const searchInputRef = useTemplateRef<HTMLInputElement>('searchInputRef');

/***********************拼音搜索工具*********************/
function buildPinyinSearchText(text: string): string {
    if (!text) return '';
    const syllables = pinyin(text, { toneType: 'none', type: 'array' }) as string[];
    const full = syllables.join('');
    const initials = syllables.map(s => s[0] || '').join('');
    return `${full} ${initials}`.toLowerCase();
}

const pinyinCache = new Map<string, string>();

function getCachedPinyin(text: string) {
    if (!text) return '';
    const cached = pinyinCache.get(text);
    if (cached) return cached;
    const next = buildPinyinSearchText(text);
    pinyinCache.set(text, next);
    return next;
}

/***********************搜索结果*********************/

function buildSearchEntry(project: Project) {
    return {
        project,
        normalizedName: project.name.toLowerCase(),
        normalizedPath: project.path.toLowerCase(),
        namePinyin: getCachedPinyin(project.name),
        pathPinyin: getCachedPinyin(project.path),
        normalizedDescription: (project.description || '').toLowerCase(),
        normalizedTags: (project.tags || []).join(' ').toLowerCase(),
        normalizedScripts: (project.scripts || []).join(' ').toLowerCase(),
        normalizedCustomCommands: (project.customCommands || []).map(c => c.name).join(' ').toLowerCase(),
    };
}

const allSearchEntries = computed(() => projectStore.projects.map(buildSearchEntry));

const searchResults = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    const compactQuery = query.replace(/\s+/g, '');

    if (!query) return [];

    return allSearchEntries.value
        .filter(entry => {
            return entry.normalizedName.includes(query)
                || entry.normalizedPath.includes(query)
                || entry.namePinyin.includes(compactQuery)
                || entry.pathPinyin.includes(compactQuery)
                || entry.normalizedDescription.includes(query)
                || entry.normalizedTags.includes(query)
                || entry.normalizedScripts.includes(compactQuery)
                || entry.normalizedCustomCommands.includes(compactQuery);
        })
        .map(entry => entry.project);
});

const defaultResults = computed(() => {
    const pinned = projectStore.projects.filter(p => p.pinned);
    const weights = usageStore.calculateAllWeights();
    const recent = projectStore.projects
        .filter(p => !p.pinned && (weights[p.id] ?? 0) > 0)
        .sort((a, b) => (weights[b.id] ?? 0) - (weights[a.id] ?? 0))
        .slice(0, 10);
    return { pinned, recent };
});

const displayList = computed(() => {
    const query = searchQuery.value.trim();
    if (query) return searchResults.value;

    const list: Project[] = [];
    const seenIds = new Set<string>();
    for (const p of defaultResults.value.pinned) {
        if (!seenIds.has(p.id)) {
            list.push(p);
            seenIds.add(p.id);
        }
    }
    for (const p of defaultResults.value.recent) {
        if (!seenIds.has(p.id)) {
            list.push(p);
            seenIds.add(p.id);
        }
    }
    return list;
});

const showPinnedHeader = computed(() => !searchQuery.value.trim() && defaultResults.value.pinned.length > 0);
const showRecentHeader = computed(() => !searchQuery.value.trim() && defaultResults.value.recent.length > 0);
const showNoResults = computed(() => searchQuery.value.trim() && searchResults.value.length === 0);

/** 合并后的完整列表（用于键盘导航索引计算） */
const fullFlatList = computed(() => {
    if (searchQuery.value.trim()) return searchResults.value;
    return displayList.value;
});

/***********************键盘导航（仅在输入框触发，不冒泡到遮罩）*********************/

function handleKeydown(event: KeyboardEvent) {
    const list = fullFlatList.value;
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        selectedIndex.value = Math.min(selectedIndex.value + 1, list.length - 1);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (list[selectedIndex.value]) {
            selectProject(list[selectedIndex.value].id);
        }
    } else if (event.key === 'Escape') {
        event.preventDefault();
        emit('close');
    }
}

function selectProject(projectId: string) {
    emit('select', projectId);
}

function handleOverlayClick(event: MouseEvent) {
    if ((event.target as HTMLElement).classList.contains('quick-search-overlay')) {
        emit('close');
    }
}

watch(searchQuery, () => {
    selectedIndex.value = 0;
});

onMounted(() => {
    nextTick(() => {
        searchInputRef.value?.focus();
    });
});

function getDisplayTags(project: Project): string[] {
    return (project.tags || []).slice(0, 2);
}
</script>

<template>
    <div class="quick-search-overlay" @click="handleOverlayClick">
        <div class="quick-search-container">
            <div class="quick-search-header">
                <div class="i-mdi-magnify text-lg text-slate-400 dark:text-slate-500 flex-shrink-0" />
                <input
                    ref="searchInputRef"
                    v-model="searchQuery"
                    :placeholder="t('dashboard.quickSearchPlaceholder')"
                    class="quick-search-input"
                    @keydown="handleKeydown"
                />
                <div class="quick-search-shortcut">
                    <kbd>ESC</kbd>
                </div>
            </div>

            <div class="quick-search-results custom-scrollbar">
                <!-- 搜索态：单列表 -->
                <template v-if="searchQuery.trim()">
                    <div
                        v-for="(project, index) in searchResults"
                        :key="project.id"
                        class="quick-search-item"
                        :class="{ 'quick-search-item-active': index === selectedIndex }"
                        @click="selectProject(project.id)"
                        @mouseenter="selectedIndex = index"
                    >
                        <div class="quick-search-item-icon">
                            <div :class="project.type === 'node' ? 'i-mdi-nodejs text-emerald-500' : 'i-mdi-folder-outline text-slate-400'" class="text-base" />
                        </div>
                        <div class="quick-search-item-content">
                            <div class="quick-search-item-name">{{ project.name }}</div>
                            <div class="quick-search-item-path">{{ project.path }}</div>
                        </div>
                        <div class="quick-search-item-meta">
                            <span
                                v-for="tag in getDisplayTags(project)"
                                :key="tag"
                                class="quick-search-tag"
                            >
                                {{ tag }}
                            </span>
                            <span v-if="project.pinned" class="i-mdi-pin text-[10px] text-amber-500" />
                        </div>
                    </div>
                    <div v-if="showNoResults" class="quick-search-empty">
                        <div class="i-mdi-magnify-close text-3xl mb-2 opacity-20" />
                        <p class="text-sm">{{ t('dashboard.noSearchResults') }}</p>
                    </div>
                </template>

                <!-- 默认态：置顶 + 最近使用分组渲染 -->
                <template v-else>
                    <!-- 置顶项目 -->
                    <template v-if="showPinnedHeader">
                        <div class="quick-search-section-title">
                            <div class="i-mdi-pin text-[10px] text-amber-500" />
                            {{ t('dashboard.pinnedProjects') }}
                        </div>
                        <div
                            v-for="(project, localIdx) in defaultResults.pinned"
                            :key="project.id"
                            class="quick-search-item"
                            :class="{ 'quick-search-item-active': localIdx === selectedIndex }"
                            @click="selectProject(project.id)"
                            @mouseenter="selectedIndex = localIdx"
                        >
                            <div class="quick-search-item-icon">
                                <div :class="project.type === 'node' ? 'i-mdi-nodejs text-emerald-500' : 'i-mdi-folder-outline text-slate-400'" class="text-base" />
                            </div>
                            <div class="quick-search-item-content">
                                <div class="quick-search-item-name">{{ project.name }}</div>
                                <div class="quick-search-item-path">{{ project.path }}</div>
                            </div>
                            <div class="quick-search-item-meta">
                                <span
                                    v-for="tag in getDisplayTags(project)"
                                    :key="tag"
                                    class="quick-search-tag"
                                >
                                    {{ tag }}
                                </span>
                                <span class="i-mdi-pin text-[10px] text-amber-500" />
                            </div>
                        </div>
                    </template>

                    <!-- 最近使用项目 -->
                    <template v-if="showRecentHeader">
                        <div class="quick-search-divider" />
                        <div class="quick-search-section-title">
                            <div class="i-mdi-clock-outline text-[10px] text-slate-400" />
                            {{ t('dashboard.recentProjects') }}
                        </div>
                        <div
                            v-for="(project, localIdx) in defaultResults.recent"
                            :key="project.id"
                            class="quick-search-item"
                            :class="{ 'quick-search-item-active': (defaultResults.pinned.length + localIdx) === selectedIndex }"
                            @click="selectProject(project.id)"
                            @mouseenter="selectedIndex = defaultResults.pinned.length + localIdx"
                        >
                            <div class="quick-search-item-icon">
                                <div :class="project.type === 'node' ? 'i-mdi-nodejs text-emerald-500' : 'i-mdi-folder-outline text-slate-400'" class="text-base" />
                            </div>
                            <div class="quick-search-item-content">
                                <div class="quick-search-item-name">{{ project.name }}</div>
                                <div class="quick-search-item-path">{{ project.path }}</div>
                            </div>
                            <div class="quick-search-item-meta">
                                <span
                                    v-for="tag in getDisplayTags(project)"
                                    :key="tag"
                                    class="quick-search-tag"
                                >
                                    {{ tag }}
                                </span>
                            </div>
                        </div>
                    </template>

                    <!-- 无项目 -->
                    <div v-if="displayList.length === 0" class="quick-search-empty">
                        <div class="i-mdi-folder-open-outline text-3xl mb-2 opacity-20" />
                        <p class="text-sm">{{ t('dashboard.noProjects') }}</p>
                    </div>
                </template>
            </div>
        </div>
    </div>
</template>

<style scoped>
.quick-search-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.quick-search-container {
  width: min(560px, calc(100vw - 48px));
  max-height: 440px;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow:
    0 25px 60px rgba(15, 23, 42, 0.2),
    0 0 0 1px rgba(148, 163, 184, 0.15);
  overflow: hidden;
}

:global(html.dark) .quick-search-container {
  background: rgba(30, 41, 59, 0.98);
  box-shadow:
    0 25px 60px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(71, 85, 105, 0.3);
}

.quick-search-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.7);
}

:global(html.dark) .quick-search-header {
  border-bottom-color: rgba(51, 65, 85, 0.5);
}

.quick-search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  font-weight: 500;
  color: rgb(30, 41, 59);
  font-family: inherit;
}

.quick-search-input::placeholder {
  color: rgb(148, 163, 184);
  font-weight: 400;
}

:global(html.dark) .quick-search-input {
  color: rgb(241, 245, 249);
}

.quick-search-shortcut {
  display: flex;
  align-items: center;
  gap: 4px;
}

.quick-search-shortcut kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  min-width: 20px;
  padding: 0 5px;
  border-radius: 5px;
  background: rgba(241, 245, 249, 0.8);
  border: 1px solid rgba(226, 232, 240, 0.7);
  color: rgb(100, 116, 139);
  font-size: 10px;
  font-family: inherit;
  font-weight: 600;
}

:global(html.dark) .quick-search-shortcut kbd {
  background: rgba(51, 65, 85, 0.5);
  border-color: rgba(71, 85, 105, 0.5);
  color: rgb(148, 163, 184);
}

.quick-search-results {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.quick-search-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(148, 163, 184);
}

.quick-search-divider {
  height: 1px;
  margin: 4px 10px;
  background: rgba(226, 232, 240, 0.5);
}

:global(html.dark) .quick-search-divider {
  background: rgba(51, 65, 85, 0.5);
}

.quick-search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.quick-search-item:hover {
  background: rgba(241, 245, 249, 0.6);
}

:global(html.dark) .quick-search-item:hover {
  background: rgba(51, 65, 85, 0.3);
}

.quick-search-item-active {
  background: rgba(59, 130, 246, 0.08);
}

:global(html.dark) .quick-search-item-active {
  background: rgba(59, 130, 246, 0.12);
}

.quick-search-item-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(241, 245, 249, 0.6);
}

:global(html.dark) .quick-search-item-icon {
  background: rgba(51, 65, 85, 0.3);
}

.quick-search-item-content {
  flex: 1;
  min-width: 0;
}

.quick-search-item-name {
  font-size: 13px;
  font-weight: 600;
  color: rgb(30, 41, 59);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:global(html.dark) .quick-search-item-name {
  color: rgb(241, 245, 249);
}

.quick-search-item-path {
  font-size: 11px;
  color: rgb(148, 163, 184);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono, monospace);
}

.quick-search-item-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.quick-search-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
  background: rgba(59, 130, 246, 0.08);
  color: rgb(37, 99, 235);
}

:global(html.dark) .quick-search-tag {
  background: rgba(59, 130, 246, 0.15);
  color: rgb(96, 165, 250);
}

.quick-search-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  color: rgb(148, 163, 184);
}
</style>
