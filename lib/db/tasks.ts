// 任务数据访问层（docs/01-architecture.md「模块边界」）：唯一经 Prisma 访问任务表的入口。
// 只调用 Prisma API，不写 SQL；所有写操作放在事务里保证一致。
// 取值与字段校验复用 lib/domain/task.ts 的纯函数，非法输入抛 TaskValidationError
// （调用方映射为 400），任务不存在抛 TaskNotFoundError（调用方映射为 404）。

import { Prisma, type Task } from "@prisma/client";

import {
  applyStatusChange,
  computeColumnInsert,
  computeMove,
  endOfDay,
  normalizeNewTask,
  normalizeTaskPatch,
  parseStatus,
  startOfDay,
  TaskValidationError,
  type BoardTaskRef,
  type NormalizedNewTask,
  type TaskStatus,
  type TodayBucket,
} from "@/lib/domain/task";

import { prisma } from "./index";

/** 任务表行记录。 */
export type TaskRecord = Task;

/** 把数据库行快照转成排序计算所需的引用（status 在此做合法性校验）。 */
function toBoardTaskRef(row: { id: string; status: string; orderIndex: number }): BoardTaskRef {
  return { id: row.id, status: parseStatus(row.status), orderIndex: row.orderIndex };
}

/** 任务不存在（调用方据此返回 404）。 */
export class TaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`任务不存在：${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

// ---------------------------------------------------------------------------
// 创建 / 查询 / 更新 / 删除
// ---------------------------------------------------------------------------

/** createTask 输入（字段校验规则见 lib/domain normalizeNewTask）。 */
export interface CreateTaskInput {
  title: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: "low" | "medium" | "high";
  dueDate?: Date | string | null;
  projectId?: string | null;
  orderIndex?: number;
}

/**
 * 创建任务：校验后写入，返回任务。
 * - status 缺省 todo，priority 缺省 medium，直接以 done 创建时写入 completedAt；
 * - orderIndex 缺省表示追加到目标状态列末尾；显式提供时插入该位置并把后续任务后移；
 * - projectId 不存在时抛出 TaskValidationError（field=projectId）。
 */
export async function createTask(input: CreateTaskInput, now: Date = new Date()): Promise<TaskRecord> {
  const normalized: NormalizedNewTask = normalizeNewTask(input);
  return prisma.$transaction(async (tx) => {
    await ensureProjectExists(tx, normalized.projectId);

    const column = await tx.task.findMany({
      where: { status: normalized.status },
      select: { id: true, status: true, orderIndex: true },
    });
    const plan = computeColumnInsert(
      column.map(toBoardTaskRef),
      normalized.orderIndex ?? column.length,
    );
    for (const entry of plan.reorder) {
      await tx.task.update({ where: { id: entry.id }, data: { orderIndex: entry.orderIndex } });
    }

    return tx.task.create({
      data: {
        title: normalized.title,
        notes: normalized.notes,
        status: normalized.status,
        priority: normalized.priority,
        dueDate: normalized.dueDate,
        projectId: normalized.projectId,
        orderIndex: plan.orderIndex,
        completedAt: normalized.status === "done" ? now : null,
      },
    });
  });
}

/** 按 id 查询任务；不存在返回 null。 */
export async function getTask(id: string): Promise<TaskRecord | null> {
  return prisma.task.findUnique({ where: { id } });
}

/** updateTask 可更新的字段；其余字段（含 status）被忽略，状态变更走 updateStatus / moveTask。 */
export interface UpdateTaskPatch {
  title?: string;
  notes?: string | null;
  priority?: "low" | "medium" | "high";
  dueDate?: Date | string | null;
  projectId?: string | null;
}

/**
 * 更新任务的 title / notes / priority / dueDate / projectId（字段校验见 lib/domain）。
 * 显式 null 清空 dueDate / projectId；任务不存在时抛出 TaskNotFoundError。
 */
export async function updateTask(id: string, patch: UpdateTaskPatch): Promise<TaskRecord> {
  const normalized = normalizeTaskPatch(patch);
  return prisma.$transaction(async (tx) => {
    if (normalized.projectId !== undefined) {
      await ensureProjectExists(tx, normalized.projectId);
    }
    try {
      return await tx.task.update({ where: { id }, data: normalized });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new TaskNotFoundError(id);
      }
      throw error;
    }
  });
}

/**
 * 更新状态：按领域规则维护 completedAt（进入 done 写入 now，离开 done 清空，
 * done → done 保留原完成时间）。status 非法抛 TaskValidationError；任务不存在抛 TaskNotFoundError。
 */
export async function updateStatus(
  id: string,
  status: unknown,
  now: Date = new Date(),
): Promise<TaskRecord> {
  const next = parseStatus(status);
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id } });
    if (!task) throw new TaskNotFoundError(id);
    const nextTimestamps = applyStatusChange(
      { status: parseStatus(task.status), completedAt: task.completedAt },
      next,
      now,
    );
    return tx.task.update({
      where: { id },
      data: { status: nextTimestamps.status, completedAt: nextTimestamps.completedAt },
    });
  });
}

/** moveTask 的目标：目标状态 + 目标列内位置（0 起始，越界收敛到列边界）。 */
export interface MoveTarget {
  status: unknown;
  orderIndex: unknown;
}

/**
 * 看板移动：同一事务内完成“目标列插入 + 源列重排”，保证两列 orderIndex
 * 均为 0..n-1、无重复（重排计算见 lib/domain computeMove）。
 * 移动进入 / 离开 done 时按领域规则维护 completedAt。
 */
export async function moveTask(
  id: string,
  target: MoveTarget,
  now: Date = new Date(),
): Promise<TaskRecord> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id } });
    if (!task) throw new TaskNotFoundError(id);
    const currentStatus = parseStatus(task.status);
    const targetStatus = parseStatus(target.status);

    const columnTasks = await tx.task.findMany({
      where: { status: { in: [currentStatus, targetStatus] } },
      select: { id: true, status: true, orderIndex: true },
    });
    const plan = computeMove(
      columnTasks.map(toBoardTaskRef),
      id,
      { status: targetStatus, position: target.orderIndex },
    );
    const nextTimestamps = applyStatusChange(
      { status: currentStatus, completedAt: task.completedAt },
      targetStatus,
      now,
    );

    for (const entry of plan.reorder) {
      await tx.task.update({ where: { id: entry.id }, data: { orderIndex: entry.orderIndex } });
    }
    return tx.task.update({
      where: { id },
      data: {
        status: plan.status,
        orderIndex: plan.orderIndex,
        completedAt: nextTimestamps.completedAt,
      },
    });
  });
}

/** 删除任务；任务不存在时抛出 TaskNotFoundError。 */
export async function deleteTask(id: string): Promise<void> {
  try {
    await prisma.task.delete({ where: { id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new TaskNotFoundError(id);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 视图查询
// ---------------------------------------------------------------------------

export type TaskListView = "today" | "overdue" | "undated" | "board" | "project";

/** 看板视图：按状态分组，组内按 orderIndex。 */
export type BoardView = Record<TaskStatus, TaskRecord[]>;

export interface ListTasksOptions {
  /** today / overdue / undated 视图必需：归类所用的当前时间。 */
  now?: Date;
  /** project 视图必需：项目 id。 */
  projectId?: string;
}

/**
 * 按视图查询任务：
 * - today：dueDate 在今天之内（含 00:00 与 23:59:59.999）且未完成；
 * - overdue：dueDate 早于今天开始且未完成；
 * - undated：dueDate 为空且未完成；
 *   （三个视图互斥，时间边界由 lib/domain 的 startOfDay / endOfDay 计算，必须提供 now）
 * - board：todo / doing / done 三组，组内按 orderIndex；
 * - project：指定项目的任务，先按 todo→doing→done 再按 orderIndex 排序。
 */
export async function listTasks(view: "board", options?: ListTasksOptions): Promise<BoardView>;
export async function listTasks(
  view: Extract<TaskListView, "today" | "overdue" | "undated">,
  options: ListTasksOptions & { now: Date },
): Promise<TaskRecord[]>;
export async function listTasks(
  view: "project",
  options: ListTasksOptions & { projectId: string },
): Promise<TaskRecord[]>;
export async function listTasks(
  view: TaskListView,
  options: ListTasksOptions = {},
): Promise<TaskRecord[] | BoardView> {
  switch (view) {
    case "today":
    case "overdue":
    case "undated": {
      if (!options.now) {
        throw new TaskValidationError(`${view} 视图必须提供 now（当前时间）`, "now");
      }
      return listTodayBucket(view, options.now);
    }
    case "board":
      return listBoard();
    case "project": {
      if (!options.projectId) {
        throw new TaskValidationError("project 视图必须提供 projectId", "projectId");
      }
      return listProject(options.projectId);
    }
    default:
      throw new TaskValidationError(`未知的任务视图：${String(view)}`, "view");
  }
}

/** 今日视图三组与 classifyForToday 同一规则：未完成 + dueDate 边界（overdue 严格早于今天开始）。 */
async function listTodayBucket(bucket: TodayBucket, now: Date): Promise<TaskRecord[]> {
  const commonOrderBy = [{ dueDate: "asc" as const }, { createdAt: "asc" as const }];
  if (bucket === "undated") {
    return prisma.task.findMany({
      where: { status: { not: "done" }, dueDate: null },
      orderBy: [{ createdAt: "asc" }],
    });
  }
  if (bucket === "overdue") {
    return prisma.task.findMany({
      where: { status: { not: "done" }, dueDate: { lt: startOfDay(now) } },
      orderBy: commonOrderBy,
    });
  }
  return prisma.task.findMany({
    where: {
      status: { not: "done" },
      dueDate: { gte: startOfDay(now), lte: endOfDay(now) },
    },
    orderBy: commonOrderBy,
  });
}

async function listBoard(): Promise<BoardView> {
  const rows = await prisma.task.findMany({ orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }] });
  const board: BoardView = { todo: [], doing: [], done: [] };
  for (const row of rows) {
    board[parseStatus(row.status)].push(row);
  }
  return board;
}

async function listProject(projectId: string): Promise<TaskRecord[]> {
  const rows = await prisma.task.findMany({
    where: { projectId },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
  });
  const rank: Record<TaskStatus, number> = { todo: 0, doing: 1, done: 2 };
  return rows.sort(
    (a, b) =>
      rank[parseStatus(a.status)] - rank[parseStatus(b.status)] ||
      a.orderIndex - b.orderIndex ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

async function ensureProjectExists(
  tx: Prisma.TransactionClient,
  projectId: string | null,
): Promise<void> {
  if (projectId === null) return;
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    throw new TaskValidationError(`项目不存在：${projectId}`, "projectId");
  }
}
