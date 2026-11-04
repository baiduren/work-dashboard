// 项目数据访问层（docs/01-architecture.md「模块边界」）：经 Prisma 访问 Project 表的唯一入口。
// 取值校验复用 lib/domain/project.ts 的纯函数，非法输入抛 TaskValidationError
// （调用方映射为 400）；项目不存在抛 ProjectNotFoundError（调用方映射为 404）。
// 项目名重复不拒绝（docs/01-architecture.md「数据模型」：schema 未加唯一约束，
// 与任务「标题可重复」同一策略，见 tests/project-db.test.ts 的说明用例）。
// Issue #43 起：PATCH 支持 archived（true 归档 / false 恢复）；deleteProject 删除项目，
// 其下任务的 projectId 由 schema 的 onDelete: SetNull 置空（任务本身保留，不级联删除）。

import { Prisma, type Project } from "@prisma/client";

import {
  normalizeProjectPatch,
  parseProjectColor,
  parseProjectName,
  type ProjectPatch,
} from "@/lib/domain/project";

// updateProject 的补丁类型由 lib/domain 定义，这里转出口供 route handler 使用。
export type { ProjectPatch };

import { prisma } from "./index";

/** 项目表行记录。 */
export type ProjectRecord = Project;

/** 项目不存在（调用方据此返回 404）。 */
export class ProjectNotFoundError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`项目不存在：${projectId}`);
    this.name = "ProjectNotFoundError";
    this.projectId = projectId;
  }
}

/** 各状态任务计数（total 为全部状态之和）。 */
export interface ProjectCounts {
  todo: number;
  doing: number;
  done: number;
  total: number;
}

/** 项目列表项：id / name / color + 各状态任务计数。 */
export interface ProjectWithCounts {
  id: string;
  name: string;
  color: string | null;
  counts: ProjectCounts;
}

/** createProject 输入（字段校验规则见 lib/domain parseProjectName / parseProjectColor）。 */
export interface CreateProjectInput {
  name: string;
  color?: string | null;
}

/**
 * 创建项目：name 必填（trim 后非空、≤60 字符），color 可选（#RRGGBB 或缺省 null）。
 * 返回创建后的项目行。
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectRecord> {
  const name = parseProjectName(input.name);
  const color = parseProjectColor(input.color);
  return prisma.$transaction(async (tx) => {
    return tx.project.create({ data: { name, color } });
  });
}

/** 按 id 查询项目；不存在返回 null。 */
export async function getProject(id: string): Promise<ProjectRecord | null> {
  return prisma.project.findUnique({ where: { id } });
}

/**
 * 更新项目的 name / color / archived（字段校验见 lib/domain normalizeProjectPatch；
 * 补丁为空则原样返回）。显式 color=null 清空颜色；archived=true 归档、false 恢复；
 * 项目不存在时抛出 ProjectNotFoundError。
 */
export async function updateProject(id: string, patch: ProjectPatch): Promise<ProjectRecord> {
  const normalized = normalizeProjectPatch(patch);
  return prisma.$transaction(async (tx) => {
    try {
      return await tx.project.update({ where: { id }, data: normalized });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new ProjectNotFoundError(id);
      }
      throw error;
    }
  });
}

/**
 * 删除项目（Issue #43）：项目不存在抛出 ProjectNotFoundError。
 * 只删除项目本身；其下任务的 projectId 由 schema 外键 `onDelete: SetNull` 置空，
 * 任务本身保留（不级联删除）。单行删除也放事务内执行：与现有写操作约定一致，
 * 为后续扩展留一致性边界（docs/01-architecture.md「模块边界」）。
 */
export async function deleteProject(id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    try {
      await tx.project.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new ProjectNotFoundError(id);
      }
      throw error;
    }
  });
}

/**
 * 项目列表（archived=false）+ 每个项目的任务计数（todo / doing / done / total）：
 * - 只返回指定归档状态的项目，按名称升序；
 * - counts 统计该项目全部状态的任务（含已完成）；无任务的项目计数全 0。
 */
async function listProjectsWithCounts(archived: boolean): Promise<ProjectWithCounts[]> {
  const [projects, grouped] = await Promise.all([
    prisma.project.findMany({ where: { archived }, orderBy: [{ name: "asc" }] }),
    prisma.task.groupBy({ by: ["projectId", "status"], _count: { _all: true } }),
  ]);

  const countsByProject = new Map<string, ProjectCounts>();
  for (const project of projects) {
    countsByProject.set(project.id, { todo: 0, doing: 0, done: 0, total: 0 });
  }
  for (const group of grouped) {
    const counts = group.projectId === null ? undefined : countsByProject.get(group.projectId);
    if (!counts) continue; // 无项目的任务或不在此归档状态下的项目的任务不计入列表
    const count = group._count._all;
    counts.total += count;
    if (group.status === "todo") counts.todo = count;
    else if (group.status === "doing") counts.doing = count;
    else if (group.status === "done") counts.done = count;
  }

  return projects.map((project) => {
    const counts = countsByProject.get(project.id);
    return {
      id: project.id,
      name: project.name,
      color: project.color,
      // findMany 与 groupBy 同批执行，counts 必然已初始化。
      counts: counts ?? { todo: 0, doing: 0, done: 0, total: 0 },
    };
  });
}

/** 未归档项目列表（主列表）；语义与 Issue #27 一致，不变更。 */
export async function listProjects(): Promise<ProjectWithCounts[]> {
  return listProjectsWithCounts(false);
}

/**
 * 已归档项目列表（Issue #43，供项目列表页底部「已归档」折叠区展示）：
 * 只返回 archived=true 的项目，按名称升序，结构与 ProjectWithCounts 相同。
 */
export async function listArchivedProjects(): Promise<ProjectWithCounts[]> {
  return listProjectsWithCounts(true);
}
