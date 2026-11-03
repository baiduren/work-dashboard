// 颜色圆点（Issue #27）：项目卡片与详情页共用的小圆点。
// color 为 lib/domain 校验过的 #RRGGBB；缺省渲染中性灰点（表示未设置颜色）。

export function ColorDot({ color }: { color: string | null }) {
  if (color) {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
    );
  }
  return <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-full bg-neutral-300" />;
}
