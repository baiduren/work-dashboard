// 通用拖拽排序纯逻辑（Issue #52）：把「一组可排序列表 + 被拖条目 + 落点」换算成
// 「目标列表 + 插入下标」，并把移动结果应用到本地列表数据（乐观更新）。
// 看板（components/kanban-form.ts，Issue #31）与今日视图（Issue #52）共用这一套实现，
// 避免两份相似逻辑漂移；列表 key 在调用方解释（看板是 status，今日是 today/overdue/undated）。
//
// orderIndex 语义以 docs/01-architecture.md「接口约定」为准：**移除被拖条目后**
// 在目标列表中的插入下标（0 起始，越界收敛到列表边界），与 lib/domain computeMove 一致。

/** 一次拖拽换算结果：目标列表 key + 插入下标。 */
export interface DragListTarget {
  listId: string;
  orderIndex: number;
}

/** 多条列表的条目 id 展示顺序（key → id 数组）。 */
export type DragIdLists = Record<string, readonly string[]>;

/** 列表容器 droppable 的 id 前缀：区别于条目 id（dnd-kit 里两类落点共存）。 */
const LIST_ID_PREFIX = "column:";

/** 某列表的 droppable id（列表空白处与空列表的落点）。 */
export function listDroppableId(listId: string): string {
  return `${LIST_ID_PREFIX}${listId}`;
}

/** 从 droppable id 还原列表 key；不是列表容器 id 时返回 null（可能是条目 id）。 */
export function listIdFromDroppableId(id: string): string | null {
  return id.startsWith(LIST_ID_PREFIX) ? id.slice(LIST_ID_PREFIX.length) : null;
}

/**
 * 把 dnd-kit 拖拽事件换算成目标列表 + 插入下标。
 *
 * 换算规则（与 docs/01-architecture.md「接口约定」的 orderIndex 语义一致）：
 * - 落点是列表容器：目标列表为该列表，插入到列表尾（空列表即唯一落点）；
 *   落回**自己所在列表**的容器视为原位，返回 null（不发请求）；
 * - 落点是某个条目：按 dnd-kit sortable 约定，被拖条目占据该条目的当前位置，
 *   即“移除被拖条目后”在目标列表中的插入下标 = 该条目在目标列表的当前下标；
 * - 落点为空 / 落在被拖条目自己上（原位）/ 找不到对应列表：返回 null，不调用接口。
 */
export function computeDragTargetInLists(
  idLists: DragIdLists,
  activeId: string,
  overId: string | null | undefined,
): DragListTarget | null {
  if (!overId || overId === activeId) return null;

  const sourceList = findListOf(idLists, activeId);
  if (!sourceList) return null;

  const overList = listIdFromDroppableId(overId);
  if (overList !== null) {
    const list = idLists[overList];
    if (!list) return null;
    if (overList === sourceList) return null;
    return { listId: overList, orderIndex: list.length };
  }

  const targetList = findListOf(idLists, overId);
  if (!targetList) return null;

  const overIndex = idLists[targetList].indexOf(overId);
  if (targetList === sourceList && overIndex === idLists[sourceList].indexOf(activeId)) {
    return null; // 同列表落回原位
  }
  return { listId: targetList, orderIndex: overIndex };
}

/**
 * 把移动结果应用到本地列表数据（乐观更新）：先从原列表移除，再插入目标列表的
 * `target.orderIndex` 处（越界收敛到列表边界，与 lib/domain clampPosition 同规则）。
 * 返回新的列表数据，不修改入参；被拖条目不在数据里时原样返回（避免丢卡片）。
 */
export function moveItemInLists<T extends { id: string }>(
  lists: Record<string, readonly T[]>,
  activeId: string,
  target: DragListTarget,
): Record<string, T[]> {
  const next: Record<string, T[]> = {};
  for (const [listId, entries] of Object.entries(lists)) {
    next[listId] = [...entries];
  }

  let active: T | undefined;
  for (const entries of Object.values(next)) {
    const index = entries.findIndex((entry) => entry.id === activeId);
    if (index >= 0) {
      active = entries.splice(index, 1)[0];
      break;
    }
  }
  if (!active) return next;

  const column = next[target.listId];
  if (!column) return next; // 目标列表不存在：保持移除后的结果不丢条目
  const position = Math.min(Math.max(target.orderIndex, 0), column.length);
  column.splice(position, 0, active);
  return next;
}

function findListOf(idLists: DragIdLists, entryId: string): string | null {
  for (const [listId, ids] of Object.entries(idLists)) {
    if (ids.includes(entryId)) return listId;
  }
  return null;
}
