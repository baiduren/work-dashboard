// 今日视图客户端交互的纯逻辑（Issue #25）：
// 快速添加 payload 构造、本地日期格式化、日期输入的清空语义与 API 错误文案提取。
// 全部为可单测的纯函数（tests/today-form.test.ts）；
// 取值规则复用 lib/domain/task.ts（parseTitle / DEFAULT_TASK_PRIORITY），
// 不在前端重复实现服务端校验（docs/01-architecture.md「模块边界」）。

import {
  DEFAULT_TASK_PRIORITY,
  parseStatus,
  parseTitle,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/domain/task";

import { moveItemInLists } from "./drag-lists-form";

/** 快速添加发送给 POST /api/tasks 的请求体。 */
export interface QuickAddPayload {
  title: string;
  priority: TaskPriority;
  /** 浏览器本地日期，格式 YYYY-MM-DD（docs/00-product-brief.md「快速添加」）。 */
  dueDate: string;
}

/**
 * 构造快速添加请求体：
 * - 标题按 lib/domain 规则裁剪；空 / 纯空白输入返回 null（调用方直接忽略，不发请求）；
 * - priority 取领域缺省值 medium；
 * - dueDate 取“今天”，由调用方传入浏览器本地的 Date。
 */
export function buildQuickAddPayload(rawTitle: string, today: Date): QuickAddPayload | null {
  let title: string;
  try {
    title = parseTitle(rawTitle);
  } catch {
    return null;
  }
  return { title, priority: DEFAULT_TASK_PRIORITY, dueDate: formatLocalDate(today) };
}

/** 收件箱快速添加发送给 POST /api/tasks 的请求体（Issue #50）：不带 dueDate —— 不传即无日期。 */
export interface InboxQuickAddPayload {
  title: string;
  priority: TaskPriority;
}

/**
 * 构造收件箱快速添加请求体（Issue #50，docs/00-product-brief.md「核心场景 2 收件箱」）：
 * - 标题按 lib/domain 规则裁剪；空 / 纯空白输入返回 null（调用方直接忽略，不发请求）；
 * - priority 取领域缺省值 medium；
 * - 与今日快速添加的唯一差异：**不带 dueDate**——POST /api/tasks 不传即无日期
 *   （docs/01-architecture.md「接口约定」），任务因此进入收件箱的 undated 查询。
 */
export function buildInboxQuickAddPayload(rawTitle: string): InboxQuickAddPayload | null {
  let title: string;
  try {
    title = parseTitle(rawTitle);
  } catch {
    return null;
  }
  return { title, priority: DEFAULT_TASK_PRIORITY };
}

/** 收件箱行内快捷归类的日期档位（Issue #50）：今天 / 明天 / 下周一。 */
export type QuickClassifyKind = "today" | "tomorrow" | "nextMonday";

/**
 * 收件箱行内快捷归类的目标日期（浏览器本地时区，YYYY-MM-DD，与快速添加同一格式约定）：
 * - today：当天；tomorrow：次日（跨月 / 跨年由 Date 自动进位）；
 * - nextMonday：严格“下一个周一”——今天周一时取 7 天后（不是今天），周日时取次日。
 * 归类只改 dueDate（复用现有 PATCH /api/tasks/:id，不新增端点）。
 */
export function formatQuickClassifyDate(kind: QuickClassifyKind, now: Date): string {
  const target = new Date(now.getTime());
  if (kind === "tomorrow") {
    target.setDate(target.getDate() + 1);
  } else if (kind === "nextMonday") {
    // getDay(): 0 = 周日 … 6 = 周六；(8 - day) % 7 得到到下周一的天数，
    // 周一取 0 时用 || 7 兜底为下一个周一（7 天后）。
    target.setDate(target.getDate() + ((8 - target.getDay()) % 7 || 7));
  }
  return formatLocalDate(target);
}

/** 本地时区的 YYYY-MM-DD（与截止日期展示同一格式，docs/02-acceptance.md）。 */
export function formatLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 编辑弹层里 <input type="date"> 的值 → PATCH dueDate 字段：
 * 空字符串表示“清空截止日期”（显式 null）；其余原样透传，可解析性由服务端校验。
 */
export function dueDateInputToPatch(value: string): string | null {
  return value === "" ? null : value;
}

/**
 * 从失败响应中提取服务端 `{ error }` 文案；响应不是合法 JSON 或没有 error 字段时
 * 返回调用方给定的兜底文案（docs/01-architecture.md「接口约定」：失败统一 `{ error }`）。
 */
export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      typeof (data as { error?: unknown }).error === "string"
    ) {
      return (data as { error: string }).error;
    }
  } catch {
    // 非 JSON 响应：走兜底文案
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 今日组内排序（Issue #52）：复用看板的 orderIndex 与拖拽换算纯函数
// ---------------------------------------------------------------------------

/** 今日组内排序需要的最小任务字段（status 用于把组内落点换算回该任务 status 列的下标）。 */
export interface TodaySortableTask {
  id: string;
  status: string;
}

/** 组内拖拽的移动请求体：与看板 POST /api/tasks/:id/move 同构（status 保持不变）。 */
export interface TodayMoveTarget {
  status: TaskStatus;
  orderIndex: number;
}

/** 组内乐观重排：把被拖任务从组内原位置移除，再插入 `targetIndex`（越界收敛到组边界）。 */
export function moveTaskInTodaySection<T extends TodaySortableTask>(
  tasks: readonly T[],
  activeId: string,
  targetIndex: number,
): T[] {
  return moveItemInLists({ section: tasks }, activeId, {
    listId: "section",
    orderIndex: targetIndex,
  }).section;
}

/**
 * 把「组内落点下标」换算成 POST /move 的 body。
 *
 * 今日视图的组内顺序用 orderIndex 存储，但组内可能同时含 todo / doing 任务，
 * 而 orderIndex 是**状态列内**的顺序。为了不改变任务状态（跨列移动不是本工单范围），
 * 移动请求始终以被拖任务自己的 status 为目标列，插入下标 = 落点前与它同 status 的任务数。
 * 同 status 的组内拖拽因此精确落位；混合 status 的组只保证该任务在自身状态列中的
 * 相对位置（联动取舍见 docs/01-architecture.md「接口约定」）。
 */
export function computeTodayMoveTarget(
  tasks: readonly TodaySortableTask[],
  activeId: string,
  targetIndex: number,
): TodayMoveTarget | null {
  const active = tasks.find((task) => task.id === activeId);
  if (!active) return null;

  let status: TaskStatus;
  try {
    status = parseStatus(active.status);
  } catch {
    return null;
  }

  const reordered = moveTaskInTodaySection(tasks, activeId, targetIndex);
  const position = reordered.findIndex((task) => task.id === activeId);
  if (position < 0) return null;

  const sameStatusBefore = reordered
    .slice(0, position)
    .filter((task) => task.status === status).length;
  return { status, orderIndex: sameStatusBefore };
}
