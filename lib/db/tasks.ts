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
import { parseTagIds } from "@/lib/domain/tag";
import type { TaskFilters } from "@/lib/domain/task-filter";

import { applyTaskTagsInTx } from "./tags";
import { prisma } from "./index";

/** 任务绑定的标签摘要（API / UI 展示形态，docs/01-architecture.md「数据模型」）。 */
export interface TaskTagSummary {
  id: string;
  name: string;
  color: string | null;
}

/** 任务表行记录：Task 全字段 + 绑定的标签摘要（按标签名升序）。 */
export type TaskRecord = Task & { tags: TaskTagSummary[] };

/** 所有任务读取共用的 include：带出 TaskTag → Tag 摘要（列表 / 详情统一，避免 UI 逐个再查）。 */
const TASK_TAGS_INCLUDE = {
  tags: {
    orderBy: { tag: { name: "asc" as const } },
    select: { tag: { select: { id: true, name: true, color: true } } },
  },
} satisfies Prisma.TaskInclude;

type TaskRowWithTags = Prisma.TaskGetPayload<{ include: typeof TASK_TAGS_INCLUDE }>;

/** 把带关联的数据库行快照转成 TaskRecord（tags 只保留 id/name/color）。 */
function toTaskRecord(row: TaskRowWithTags): TaskRecord {
  const { tags, ...task } = row;
  return { ...task, tags: tags.map((entry) => entry.tag) };
}

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

    return toTaskRecord(
      await tx.task.create({
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
        include: TASK_TAGS_INCLUDE,
      }),
    );
  });
}

/** 按 id 查询任务（含标签摘要）；不存在返回 null。 */
export async function getTask(id: string): Promise<TaskRecord | null> {
  const row = await prisma.task.findUnique({ where: { id }, include: TASK_TAGS_INCLUDE });
  return row ? toTaskRecord(row) : null;
}

/** updateTask / updateTaskWithStatus 可更新的字段；其余字段（含 status）被忽略，
 * 状态变更走 updateTaskWithStatus / moveTask。tagIds 仅被 updateTaskWithStatus 处理
 * （与字段更新、status 变更同一事务；Issue #39），updateTask 会忽略它。 */
export interface UpdateTaskPatch {
  title?: string;
  notes?: string | null;
  priority?: "low" | "medium" | "high";
  dueDate?: Date | string | null;
  projectId?: string | null;
  /** 任务标签绑定的全量替换集合；仅 updateTaskWithStatus 在同一事务内应用。 */
  tagIds?: string[];
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
      return toTaskRecord(
        await tx.task.update({ where: { id }, data: normalized, include: TASK_TAGS_INCLUDE }),
      );
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
 * 注意：本函数不改列内顺序（orderIndex 不变）；PATCH 接口需要“字段 + 状态”单事务
 * 且保持列内顺序一致时，使用 updateTaskWithStatus。
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
    return toTaskRecord(
      await tx.task.update({
        where: { id },
        data: { status: nextTimestamps.status, completedAt: nextTimestamps.completedAt },
        include: TASK_TAGS_INCLUDE,
      }),
    );
  });
}

/**
 * 单事务完成“字段更新 + 状态变更 + 标签绑定”（PATCH /api/tasks/:id 的落库入口，Issue #23、#39）：
 * - status 未提供时只更新字段；status 与当前相同时只按领域规则维护 completedAt，
 *   不改变列内位置；
 * - status 变更（与当前不同）时语义等价于 POST /move { status, orderIndex: 目标列末尾 }：
 *   离开原列后原列重排为 0..n-1，任务追加到目标列末尾（orderIndex = 目标列长度），
 *   重排计算复用 lib/domain 的 computeMove，两列 orderIndex 连续、无重复；
 * - completedAt 沿用 applyStatusChange（进入 done 写入，离开 done 清空，done→done 保留）；
 * - patch.tagIds 提供时（Issue #39）：在同一事务内调用 applyTaskTagsInTx 全量替换任务标签，
 *   taskId / 任一 tagId 不存在抛 TaskValidationError（400）并整体回滚；未提供 tagIds 时
 *   不触碰既有绑定；
 * - 任一步失败（字段非法、项目不存在、任务/标签不存在等）整体回滚，不会留下部分更新。
 * 字段非法抛 TaskValidationError（调用方映射为 400）；任务不存在抛 TaskNotFoundError（404）。
 */
export async function updateTaskWithStatus(
  id: string,
  patch: UpdateTaskPatch,
  status?: unknown,
  now: Date = new Date(),
): Promise<TaskRecord> {
  const normalized = normalizeTaskPatch(patch);
  const next = status === undefined ? null : parseStatus(status);
  // tagIds 的取值校验（parseTagIds）在事务外先行：非法输入快速失败，不开启事务。
  // 存在性校验（任务 / 标签是否真实存在）在事务内进行，保证与字段更新同生共死。
  const tagIds = patch.tagIds === undefined ? undefined : parseTagIds(patch.tagIds);
  return prisma.$transaction(async (tx) => {
    if (normalized.projectId !== undefined) {
      await ensureProjectExists(tx, normalized.projectId);
    }
    const task = await tx.task.findUnique({ where: { id }, include: TASK_TAGS_INCLUDE });
    if (!task) throw new TaskNotFoundError(id);

    const data: Prisma.TaskUncheckedUpdateInput = { ...normalized };
    if (next !== null) {
      const currentStatus = parseStatus(task.status);
      const nextTimestamps = applyStatusChange(
        { status: currentStatus, completedAt: task.completedAt },
        next,
        now,
      );
      data.status = nextTimestamps.status;
      data.completedAt = nextTimestamps.completedAt;

      if (next !== currentStatus) {
        // 状态变更：源列移出后收紧为 0..n-1，目标列插入位置取“目标列长度”（追加到末尾）。
        const columnTasks = await tx.task.findMany({
          where: { status: { in: [currentStatus, next] } },
          select: { id: true, status: true, orderIndex: true },
        });
        const targetLength = columnTasks.filter(
          (row) => parseStatus(row.status) === next,
        ).length;
        const plan = computeMove(
          columnTasks.map(toBoardTaskRef),
          id,
          { status: next, position: targetLength },
        );
        for (const entry of plan.reorder) {
          await tx.task.update({ where: { id: entry.id }, data: { orderIndex: entry.orderIndex } });
        }
        data.orderIndex = plan.orderIndex;
      }
    }

    const hasFieldChanges = Object.keys(data).length > 0;
    if (!hasFieldChanges && tagIds === undefined) return toTaskRecord(task); // 空 patch 且无 status/tagIds：原样返回

    // 标签绑定与字段更新、status 变更在同一事务内落库：任一步失败整体回滚。
    if (tagIds !== undefined) {
      await applyTaskTagsInTx(tx, id, tagIds);
    }
    if (!hasFieldChanges) {
      // 只有标签变化：重新读取，返回带最新 tags 的任务快照。
      const refreshed = await tx.task.findUnique({ where: { id }, include: TASK_TAGS_INCLUDE });
      if (!refreshed) throw new TaskNotFoundError(id);
      return toTaskRecord(refreshed);
    }
    return toTaskRecord(
      await tx.task.update({ where: { id }, data, include: TASK_TAGS_INCLUDE }),
    );
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
    return toTaskRecord(
      await tx.task.update({
        where: { id },
        data: {
          status: plan.status,
          orderIndex: plan.orderIndex,
          completedAt: nextTimestamps.completedAt,
        },
        include: TASK_TAGS_INCLUDE,
      }),
    );
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

export interface ListTasksOptions extends TaskFilters {
  /** today / overdue / undated 视图必需：归类所用的当前时间。 */
  now?: Date;
  /** project 视图必需：项目 id。 */
  projectId?: string;
}

/** 把可选筛选条件组装成 Prisma where（与各视图的既有条件按 AND 叠加，Issue #51）。 */
function buildFilterWhere(filters: TaskFilters): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = {};
  const q = filters.q?.trim();
  if (q) {
    // Prisma 的 contains 在 SQLite 下走 LIKE：ASCII 大小写不敏感，中文按原样子串包含（不分词）。
    where.OR = [{ title: { contains: q } }, { notes: { contains: q } }];
  }
  if (filters.priority) where.priority = filters.priority;
  if (filters.tagId !== undefined) where.tags = { some: { tagId: filters.tagId } };
  return where;
}

/** tagId 必须指向真实标签；不存在时按接口约定抛 TaskValidationError（400「标签不存在」）。 */
async function ensureTagExists(tagId: string): Promise<void> {
  const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } });
  if (!tag) {
    throw new TaskValidationError("标签不存在", "tagId");
  }
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
  // 筛选条件在各视图内按 AND 叠加（Issue #51）：tagId 先校验存在性，非法时快速失败（400）。
  if (options.tagId !== undefined) {
    await ensureTagExists(options.tagId);
  }
  const filterWhere = buildFilterWhere(options);
  switch (view) {
    case "today":
    case "overdue":
    case "undated": {
      if (!options.now) {
        throw new TaskValidationError(`${view} 视图必须提供 now（当前时间）`, "now");
      }
      return listTodayBucket(view, options.now, filterWhere);
    }
    case "board":
      return listBoard(filterWhere);
    case "project": {
      if (!options.projectId) {
        throw new TaskValidationError("project 视图必须提供 projectId", "projectId");
      }
      return listProject(options.projectId, filterWhere);
    }
    default:
      throw new TaskValidationError(`未知的任务视图：${String(view)}`, "view");
  }
}

/** 今日视图三组与 classifyForToday 同一规则：未完成 + dueDate 边界（overdue 严格早于今天开始）。 */
async function listTodayBucket(
  bucket: TodayBucket,
  now: Date,
  filterWhere: Prisma.TaskWhereInput,
): Promise<TaskRecord[]> {
  const commonOrderBy = [{ dueDate: "asc" as const }, { createdAt: "asc" as const }];
  if (bucket === "undated") {
    const rows = await prisma.task.findMany({
      where: { status: { not: "done" }, dueDate: null, ...filterWhere },
      orderBy: [{ createdAt: "asc" }],
      include: TASK_TAGS_INCLUDE,
    });
    return rows.map(toTaskRecord);
  }
  if (bucket === "overdue") {
    const rows = await prisma.task.findMany({
      where: { status: { not: "done" }, dueDate: { lt: startOfDay(now) }, ...filterWhere },
      orderBy: commonOrderBy,
      include: TASK_TAGS_INCLUDE,
    });
    return rows.map(toTaskRecord);
  }
  const rows = await prisma.task.findMany({
    where: {
      status: { not: "done" },
      dueDate: { gte: startOfDay(now), lte: endOfDay(now) },
      ...filterWhere,
    },
    orderBy: commonOrderBy,
    include: TASK_TAGS_INCLUDE,
  });
  return rows.map(toTaskRecord);
}

async function listBoard(filterWhere: Prisma.TaskWhereInput): Promise<BoardView> {
  const rows = await prisma.task.findMany({
    where: filterWhere,
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    include: TASK_TAGS_INCLUDE,
  });
  const board: BoardView = { todo: [], doing: [], done: [] };
  for (const row of rows) {
    board[parseStatus(row.status)].push(toTaskRecord(row));
  }
  return board;
}

async function listProject(
  projectId: string,
  filterWhere: Prisma.TaskWhereInput,
): Promise<TaskRecord[]> {
  const rows = await prisma.task.findMany({
    where: { projectId, ...filterWhere },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    include: TASK_TAGS_INCLUDE,
  });
  const rank: Record<TaskStatus, number> = { todo: 0, doing: 1, done: 2 };
  return rows
    .map(toTaskRecord)
    .sort(
      (a, b) =>
        rank[parseStatus(a.status)] - rank[parseStatus(b.status)] ||
        a.orderIndex - b.orderIndex ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
}

/**
 * 周回顾查询（Issue #44）：completedAt ∈ [from, to) 的任务——含头不含尾，
 * 与 lib/domain weekRange 的半开区间对齐；按 completedAt 降序
 * （同时刻再按 createdAt 降序保持稳定）；不筛项目、不筛状态（完成即完成，
 * completedAt 只在 done 上有值，见 lib/domain applyStatusChange）。
 * from / to 不是有效 Date 或 from ≥ to 时抛 TaskValidationError（调用方映射为 400）。
 */
export async function listCompletedBetween(from: Date, to: Date): Promise<TaskRecord[]> {
  const validFrom = from instanceof Date && !Number.isNaN(from.getTime());
  const validTo = to instanceof Date && !Number.isNaN(to.getTime());
  if (!validFrom || !validTo) {
    throw new TaskValidationError("from / to 必须是有效的 Date", "range");
  }
  if (from.getTime() >= to.getTime()) {
    throw new TaskValidationError("from 必须早于 to（含头不含尾区间）", "range");
  }
  const rows = await prisma.task.findMany({
    where: { completedAt: { gte: from, lt: to } },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    include: TASK_TAGS_INCLUDE,
  });
  return rows.map(toTaskRecord);
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
