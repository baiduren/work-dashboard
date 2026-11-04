"use client";

// 可复用拖拽排序 UI 设施（Issue #52）：看板（components/kanban-board.tsx，Issue #31）
// 与今日视图（components/today-board.tsx）共用同一套 dnd-kit 配置与提示样式，
// 避免两份相似实现漂移。纯逻辑换算在 components/drag-lists-form.ts。
//
// 交互约定（与看板一致）：
// - 指针/触摸共用 PointerSensor：移动 5px 才启动拖拽（与点击、编辑弹层入口隔离）；
// - 键盘可拖拽：Space 拾起 → 方向键移动 → Space 放下（KeyboardSensor + sortable 坐标）；
// - 落点判定：条目优先于列表容器（条目决定插入下标，列表空白处决定追加到列表尾）；
//   无指针坐标（键盘拖拽）时退化为矩形相交，同样优先条目。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type Collision,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

import { listDroppableId } from "./drag-lists-form";

/** 提示自动消失时长（与看板、今日视图既有提示一致）。 */
export const TOAST_AUTO_DISMISS_MS = 6000;

/** 5px 阈值的指针/触摸传感器 + 键盘传感器（看板与今日视图共用）。 */
export function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * 落点判定：指针下的条目优先于列表容器（条目决定插入下标，容器决定追加到列表尾）；
 * 无指针坐标（键盘拖拽）时退化为矩形相交，同样优先条目。
 * `isContainerId` 由调用方给出列表容器 id 的判定（看板是 `column:<status>`，
 * 今日视图是 `column:<today|overdue|undated>`）。
 */
export function createCardFirstCollisionDetection(
  isContainerId: (id: string) => boolean,
): CollisionDetection {
  return (args) => {
    const collisions =
      pointerWithin(args).length > 0 ? pointerWithin(args) : rectIntersection(args);
    const containers: Collision[] = [];
    const cards: Collision[] = [];
    for (const collision of collisions) {
      if (isContainerId(String(collision.id))) containers.push(collision);
      else cards.push(collision);
    }
    return cards.length > 0 ? cards : containers;
  };
}

/** 可排序列表容器：既是落点（列表空白处 / 空列表追加到列表尾），也承载 SortableContext。 */
export function SortableListContainer({
  listId,
  ariaLabel,
  className,
  itemIds,
  children,
}: {
  /** 列表 key；droppable id 由 listDroppableId 统一生成。 */
  listId: string;
  ariaLabel: string;
  /** 允许按 isOver（拖动经过列表容器）切换边框等样式。 */
  className: (isOver: boolean) => string;
  itemIds: readonly string[];
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: listDroppableId(listId),
    data: { type: "column" },
  });

  return (
    <section ref={setNodeRef} aria-label={ariaLabel} className={className(isOver)}>
      <SortableContext items={[...itemIds]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </section>
  );
}

/**
 * 把客户端提示接到“自动消失”计时：每条新提示重置计时（null 清除）。
 * 返回的第二个函数用于展示/清除提示；组件卸载时清掉计时器。
 */
export function useAutoDismissToast<T>(autoDismissMs: number = TOAST_AUTO_DISMISS_MS) {
  const [toast, setToast] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!toast) return;
    timer.current = setTimeout(() => setToast(null), autoDismissMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, autoDismissMs]);

  return useMemo(() => ({ toast, setToast }) as const, [toast]);
}

/** 拖拽失败等纯文本提示（浮在底部居中，与看板 / 今日视图完成提示同位置）。 */
export function DragToast({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg"
    >
      {message}
    </div>
  );
}
