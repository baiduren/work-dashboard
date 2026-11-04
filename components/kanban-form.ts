// 看板客户端交互的纯逻辑（Issue #31）：
// 「拖拽事件 → 目标状态 + 目标下标」的换算、本地列数据的乐观重排与逾期判断。
// 全部为可单测的纯函数（tests/kanban-form.test.ts）；
// orderIndex 语义以 docs/01-architecture.md「接口约定」为准：**移除被拖任务后**
// 在目标列中的插入下标，与 lib/domain computeMove 的插入语义一致。
// 通用「多条可排序列表」的换算/重排实现抽在 components/drag-lists-form.ts（Issue #52），
// 今日视图复用同一套纯函数；本文件保留看板专用的 status 包装与逾期判断。

import { startOfDay, type TaskStatus } from "@/lib/domain/task";

import {
  computeDragTargetInLists,
  listDroppableId,
  listIdFromDroppableId,
  moveItemInLists,
} from "./drag-lists-form";

/** 看板卡片在客户端需要的最小展示字段（样式约定复用 components/task-list）。 */
export interface KanbanCardData {
  id: string;
  title: string;
  /** lib/domain 约束的 low | medium | high；未知取值按中性样式兜底展示。 */
  priority: string;
  dueDate: Date | null;
  /** 由 Server Component 注入的“当前时间是否逾期”，避免客户端时钟不一致（与 task-list 同一约定）。 */
  overdue: boolean;
}

/** 看板三列的客户端状态：每列按展示顺序排列的卡片。 */
export type KanbanColumns = Record<TaskStatus, KanbanCardData[]>;

/** 列内只参与排序换算的任务 id 顺序（与展示顺序一致）。 */
export type KanbanIdColumns = Record<TaskStatus, string[]>;

/** 移动请求体：POST /api/tasks/:id/move 的 body。 */
export interface DragMoveTarget {
  status: TaskStatus;
  orderIndex: number;
}

/** 某状态列的 droppable id（列空白处与空列的落点）。 */
export function columnDroppableId(status: TaskStatus): string {
  return listDroppableId(status);
}

/** 从 droppable id 还原状态；不是列容器 id 时返回 null（可能是卡片 id）。 */
export function statusFromDroppableId(id: string): TaskStatus | null {
  return parseStatusKey(listIdFromDroppableId(id));
}

/**
 * 把 dnd-kit 拖拽事件换算成 move 接口参数（Issue #31 的纯函数抽离；
 * 通用换算法在 components/drag-lists-form.ts，Issue #52 与今日视图共用）。
 *
 * 输入：
 * - `idColumns`：三列任务 id 的当前展示顺序（乐观更新后的最新状态）；
 * - `activeId`：被拖任务 id；
 * - `overId`：落点 id（某张卡片 id，或列容器 id；无落点为 null）。
 *
 * 落点为 null / 原位 / 找不到对应列时返回 null，不调用接口。
 */
export function computeDragTarget(
  idColumns: KanbanIdColumns,
  activeId: string,
  overId: string | null | undefined,
): DragMoveTarget | null {
  const target = computeDragTargetInLists(idColumns, activeId, overId);
  const status = target ? parseStatusKey(target.listId) : null;
  return target && status ? { status, orderIndex: target.orderIndex } : null;
}

/**
 * 把移动结果应用到本地列数据（乐观更新）：先从原列移除，再插入目标列的
 * `target.orderIndex` 处（越界收敛到列边界，与 lib/domain clampPosition 同规则）。
 * 返回新的列数据，不修改入参。
 */
export function moveTaskInColumns(
  columns: KanbanColumns,
  activeId: string,
  target: DragMoveTarget,
): KanbanColumns {
  const activeInColumns = Object.values(columns).some((cards) =>
    cards.some((card) => card.id === activeId),
  );
  if (!activeInColumns) return columns; // 被拖任务不在看板数据里：原样返回，避免丢卡
  const moved = moveItemInLists(columns, activeId, {
    listId: target.status,
    orderIndex: target.orderIndex,
  });
  return {
    todo: moved.todo,
    doing: moved.doing,
    done: moved.done,
  };
}

/** 截止日期早于今天 00:00 即逾期；恰为今天不算（与 lib/domain classifyForToday 同一边界）。 */
export function isOverdue(dueDate: Date | null, now: Date): boolean {
  if (dueDate === null) return false;
  return dueDate.getTime() < startOfDay(now).getTime();
}

function parseStatusKey(key: string | null): TaskStatus | null {
  return key === "todo" || key === "doing" || key === "done" ? key : null;
}
