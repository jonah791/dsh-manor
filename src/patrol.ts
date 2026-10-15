/**
 * 庄园存活巡检 —— 决策层（纯函数 · 零 IO · 可离线测）
 *
 * 存在理由（庄园语义文档 §5.2）：2026-10-10 实测「成员会静默死亡而无人发现」，
 * 2026-10-11 复核：织死了 6.4 小时、澄死了 70 小时，**没有任何机制或人知道**，
 * 派给织的 4 条活就一直躺在她的收件箱里。庄园缺的不是「能起成员」，是
 * 「**死了会被发现、并被拉回来**」。
 *
 * 三条纪律（不是风格偏好，是各自对应一种事故）：
 *   1. **有界退避**：连续拉起必须**推远**下次尝试（AGENTS.md §5.17）——
 *      否则崩溃循环会紧转轮烧资源，而「转得快」还会掩盖「它其实起不来」这个事实。
 *   2. **上限告警**：重试到上限仍不活 ⇒ **停止重试并升级为告警**（不静默、也不无限重试）。
 *      「一直重试」看起来比「放弃」努力，实际是把问题藏进噪音里。
 *   3. **恢复即清零**：成员活回来后**清掉她的重试账**——否则下次死时退避会从上次的位置继续，
 *      把「新的一次故障」当成「旧故障的第 N 次」。
 */
import type { NodeObservation, RosterFile } from './roster-registry.ts'

export type PatrolAction = 'ok' | 'wake' | 'alert' | 'skip-backoff'

export interface PatrolAttempt {
  /** 连续拉起尝试次数（成员活回来即清零） */
  count: number
  lastAtMs: number
  lastReason: string
}

export interface PatrolState {
  v: number
  lastRunAtMs: number
  attempts: Record<string, PatrolAttempt>
}

export const PATROL_VERSION = 1

/**
 * **启动即补一轮**的判据（§5.11 规则 5「定时机制防重启吞」· 2026-10-14 补）。
 *
 * ★ 存在理由（现读抓出的**不对称**）：`holdTimer` 有启动即补（`index.ts` 明引本条纪律），
 *   而 **`patrolTimer` 没有** ⇒ 每轮 web 重启后，巡检要**干等满一个周期**（缺省 5 分钟）
 *   才开始干活；停机期间死掉的成员会**多躺最多 5 分钟**。
 *   `manor.md` 也只给 hold 那条路记了「启动即补一轮」⇒ 不对称是真的，不是我看错。
 *
 * ★ 判据：**距上次跑满一个周期**就立刻补。⚠ 不是「启动就无条件跑」——
 *   那会让**热重载/快速连重启**把巡检变成紧转轮（与 §5.17「跳过必须推远」同精神）。
 *
 * @param lastRunAtMs 上次巡检落盘时刻（`manor-patrol-state.json`）
 * @param nowMs 启动时刻
 * @param intervalMs 巡检周期
 */
export function shouldRunOnBoot(lastRunAtMs: number, nowMs: number, intervalMs: number): boolean {
  // ★ 脏值**取严**（倾向补跑）：宁可多跑一轮，也不因一个坏数字而干等
  if (!Number.isFinite(lastRunAtMs) || !Number.isFinite(nowMs)) return true
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return true
  const elapsed = nowMs - lastRunAtMs
  // ★ 未来时刻（时钟回拨 / 账被改）同样**取严**补跑
  if (elapsed < 0) return true
  return elapsed >= intervalMs
}

export function emptyPatrolState(nowMs: number): PatrolState {
  return { v: PATROL_VERSION, lastRunAtMs: nowMs, attempts: {} }
}

/** 把来路不明的巡检状态归一（坏字段补默认值，不抛——状态坏了不该让巡检停摆）。 */
export function normalizePatrolState(raw: unknown, nowMs: number): PatrolState {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const attempts: Record<string, PatrolAttempt> = {}
  const rawAtt = o['attempts']
  if (rawAtt !== null && typeof rawAtt === 'object' && !Array.isArray(rawAtt)) {
    for (const [k, v] of Object.entries(rawAtt as Record<string, unknown>)) {
      const a = (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>
      const count = typeof a['count'] === 'number' && Number.isFinite(a['count']) ? a['count'] : 0
      attempts[k] = {
        count,
        lastAtMs: typeof a['lastAtMs'] === 'number' && Number.isFinite(a['lastAtMs']) ? a['lastAtMs'] : 0,
        lastReason: typeof a['lastReason'] === 'string' ? a['lastReason'] : '',
      }
    }
  }
  return {
    v: PATROL_VERSION,
    lastRunAtMs: typeof o['lastRunAtMs'] === 'number' && Number.isFinite(o['lastRunAtMs']) ? o['lastRunAtMs'] : nowMs,
    attempts,
  }
}

export interface PatrolDecision {
  id: string
  name: string
  action: PatrolAction
  reason: string
  heartbeatAgeMs: number
  attemptCount: number
}

export interface PatrolPlan {
  decisions: PatrolDecision[]
  /** 本轮要拉起的（按 id 升序稳定） */
  toWake: string[]
  /** 本轮要告警的（重试到上限仍不活） */
  toAlert: string[]
  healthy: string[]
  /** 本轮发现已恢复的 ⇒ 调用者应清掉它们的重试账 */
  recovered: string[]
}

/**
 * 算本轮巡检计划。
 *
 * `deadAfterMs` 有意**宽于心跳新鲜阈值**（缺省 5 分钟 vs 30 秒）：心跳抖动一次不该触发拉起。
 * 「从未上线」也算死的（`observation` 缺失）——聘了没起过正是要拉起的场景。
 */
export function planPatrol(input: {
  roster: RosterFile
  observations: NodeObservation[]
  state: PatrolState
  nowMs: number
  deadAfterMs: number
  maxAttempts: number
  backoffMs: number[]
}): PatrolPlan {
  const byId = new Map<string, NodeObservation>()
  for (const o of input.observations) byId.set(o.id, o)
  const decisions: PatrolDecision[] = []
  const toWake: string[] = []
  const toAlert: string[] = []
  const healthy: string[] = []
  const recovered: string[] = []

  for (const m of input.roster.members) {
    if (m.status !== 'active') continue // 已退役的不巡检——退役就是「不再管她的身体」
    const ob = byId.get(m.id)
    let ageMs = -1
    if (ob !== undefined) {
      ageMs = input.nowMs - ob.atMs
      if (ageMs < 0) ageMs = -1
    }
    const isDead = ob === undefined || ageMs < 0 || ageMs >= input.deadAfterMs

    if (!isDead) {
      healthy.push(m.id)
      if (input.state.attempts[m.id] !== undefined) recovered.push(m.id)
      decisions.push({ id: m.id, name: m.name, action: 'ok', reason: '心跳新鲜', heartbeatAgeMs: ageMs, attemptCount: 0 })
      continue
    }

    const att = input.state.attempts[m.id]
    const count = att !== undefined ? att.count : 0
    const lastAt = att !== undefined ? att.lastAtMs : 0
    const why = ob === undefined
      ? '从未上线'
      : (ageMs < 0 ? '心跳时间异常（在未来）' : '心跳过期 ' + String(Math.round(ageMs / 1000)) + 's')

    if (count >= input.maxAttempts) {
      toAlert.push(m.id)
      decisions.push({
        id: m.id, name: m.name, action: 'alert',
        reason: why + '；已连续拉起 ' + String(count) + ' 次仍不活 ⇒ **停止重试、升级告警**（需人介入）',
        heartbeatAgeMs: ageMs, attemptCount: count,
      })
      continue
    }

    if (count > 0) {
      const waitMs = input.backoffMs[Math.min(count - 1, input.backoffMs.length - 1)] ?? 0
      const since = input.nowMs - lastAt
      if (since < waitMs) {
        decisions.push({
          id: m.id, name: m.name, action: 'skip-backoff',
          reason: why + '；退避中（第 ' + String(count) + ' 次尝试后等 ' + String(Math.round(waitMs / 1000))
            + 's，还差 ' + String(Math.round((waitMs - since) / 1000)) + 's）',
          heartbeatAgeMs: ageMs, attemptCount: count,
        })
        continue
      }
    }

    toWake.push(m.id)
    decisions.push({
      id: m.id, name: m.name, action: 'wake',
      reason: why + (count > 0 ? '；第 ' + String(count + 1) + ' 次拉起' : '；首次拉起'),
      heartbeatAgeMs: ageMs, attemptCount: count,
    })
  }

  return { decisions, toWake, toAlert, healthy, recovered }
}

/**
 * 记本轮结果。**只对真的发起过拉起（成功或失败）的成员记账**——
 * 拉起失败也计数（否则一个永远起不来的成员会被无限重试）。
 */
export function updatePatrolState(
  state: PatrolState,
  plan: PatrolPlan,
  wakeResults: { id: string; ok: boolean }[],
  nowMs: number,
): PatrolState {
  const attempts: Record<string, PatrolAttempt> = { ...state.attempts }
  for (const id of plan.recovered) delete attempts[id]
  for (const r of wakeResults) {
    const prev = attempts[r.id]
    attempts[r.id] = {
      count: (prev !== undefined ? prev.count : 0) + 1,
      lastAtMs: nowMs,
      lastReason: r.ok ? '已发起（等待心跳）' : '拉起失败',
    }
  }
  return { v: PATROL_VERSION, lastRunAtMs: nowMs, attempts }
}

/** 巡检结果的对外形状（供工具层渲染）。 */
export interface PatrolReport {
  ranAtMs: number
  activeCount: number
  healthyCount: number
  wokeCount: number
  alertCount: number
  skipCount: number
  lines: string[]
}

export function renderPatrol(plan: PatrolPlan, activeCount: number, nowMs: number): PatrolReport {
  const lines: string[] = []
  const woke = plan.decisions.filter((d) => d.action === 'wake')
  const alert = plan.decisions.filter((d) => d.action === 'alert')
  const skip = plan.decisions.filter((d) => d.action === 'skip-backoff')
  lines.push(
    '存活巡检｜在职 ' + String(activeCount) + ' · 健康 ' + String(plan.healthy.length)
    + ' · 拉起 ' + String(woke.length) + ' · 退避中 ' + String(skip.length) + ' · 告警 ' + String(alert.length),
  )
  for (const d of plan.decisions) {
    if (d.action === 'ok') continue
    const tag = d.action === 'wake' ? '↻' : (d.action === 'alert' ? '✖' : '⏳')
    lines.push('  ' + tag + ' ' + d.id + '（' + (d.name !== '' ? d.name : '?') + '）：' + d.reason)
  }
  if (plan.recovered.length > 0) lines.push('  ✔ 已恢复（重试账清零）：' + plan.recovered.join('、'))
  return {
    ranAtMs: nowMs,
    activeCount,
    healthyCount: plan.healthy.length,
    wokeCount: woke.length,
    alertCount: alert.length,
    skipCount: skip.length,
    lines,
  }
}
