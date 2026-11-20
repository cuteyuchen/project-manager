import type { Extension } from '@codemirror/state';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorLanguage } from './editorLanguage';
import { buildWorkspacePathIndex } from './workspaceSearchIndex';

/***********************语言关键字与常用代码片段 (Snippets)*********************/

function kw(label: string, detail = 'keyword'): Completion {
  return { label, type: 'keyword', detail, boost: 40 };
}

function snip(template: string, label: string, detail: string, info?: string): Completion {
  return snippetCompletion(template, {
    label,
    detail,
    info,
    type: 'snippet',
    boost: 85,
  });
}

function api(label: string, type: 'function' | 'variable' | 'class' | 'type' | 'property' | 'keyword' = 'function', detail = 'api'): Completion {
  return { label, type, detail, boost: 30 };
}

// JS / TS / Vue 共有核心语法与标准库
const JS_TS_BASE: Completion[] = [
  kw('const'), kw('let'), kw('var'), kw('function'), kw('return'),
  kw('async'), kw('await'), kw('import'), kw('export'), kw('from'),
  kw('default'), kw('class'), kw('extends'), kw('interface'), kw('type'),
  kw('enum'), kw('implements'), kw('try'), kw('catch'), kw('finally'),
  kw('throw'), kw('if'), kw('else'), kw('switch'), kw('case'),
  kw('break'), kw('continue'), kw('for'), kw('while'), kw('do'),
  kw('new'), kw('this'), kw('super'), kw('typeof'), kw('instanceof'),
  kw('void'), kw('yield'), kw('null'), kw('undefined'), kw('true'), kw('false'),

  api('console', 'class', 'Console API'),
  api('Promise', 'class', 'ES Promise'),
  api('JSON', 'class', 'JSON global'),
  api('Math', 'class', 'Math global'),
  api('Object', 'class', 'Object global'),
  api('Array', 'class', 'Array global'),
  api('String', 'class', 'String global'),
  api('Number', 'class', 'Number global'),
  api('Boolean', 'class', 'Boolean global'),
  api('Map', 'class', 'Map global'),
  api('Set', 'class', 'Set global'),
  api('setTimeout', 'function', 'Timer API'),
  api('clearTimeout', 'function', 'Timer API'),
  api('setInterval', 'function', 'Timer API'),
  api('clearInterval', 'function', 'Timer API'),
  api('window', 'variable', 'Window global'),
  api('document', 'variable', 'Document global'),

  snip('console.log(${1});', 'clg', 'console.log(...)'),
  snip('console.error(${1});', 'cer', 'console.error(...)'),
  snip('console.warn(${1});', 'cwn', 'console.warn(...)'),
  snip("import { ${1} } from '${2}';", 'imp', "import { ... } from '...'"),
  snip("import ${1} from '${2}';", 'impd', "import default from '...'"),
  snip('export default ${1};', 'edef', 'export default ...'),
  snip('const ${1:name} = async (${2}) => {\n  ${3}\n};', 'afn', 'async arrow function'),
  snip('function ${1:name}(${2}) {\n  ${3}\n}', 'fn', 'function declaration'),
  snip('try {\n  ${1}\n} catch (error) {\n  ${2:console.error(error);}\n}', 'try', 'try-catch block'),
];

// Vue 3 核心组合式 API 与模板指令
const VUE_BASE: Completion[] = [
  ...JS_TS_BASE,
  api('ref', 'function', 'Vue Reactivity'),
  api('reactive', 'function', 'Vue Reactivity'),
  api('computed', 'function', 'Vue Reactivity'),
  api('watch', 'function', 'Vue Reactivity'),
  api('watchEffect', 'function', 'Vue Reactivity'),
  api('onMounted', 'function', 'Vue Lifecycle'),
  api('onUnmounted', 'function', 'Vue Lifecycle'),
  api('onActivated', 'function', 'Vue Lifecycle'),
  api('onDeactivated', 'function', 'Vue Lifecycle'),
  api('defineProps', 'function', 'Vue Compiler Macro'),
  api('defineEmits', 'function', 'Vue Compiler Macro'),
  api('defineExpose', 'function', 'Vue Compiler Macro'),
  api('nextTick', 'function', 'Vue Utility'),
  api('toRef', 'function', 'Vue Reactivity'),
  api('toRefs', 'function', 'Vue Reactivity'),
  api('shallowRef', 'function', 'Vue Reactivity'),
  api('provide', 'function', 'Vue Dependency Injection'),
  api('inject', 'function', 'Vue Dependency Injection'),

  snip('const ${1:name} = ref(${2});', 'vref', 'const name = ref(...)'),
  snip('const ${1:name} = reactive({\n  ${2}\n});', 'vreact', 'const name = reactive({...})'),
  snip('const ${1:name} = computed(() => ${2});', 'vcomp', 'const name = computed(...)'),
  snip('watch(() => ${1:source}, (${2:value}) => {\n  ${3}\n});', 'vwatch', 'watch(() => source, callback)'),
  snip('onMounted(() => {\n  ${1}\n});', 'vonmounted', 'onMounted hook'),
  snip('v-for="${1:item} in ${2:items}" :key="${3:item.id}"', 'vfor', 'v-for directive'),
  snip('v-if="${1:condition}"', 'vif', 'v-if directive'),
  snip('@click="${1:handler}"', 'vclick', '@click event handler'),
];

// HTML / 模板补全
const HTML_BASE: Completion[] = [
  kw('div'), kw('span'), kw('p'), kw('a'), kw('button'), kw('input'),
  kw('form'), kw('ul'), kw('ol'), kw('li'), kw('table'), kw('tr'),
  kw('td'), kw('th'), kw('header'), kw('footer'), kw('nav'), kw('section'),
  kw('template'), kw('slot'), kw('component'), kw('style'), kw('script'),

  api('class', 'property', 'HTML Attribute'),
  api('id', 'property', 'HTML Attribute'),
  api('style', 'property', 'HTML Attribute'),
  api('src', 'property', 'HTML Attribute'),
  api('href', 'property', 'HTML Attribute'),
  api('placeholder', 'property', 'HTML Attribute'),
  api('disabled', 'property', 'HTML Attribute'),
  api('type', 'property', 'HTML Attribute'),
  api('v-if', 'property', 'Vue Directive'),
  api('v-else-if', 'property', 'Vue Directive'),
  api('v-else', 'property', 'Vue Directive'),
  api('v-for', 'property', 'Vue Directive'),
  api('v-model', 'property', 'Vue Directive'),
  api('v-show', 'property', 'Vue Directive'),
  api('@click', 'property', 'Vue Event'),
  api('@change', 'property', 'Vue Event'),
  api('@input', 'property', 'Vue Event'),
  api('@submit', 'property', 'Vue Event'),
];

// CSS / SCSS 常用属性与取值
const CSS_BASE: Completion[] = [
  kw('display'), kw('position'), kw('flex'), kw('flex-direction'),
  kw('justify-content'), kw('align-items'), kw('gap'), kw('width'),
  kw('height'), kw('min-width'), kw('min-height'), kw('max-width'),
  kw('max-height'), kw('margin'), kw('padding'), kw('border'),
  kw('border-radius'), kw('background'), kw('background-color'),
  kw('color'), kw('font-size'), kw('font-weight'), kw('line-height'),
  kw('text-align'), kw('opacity'), kw('overflow'), kw('z-index'),
  kw('cursor'), kw('box-shadow'), kw('transition'), kw('transform'),

  api('none', 'variable', 'CSS Value'),
  api('block', 'variable', 'CSS Value'),
  api('inline-block', 'variable', 'CSS Value'),
  api('flex', 'variable', 'CSS Value'),
  api('grid', 'variable', 'CSS Value'),
  api('absolute', 'variable', 'CSS Value'),
  api('relative', 'variable', 'CSS Value'),
  api('fixed', 'variable', 'CSS Value'),
  api('sticky', 'variable', 'CSS Value'),
  api('pointer', 'variable', 'CSS Value'),
  api('center', 'variable', 'CSS Value'),
  api('space-between', 'variable', 'CSS Value'),
  api('auto', 'variable', 'CSS Value'),
  api('transparent', 'variable', 'CSS Value'),

  snip('display: flex;\njustify-content: center;\nalign-items: center;', 'fcenter', 'Flexbox center'),
  snip('transition: all 0.2s ease;', 'trans', 'Standard transition'),
];

// Python 核心语法
const PYTHON_BASE: Completion[] = [
  kw('def'), kw('class'), kw('import'), kw('from'), kw('return'),
  kw('if'), kw('elif'), kw('else'), kw('for'), kw('while'),
  kw('try'), kw('except'), kw('finally'), kw('raise'), kw('with'),
  kw('as'), kw('pass'), kw('break'), kw('continue'), kw('lambda'),
  kw('yield'), kw('async'), kw('await'), kw('assert'), kw('self'),
  kw('True'), kw('False'), kw('None'),

  api('print', 'function', 'Built-in function'),
  api('len', 'function', 'Built-in function'),
  api('range', 'function', 'Built-in function'),
  api('list', 'class', 'Built-in type'),
  api('dict', 'class', 'Built-in type'),
  api('set', 'class', 'Built-in type'),
  api('str', 'class', 'Built-in type'),
  api('int', 'class', 'Built-in type'),
  api('float', 'class', 'Built-in type'),
  api('open', 'function', 'Built-in function'),

  snip("if __name__ == '__main__':\n    ${1:main()}", 'main', "if __name__ == '__main__'"),
  snip('def ${1:func_name}(${2}):\n    ${3:pass}', 'def', 'def func(...):'),
];

// Rust 核心语法
const RUST_BASE: Completion[] = [
  kw('fn'), kw('let'), kw('mut'), kw('pub'), kw('struct'),
  kw('enum'), kw('impl'), kw('trait'), kw('match'), kw('if'),
  kw('else'), kw('for'), kw('while'), kw('loop'), kw('return'),
  kw('break'), kw('continue'), kw('use'), kw('mod'), kw('crate'),
  kw('super'), kw('self'), kw('Self'), kw('type'), kw('const'),
  kw('static'), kw('async'), kw('await'), kw('where'),

  api('Option', 'type', 'core::option'),
  api('Result', 'type', 'core::result'),
  api('Some', 'variable', 'Option::Some'),
  api('None', 'variable', 'Option::None'),
  api('Ok', 'variable', 'Result::Ok'),
  api('Err', 'variable', 'Result::Err'),
  api('String', 'type', 'alloc::string'),
  api('Vec', 'type', 'alloc::vec'),

  snip('println!("${1}");', 'pln', 'println!(...)'),
  snip('pub fn ${1:name}(${2}) -> ${3:()} {\n    ${4}\n}', 'pfn', 'pub fn name(...)'),
];

// Go 核心语法
const GO_BASE: Completion[] = [
  kw('func'), kw('package'), kw('import'), kw('return'), kw('var'),
  kw('const'), kw('type'), kw('struct'), kw('interface'), kw('if'),
  kw('else'), kw('for'), kw('range'), kw('switch'), kw('case'),
  kw('default'), kw('select'), kw('chan'), kw('go'), kw('defer'),
  kw('nil'), kw('true'), kw('false'),

  api('make', 'function', 'Built-in function'),
  api('new', 'function', 'Built-in function'),
  api('len', 'function', 'Built-in function'),
  api('append', 'function', 'Built-in function'),

  snip('if err != nil {\n\treturn ${1:err}\n}', 'iferr', 'if err != nil'),
  snip('func ${1:name}(${2}) ${3} {\n\t${4}\n}', 'fn', 'func name(...)'),
];

// SQL 常用关键词
const SQL_BASE: Completion[] = [
  kw('SELECT'), kw('FROM'), kw('WHERE'), kw('INSERT INTO'), kw('UPDATE'),
  kw('DELETE'), kw('JOIN'), kw('LEFT JOIN'), kw('INNER JOIN'), kw('GROUP BY'),
  kw('ORDER BY'), kw('HAVING'), kw('LIMIT'), kw('OFFSET'), kw('AND'),
  kw('OR'), kw('NOT'), kw('IN'), kw('LIKE'), kw('IS NULL'), kw('AS'),
  kw('CREATE TABLE'), kw('DROP TABLE'), kw('ALTER TABLE'),
];

// Shell 常用指令
const SHELL_BASE: Completion[] = [
  kw('echo'), kw('exit'), kw('if'), kw('then'), kw('elif'),
  kw('else'), kw('fi'), kw('for'), kw('in'), kw('do'), kw('done'),
  kw('while'), kw('case'), kw('esac'), kw('export'), kw('source'),
  kw('cd'), kw('pwd'), kw('mkdir'), kw('rm'), kw('cp'), kw('mv'),
  kw('cat'), kw('grep'), kw('sed'), kw('awk'), kw('curl'),
];

// JSON 常用键名
const JSON_BASE: Completion[] = [
  api('name', 'property', 'JSON property'),
  api('version', 'property', 'JSON property'),
  api('description', 'property', 'JSON property'),
  api('main', 'property', 'JSON property'),
  api('scripts', 'property', 'JSON property'),
  api('dependencies', 'property', 'JSON property'),
  api('devDependencies', 'property', 'JSON property'),
  api('compilerOptions', 'property', 'tsconfig property'),
];

export function getLanguageCompletions(language: EditorLanguage): Completion[] {
  switch (language) {
    case 'vue': return VUE_BASE;
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx': return JS_TS_BASE;
    case 'html': return HTML_BASE;
    case 'css': return CSS_BASE;
    case 'python': return PYTHON_BASE;
    case 'rust': return RUST_BASE;
    case 'go': return GO_BASE;
    case 'sql': return SQL_BASE;
    case 'shell': return SHELL_BASE;
    case 'json': return JSON_BASE;
    default: return [];
  }
}

/***********************当前文档上下文词法提取 (Document Context)*********************/

/** 从当前文档全文中提取所有已有标识符作为上下文候选 */
export function extractDocumentWords(docText: string, currentWord: string): Completion[] {
  const wordRegex = /[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g;
  const words = new Set<string>();
  const lowerCurrent = currentWord.toLowerCase();

  let match: RegExpExecArray | null;
  // 避免在超大文件中无限循环，最多扫描前 5000 处匹配
  let count = 0;
  while ((match = wordRegex.exec(docText)) !== null && count < 5000) {
    count++;
    const w = match[0];
    if (w.toLowerCase() !== lowerCurrent && w.length >= 3 && !/^\d+$/.test(w)) {
      words.add(w);
      if (words.size >= 400) break;
    }
  }

  const results: Completion[] = [];
  for (const label of words) {
    results.push({
      label,
      type: 'variable',
      detail: '(local)',
      boost: 15,
    });
  }
  return results;
}

/***********************路径引用自动补全 (Path Autocompletion)*********************/

/** 判断是否正在输入导入或引用路径，并返回候选文件列表 */
export async function getPathCompletions(
  projectPath: string,
  currentRelativePath: string,
  pathQuery: string,
): Promise<Completion[] | null> {
  if (!projectPath) return null;

  try {
    const index = await buildWorkspacePathIndex(projectPath);
    const currentDir = currentRelativePath.includes('/')
      ? currentRelativePath.substring(0, currentRelativePath.lastIndexOf('/'))
      : '';

    // 解析目标目录基准
    let targetDir = currentDir;

    if (pathQuery.startsWith('@/') || pathQuery.startsWith('~/')) {
      const rest = pathQuery.slice(2);
      const lastSlash = rest.lastIndexOf('/');
      if (lastSlash >= 0) {
        targetDir = `src/${rest.substring(0, lastSlash)}`;
      } else {
        targetDir = 'src';
      }
    } else if (pathQuery.startsWith('/')) {
      const rest = pathQuery.slice(1);
      const lastSlash = rest.lastIndexOf('/');
      if (lastSlash >= 0) {
        targetDir = rest.substring(0, lastSlash);
      } else {
        targetDir = '';
      }
    } else if (pathQuery.startsWith('./') || pathQuery.startsWith('../')) {
      const lastSlash = pathQuery.lastIndexOf('/');
      const dirPart = pathQuery.substring(0, lastSlash);

      // 计算目标目录
      const combined = currentDir ? `${currentDir}/${dirPart}` : dirPart;
      const parts = combined.replace(/\\/g, '/').split('/');
      const stack: string[] = [];
      for (const p of parts) {
        if (!p || p === '.') continue;
        if (p === '..') {
          if (stack.length > 0) stack.pop();
        } else {
          stack.push(p);
        }
      }
      targetDir = stack.join('/');
    } else {
      return null;
    }

    const normTargetDir = targetDir.toLowerCase();
    const suggestions: Completion[] = [];
    const seen = new Set<string>();

    for (const entry of index.entries) {
      const entryRel = entry.relativePath.replace(/\\/g, '/');
      const entryDir = entryRel.includes('/')
        ? entryRel.substring(0, entryRel.lastIndexOf('/')).toLowerCase()
        : '';

      if (entryDir === normTargetDir) {
        const fileName = entry.name;
        if (!seen.has(fileName)) {
          seen.add(fileName);
          suggestions.push({
            label: fileName,
            type: entry.isDirectory ? 'folder' : 'file',
            detail: entry.isDirectory ? '(folder)' : '(file)',
            boost: 95,
            apply: entry.isDirectory ? `${fileName}/` : fileName,
          });
        }
      }
    }

    return suggestions;
  } catch {
    return null;
  }
}

/***********************整合自动联想源 (CompletionSource)*********************/

export interface EditorAutocompleteOptions {
  getLanguage: () => EditorLanguage;
  getProjectPath: () => string;
  getCurrentPath: () => string;
}

export function createEditorAutocompleteSource(options: EditorAutocompleteOptions): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    // 1. 优先检测是否为路径联想 (处于引号中且输入了 ./ 或 ../ 或 @/ 或 ~/)
    const pathMatch = context.matchBefore(/(?:['"`]|url\(\s*['"]?)(?:@\/|~\/|\.{1,2}\/|\/)[^'"`)]*$/);
    if (pathMatch) {
      // 提取路径起始位置 (跳过引号与 url( 前缀)
      const quoteIndex = Math.max(
        pathMatch.text.lastIndexOf("'"),
        pathMatch.text.lastIndexOf('"'),
        pathMatch.text.lastIndexOf('`'),
        pathMatch.text.lastIndexOf('('),
      );
      const rawPathQuery = quoteIndex >= 0 ? pathMatch.text.substring(quoteIndex + 1) : pathMatch.text;
      const pathFrom = pathMatch.from + (quoteIndex >= 0 ? quoteIndex + 1 : 0);

      const pathCompletions = await getPathCompletions(
        options.getProjectPath(),
        options.getCurrentPath(),
        rawPathQuery,
      );

      if (pathCompletions && pathCompletions.length > 0) {
        const lastSlash = rawPathQuery.lastIndexOf('/');
        const fromPos = lastSlash >= 0 ? pathFrom + lastSlash + 1 : pathFrom;
        return {
          from: fromPos,
          options: pathCompletions,
          filter: true,
        };
      }
    }

    // 2. 普通标识符 / 关键字 / 片段联想
    const word = context.matchBefore(/[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (!word && !context.explicit) return null;

    const from = word ? word.from : context.pos;
    const currentWord = word ? word.text : '';

    // 获取当前语言预置关键字与代码片段
    const langCompletions = getLanguageCompletions(options.getLanguage());

    // 扫描提取当前文档上下文标识符（大文件只截取光标邻近区域，保证按键 0 延迟）
    let docSlice: string;
    if (context.state.doc.length > 80_000) {
      const fromPos = Math.max(0, context.pos - 40_000);
      const toPos = Math.min(context.state.doc.length, context.pos + 40_000);
      docSlice = context.state.doc.sliceString(fromPos, toPos);
    } else {
      docSlice = context.state.doc.toString();
    }
    const docWords = extractDocumentWords(docSlice, currentWord);

    // 合并并按 label 去重 (语言专属词库优先)
    const seen = new Set<string>();
    const merged: Completion[] = [];

    for (const item of langCompletions) {
      if (!seen.has(item.label)) {
        seen.add(item.label);
        merged.push(item);
      }
    }

    for (const item of docWords) {
      if (!seen.has(item.label)) {
        seen.add(item.label);
        merged.push(item);
      }
    }

    return {
      from,
      options: merged,
      validFor: /^[a-zA-Z_$][a-zA-Z0-9_$]*$/,
    };
  };
}

/** 创建自动联想全套扩展 (包含自动闭合括号、Tab/Enter快捷键与词法联想) */
export function createEditorAutocompleteExtension(options: EditorAutocompleteOptions): Extension {
  return [
    autocompletion({
      override: [createEditorAutocompleteSource(options)],
      activateOnTyping: true,
      maxRenderedOptions: 30,
    }),
    closeBrackets(),
  ];
}

export { completionKeymap, closeBracketsKeymap };
