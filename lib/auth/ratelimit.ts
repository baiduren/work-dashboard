// 登录限流：内存实现，15 分钟窗口内同一来源连续失败 5 次后拒绝（429）。
// docs/adr/0004-authentication.md 已知代价：单实例内存实现，水平扩展需换共享存储。

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;

type FailureRecord = {
  count: number;
  /** 窗口截止时间（毫秒时间戳），自首次失败起计 */
  resetAt: number;
};

export interface LoginRateLimitOptions {
  windowMs?: number;
  maxFailures?: number;
}

export class LoginRateLimiter {
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly records = new Map<string, FailureRecord>();

  constructor(options: LoginRateLimitOptions = {}) {
    this.windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
    this.maxFailures = options.maxFailures ?? LOGIN_MAX_FAILURES;
  }

  /** 该来源当前是否已被限流。窗口过期后自动解除。 */
  isLimited(key: string, now: number = Date.now()): boolean {
    const record = this.records.get(key);
    if (!record) return false;
    if (now >= record.resetAt) {
      this.records.delete(key);
      return false;
    }
    return record.count >= this.maxFailures;
  }

  /** 记录一次登录失败；窗口内首次失败确定窗口起点。 */
  recordFailure(key: string, now: number = Date.now()): void {
    this.sweepIfNeeded(now);
    const record = this.records.get(key);
    if (!record || now >= record.resetAt) {
      this.records.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    record.count += 1;
  }

  /** 登录成功后清除该来源的失败记录（“连续失败”语义）。 */
  reset(key: string): void {
    this.records.delete(key);
  }

  /** 距离限流解除的秒数，未限流时为 0（用于 Retry-After）。 */
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const record = this.records.get(key);
    if (!record || now >= record.resetAt) return 0;
    return Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  }

  private sweepIfNeeded(now: number): void {
    if (this.records.size < 128) return;
    for (const [key, record] of this.records) {
      if (now >= record.resetAt) this.records.delete(key);
    }
  }
}

/** 登录路由使用的进程内单例。 */
export const loginRateLimiter = new LoginRateLimiter();

/** 提取限流键：优先取代理注入的客户端 IP（x-forwarded-for 第一段），缺省记为 unknown。 */
export function clientKeyFromRequest(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  return realIp || "unknown";
}
