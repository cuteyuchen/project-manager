import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const theme = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8');

function readSourceTree(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .map(entry => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return readSourceTree(path);
      return /\.(css|ts|tsx|vue)$/.test(entry.name) ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

function tokenValue(source: string, name: string): number {
  const match = source.match(new RegExp(`--${name}:\\s*([0-9.]+)px`));
  assert(match, `missing typography token --${name}`);
  return Number(match[1]);
}

function selectorBlock(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert(match, `missing selector ${selector}`);
  return match[1];
}

const source = readSourceTree(resolve(root, 'src'));
const standard = {
  caption: tokenValue(theme, 'app-font-caption'),
  meta: tokenValue(theme, 'app-font-meta'),
  control: tokenValue(theme, 'app-font-control'),
  body: tokenValue(theme, 'app-font-body'),
  subheading: tokenValue(theme, 'app-font-subheading'),
  section: tokenValue(theme, 'app-font-section-title'),
  pageTitle: tokenValue(theme, 'app-font-page-title'),
  console: tokenValue(theme, 'app-font-console'),
  code: tokenValue(theme, 'app-font-code'),
};

assert(standard.caption >= 12);
assert(standard.meta >= 12);
assert(standard.control >= 13);
assert(standard.body >= 14);
assert(standard.console >= 13);
assert(standard.code >= 14);
assert.match(theme, /--app-line-height-console:\s*1\.55/);
assert.match(theme, /--app-line-height-code:\s*1\.55/);

const compact = selectorBlock(theme, "html[data-ui-size='compact']");
const comfortable = selectorBlock(theme, "html[data-ui-size='comfortable']");
assert(Number(compact.match(/--app-font-body:\s*([0-9.]+)px/)?.[1]) >= 13);
assert(Number(compact.match(/--app-font-code:\s*([0-9.]+)px/)?.[1]) >= 13);
assert(Number(comfortable.match(/--app-font-body:\s*([0-9.]+)px/)?.[1]) > standard.body);
assert(Number(comfortable.match(/--app-font-control:\s*([0-9.]+)px/)?.[1]) > standard.control);
assert(Number(comfortable.match(/--app-font-code:\s*([0-9.]+)px/)?.[1]) > standard.code);

for (const className of [
  'app-text-caption',
  'app-text-meta',
  'app-text-control',
  'app-text-body',
  'app-text-subheading',
  'app-text-section-title',
  'app-text-page-title',
  'app-text-console',
  'app-text-code',
]) {
  assert.match(theme, new RegExp(`\\.${className}\\s*\\{`), `${className} must be defined`);
}

assert.match(theme, /--el-font-size-extra-small:\s*var\(--app-font-caption\)/);
assert.match(theme, /--el-font-size-small:\s*var\(--app-font-control\)/);
assert.match(theme, /--el-font-size-base:\s*var\(--app-font-body\)/);
assert.match(theme, /--el-font-size-medium:\s*var\(--app-font-section-title\)/);

assert(!/text-\[(?:9|10|11)px\]|font-size:\s*(?:9|10|11)px/.test(source), '9/10/11px user text must not return');
assert(!/\bzoom\s*:/.test(theme), 'global zoom is not an interface sizing strategy');
assert(!/html\s*\{[^}]*transform\s*:\s*scale\(/s.test(theme), 'html must not use transform scaling');
assert(!/body\s*\{[^}]*transform\s*:\s*scale\(/s.test(theme), 'body must not use transform scaling');
assert(!/html\s*\{[^}]*font-size\s*:/s.test(theme), 'html font-size must remain untouched');

const consoleView = readFileSync(resolve(root, 'src/components/ConsoleView.vue'), 'utf8');
const fileTree = readFileSync(resolve(root, 'src/components/dashboard/FileTreeNode.vue'), 'utf8');
const projectExplorer = readFileSync(resolve(root, 'src/components/dashboard/ProjectExplorerNode.vue'), 'utf8');
const editor = readFileSync(resolve(root, 'src/components/dashboard/LightweightEditor.vue'), 'utf8');
const gitFileList = readFileSync(resolve(root, 'src/components/git/GitCommitFileList.vue'), 'utf8');
const gitStyles = readFileSync(resolve(root, 'src/styles/git-ui.css'), 'utf8');

assert.match(consoleView, /app-text-console/);
assert.match(theme, /\.app-text-console\s*\{[\s\S]*?font-size:\s*var\(--app-font-console\)/);
assert.match(fileTree, /\.explorer-file-name[\s\S]*font-size:\s*var\(--app-font-control\)/);
assert.match(projectExplorer, /\.explorer-row[\s\S]*font-size:\s*var\(--app-font-control\)/);
assert.match(editor, /font-size:\s*var\(--app-font-code\)/);
assert.match(gitFileList, /git-commit-files app-text-control/);
assert.match(gitStyles, /\.git-diff-body[\s\S]*font-size:\s*var\(--app-font-console\)/);

console.log('uiTypographyBaseline tests passed');
