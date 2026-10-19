import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, effectScope, ref } from 'vue';
import { useZIndex, ZINDEX_INJECTION_KEY } from 'element-plus';
import { parse } from '@vue/compiler-sfc';
import { parse as parseTemplate, NodeTypes, type RootNode, type ElementNode } from '@vue/compiler-dom';
import { useOverlayZIndex } from '../src/composables/useOverlayZIndex';

/***********************动态叠层行为*********************/
// 无需浏览器或真实窗口，直接验证自定义浮层与 Element Plus 共用的计数行为。
const app = createApp({});
app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
app.runWithContext(() => {
  const { nextZIndex } = useZIndex();
  const management = nextZIndex();
  const editor = nextZIndex();
  const subProjects = nextZIndex();
  assert(management < editor && editor < subProjects);

  const opened = ref(false);
  const scope = effectScope();
  const overlay = scope.run(() => useOverlayZIndex(() => opened.value))!;
  assert.equal(overlay.value, 0, '隐藏浮层不能提前抢占层级');
  opened.value = true;
  assert(overlay.value > subProjects, '打开的自定义浮层必须高于已有弹窗');
  const firstZIndex = overlay.value;
  const select = nextZIndex();
  const confirmation = nextZIndex();
  assert(select > overlay.value && confirmation > select, '下拉与二次确认应高于当前浮层');
  assert.equal(overlay.value, firstZIndex, '父浮层不能跟随后打开的确认框一起抬升');
  opened.value = false;
  assert.equal(overlay.value, firstZIndex, '关闭动画期间保留原层级');
  opened.value = true;
  assert(overlay.value > confirmation, '再次打开必须重新置顶');
  const reopenedZIndex = overlay.value;
  scope.stop();
  opened.value = false;
  opened.value = true;
  assert.equal(overlay.value, reopenedZIndex, '组件卸载后应停止分配层级');
});

/***********************全库对话框挂载约束*********************/
const srcRoot = resolve(process.cwd(), 'src');
const vueFiles = readdirSync(srcRoot, { recursive: true }).filter(file => String(file).endsWith('.vue'));
let dialogCount = 0;
for (const relativeFile of vueFiles) {
  const source = readFileSync(resolve(srcRoot, String(relativeFile)), 'utf8');
  const { descriptor, errors } = parse(source);
  assert.equal(errors.length, 0, String(relativeFile));
  if (!descriptor.template) continue;
  const root = parseTemplate(descriptor.template.content);
  function visit(node: RootNode | ElementNode) {
    if (node.type === NodeTypes.ELEMENT && node.tag === 'el-dialog') {
      dialogCount++;
      assert(
        node.props.some(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'append-to-body'),
        `${relativeFile} 的 Dialog 必须挂载到 body，不能被父层的 transform/backdrop-filter 困住`,
      );
      assert(
        !node.props.some(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'z-index'),
        `${relativeFile} 不能固定 Dialog 层级`,
      );
    }
    for (const child of node.children) {
      if (child.type === NodeTypes.ELEMENT) visit(child);
    }
  }
  visit(root);
}
assert(dialogCount > 20, '应覆盖整个项目的 Dialog，而非只检查当前出错的弹窗');

/***********************自定义浮层统一层级*********************/
for (const file of [
  'components/FileManager.vue',
  'components/ProjectQuickSearch.vue',
  'components/UpdateProgress.vue',
  'components/git/GitFileContextMenu.vue',
  'components/git/GitHistory.vue',
  'components/dashboard/WorkspaceSearchModal.vue',
  'components/dashboard/WorkspaceProjectExplorer.vue',
]) {
  const source = readFileSync(resolve(srcRoot, file), 'utf8');
  assert(source.includes('useOverlayZIndex'), `${file} 必须使用共享层级分配`);
  assert.match(source, /:style="[^"]*zIndex:/, `${file} 必须将动态层级绑定到浮层`);
  assert(!/z-index:\s*[2-9]\d{3,}/.test(source), `${file} 不能用固定高层级遮挡后续弹窗`);
}
const management = readFileSync(resolve(srcRoot, 'components/dashboard/ProjectManagementDialog.vue'), 'utf8');
assert(!management.includes(':teleported="false"'), '管理弹窗内的项目切换 Popover 也应脱离裁切容器');
const workspace = readFileSync(resolve(srcRoot, 'components/dashboard/ProjectWorkspace.vue'), 'utf8');
assert(!workspace.includes(':teleported="false"'), '工作区项目切换 Popover 不能留在横向滚动容器内');

console.log(`overlay layering tests passed (${dialogCount} dialogs audited)`);
