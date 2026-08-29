<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { vue } from '@codemirror/lang-vue';
import type { EditorLanguage } from '../../utils/editorLanguage';

const props = withDefaults(defineProps<{
  modelValue: string;
  language: EditorLanguage;
  readOnly?: boolean;
  dark?: boolean;
}>(), {
  readOnly: false,
  dark: true,
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

function languageExtension(language: EditorLanguage): Extension {
  switch (language) {
    case 'typescript': return javascript({ typescript: true });
    case 'javascript': return javascript();
    case 'jsx': return javascript({ jsx: true });
    case 'tsx': return javascript({ jsx: true, typescript: true });
    case 'json': return json();
    case 'html': return html();
    case 'css': return css();
    case 'markdown': return markdown();
    case 'vue': return vue({ base: html() });
    default: return [];
  }
}

function themeExtension(dark: boolean): Extension {
  return EditorView.theme({
    '&': {
      color: dark ? '#d7dee8' : '#263241',
      backgroundColor: dark ? '#151a21' : '#ffffff',
      height: '100%',
    },
    '.cm-content': { caretColor: dark ? '#8bc8ff' : '#2167a7' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: dark ? '#8bc8ff' : '#2167a7' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: dark ? '#11161c' : '#f5f7fa',
      color: dark ? '#667384' : '#8b96a5',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: dark ? '#1b2430' : '#eef4fa' },
    '.cm-activeLineGutter': { backgroundColor: dark ? '#1b2430' : '#e7eff8' },
    '.cm-selectionBackground, ::selection': { backgroundColor: dark ? '#294b6b' : '#cfe4fb' },
    '.cm-panels': { backgroundColor: dark ? '#1b222c' : '#f7f9fb', color: 'inherit' },
    '.cm-search': { padding: '8px', borderBottom: `1px solid ${dark ? '#303b48' : '#d9e0e8'}` },
    '.cm-button': { color: 'inherit', backgroundColor: dark ? '#273342' : '#ffffff', border: `1px solid ${dark ? '#46586c' : '#cbd5e1'}` },
    '.cm-textfield': { color: 'inherit', backgroundColor: dark ? '#11161c' : '#ffffff', border: `1px solid ${dark ? '#46586c' : '#cbd5e1'}` },
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
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      search({ top: true }),
      highlightSelectionMatches(),
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
      languageCompartment.of(languageExtension(props.language)),
      themeCompartment.of(themeExtension(props.dark)),
      EditorView.updateListener.of(update => {
        if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
      }),
    ],
  });
  view = new EditorView({ state, parent: editorHost.value });
}

watch(() => props.modelValue, value => {
  if (!view || value === view.state.doc.toString()) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
});

watch(() => props.language, language => {
  view?.dispatch({ effects: languageCompartment.reconfigure(languageExtension(language)) });
});

watch(() => props.dark, dark => {
  view?.dispatch({ effects: themeCompartment.reconfigure(themeExtension(dark)) });
});

watch(() => props.readOnly, readOnly => {
  view?.dispatch({
    effects: readOnlyCompartment.reconfigure([
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
    ]),
  });
});

onMounted(createView);
onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

defineExpose({
  focus: () => view?.focus(),
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
  font-size: 13px;
}
.lightweight-editor :deep(.cm-editor) {
  height: 100%;
}
.lightweight-editor :deep(.cm-scroller) {
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  line-height: 1.55;
}
.lightweight-editor :deep(.cm-gutters) {
  min-width: 42px;
}
</style>
