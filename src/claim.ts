/**
 * 独占领取（claim）—— ③ 任务与调度的**竞争面**（纯函数 · 零 IO · 可离线测）
 *
 * 存在理由（E12，判据由成员「澄」给出，我按她的账落 · 2026-10-12）：
 *   按任务性质分：**独立型 / 读取型 ⇒ 各做各的**（重复成本 < 协调成本，两份独立结论还能互相校对）；
 *   **独占型 / 写入型 ⇒ 必须先举手**。
 *   ★ 但她把「举手的形态」挑死了：「礼貌式举手（总线上喊一声、等别人不反对）**不可靠** ——
 *     **我没有持续在场去『举着』**」⇒ **claim 必须落在账本上的原子操作 + 可见性超时**
 *     （否则谁死在半路就永久占着）。**「『谁做』靠原子领取，不靠招呼。」**
 *
 * ★ 与 `hold` 的分界 —— **这是本模块的第一判据**：
 *   - `hold` 答「**还没开始，在等谁**」（依赖面，只存指针，状态现读）
 *   - `claim` 答「**开始了，谁在做**」（竞争面，存持有人 + 到期时刻）
 *   ⇒ 两者**正交但相邻**：同一件活可能先 held、后 claimed。
 *   ⇒ **claim 不得回答「为什么还没跑」**（那是 hold 的问题）；**hold 不得回答「谁在做」**（那是 claim 的）。
 *
 * 三条设计约束（各自都配测试）：
 *   ① **原子性靠 `wx`（O_EXCL）** —— 文件系统上唯一不需要锁的原子操作是「创建已存在的文件会失败」。
 *   ② **过期抢占靠 `rename` 的 CAS** —— 抢占本质是 read-check-write（非原子），
 *      所以先把旧记录 `rename` 进 `expired/`（**rename 同分区原子、只有一个能成功**），
 *      成功者才获得「写新 claim」的资格。
 *   ③ **过期 ≠ 静默** —— 抢占必须留痕（旧记录进 `expired/`，**不是删掉**）。
 *
 * ⚠ **fail-closed**：坏 claim 记录（读不出 / 结构不符）**不静默放行** ——
 *   按「读不到」处理并留痕（「读不到」≠「不在」，这是本文档反复踩的那条）。
 */

export const CLAIM_VERSION = 1
/** claim 记录目录名（相对总线根）。 */
export const CLAIM_DIRNAME = 'claims'
/** 过期/抢占留痕目录名（相对 `hold/`）——**旧记录进这里，不是删掉**。 */
export const CLAIM_EXPIRED_DIRNAME = 'expired'

/**
 * 默认可见性超时。
 * 取值依据（实测，非拍脑袋）：台账 92 个任务，**中位 3.7 分钟 · 最长 30.0 分钟**
 * ⇒ TTL 必须 > 最长正常耗时（否则正常跑着的活会被抢），但不该大得失去意义。
 * **15 分钟** ≈ 中位的 4 倍、最长的一半。
 */
export const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000

/** 一条 claim 记录（**只存指针与持有信息，绝不存进度**）。 */
export interface ClaimRecord {
  v: number
  taskId: string
  /** 持有人（成员 id；主脑派活时用 selfId）。 */
  holder: string
  /** 领取时刻（ISO）。 */
  at: string
  /** 可见性超时毫秒数。 */
  ttlMs: number
}

/** 判定结果。四态各有不同处置，**不可合并**。 */
export type ClaimDecision = 'granted' | 'renewed' | 'denied' | 'takeover' | 'blocked'

export interface ClaimJudgement {
  decision: ClaimDecision
  /** 给人读的一句（含持有者与剩余时间）。 */
  note: string
  /** 抢占时：旧记录应当被移去 `expired/` 的**内容**（调用方负责 rename，保原子）。 */
  stale?: ClaimRecord
  /** 当前有效的持有者（`denied` 时是她；`granted` 时是本人）。 */
  holder: string
  /** 距过期的剩余毫秒（`denied` 时 > 0；`granted`/`takeover` 时为 ttlMs）。 */
  remainMs: number
}

/** 人读的时长（与 task-ledger 的口径一致：小时 / 分钟 / 秒）。 */
export function humanSpan(ms: number): string {
  const x = Math.max(0, ms)
  if (x >= 3_600_000) return (x / 3_600_000).toFixed(1) + ' 小时'
  if (x >= 60_000) return (x / 60_000).toFixed(1) + ' 分钟'
  return (x / 1000).toFixed(1) + ' 秒'
}

export function claimFileNameOf(taskId: string): string {
  return taskId + '.json'
}

/**
 * 纯判定：给定「盘上现有的记录（或 null）」+ 请求者 + 现在时刻 ⇒ 该走哪条路。
 *
 * 判定表（**每一格都配测试**）：
 *   | 现状 | 结果 |
 *   |---|---|
 *   | 无记录 | `granted`（新建） |
 *   | 有记录，**同一持有人** | `renewed`（**幂等 + 续期**：我还在做，就是在续「我还在」） |
 *   | 有记录，别人，**未过期** | `denied`（报持有人与剩余） |
 *   | 有记录，别人，**已过期** | `takeover`（抢占；旧记录交给调用方 rename 进 `expired/`） |
 *   | 记录坏（`null` 但**存在**） | `blocked`（fail-closed，**不静默放行**） |
 *
 * @param existing 盘上的记录；`undefined` = **确认不存在**（可领取）；`null` = **读不到/坏**（fail-closed）
 * @param nowMs 现在（毫秒）；缺省由调用方必须给 —— **年龄/剩余一律现算，不缓存**
 */
export function judgeClaim(
  existing: ClaimRecord | undefined | null,
  taskId: string,
  holder: string,
  nowMs: number,
  ttlMs: number = DEFAULT_CLAIM_TTL_MS,
): ClaimJudgement {
  if (existing === null) {
    return {
      decision: 'blocked',
      note: '**有同名 claim 文件但读不出或结构不符** ⇒ fail-closed：不静默放行，'
        + '需人工看一眼（「读不到」≠「不在」）',
      holder: '',
      remainMs: 0,
    }
  }
  if (existing === undefined) {
    return {
      decision: 'granted',
      note: '领取成功（此前无记录）· 有效期 ' + humanSpan(ttlMs),
      holder,
      remainMs: ttlMs,
    }
  }
  const atMs = Date.parse(existing.at)
  const elapsed = Number.isNaN(atMs) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - atMs)
  const remain = existing.ttlMs - elapsed
  if (existing.holder === holder) {
    return {
      decision: 'renewed',
      note: '续期成功（**同一持有人重领 = 幂等续期**：我还在做，这一笔就是在续「我还在」）'
        + '· 有效期 ' + humanSpan(existing.ttlMs),
      holder,
      remainMs: existing.ttlMs,
    }
  }
  if (remain > 0) {
    return {
      decision: 'denied',
      note: '**已被 `' + existing.holder + '` 持有**，剩余 ' + humanSpan(remain)
        + ' ⇒ 不抢（`' + taskId + '` 是独占型；独立型/读取型的活本就该各做各的，不需要 claim）',
      holder: existing.holder,
      remainMs: remain,
    }
  }
  return {
    decision: 'takeover',
    note: '**原持有者 `' + existing.holder + '` 已超时 ' + humanSpan(-remain)
      + '** ⇒ 允许抢占；旧记录移入 `' + CLAIM_EXPIRED_DIRNAME + '/` **留痕**（不是删掉）',
    stale: existing,
    holder,
    remainMs: ttlMs,
  }
}

/** 造一条新记录（`renewed` 时调用方仍会写新 `at` ⇒ 续期在盘上可见）。 */
export function buildClaimRecord(taskId: string, holder: string, nowMs: number, ttlMs: number): ClaimRecord {
  return { v: CLAIM_VERSION, taskId, holder, at: new Date(nowMs).toISOString(), ttlMs }
}

export function serializeClaim(r: ClaimRecord): string {
  return JSON.stringify(r) + '\n'
}

/**
 * 解析一条 claim 记录。
 * **区分「不存在」与「坏」**：调用方读到文件内容才调本函数；
 * 返回 `null` 表示**内容坏**（⇒ `judgeClaim` 会判 `blocked`），不是「没有记录」。
 */
export function parseClaim(text: string): ClaimRecord | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (o === null || typeof o !== 'object') return null
    const v = o['v']
    const taskId = o['taskId']
    const holder = o['holder']
    const at = o['at']
    const ttlMs = o['ttlMs']
    if (typeof v !== 'number' || typeof taskId !== 'string' || taskId === '') return null
    if (typeof holder !== 'string' || holder === '') return null
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null
    if (typeof ttlMs !== 'number' || !(ttlMs > 0)) return null
    return { v, taskId, holder, at, ttlMs }
  } catch {
    return null
  }
}
