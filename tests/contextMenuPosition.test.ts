import assert from 'node:assert/strict';
import { clampContextMenuPosition, positionContextSubmenu } from '../src/utils/contextMenuPosition';

const viewport = { width: 800, height: 600 };

assert.deepEqual(
  clampContextMenuPosition(780, 590, 220, 320, viewport),
  { left: 572, top: 272 },
  'main menu should stay inside the viewport',
);

assert.equal(
  positionContextSubmenu({ left: 200, top: 100, width: 100, height: 28 }, 210, 300, viewport).side,
  'right',
  'submenu should open right when there is enough space',
);

const flipped = positionContextSubmenu({ left: 700, top: 500, width: 80, height: 28 }, 210, 300, viewport);
assert.equal(flipped.side, 'left', 'submenu should flip left near the right edge');
assert.ok(flipped.left >= 4 && flipped.left + 210 <= 796, 'flipped submenu should remain horizontal');
assert.ok(flipped.top >= 4 && flipped.top + 300 <= 596, 'submenu should remain vertical');

console.log('contextMenuPosition tests passed');
