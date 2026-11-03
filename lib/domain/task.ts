// 任务领域逻辑（docs/01-architecture.md「模块边界」）：纯函数、可单测、不依赖数据库与框架。
// 职责：
// 1. status / priority 合法取值校验（SQLite 无 enum，schema 注释约定由本层约束）；
// 2. 状态切换语义（进入 done 写 completedAt，离开 done 清空，done→todo/doing 视为“取消完成”）；
// 3. 看板列内排序计算（orderIndex，0..n-1，无重复）；
// 4. 今日视图归类（today / overdue / undated），日期边界可注入当前时间。
// 非法输入统一抛出 TaskValidationError，调用方据此返回 400（docs/01-architecture.md「接口约定」）。

/** 任务状态：看板三列。 */
export type TaskStatus = "todo" | "doing" | "done";

/** 任务优先级。 */
export type TaskPriority = "low" | "medium" | "high";

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "doing", "done"];
export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high"];
/** priority 缺省值。 */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "medium";

/**
 * 可识别的校验错误：调用方捕获后应映射为 400（docs/01-architecture.md「接口约定」）。
 * `field` 指出出错的输入字段，便于构造错误信息。
 */
export class TaskValidationError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "TaskValidationError";
    this.field = field;
  }
}

/** 校验 status 合法值，非法值抛出 TaskValidationError。 */
export function parseStatus(value: unknown): TaskStatus {
  if (value === "todo" || value === "doing" || value === "done") return value;
  throw new TaskValidationError(
    `status 必须是 ${TASK_STATUSES.join(" | ")} 之一，收到：${stringify(value)}`,
    "status",
  );
}

/** 校验 priority 合法值（严格版，用于“显式提供”的场景），非法值抛出 TaskValidationError。 */
export function parsePriority(value: unknown): TaskPriority {
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new TaskValidationError(
    `priority 必须是 ${TASK_PRIORITIES.join(" | ")} 之一，收到：${stringify(value)}`,
    "priority",
  );
}

/** 校验 priority 并应用缺省值：未提供（undefined / null）时返回 medium。 */
export function normalizePriority(value: unknown): TaskPriority {
  if (value === undefined || value === null) return DEFAULT_TASK_PRIORITY;
  return parsePriority(value);
}

/** 校验标题：必须是非空字符串（首尾空白会被裁掉），返回裁剪后的标题。 */
export function parseTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new TaskValidationError(`title 必须是字符串，收到：${stringify(value)}`, "title");
  }
  const title = value.trim();
  if (title.length === 0) {
    throw new TaskValidationError("title 不能为空", "title");
  }
  return title;
}

/** 校验备注：字符串或 null；undefined 视为 null。 */
export function parseNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new TaskValidationError(`notes 必须是字符串或 null，收到：${stringify(value)}`, "notes");
}

/**
 * 校验截止日期：Date 实例、可解析的日期字符串或 null；undefined / null 视为“无日期”。
 * 返回 Date 实例（字符串会被解析成 Date），无法解析时抛出 TaskValidationError。
 */
export function parseDueDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TaskValidationError("dueDate 是无效的日期", "dueDate");
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new TaskValidationError(`dueDate 无法解析：${stringify(value)}`, "dueDate");
    }
    return parsed;
  }
  throw new TaskValidationError(
    `dueDate 必须是日期字符串、Date 或 null，收到：${stringify(value)}`,
    "dueDate",
  );
}

/**
 * 校验项目归属：非空字符串、null 或 undefined；空串 / 纯空白视为“无项目”（null）。
 */
export function parseProjectId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  throw new TaskValidationError(
    `projectId 必须是字符串或 null，收到：${stringify(value)}`,
    "projectId",
  );
}

/** 校验列内位置：必须是整数（可为负，由排序计算按边界收敛），否则抛出 TaskValidationError。 */
export function parseOrderIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TaskValidationError(`orderIndex 必须是整数，收到：${stringify(value)}`, "orderIndex");
  }
  return value;
}

/** 把位置收敛到 [0, upperBound]（越界取边界），非整数抛出 TaskValidationError。 */
export function clampPosition(value: unknown, upperBound: number): number {
  const position = parseOrderIndex(value);
  return Math.min(Math.max(position, 0), upperBound);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? "数组" : "对象";
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// 状态切换语义
// ---------------------------------------------------------------------------

/** 任务在状态切换时受影响的两个字段。 */
export interface StatusTimestamps {
  status: TaskStatus;
  completedAt: Date | null;
}

/**
 * 计算状态切换后的 status / completedAt：
 * - 进入 done：写入 completedAt = now；
 * - 离开 done（→ todo/doing，即“取消完成”）：清空 completedAt；
 * - done → done：保留原 completedAt（重复完成不重置时间；若历史数据缺失则补 now）；
 * - 其余切换不携带完成时间。
 * 允许任意状态直接切换（看板拖拽），因此这里没有“非法迁移”。
 */
export function applyStatusChange(
  current: { status: TaskStatus; completedAt: Date | null },
  next: TaskStatus,
  now: Date,
): StatusTimestamps {
  if (next === "done") {
    const completedAt =
      current.status === "done" ? (current.completedAt ?? now) : now;
    return { status: next, completedAt };
  }
  return { status: next, completedAt: null };
}

// ---------------------------------------------------------------------------
// 今日视图：日期边界与归类
// ---------------------------------------------------------------------------

/** 当天 00:00:00.000（按运行环境的本地时区；时间由调用方注入）。 */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/** 当天 23:59:59.999（含当天最后一毫秒）。 */
export function endOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

/** 今日视图的三个分组；null 表示不属于任何分组（未来日期或已完成）。 */
export type TodayBucket = "today" | "overdue" | "undated";

/**
 * 今日视图归类（互斥分组，overdue 优先于 today）：
 * - overdue：dueDate 早于“今天开始”且未完成；
 * - today：dueDate 在今天之内（含 00:00 与 23:59:59.999）且未完成；
 * - undated：dueDate 为空且未完成；
 * - 已完成（status = done）不属于任何分组；未来日期返回 null。
 * 边界归属：dueDate 恰为今天 00:00 算 today；恰为昨天最后一毫秒算 overdue。
 */
export function classifyForToday(
  task: { dueDate: Date | null; status: TaskStatus },
  now: Date,
): TodayBucket | null {
  if (task.status === "done") return null;
  if (task.dueDate === null) return "undated";
  if (task.dueDate.getTime() < startOfDay(now).getTime()) return "overdue";
  if (task.dueDate.getTime() <= endOfDay(now).getTime()) return "today";
  return null;
}

// ---------------------------------------------------------------------------
// 看板排序
// ---------------------------------------------------------------------------

/** 参与看板排序计算的最小任务快照。 */
export interface BoardTaskRef {
  id: string;
  status: TaskStatus;
  orderIndex: number;
}

/** 一次重排中某个任务的新 orderIndex。 */
export interface TaskReorder {
  id: string;
  orderIndex: number;
}

/** 移动计算结果：被移动任务的新位置 + 受影响同列任务的重排结果（不包含被移动任务自身）。 */
export interface MovePlan {
  taskId: string;
  /** 目标状态。 */
  status: TaskStatus;
  /** 被移动任务的新 orderIndex。 */
  orderIndex: number;
  /** 需要同步更新的其他任务及其新 orderIndex。 */
  reorder: TaskReorder[];
  /** 是否为同列内移动。 */
  sameColumn: boolean;
}

/** 把任务插入目标列的 position 处：返回新任务的 orderIndex 与被挤后移的同列任务。 */
export function computeColumnInsert(
  column: readonly BoardTaskRef[],
  position: unknown,
): { orderIndex: number; reorder: TaskReorder[] } {
  const sorted = sortByOrder(column);
  const index = clampPosition(position, sorted.length);
  const reorder: TaskReorder[] = [];
  sorted.forEach((task, i) => {
    const newIndex = i < index ? i : i + 1;
    if (newIndex !== task.orderIndex) {
      reorder.push({ id: task.id, orderIndex: newIndex });
    }
  });
  return { orderIndex: index, reorder };
}

/**
 * 看板移动计算：给定任务集合（至少包含被移动任务所在的源列与目标列，可传整个看板）、
 * 被移动任务 id、目标状态与目标位置（0 起始，越界收敛到列边界），
 * 返回被移动任务的新 orderIndex 及所有受影响同列任务的重排结果。
 * 结果保证两列各自重排为 0..n-1、无重复；只返回 orderIndex 实际变化的任务。
 */
export function computeMove(
  tasks: readonly BoardTaskRef[],
  taskId: string,
  target: { status: unknown; position: unknown },
): MovePlan {
  const status = parseStatus(target.status);
  const moving = tasks.find((task) => task.id === taskId);
  if (!moving) {
    throw new TaskValidationError(`id 为 ${taskId} 的任务不在给定任务集合中`, "id");
  }

  if (moving.status === status) {
    const column = sortByOrder(
      tasks.filter((task) => task.status === status && task.id !== taskId),
    );
    const { orderIndex, reorder } = computeColumnInsert(column, target.position);
    return { taskId, status, orderIndex, reorder, sameColumn: true };
  }

  const targetColumn = sortByOrder(
    tasks.filter((task) => task.status === status && task.id !== taskId),
  );
  const insert = computeColumnInsert(targetColumn, target.position);

  // 源列移出被移动任务后收紧空隙，重新编号为 0..n-1。
  const originColumn = sortByOrder(
    tasks.filter((task) => task.status === moving.status && task.id !== taskId),
  );
  const originOriginal = new Map(originColumn.map((task) => [task.id, task.orderIndex]));
  const originReorder = originColumn
    .map((task, i) => ({ id: task.id, orderIndex: i }))
    .filter((entry) => entry.orderIndex !== originOriginal.get(entry.id));

  return {
    taskId,
    status,
    orderIndex: insert.orderIndex,
    reorder: [...insert.reorder, ...originReorder],
    sameColumn: false,
  };
}

function sortByOrder(tasks: readonly BoardTaskRef[]): BoardTaskRef[] {
  return [...tasks].sort((a, b) => a.orderIndex - b.orderIndex);
}

// ---------------------------------------------------------------------------
// 创建 / 更新输入的归一化（供 lib/db 与后续 route handler 复用）
// ---------------------------------------------------------------------------

/** createTask 的输入：字段校验规则见 normalizeNewTask。 */
export interface NewTaskInput {
  title: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | string | null;
  projectId?: string | null;
  /** 列内位置；缺省表示追加到目标列末尾。 */
  orderIndex?: number;
}

export interface NormalizedNewTask {
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  projectId: string | null;
  /** 已校验为整数；undefined 表示追加到列尾（由数据层按列长度决定）。 */
  orderIndex: number | undefined;
}

/**
 * 归一化创建输入：应用缺省值（status=todo，priority=medium），校验全部字段。
 * 输入不是对象或任一字段非法时抛出 TaskValidationError。
 */
export function normalizeNewTask(input: unknown): NormalizedNewTask {
  const source = expectPlainObject(input, "input");
  return {
    title: parseTitle(source.title),
    notes: parseNotes(source.notes),
    status: source.status === undefined ? "todo" : parseStatus(source.status),
    priority: normalizePriority(source.priority),
    dueDate: parseDueDate(source.dueDate),
    projectId: parseProjectId(source.projectId),
    orderIndex: source.orderIndex === undefined ? undefined : parseOrderIndex(source.orderIndex),
  };
}

/** updateTask 的输入：仅允许 title / notes / priority / dueDate / projectId。 */
export interface TaskPatch {
  title?: string;
  notes?: string | null;
  priority?: TaskPriority;
  dueDate?: Date | string | null;
  projectId?: string | null;
}

export interface NormalizedTaskPatch {
  title?: string;
  notes?: string | null;
  priority?: TaskPriority;
  dueDate?: Date | null;
  projectId?: string | null;
}

/**
 * 归一化更新补丁：只挑选可更新字段（其余字段——包括 status——一律忽略，
 * 状态变更必须走 updateTaskWithStatus / moveTask）；未提供的字段不出现在结果里，
 * 显式 null 表示清空（dueDate / projectId）。输入不是对象时抛出 TaskValidationError。
 */
export function normalizeTaskPatch(patch: unknown): NormalizedTaskPatch {
  const source = expectPlainObject(patch, "patch");
  const result: NormalizedTaskPatch = {};
  if (source.title !== undefined) result.title = parseTitle(source.title);
  if (source.notes !== undefined) result.notes = parseNotes(source.notes);
  if (source.priority !== undefined) result.priority = parsePriority(source.priority);
  if (source.dueDate !== undefined) result.dueDate = parseDueDate(source.dueDate);
  if (source.projectId !== undefined) result.projectId = parseProjectId(source.projectId);
  return result;
}

function expectPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskValidationError(`${field} 必须是对象，收到：${stringify(value)}`, field);
  }
  return value as Record<string, unknown>;
}
