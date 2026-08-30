import assert from 'node:assert/strict';
import {
  clampWorkspaceExplorerWidth,
  persistWorkspaceExplorerWidth,
  readWorkspaceExplorerWidth,
  WORKSPACE_EXPLORER_DEFAULT_WIDTH,
  WORKSPACE_EXPLORER_MAX_WIDTH,
  WORKSPACE_EXPLORER_MIN_WIDTH,
} from '../src/utils/workspaceExplorerLayout';

assert.equal(clampWorkspaceExplorerWidth(undefined), WORKSPACE_EXPLORER_DEFAULT_WIDTH);
assert.equal(clampWorkspaceExplorerWidth(100), WORKSPACE_EXPLORER_MIN_WIDTH);
assert.equal(clampWorkspaceExplorerWidth(900), WORKSPACE_EXPLORER_MAX_WIDTH);
assert.equal(clampWorkspaceExplorerWidth(400), 400);
assert.equal(clampWorkspaceExplorerWidth(400.6), 401);

const settings: { workspaceExplorerWidth?: unknown } = {};
assert.equal(readWorkspaceExplorerWidth(settings), WORKSPACE_EXPLORER_DEFAULT_WIDTH);
assert.equal(persistWorkspaceExplorerWidth(settings, 400), 400);
assert.equal(readWorkspaceExplorerWidth(settings), 400);
assert.equal(persistWorkspaceExplorerWidth(settings, 100), WORKSPACE_EXPLORER_MIN_WIDTH);
assert.equal(persistWorkspaceExplorerWidth(settings, 900), WORKSPACE_EXPLORER_MAX_WIDTH);

console.log('workspaceExplorerLayout tests passed');
