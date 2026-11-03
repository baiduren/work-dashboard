// 数据备份层（docs/01-architecture.md「数据导出 / 导入」、Issue #37）：
// - exportAll()：单事务内读取全量数据（Project / Task / Tag / TaskTag），日期字段一律
//   ISO 8601 字符串，返回可直接落盘的备份 JSON（version 1 格式）；
// - importAll(data)：**单事务内先清空后导入**（删除顺序 taskTags → tags → tasks → projects，
//   写入顺序相反），整体成功或整体回滚，导入失败不破坏现有数据。
// 校验分两层：
// - 结构校验在触碰数据库之前完成（version、缺字段、类型、id 重复、引用悬空），
//   非法输入抛 TaskValidationError（调用方映射为 400），不落库；
//   这里只做结构与类型检查，不重复 domain 层取值规则——备份文件来自本应用，
//   字段取值已在原写入路径校验过（tags / taskTags 当前无 API 产出，同样只查结构）。
// - 数据库唯一约束（如 Tag.name unique）交给事务兜底：冲突时整体回滚，
//   并把 Prisma P2002 映射为 TaskValidationError（仍返回 400）。

import { Prisma } from "@prisma/client";

import { parsePriority, parseStatus, TaskValidationError, type TaskPriority, type TaskStatus } from "@/lib/domain/task";

import { prisma } from "./index";

/** 备份文件格式版本；结构变更时递增，并同步 docs/01-architecture.md。 */
export const BACKUP_VERSION = 1;

/** 备份文件里的项目行（含已归档项目；日期字段不涉及）。 */
export interface BackupProject {
  id: string;
  name: string;
  color: string | null;
  archived: boolean;
}

/** 备份文件里的任务行：全字段，日期一律 ISO 8601 字符串。 */
export interface BackupTask {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  projectId: string | null;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** 备份文件里的标签行（Tag / TaskTag 当前无 API 产出，结构上保留）。 */
export interface BackupTag {
  id: string;
  name: string;
  color: string | null;
}

/** 备份文件里的任务-标签关联行。 */
export interface BackupTaskTag {
  taskId: string;
  tagId: string;
}

/** 备份文件顶层结构（version 1）。 */
export interface BackupData {
  version: number;
  exportedAt: string;
  projects: BackupProject[];
  tasks: BackupTask[];
  tags: BackupTag[];
  taskTags: BackupTaskTag[];
}

/** importAll 成功后返回的写入计数。 */
export interface ImportCounts {
  projects: number;
  tasks: number;
  tags: number;
  taskTags: number;
}

export interface ImportAllOptions {
  /**
   * 可注入的当前时间（与 lib/db 其他写函数的 now 参数同一约定）。
   * 当前导出格式（version 1）的全部时间戳都取自文件原值，导入不产生新时间戳，
   * 因此本参数目前不参与落库，仅做类型校验；保留注入点是为了未来增量合并 /
   * 冲突解决（Issue #37 非目标）沿用同一签名，避免届时变更调用方。
   */
  now?: Date;
}

/** importAll 内部使用的已校验形态：日期字段解析为 Date，直接落库。 */
interface ParsedBackupTask {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  projectId: string | null;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

interface ParsedBackupData {
  projects: BackupProject[];
  tasks: ParsedBackupTask[];
  tags: BackupTag[];
  taskTags: BackupTaskTag[];
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 导出全量数据：单事务内顺序读取四张表，保证读到一致的整体快照。
 * 行顺序确定（项目按名称、任务按列内顺序、标签按名称），便于备份文件之间 diff。
 */
export async function exportAll(): Promise<BackupData> {
  return prisma.$transaction(async (tx) => {
    const projects = await tx.project.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const tasks = await tx.task.findMany({
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const tags = await tx.tag.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] });
    const taskTags = await tx.taskTag.findMany({
      orderBy: [{ taskId: "asc" }, { tagId: "asc" }],
    });

    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      projects: projects.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        archived: row.archived,
      })),
      tasks: tasks.map((row) => ({
        id: row.id,
        title: row.title,
        notes: row.notes,
        status: parseStatus(row.status),
        priority: parsePriority(row.priority),
        dueDate: row.dueDate?.toISOString() ?? null,
        projectId: row.projectId,
        orderIndex: row.orderIndex,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      tags: tags.map((row) => ({ id: row.id, name: row.name, color: row.color })),
      taskTags: taskTags.map((row) => ({ taskId: row.taskId, tagId: row.tagId })),
    };
  });
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/**
 * 导入备份文件：结构校验 → 单事务内先清空后按原 id 原样写入。
 * - 校验失败（version 不支持 / 缺字段 / 类型不对 / id 重复 / 引用悬空）抛
 *   TaskValidationError → 400，此时未触碰数据库，现有数据不变；
 * - 事务内任何写入失败（如标签名重复触发唯一约束）整体回滚，现有数据不变，
 *   Prisma P2002 统一映射为 TaskValidationError → 400；
 * - 校验通过后按原 id 写入，保留 cuid、orderIndex、completedAt 与
 *   createdAt / updatedAt 原值（Prisma 显式提供这些字段时不会自动改写）。
 * 成功返回各表写入计数。
 */
export async function importAll(
  data: unknown,
  options: ImportAllOptions = {},
): Promise<ImportCounts> {
  // options.now 当前不参与落库（见 ImportAllOptions 注释）；按 lib/db 统一约定
  // 仍严格校验类型，避免调用方静默传入错误类型的注入时间。
  if (options.now !== undefined && !(options.now instanceof Date)) {
    throw new TaskValidationError("now 必须是 Date 实例", "now");
  }

  const backup = parseBackupData(data);

  return prisma.$transaction(
    async (tx) => {
      // 先清空后导入；删除顺序跟随外键依赖：taskTags → tags → tasks → projects。
      await tx.taskTag.deleteMany();
      await tx.tag.deleteMany();
      await tx.task.deleteMany();
      await tx.project.deleteMany();

      // 写入顺序与删除相反：projects → tasks → tags → taskTags。
      for (const project of backup.projects) {
        await tx.project.create({
          data: {
            id: project.id,
            name: project.name,
            color: project.color,
            archived: project.archived,
          },
        });
      }
      for (const task of backup.tasks) {
        await tx.task.create({
          data: {
            id: task.id,
            title: task.title,
            notes: task.notes,
            status: task.status,
            priority: task.priority,
            dueDate: task.dueDate,
            projectId: task.projectId,
            orderIndex: task.orderIndex,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            completedAt: task.completedAt,
          },
        });
      }
      for (const tag of backup.tags) {
        await tx.tag.create({
          data: { id: tag.id, name: tag.name, color: tag.color },
        });
      }
      for (const taskTag of backup.taskTags) {
        await tx.taskTag.create({
          data: { taskId: taskTag.taskId, tagId: taskTag.tagId },
        });
      }

      return {
        projects: backup.projects.length,
        tasks: backup.tasks.length,
        tags: backup.tags.length,
        taskTags: backup.taskTags.length,
      };
    },
    // 全量恢复可能写入大量行，放宽交互式事务默认 5s 超时（单机 SQLite 足够）。
    { timeout: 30_000 },
  ).catch((error: unknown) => {
    // 事务内触发的数据库唯一约束（如标签名重复）映射为 400 语义；数据已回滚。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new TaskValidationError("备份文件存在重复数据（违反唯一约束）", "data");
    }
    throw error;
  });
}

// ---------------------------------------------------------------------------
// 备份文件结构校验（纯函数，不触碰数据库）
// ---------------------------------------------------------------------------

function parseBackupData(input: unknown): ParsedBackupData {
  const source = expectObject(input, "备份文件");
  if (source.version !== BACKUP_VERSION) {
    throw new TaskValidationError(
      `不支持的备份文件版本：${stringify(source.version)}，当前支持版本 ${BACKUP_VERSION}`,
      "version",
    );
  }
  expectIsoDate(source.exportedAt, "exportedAt");

  const projects = parseArray(source.projects, "projects", parseBackupProject);
  const tasks = parseArray(source.tasks, "tasks", parseBackupTask);
  const tags = parseArray(source.tags, "tags", parseBackupTag);
  const taskTags = parseArray(source.taskTags, "taskTags", parseBackupTaskTag);

  requireUnique(projects.map((row) => row.id), "projects");
  requireUnique(tasks.map((row) => row.id), "tasks");
  requireUnique(tags.map((row) => row.id), "tags");
  requireUnique(taskTags.map((row) => `${row.taskId}\u0000${row.tagId}`), "taskTags");

  // 引用完整性：悬空引用属于结构非法（写入时必然违反外键，提前给出精确文案）。
  const projectIds = new Set(projects.map((row) => row.id));
  for (const task of tasks) {
    if (task.projectId !== null && !projectIds.has(task.projectId)) {
      throw new TaskValidationError(
        `任务 ${task.id} 引用了不存在的项目 ${task.projectId}`,
        "tasks",
      );
    }
  }
  const taskIds = new Set(tasks.map((row) => row.id));
  const tagIds = new Set(tags.map((row) => row.id));
  for (const relation of taskTags) {
    if (!taskIds.has(relation.taskId)) {
      throw new TaskValidationError(
        `任务标签关联引用了不存在的任务 ${relation.taskId}`,
        "taskTags",
      );
    }
    if (!tagIds.has(relation.tagId)) {
      throw new TaskValidationError(
        `任务标签关联引用了不存在的标签 ${relation.tagId}`,
        "taskTags",
      );
    }
  }

  return { projects, tasks, tags, taskTags };
}

function parseBackupProject(input: unknown, index: number): BackupProject {
  const row = expectObject(input, `projects[${index}]`);
  const field = (name: string) => `projects[${index}].${name}`;
  return {
    id: requireNonEmptyString(row.id, field("id")),
    name: requireNonEmptyString(row.name, field("name")),
    color: requireStringOrNull(row.color, field("color")),
    archived: requireBoolean(row.archived, field("archived")),
  };
}

function parseBackupTask(input: unknown, index: number): ParsedBackupTask {
  const row = expectObject(input, `tasks[${index}]`);
  const field = (name: string) => `tasks[${index}].${name}`;
  return {
    id: requireNonEmptyString(row.id, field("id")),
    title: requireNonEmptyString(row.title, field("title")),
    notes: requireStringOrNull(row.notes, field("notes")),
    status: parseStatus(row.status),
    priority: parsePriority(row.priority),
    dueDate: requireIsoDateOrNull(row.dueDate, field("dueDate")),
    projectId: requireNonEmptyStringOrNull(row.projectId, field("projectId")),
    orderIndex: requireInteger(row.orderIndex, field("orderIndex")),
    createdAt: expectIsoDate(row.createdAt, field("createdAt")),
    updatedAt: expectIsoDate(row.updatedAt, field("updatedAt")),
    completedAt: requireIsoDateOrNull(row.completedAt, field("completedAt")),
  };
}

function parseBackupTag(input: unknown, index: number): BackupTag {
  const row = expectObject(input, `tags[${index}]`);
  const field = (name: string) => `tags[${index}].${name}`;
  return {
    id: requireNonEmptyString(row.id, field("id")),
    name: requireNonEmptyString(row.name, field("name")),
    color: requireStringOrNull(row.color, field("color")),
  };
}

function parseBackupTaskTag(input: unknown, index: number): BackupTaskTag {
  const row = expectObject(input, `taskTags[${index}]`);
  const field = (name: string) => `taskTags[${index}].${name}`;
  return {
    taskId: requireNonEmptyString(row.taskId, field("taskId")),
    tagId: requireNonEmptyString(row.tagId, field("tagId")),
  };
}

// --- 通用取值校验辅助 -------------------------------------------------------

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskValidationError(`${field} 必须是对象，收到：${stringify(value)}`, field);
  }
  return value as Record<string, unknown>;
}

function parseArray<T>(
  value: unknown,
  field: string,
  parseRow: (row: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new TaskValidationError(`${field} 必须是数组，收到：${stringify(value)}`, field);
  }
  return value.map((row, index) => parseRow(row, index));
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TaskValidationError(`${field} 必须是非空字符串，收到：${stringify(value)}`, field);
  }
  return value;
}

function requireStringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new TaskValidationError(`${field} 必须是字符串或 null，收到：${stringify(value)}`, field);
}

function requireNonEmptyStringOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new TaskValidationError(
    `${field} 必须是非空字符串或 null，收到：${stringify(value)}`,
    field,
  );
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TaskValidationError(`${field} 必须是布尔值，收到：${stringify(value)}`, field);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TaskValidationError(`${field} 必须是整数，收到：${stringify(value)}`, field);
  }
  return value;
}

/** ISO 8601 日期字符串 → Date；缺失、类型不对或无法解析都抛 TaskValidationError。 */
function expectIsoDate(value: unknown, field: string): Date {
  if (typeof value !== "string") {
    throw new TaskValidationError(
      `${field} 必须是 ISO 8601 日期字符串，收到：${stringify(value)}`,
      field,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TaskValidationError(`${field} 无法解析为日期：${JSON.stringify(value)}`, field);
  }
  return parsed;
}

function requireIsoDateOrNull(value: unknown, field: string): Date | null {
  return value === null ? null : expectIsoDate(value, field);
}

function requireUnique(ids: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new TaskValidationError(`${field} 中存在重复的 id：${id}`, field);
    }
    seen.add(id);
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? "数组" : "对象";
  }
  return String(value);
}
