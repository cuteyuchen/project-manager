<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorState, Compartment, StateEffect, StateField, RangeSet, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { editorLanguageExtension, type EditorLanguage } from '../../utils/editorLanguage';
import { editorHighlightExtension } from '../../utils/editorHighlight';
import type { EditorLineMarkers } from '../../utils/editorGitMarkers';

class GitGutterMarker extends GutterMarker {
  constructor(className: string) {
    super();
    this.elementClass = className;
  }
}

const props = withDefaults(defineProps<{
  modelValue: string;
  language: EditorLanguage;
  readOnly?: boolean;
  dark?: boolean;
  /** Git 行级变更标记：行号（1-based）→ 类型 */
  lineMarkers?: EditorLineMarkers | null;
  /** 打开后滚动并选中到该行（1-based） */
  initialLine?: number;
}>(), {
  readOnly: false,
  dark: true,
  lineMarkers: null,
  initialLine: undefined,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  save: [];
}>();

const editorHost = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const languageCompartment = new Compartment();
const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const highlightCompartment = new Compartment();

/** Git 修改行装饰：在 gutter 左侧加色条 */
const setGitLineMarkers = StateEffect.define<EditorLineMarkers | null>();

function buildLineDecorationsFromState(markers: EditorLineMarkers, state: EditorState): DecorationSet {
  // 行背景只给当前文件仍存在的新增/修改；删除行用 gutter 短标记，不整行高亮
  const lines: { line: number; cls: string }[] = [];
  for (const line of markers.added) lines.push({ line, cls: 'cm-git-line-added' });
  for (const line of markers.modified) lines.push({ line, cls: 'cm-git-line-modified' });
  const seen = new Set<number>();
  const specs: { pos: number; class: string }[] = [];
  for (const item of lines.sort((a, b) => a.line - b.line)) {
    if (item.line < 1 || item.line > state.doc.lines || seen.has(item.line)) continue;
    seen.add(item.line);
    specs.push({ pos: state.doc.line(item.line).from, class: item.cls });
  }
  return Decoration.set(specs.map(spec => Decoration.line({ class: spec.class }).range(spec.pos)), true);
}

function buildGutterMarkers(markers: EditorLineMarkers, state: EditorState): RangeSet<GutterMarker> {
  const total = state.doc.lines;
  const lines: { line: number; cls: string }[] = [];
  for (const line of markers.added) lines.push({ line, cls: 'cm-git-line-added' });
  for (const line of markers.modified) lines.push({ line, cls: 'cm-git-line-modified' });
  // deleted: 0 → 首行顶边；n>0 → 第 n 行底边（即 n 与 n+1 之间）
  for (const line of markers.deleted) {
    if (line <= 0) {
      if (total >= 1) lines.push({ line: 1, cls: 'cm-git-deleted-tick cm-git-deleted-tick-top' });
      continue;
    }
    if (line <= total) lines.push({ line, cls: 'cm-git-deleted-tick' });
  }
  const seen = new Set<string>();
  const specs: { pos: number; marker: GitGutterMarker }[] = [];
  for (const item of lines.sort((a, b) => a.line - b.line)) {
    const key = `${item.line}:${item.cls}`;
    if (item.line < 1 || item.line > total || seen.has(key)) continue;
    seen.add(key);
    specs.push({
      pos: state.doc.line(item.line).from,
      marker: new GitGutterMarker(item.cls),
    });
  }
  return RangeSet.of(specs.map(spec => spec.marker.range(spec.pos)), true);
}

const gitLineMarkersField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setGitLineMarkers)) continue;
      const markers = effect.value;
      // effect 重建后直接返回，避免再 map(changes)
      return markers ? buildLineDecorationsFromState(markers, tr.state) : Decoration.none;
    }
    return deco.map(tr.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

const gitGutterMarkersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setGitLineMarkers)) continue;
      const markers = effect.value;
      return markers ? buildGutterMarkers(markers, tr.state) : RangeSet.empty;
    }
    return value.map(tr.changes);
  },
  provide: field => gutterLineClass.from(field),
});

function highlightExtension(dark: boolean): Extension {
  return editorHighlightExtension(dark);
}

function themeExtension(dark: boolean): Extension {
  // 背景/前景走全局 CSS 变量，保证与左侧资源管理器、工作区底色一致
  return EditorView.theme({
    '&': {
      color: 'var(--app-text)',
      backgroundColor: 'var(--app-surface)',
      height: '100%',
    },
    '.cm-content': { caretColor: dark ? '#8bc8ff' : '#2167a7' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: dark ? '#8bc8ff' : '#2167a7' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'var(--app-surface-soft)',
      color: 'var(--app-text-muted)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: dark ? 'rgba(30, 41, 59, 0.55)' : 'rgba(238, 244, 250, 0.85)' },
    '.cm-activeLineGutter': { backgroundColor: dark ? 'rgba(30, 41, 59, 0.7)' : 'rgba(231, 239, 248, 0.9)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: dark ? '#294b6b' : '#cfe4fb' },
    '.cm-panels': { backgroundColor: 'var(--app-surface-soft)', color: 'inherit' },
    '.cm-search': { padding: '8px', borderBottom: '1px solid var(--app-border)' },
    '.cm-button': { color: 'inherit', backgroundColor: 'var(--app-surface-raised)', border: '1px solid var(--app-border-strong)' },
    '.cm-textfield': { color: 'inherit', backgroundColor: 'var(--app-surface)', border: '1px solid var(--app-border-strong)' },
  }, { dark });
}

function saveCommand(): boolean {
  emit('save');
  return true;
}

function createView(): void {
  if (!editorHost.value) return;
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      foldGutter(),
      search({ top: true }),
      highlightSelectionMatches(),
      gitLineMarkersField,
      gitGutterMarkersField,
      keymap.of([
        { key: 'Mod-s', run: saveCommand },
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      readOnlyCompartment.of([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
      ]),
      languageCompartment.of(editorLanguageExtension(props.language)),
      themeCompartment.of(themeExtension(props.dark)),
      highlightCompartment.of(highlightExtension(props.dark)),
      EditorView.updateListener.of(update => {
        if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
      }),
    ],
  });
  view = new EditorView({ state, parent: editorHost.value });
  if (props.lineMarkers) {
    view.dispatch({ effects: setGitLineMarkers.of(props.lineMarkers) });
  }
}

watch(() => props.modelValue, value => {
  if (!view || value === view.state.doc.toString()) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
});

watch(() => props.language, language => {
  view?.dispatch({ effects: languageCompartment.reconfigure(editorLanguageExtension(language)) });
});

watch(() => props.dark, dark => {
  view?.dispatch({
    effects: [
      themeCompartment.reconfigure(themeExtension(dark)),
      highlightCompartment.reconfigure(highlightExtension(dark)),
    ],
  });
});

watch(() => props.readOnly, readOnly => {
  view?.dispatch({
    effects: readOnlyCompartment.reconfigure([
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
    ]),
  });
});

function revealLine(line: number): void {
  if (!view || !Number.isFinite(line) || line < 1) return;
  const total = view.state.doc.lines;
  const target = Math.min(Math.floor(line), total);
  const pos = view.state.doc.line(target).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
}

watch(() => props.initialLine, line => {
  if (line) revealLine(line);
});

watch(() => props.lineMarkers, markers => {
  view?.dispatch({ effects: setGitLineMarkers.of(markers || null) });
});

onMounted(() => {
  createView();
  if (props.initialLine) revealLine(props.initialLine);
});
onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

defineExpose({
  focus: () => view?.focus(),
  revealLine,
});
</script>

<template>
  <div ref="editorHost" class="lightweight-editor" :class="{ 'is-read-only': readOnly }" />
</template>

<style scoped>
.lightweight-editor {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  font-size: var(--app-font-code);
  line-height: var(--app-line-height-code);
}
.lightweight-editor :deep(.cm-editor) {
  height: 100%;
}
.lightweight-editor :deep(.cm-scroller) {
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: var(--app-font-code);
  line-height: var(--app-line-height-code);
}
.lightweight-editor :deep(.cm-gutters) {
  min-width: 42px;
}
.lightweight-editor :deep(.cm-line.cm-git-line-added) {
  background: color-mix(in srgb, var(--app-success) 10%, transparent);
}
.lightweight-editor :deep(.cm-line.cm-git-line-modified) {
  background: color-mix(in srgb, var(--app-warning) 10%, transparent);
}
.lightweight-editor :deep(.cm-gutters .cm-git-line-added) {
  color: var(--app-success);
  box-shadow: inset 3px 0 0 var(--app-success);
}
.lightweight-editor :deep(.cm-gutters .cm-git-line-modified) {
  color: var(--app-warning);
  box-shadow: inset 3px 0 0 var(--app-warning);
}
/* 删除：短划线落在两行交界（上一行底边 / 首行顶边），不整行高亮 */
.lightweight-editor :deep(.cm-gutters .cm-git-deleted-tick) {
  position: relative;
}
.lightweight-editor :deep(.cm-gutters .cm-git-deleted-tick::after) {
  content: '';
  position: absolute;
  left: 5px;
  right: 6px;
  bottom: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--app-danger);
  transform: translateY(50%);
  pointer-events: none;
}
.lightweight-editor :deep(.cm-gutters .cm-git-deleted-tick-top::after) {
  top: 0;
  bottom: auto;
  transform: translateY(-50%);
}
</style>
