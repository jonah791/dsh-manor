/**
 * roster-lock —— 名册写操作的并发保护。
 *
 * 为什么需要：`manor_hire` / `manor_retire` / `manor_assign` 都是「读 → 改 → 写」。
 * 两个动作同时进行时，后写的那份**整份覆盖**前一份 ⇒ 先写的那笔凭空消失（丢更新）。
 * 此前的处置是「管理动作串行调用」的**纪律**——而纪律不是机制：默认行为由布线决定。
 *
 * 两层保护：
 *   1. **进程内队列**：同一目标的调用依次执行（同进程的工具并发调用不交错）。
 *   2. **跨进程文件锁**：`<target>.lock`，带 owner / atMs / ttlMs；TTL 过期可抢；
 *      坏锁（损坏 / 空 / shape 非法 / 时钟偏移）**放行并留痕**——不因坏数据停在半路。
 *
 * 边界（如实）：不保证公平性；TTL 只保证「持锁方崩溃后不会永久锁死」，不保证互斥绝对
 * （时钟跳变即可击穿）⇒ 因此写盘前仍做一次 CAS 复核（见 `expectedFingerprint`）。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export interface LockInfo {
  owner: string
  atMs: number
  ttlMs: number
  note: string
}

export type LockVerdict = 'free' | 'self' | 'held' | 'expired'

export interface LockJudgement {
  verdict: LockVerdict
  info: LockInfo | null
  issue: string
  ageMs: number
}

export const DEFAULT_TTL_MS = 15_000
export const DEFAULT_WAIT_MS = 5_000
export const DEFAULT_POLL_MS = 25

export function lockPathOf(target: string): string {
  return target + '.lock'
}

/** 解析锁文件内容。**坏数据不抛**：info=null + issue 说明（调用方据此放行并留痕）。 */
export function parseLock(text: string | null): { info: LockInfo | null; issue: string } {
  if (text === null) return { info: null, issue: '' }
  const trimmed = text.trim()
  if (trimmed === '') return { info: null, issue: '锁文件为空' }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return { info: null, issue: '锁文件不是合法 JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { info: null, issue: '锁文件 shape 非法（非对象）' }
  }
  const o = raw as Record<string, unknown>
  const owner = typeof o.owner === 'string' ? o.owner : ''
  const atMs = typeof o.atMs === 'number' && Number.isFinite(o.atMs) ? o.atMs : 0
  const ttlMs = typeof o.ttlMs === 'number' && Number.isFinite(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : 0
  if (owner === '' || atMs <= 0 || ttlMs <= 0) {
    return { info: null, issue: '锁文件缺字段（owner / atMs / ttlMs 必须齐备且为正）' }
  }
  return { info: { owner, atMs, ttlMs, note: typeof o.note === 'string' ? o.note : '' }, issue: '' }
}

/**
 * 裁决「我能拿这把锁吗」。`self` 与 `expired` 都视为**可取**（前者是重入，后者是接管）。
 * 时钟偏移（atMs 在未来）按 `held` 处理——不因时钟问题去抢别人的锁。
 */
export function judgeLock(info: LockInfo | null, issue: string, nowMs: number, selfOwner: string): LockJudgement {
  if (info === null) return { verdict: 'free', info: null, issue, ageMs: 0 }
  const ageMs = nowMs - info.atMs
  if (ageMs < 0) return { verdict: 'held', info, issue, ageMs }
  if (ageMs >= info.ttlMs) return { verdict: 'expired', info, issue, ageMs }
  if (info.owner === selfOwner) return { verdict: 'self', info, issue, ageMs }
  return { verdict: 'held', info, issue, ageMs }
}

export function renderLockInfo(owner: string, ttlMs: number, note: string, nowMs: number): string {
  const info: LockInfo = { owner, atMs: nowMs, ttlMs, note }
  return JSON.stringify(info) + '\n'
}

export interface AcquireOptions {
  owner: string
  ttlMs?: number
  waitMs?: number
  pollMs?: number
  /** 注入时钟（测试用）；缺省 Date.now */
  now?: () => number
  /** 注入睡眠（测试用）；缺省 setTimeout */
  sleep?: (ms: number) => Promise<void>
  note?: string
}

export interface AcquireOutcome {
  ok: boolean
  waitedMs: number
  error: string
  /** 每轮尝试的读数（「断在哪一段」可回答，不落空白痕迹） */
  trace: string[]
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 取锁：**有界等待**——超时即失败并给出读数，不无限等。
 * 每轮读锁文件重新裁决（不缓存），因为等待期间锁可能被释放或过期。
 */
export async function acquireLock(target: string, opts: AcquireOptions): Promise<AcquireOutcome> {
  const ttlMs = opts.ttlMs === undefined ? DEFAULT_TTL_MS : opts.ttlMs
  const waitMs = opts.waitMs === undefined ? DEFAULT_WAIT_MS : opts.waitMs
  const pollMs = opts.pollMs === undefined ? DEFAULT_POLL_MS : opts.pollMs
  const now = opts.now === undefined ? () => Date.now() : opts.now
  const sleep = opts.sleep === undefined ? realSleep : opts.sleep
  const note = opts.note === undefined ? '' : opts.note
  const lockPath = lockPathOf(target)
  const startedAt = now()
  const trace: string[] = []

  for (;;) {
    let text: string | null = null
    try {
      text = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null
    } catch (e) {
      // 读不到（权限/竞态删除）⇒ 当作无锁放行，但留痕
      text = null
      trace.push('读锁文件异常（按无锁处理）：' + String(e))
    }
    const parsed = parseLock(text)
    const judgement = judgeLock(parsed.info, parsed.issue, now(), opts.owner)
    if (judgement.issue !== '') trace.push('坏锁放行：' + judgement.issue)
    if (judgement.verdict === 'free' || judgement.verdict === 'self' || judgement.verdict === 'expired') {
      try {
        writeFileSync(lockPath, renderLockInfo(opts.owner, ttlMs, note, now()), 'utf8')
        if (judgement.verdict === 'expired') trace.push('接管过期锁（原持有者 ' + String(judgement.info === null ? '' : judgement.info.owner) + '，age ' + String(judgement.ageMs) + 'ms）')
        return { ok: true, waitedMs: now() - startedAt, error: '', trace }
      } catch (e) {
        return { ok: false, waitedMs: now() - startedAt, error: '写锁文件失败：' + lockPath + ' · ' + String(e), trace }
      }
    }
    const waited = now() - startedAt
    if (waited >= waitMs) {
      const holder = judgement.info === null ? '未知' : judgement.info.owner
      return {
        ok: false,
        waitedMs: waited,
        error: '等待名册锁超时（' + String(waited) + 'ms，持有者 ' + holder + '）',
        trace,
      }
    }
    await sleep(pollMs)
  }
}

/** 释放：**只释放自己持有的**（不夺权）；文件已被别人换掉时不动它。 */
export function releaseLock(target: string, owner: string): string {
  const lockPath = lockPathOf(target)
  try {
    if (!existsSync(lockPath)) return ''
    const parsed = parseLock(readFileSync(lockPath, 'utf8'))
    if (parsed.info !== null && parsed.info.owner !== owner) return ''
    unlinkSync(lockPath)
    return ''
  } catch (e) {
    return '释放锁失败：' + lockPath + ' · ' + String(e)
  }
}

/** 进程内队列：同一目标的调用依次执行（键是锁文件路径）。 */
const inProcQueues = new Map<string, Promise<unknown>>()

export function serializePerTarget<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const key = lockPathOf(target)
  const prev = inProcQueues.get(key)
  const run = (prev === undefined ? Promise.resolve() : prev.catch(() => undefined)).then(fn)
  // 队列尾只用于串行化，失败不得污染下一笔
  inProcQueues.set(key, run.catch(() => undefined))
  return run
}

export interface WithLockResult<T> {
  ok: boolean
  value: T | null
  error: string
  trace: string[]
}

/**
 * 串行 + 加锁地执行一段「读-改-写」。两层都在这里收口，调用方只管传临界区。
 * 临界区抛错 ⇒ 锁仍被释放（finally），错误原样上报（不吞）。
 */
export async function withTargetLock<T>(
  target: string,
  opts: AcquireOptions,
  critical: () => Promise<T> | T,
): Promise<WithLockResult<T>> {
  return serializePerTarget(target, async () => {
    const acquired = await acquireLock(target, opts)
    if (!acquired.ok) return { ok: false, value: null, error: acquired.error, trace: acquired.trace }
    try {
      const value = await critical()
      return { ok: true, value, error: '', trace: acquired.trace }
    } catch (e) {
      return { ok: false, value: null, error: String(e), trace: acquired.trace }
    } finally {
      releaseLock(target, opts.owner)
    }
  })
}
