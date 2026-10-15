/**
 * 任务失败守望 —— ⑥ 观测与治理的「**追**」半环（纯函数 · 零 IO · 可离线测）
 *
 * 存在理由（2026-10-11 实测）：
 *   上一步做出了**归因**（`manor_tasks`：四终态 + 失败类别），但那只是**能查**——
 *   没有人或机制会在我没去查的时候告诉我「又失败了三个」。文档里这一半标着「未建」。
 *   ⇒ 本层补的是**主动侧**：**新增**的失败/静默失败要被推出去，而不是等我去 grep。
 *
 * 三条纪律（写死在这里，供测试直接断言）：
 *   - **W1 只报新增**：同一 taskId 只通报一次（记住 seen）。否则每轮巡检重报同一批 ⇒
 *     「狼来了」，告警通道会被自己淹掉（§5.14 规则 5 的同理）。
 *   - **W2 拒收不报故障**：`rejected` 是**防线在工作**，不进故障告警（只累计计数）。
 *     把拒收报成故障 = 让人去修一个没坏的东西（2026-10-11 已犯过一次同类错）。
 *   - **W3 未完优先报**：`unfinished`（有 start 无终态）比 `failed` 更值得喊——
 *     失败至少留下了原因，未完是**静默**的。
 *   - **W4 首轮只建基线**：第一次运行时**不报**，只把现有失败登记进 seen。
 *     否则启用瞬间会把**全部历史失败**一次性推出去（实测 18 条）——那是「狼来了」的最坏形态。
 */

import type { TaskRecord } from './task-ledger.ts'
// 任务性质是**信封契约**里定义的闭集（单一真源）—— 本层只读它做分流，不自己判。
import type { TaskNature } from './envelope.ts'

export const TASK_WATCH_VERSION = 1

/**
 * 「未完」的**静默期**：从 `startedAtMs` 起算，短于它的 `unfinished` **不报**。
 *
 * ★ W5（2026-10-12 主人问「怎么发了一堆任务失败」时查出）：修前 `unfinished`（有 start 无终态）
 *   **一出现就报**，措辞还是「⛔ 静默失败」。实测代价：我 09:57 派给 maid-01 的活，10:01 就被
 *   报成静默失败（**4 分钟**）——而台账自己写着「同一成员已完成任务的最长耗时 20 分钟
 *   ⇒ **明显超过它才谈得上「卡住」**」，并明说「**『还在跑』与『静默失败』是两类**」。
 * ⇒ 取值 25 分钟 = 实测最长耗时 20 分钟 × 1.25（留出余量；**不是拍脑袋**，依据是台账读数）。
 * ⚠ 只加在 `unfinished` 上：`failed` **有终态**，它不需要等（等到期只会拖慢真故障的通报）。
 */
export const DEFAULT_SILENT_GRACE_MS = 1500000

export interface TaskWatchState {
  v: number
  updatedAtMs: number
  /** 已通报过的 taskId → 首次通报时刻（只报新增，见 W1） */
  seen: Record<string, number>
  /** 累计通报过的失败/未完条数（用于报「本轮新增 N 条 / 累计 M 条」） */
  reportedTotal: number
  /** 0 = 尚未建基线（首轮只登记不告警，见 W4） */
  baselineAtMs: number
}

export function emptyTaskWatchState(nowMs: number): TaskWatchState {
  return { v: TASK_WATCH_VERSION, updatedAtMs: nowMs, seen: {}, reportedTotal: 0, baselineAtMs: 0 }
}

/** 把来路不明的状态归一（缺字段补默认，不抛）。 */
export function normalizeTaskWatchState(raw: unknown, nowMs: number): TaskWatchState {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const seenRaw = r['seen']
  const seen: Record<string, number> = {}
  if (seenRaw !== null && typeof seenRaw === 'object') {
    for (const [k, v] of Object.entries(seenRaw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) seen[k] = v
    }
  }
  const total = r['reportedTotal']
  const base = r['baselineAtMs']
  return {
    v: TASK_WATCH_VERSION,
    updatedAtMs: typeof r['updatedAtMs'] === 'number' ? r['updatedAtMs'] : nowMs,
    seen,
    reportedTotal: typeof total === 'number' && Number.isFinite(total) ? total : 0,
    baselineAtMs: typeof base === 'number' && Number.isFinite(base) ? base : 0,
  }
}

/** 一条待通报的告警。 */
export interface TaskAlert {
  taskId: string
  /** 派给谁（'' = 日志未记成员，**不猜**） */
  to: string
  /**
   * 任务性质（透传自台账）。**分流的唯一依据**（`owner` ⇒ 推给主人；`internal`/`probe` ⇒ 只进读数）。
   * ⚠ 消费侧**不许**自己判「这条像不像主人的活」（那是编造）；它只读这一格。
   */
  nature: TaskNature
  outcome: 'failed' | 'unfinished'
  /** 归因：failureKind（failed）或 'silent'（unfinished） */
  reason: string
  /** 终态原文（诊断用） */
  tail: string
  ms: number
}

export interface TaskWatchPlan {
  /** 本轮**新增**、需要通报的告警（W1：同一任务只出现一次）—— ★ **只含 `owner` 档** */
  alerts: TaskAlert[]
  /**
   * ★ W6（2026-10-12 · 主人问「怎么发了一堆任务失败」）：**同一批新增里不该打扰主人的那些**。
   *
   * 为什么要单独一格而**不是丢弃**：「不推」不等于「不记」。它们照样是本轮的新增失败 ——
   *   台账（`manor_tasks`）全量可见，工具**输出**里也照报，变的只是 **telegram 推不推**。
   *   ⇒ 丢弃它们 = 用一次「降噪」把「内部试错的可见性」也一起削掉（正是我该避免的形状）。
   */
  quietAlerts: TaskAlert[]
  /** 本轮看到的拒收数（W2：不报故障，只计数） */
  rejectedSeen: number
  /**
   * W5：因**静默期**而暂不通报的未完数。
   * ★ 它必须**可见** —— 否则「没报」与「没有未完」会被读成同一件事（W5 的静默期是新引入的「不报」理由）。
   */
  young: number
  /** 本轮看到的失败/未完**总数**（含已被通报过的，用于给出全局读数） */
  totalFailed: number
  totalUnfinished: number
  /** 首轮建基线时登记了多少条（W4：>0 且 alerts 为空 = 这是首次运行，不是「没有失败」） */
  seeded: number
  nextState: TaskWatchState
}

const alertOf = (t: TaskRecord): TaskAlert => ({
  taskId: t.taskId,
  to: t.to,
  nature: t.nature,
  outcome: t.outcome === 'unfinished' ? 'unfinished' : 'failed',
  reason: t.outcome === 'unfinished' ? 'silent' : (t.failureKind !== 'none' ? t.failureKind : 'unknown'),
  tail: t.tail,
  ms: t.ms,
})

/**
 * 计划一轮守望：折出「该报什么」与「新状态」。
 * 纯函数——**不发送、不写盘**，两件事都归调用方（便于离线测）。
 */
export function planTaskWatch(
  tasks: TaskRecord[],
  state: TaskWatchState,
  nowMs: number,
  silentGraceMs: number = DEFAULT_SILENT_GRACE_MS,
): TaskWatchPlan {
  const seeding = state.baselineAtMs === 0 // W4：首轮只建基线
  const seen = { ...state.seen }
  const alerts: TaskAlert[] = []
  const quietAlerts: TaskAlert[] = []
  let rejectedSeen = 0
  let totalFailed = 0
  let totalUnfinished = 0
  let seeded = 0
  let young = 0

  // W3：未完排在前（更值得喊）
  const ordered = [...tasks].sort((a, b) => {
    const rank = (t: TaskRecord): number => (t.outcome === 'unfinished' ? 0 : 1)
    return rank(a) - rank(b)
  })

  for (const t of ordered) {
    if (t.outcome === 'rejected') {
      rejectedSeen += 1
      continue // W2：拒收是防线在工作，不进故障告警
    }
    if (t.outcome === 'done') continue
    if (t.outcome === 'failed') totalFailed += 1
    if (t.outcome === 'unfinished') totalUnfinished += 1
    // ★ W5 静默期（见 `DEFAULT_SILENT_GRACE_MS` 头注）：**年轻的未完不报**。
    //   ⚠ **年轻的不写进 `seen`** —— 写了它下次真超时也**永远不会再报**（漏报比误报更坏）。
    //   ⚠⚠ **负数 ≠ 年轻**：`age < 0` 意味着「这条活的时间算不出来」（时钟倒挂 / 夹具用了假 now），
    //     而**「算不出来」必须有自己的处置** —— 这里取严**报出**（漏报比误报坏）。
    //     实测：本判据上线时，5 条既有测试立刻红了 —— 它们的 `now` 是假的常量 T0（比日志时间早）
    //     ⇒ 若把负数当年轻，**所有**未完都会被静默掉，而测试全绿（假绿）。同族纪律：
    //     `unreadable ≠ clean` · `no data ≠ zero` · 「空必须有自己的值」。
    const ageMs = nowMs - t.startedAtMs
    if (t.outcome === 'unfinished' && ageMs >= 0 && ageMs < silentGraceMs) {
      young += 1
      continue
    }
    if (seen[t.taskId] !== undefined) continue // W1：只报新增
    seen[t.taskId] = nowMs
    if (seeding) {
      seeded += 1
      continue // W4：首轮只登记，不告警
    }
    // ★ W6 分流（2026-10-12 · 主人在意的是「别拿内部试错烦我」）：
    //   依据是**派活侧声明的 `nature`**，不是消费侧猜「哪条像主人的活」（那是编造）。
    //   ⚠ 两格**都要**产出 —— `quietAlerts` 不是垃圾桶，它是「**不推但照记**」的那一半。
    const one = alertOf(t)
    if (t.nature === 'owner') alerts.push(one)
    else quietAlerts.push(one)
  }

  return {
    alerts,
    quietAlerts,
    rejectedSeen,
    young,
    totalFailed,
    totalUnfinished,
    seeded,
    nextState: {
      v: TASK_WATCH_VERSION,
      updatedAtMs: nowMs,
      seen,
      reportedTotal: state.reportedTotal + alerts.length,
      baselineAtMs: seeding ? nowMs : state.baselineAtMs,
    },
  }
}

/** 渲染告警（给人看/发出去的那段）。空数组返回 ''（调用方据此决定不发）。 */
export function renderTaskAlerts(alerts: TaskAlert[]): string {
  if (alerts.length === 0) return ''
  const silent = alerts.filter((a) => a.outcome === 'unfinished')
  const lines: string[] = []
  lines.push('⚠ 庄园任务告警 · 新增 ' + String(alerts.length) + ' 条')
  for (const a of alerts) {
    const who = a.to !== '' ? a.to : '(未记成员)'
    const secs = a.ms > 0 ? (a.ms / 1000).toFixed(0) + 's' : '-'
    const head = a.outcome === 'unfinished' ? '⛔ 静默失败（有 start 无终态）' : '✖ 失败/' + a.reason
    lines.push('  ' + head + ' · ' + a.taskId + ' → ' + who + ' · ' + secs)
    if (a.tail !== '') lines.push('      ' + a.tail.slice(0, 160))
  }
  if (silent.length > 0) {
    lines.push('（其中 ' + String(silent.length) + ' 条是**静默失败**——最该追的一类）')
  }
  return lines.join('\n')
}
