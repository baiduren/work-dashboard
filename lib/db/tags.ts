// 标签数据访问层（Issue #39，docs/01-architecture.md「模块边界」）：经 Prisma 访问
// Tag / TaskTag 表的唯一入口。只调用 Prisma API，不写 SQL；所有写操作放在事务里保证一致。
// 取值校验复用 lib/domain/tag.ts 的纯函数，非法输入抛 TaskValidationError（调用方映射为
// 400）；标签名重复抛 TagValidationError（P2002 映射，固定文案「标签名已存在」→ 400）；
// 标签不存在抛 TagNotFoundError（调用方映射为 404）。
// 标签唯一性靠 schema `name @unique` + 捕获 P2002 映射 400，不在应用层做先查后插；
// TaskTag 级联删除由 schema `onDelete: Cascade`（数据库外键）保证，见 prisma 迁移 SQL。

import { Prisma, type Tag } from "@prisma/client";

import { parseTagColor, parseTagIds, parseTagName, TagValidationError } from "@/lib/domain/tag";
import { TaskValidationError } from "@/lib/domain/task";

import { prisma } from "./index";

/** 标签表行记录。 */
export type TagRecord = Tag;

/** 标签不存在（调用方据此返回 404）。 */
export class TagNotFoundError extends Error {
  readonly tagId: string;

  constructor(tagId: string) {
    super(`标签不存在：${tagId}`);
    this.name = "TagNotFoundError";
    this.tagId = tagId;
  }
}

// ---------------------------------------------------------------------------
// 标签 CRUD
// ---------------------------------------------------------------------------

/** createTag 输入（字段校验规则见 lib/domain parseTagName / parseTagColor）。 */
export interface CreateTagInput {
  name: string;
  color?: string | null;
}

/** updateTag 的输入：仅允许 name / color。 */
export interface UpdateTagPatch {
  name?: string;
  color?: string | null;
}

/** 把 Prisma 唯一约束冲突映射为固定文案的 400 语义错误。 */
function mapDuplicateName(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return new TagValidationError("标签名已存在", "name");
  }
  return error;
}

/**
 * 全部标签，按 name 升序（name 有唯一约束，排序稳定）。
 */
export async function listTags(): Promise<TagRecord[]> {
  return prisma.tag.findMany({ orderBy: [{ name: "asc" }] });
}

/**
 * 标签是否存在（Issue #51 页面筛选容错：URL 中的 tagId 已失效时忽略该筛选，
 * 避免手工改 URL 导致页面 500；API 侧仍按约定返回 400「标签不存在」）。
 */
export async function tagExists(id: string): Promise<boolean> {
  const tag = await prisma.tag.findUnique({ where: { id }, select: { id: true } });
  return tag !== null;
}

/**
 * 创建标签：name 必填（trim 后非空、≤24 字符），color 可选（#RRGGBB 或缺省 null）。
 * 重名（唯一约束）抛 TagValidationError（「标签名已存在」），调用方映射 400。
 */
export async function createTag(input: CreateTagInput): Promise<TagRecord> {
  const name = parseTagName(input.name);
  const color = parseTagColor(input.color);
  return prisma.$transaction(async (tx) => {
    try {
      return await tx.tag.create({ data: { name, color } });
    } catch (error) {
      throw mapDuplicateName(error);
    }
  });
}

/**
 * 更新标签的 name / color（字段校验见 lib/domain；补丁为空则原样返回）。
 * 显式 color=null 清空颜色；标签不存在抛 TagNotFoundError；重名抛 TagValidationError。
 */
export async function updateTag(id: string, patch: UpdateTagPatch): Promise<TagRecord> {
  const data: { name?: string; color?: string | null } = {};
  if (patch.name !== undefined) data.name = parseTagName(patch.name);
  if (patch.color !== undefined) data.color = parseTagColor(patch.color);
  return prisma.$transaction(async (tx) => {
    try {
      return await tx.tag.update({ where: { id }, data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2025") throw new TagNotFoundError(id);
        throw mapDuplicateName(error);
      }
      throw error;
    }
  });
}

/**
 * 删除标签；不存在抛 TagNotFoundError。挂在该标签上的 TaskTag 关联由
 * 数据库外键 `ON DELETE CASCADE` 级联删除（任务本身保留）。
 */
export async function deleteTag(id: string): Promise<void> {
  try {
    await prisma.tag.delete({ where: { id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new TagNotFoundError(id);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 任务绑定（TaskTag）
// ---------------------------------------------------------------------------

/**
 * 设置任务的标签绑定：**事务内**先删该任务全部 TaskTag 再按给定顺序批量插入
 * （全量替换语义）。taskId 或任一 tagId 不存在抛 TaskValidationError（400，
 * message 指明哪个 id）；重复的 tagId 去重后绑定一次（TaskTag 复合主键不允许重复）。
 * 独立调用时的入口；需要与任务字段更新共用同一事务时，使用 applyTaskTagsInTx。
 */
export async function setTaskTags(taskId: string, tagIds: string[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await applyTaskTagsInTx(tx, taskId, tagIds);
  });
}

/**
 * 在调用方提供的事务内应用任务标签绑定（lib/db 内部复用点）：
 * - updateTaskWithStatus 把它与字段更新、status 变更放在**同一事务**内执行，
 *   任一步失败整体回滚（禁止嵌套独立事务）；
 * - 校验逻辑与 setTaskTags 完全一致（parseTagIds → 任务存在 → 标签存在 → 全删全插）。
 * 事务客户端类型来自 Prisma（Prisma.TransactionClient）。
 */
export async function applyTaskTagsInTx(
  tx: Prisma.TransactionClient,
  taskId: string,
  tagIds: string[],
): Promise<void> {
  const ids = [...new Set(parseTagIds(tagIds))];

  const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) {
    throw new TaskValidationError(`任务不存在：${taskId}`, "taskId");
  }

  if (ids.length > 0) {
    const found = await tx.tag.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const foundIds = new Set(found.map((tag) => tag.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new TaskValidationError(`标签不存在：${missing.join("、")}`, "tagIds");
    }
  }

  await tx.taskTag.deleteMany({ where: { taskId } });
  if (ids.length > 0) {
    await tx.taskTag.createMany({ data: ids.map((tagId) => ({ taskId, tagId })) });
  }
}
