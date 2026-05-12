import { calculateDraggedItemCenterY, calculateDraggedItemTranslateY, calculateFlipTransforms } from '../src/utils/dragPosition.ts';

/***********************测试辅助函数*********************/

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

/***********************拖拽元素位置计算*********************/

{
  const translateY = calculateDraggedItemTranslateY({
    pointerClientY: 260,
    listClientTop: 100,
    pointerOffsetY: 20,
    itemOffsetTop: 120,
  });

  assert(translateY === 20, 'dragged item should stay under the pointer after DOM reorder changes offsetTop');
}

{
  const centerY = calculateDraggedItemCenterY({
    itemOffsetTop: 120,
    itemHeight: 48,
    translateY: 20,
  });

  assert(centerY === 164, 'dragged item center should include current translate and half item height');
}

/***********************项目换位动画计算*********************/

{
  const transforms = calculateFlipTransforms({
    oldPositions: [
      { id: 'a', top: 0 },
      { id: 'b', top: 56 },
      { id: 'c', top: 112 },
    ],
    newPositions: [
      { id: 'b', top: 0 },
      { id: 'c', top: 56 },
      { id: 'a', top: 112 },
    ],
    excludedId: 'a',
  });

  assert(transforms.get('b') === 56, 'item b should animate downward from its old position');
  assert(transforms.get('c') === 56, 'item c should animate downward from its old position');
  assert(!transforms.has('a'), 'dragged item should not receive FLIP animation');
}

console.log('dragPosition tests passed');
