// 登录限流：内存实现（docs/adr/0004-authentication.md 已知代价：单实例内存实现，
// 水平扩展需换共享存储）。
//
// 加固约束（docs/01-architecture.md「认证与访问控制」）：
// - 限流键只信任代理注入的来源头（x-real-ip → CF-Connecting-IP），缺省记为 unknown；
//   不读取 x-forwarded-for——其分段由客户端可控，轮换即可绕过限流；
// - 失败按“来源 + 账号”双键记录（键的组合见 lib/auth/login.ts），防止单一维度轮换绕过；
// - 全局失败阈值：窗口内失败总数超限后暂时拒绝所有登录，防分布式撞库；
// - 记录有界：键数与键长都有上限，满员先清理过期项、再按插入顺序淘汰最旧项；
//   全局计数为单条固定大小的记录，天然有界。

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;

/** 全局失败阈值：10 分钟窗口内累计失败达到上限后，暂时拒绝所有登录尝试。 */
export const GLOBAL_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const GLOBAL_MAX_FAILURES = 100;

/** 单个维度最多跟踪的键数：限制内存占用（大量不同来源/账号失败不会撑爆 Map）。 */
export const MAX_TRACKED_KEYS = 10_000;

/** 键的最大长度：真实 IP 与账号远短于此；截断超长键避免伪造头占用内存。 */
const MAX_KEY_LENGTH = 128;

type FailureRecord = {
  count: number;
  /** 窗口截止时间（毫秒时间戳），自首次失败起计 */
  resetAt: number;
};

export interface LoginRateLimitOptions {
  windowMs?: number;
  maxFailures?: number;
  globalWindowMs?: number;
  globalMaxFailures?: number;
  maxKeys?: number;
}

export class LoginRateLimiter {
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly globalWindowMs: number;
  private readonly globalMaxFailures: number;
  private readonly maxKeys: number;
  private readonly records = new Map<string, FailureRecord>();
  /** 全局失败计数：单条记录（count + resetAt），无按键展开，天然有界。 */
  private global: FailureRecord | null = null;

  constructor(options: LoginRateLimitOptions = {}) {
    this.windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
    this.maxFailures = options.maxFailures ?? LOGIN_MAX_FAILURES;
    this.globalWindowMs = options.globalWindowMs ?? GLOBAL_FAILURE_WINDOW_MS;
    this.globalMaxFailures = options.globalMaxFailures ?? GLOBAL_MAX_FAILURES;
    this.maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS;
  }

  /** 当前跟踪的来源/账号键数量（不超过 maxKeys，供观测与测试）。 */
  get size(): number {
    return this.records.size;
  }

  /** 清空全部记录（仅测试与运维使用）。 */
  clear(): void {
    this.records.clear();
    this.global = null;
  }

  /** 该来源当前是否已被限流。窗口过期后自动解除。 */
  isLimited(key: string, now: number = Date.now()): boolean {
    const normalized = this.normalizeKey(key);
    const record = this.records.get(normalized);
    if (!record) return false;
    if (now >= record.resetAt) {
      this.records.delete(normalized);
      return false;
    }
    return record.count >= this.maxFailures;
  }

  /** 全局失败阈值是否已触发。窗口过期后自动解除。 */
  isGloballyLimited(now: number = Date.now()): boolean {
    const record = this.global;
    if (!record) return false;
    if (now >= record.resetAt) {
      this.global = null;
      return false;
    }
    return record.count >= this.globalMaxFailures;
  }

  /** 记录一次登录失败；同时累加来源/账号键与全局计数，窗口起点均取首次失败。 */
  recordFailure(key: string, now: number = Date.now()): void {
    const normalized = this.normalizeKey(key);
    const record = this.records.get(normalized);
    if (!record || now >= record.resetAt) {
      if (!record) this.ensureCapacity(now); // 已存在的键重新计数不会增大 Map
      this.records.set(normalized, { count: 1, resetAt: now + this.windowMs });
    } else {
      record.count += 1;
    }

    const global = this.global;
    if (!global || now >= global.resetAt) {
      this.global = { count: 1, resetAt: now + this.globalWindowMs };
    } else {
      global.count += 1;
    }
  }

  /** 登录成功后清除该来源的失败记录（“连续失败”语义）。 */
  reset(key: string): void {
    this.records.delete(this.normalizeKey(key));
  }

  /** 距离限流解除的秒数，未限流时为 0（用于 Retry-After）。 */
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const record = this.records.get(this.normalizeKey(key));
    if (!record || now >= record.resetAt) return 0;
    return Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  }

  /** 距离全局限流解除的秒数，未触发时为 0。 */
  globalRetryAfterSeconds(now: number = Date.now()): number {
    const record = this.global;
    if (!record || now >= record.resetAt) return 0;
    return Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  }

  /** Map 满员时先清理过期项；仍满则按插入顺序淘汰最旧项，为新键腾出空间。 */
  private ensureCapacity(now: number): void {
    if (this.records.size < this.maxKeys) return;
    for (const [key, record] of this.records) {
      if (now >= record.resetAt) this.records.delete(key);
    }
    while (this.records.size >= this.maxKeys) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      this.records.delete(oldest.value);
    }
  }

  private normalizeKey(key: string): string {
    return key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key;
  }
}

/** 登录路由使用的进程内单例。 */
export const loginRateLimiter = new LoginRateLimiter();

/**
 * 提取来源限流键：只信任代理注入的地址头——优先 `x-real-ip`（约定代理必须覆盖该头），
 * 其次 `CF-Connecting-IP`；两者都缺失时记为 unknown。
 * 不读取 `x-forwarded-for`：其分段客户端可伪造，轮换即可绕过限流
 * （部署要求见 README「反向代理要求」）。
 */
export function clientKeyFromRequest(headers: Headers): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const cfConnectingIp = headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;
  return "unknown";
}
