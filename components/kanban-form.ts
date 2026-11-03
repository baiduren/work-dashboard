// 看板客户端交互的纯逻辑（Issue #31）：
// 「拖拽事件 → 目标状态 + 目标下标」的换算、本地列数据的乐观重排与逾期判断。
// 全部为可单测的纯函数（tests/kanban-form.test.ts）；
// orderIndex 语义以 docs/01-architecture.md「接口约定」为准：**移除被拖任务后**
// 在目标列中的插入下标，与 lib/domain computeMove 的插入语义一致。
// 取值规则复用 lib/domain/task.ts，不在前端重复实现服务端校验（docs/01-architecture.md「模块边界」）。

import { startOfDay, type TaskStatus } from "@/lib/domain/task";

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

/** 列容器 droppable 的 id 前缀：区别于卡片 id（dnd-kit 里两类落点共存）。 */
const COLUMN_ID_PREFIX = "column:";

/** 某状态列的 droppable id（列空白处与空列的落点）。 */
export function columnDroppableId(status: TaskStatus): string {
  return `${COLUMN_ID_PREFIX}${status}`;
}

/** 从 droppable id 还原状态；不是列容器 id 时返回 null（可能是卡片 id）。 */
export function statusFromDroppableId(id: string): TaskStatus | null {
  if (!id.startsWith(COLUMN_ID_PREFIX)) return null;
  const status = id.slice(COLUMN_ID_PREFIX.length);
  return status === "todo" || status === "doing" || status === "done" ? status : null;
}

/** 移动请求体：POST /api/tasks/:id/move 的 body。 */
export interface DragMoveTarget {
  status: TaskStatus;
  orderIndex: number;
}

/**
 * 把 dnd-kit 拖拽事件换算成 move 接口参数（Issue #31 的纯函数抽离）。
 *
 * 输入：
 * - `idColumns`：三列任务 id 的当前展示顺序（乐观更新后的最新状态）；
 * - `activeId`：被拖任务 id；
 * - `overId`：落点 id（某张卡片 id，或列容器 id；无落点为 null）。
 *
 * 换算规则（与 docs/01-architecture.md「接口约定」的 orderIndex 语义一致）：
 * - 落点是列容器：目标列为该列，插入到列尾（空列即唯一落点）；
 *   落回**自己所在列**的容器视为原位，返回 null（不发请求）；
 * - 落点是某张卡片：按 dnd-kit sortable 约定，被拖任务占据该卡片的当前位置，
 *   即“移除被拖任务后”在目标列中的插入下标 = 该卡片在目标列的当前下标；
 * - 落点为空 / 落在被拖任务自己上（原位）/ 找不到对应列：返回 null，不调用接口。
 */
export function computeDragTarget(
  idColumns: KanbanIdColumns,
  activeId: string,
  overId: string | null | undefined,
): DragMoveTarget | null {
  if (!overId || overId === activeId) return null;

  const sourceStatus = findStatusOf(idColumns, activeId);
  if (!sourceStatus) return null;

  const containerStatus = statusFromDroppableId(overId);
  if (containerStatus) {
    if (containerStatus === sourceStatus) return null;
    return { status: containerStatus, orderIndex: idColumns[containerStatus].length };
  }

  const targetStatus = findStatusOf(idColumns, overId);
  if (!targetStatus) return null;

  const overIndex = idColumns[targetStatus].indexOf(overId);
  if (targetStatus === sourceStatus && overIndex === idColumns[sourceStatus].indexOf(activeId)) {
    return null; // 同列落回原位
  }
  return { status: targetStatus, orderIndex: overIndex };
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
  const next: KanbanColumns = {
    todo: [...columns.todo],
    doing: [...columns.doing],
    done: [...columns.done],
  };
  for (const status of Object.keys(next) as TaskStatus[]) {
    const index = next[status].findIndex((card) => card.id === activeId);
    if (index >= 0) next[status].splice(index, 1);
  }
  const column = next[target.status];
  const position = Math.min(Math.max(target.orderIndex, 0), column.length);
  const card = findCard(columns, activeId);
  if (!card) return columns; // 被拖任务不在看板数据里：原样返回，避免丢卡
  column.splice(position, 0, card);
  return next;
}

/** 截止日期早于今天 00:00 即逾期；恰为今天不算（与 lib/domain classifyForToday 同一边界）。 */
export function isOverdue(dueDate: Date | null, now: Date): boolean {
  if (dueDate === null) return false;
  return dueDate.getTime() < startOfDay(now).getTime();
}

function findStatusOf(idColumns: KanbanIdColumns, taskId: string): TaskStatus | null {
  for (const status of Object.keys(idColumns) as TaskStatus[]) {
    if (idColumns[status].includes(taskId)) return status;
  }
  return null;
}

function findCard(columns: KanbanColumns, taskId: string): KanbanCardData | null {
  for (const status of Object.keys(columns) as TaskStatus[]) {
    const card = columns[status].find((entry) => entry.id === taskId);
    if (card) return card;
  }
  return null;
}
