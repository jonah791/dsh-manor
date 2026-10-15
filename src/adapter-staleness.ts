/**
 * 成员适配器「跑的是哪个构建」的判据（纯函数，零 I/O）。
 *
 * ## 存在理由（2026-10-14 现读抓出）
 *
 * `adapter.mjs` 是**独立长驻 node 进程**（不属 web 进程树）⇒ **重启 web 不重启它们**。
 * 于是改完 adapter 的代码、测试全绿、预检通过、重启 web —— **五名成员照旧跑旧代码**，
 * 而**没有任何读数会告诉你这件事**。
 *
 * 实测（2026-10-14 11:13，域=庄园名册 6 名成员）：
 *   adapter.mjs mtime = 10-13 23:49:40
 *   maid-01..05 进程 start = 10-13 12:38:34 ⇒ **滞后 11 小时 11 分 6 秒**
 *   只有 maid-06（23:57:07 起）含新代码
 *
 * 同日的真实事故：改 adapter 加 `envelopeCreatedAtMs` → 测试全绿 → 预检 → 重启 web → 派活
 * ⇒ **字段没进动作日志**；杀秤(9388) 后 `manor_wake` 拉起(5648) ⇒ 字段才出现。
 * 我当时的诊断是「成员适配器是独立进程，重启 web 不重启它们」——**那句话是对的，
 * 而它只活在我的会话里**（纪律会随压缩蒸发）。
 *
 * ## 判据为何用 `startedAtMs`，不查进程
 *
 * `adapter.mjs:622` **早就在心跳里自报** `startedAtMs: startedAt`（`Date.now()`，adapter.mjs:108）。
 * ⇒ **数据一直在心跳里，缺的只是显示面**（§5.22 规则 2「线上跑的是哪个构建」的成员侧落点）。
 * 而进程 `StartTime` 要宿主权限去查别的进程——**插件做不到，也不该做**（§5.34：依赖要显式）。
 *
 * ## 为何是三态而不是两态
 *
 * 缺 `startedAtMs`（老版本心跳 / 非适配器进程）时，**「判不了」必须与「新鲜」分开报**——
 * 合并即静默：一个读不出的成员会被渲染成「已含新代码」。
 * 这与 §5.9 规则 4 同族（异常状态先问「为什么是这样」），也与 `inbox.ts` 的空分型同源。
 *
 * ## 与既有三条 `stale` 的关系（防误读）
 *
 * 现存三个 `stale` **全都不是它**：`inbox.ts` 是**信箱** stale · `claim.ts` 是**租约** stale ·
 * `manor_*` 报的是**心跳** stale。本判据补的是第四格：**成员在跑旧代码**。
 *
 * ⚠ 与 §5.11 规则 7 **同构**：改配置约 2 秒自生效，改代码必须重启——成员侧同理。
 */

/** 成员相对 adapter 产物的新鲜度（三态，`unknown` 不可省）。 */
export type AdapterFreshness = 'fresh' | 'stale' | 'unknown'

export interface AdapterStaleness {
  /** 三态判定。 */
  freshness: AdapterFreshness
  /** 成员启动时刻（ms）；`unknown` 时为 0。 */
  startedAtMs: number
  /** 滞后时长（ms）= adapter mtime − startedAtMs；非 stale 时为 0。 */
  lagMs: number
}

/**
 * 判一名成员相对 adapter 产物是否跑旧代码。
 *
 * @param startedAtMs 成员心跳里的 `startedAtMs`（非有限数 ⇒ unknown）
 * @param adapterMtimeMs adapter.mjs 的 mtime（非有限数 ⇒ 全体 unknown，响亮降级）
 *
 * 判据：`startedAtMs < adapterMtimeMs` ⇒ stale（**零迟滞**——改完代码即算旧）。
 * ⚠ 相等算 fresh：同一秒内起进程与落盘在文件系统时间粒度下不可区分，取严会让
 *   每次「刚改完就重启」都误报。
 */
export function judgeAdapterFreshness(startedAtMs: number, adapterMtimeMs: number): AdapterStaleness {
  // ⚠ 两处 `<= 0` 都不是防御性冗余：**0 是「读不到」的哨兵值**（`statSync` 失败、字段缺失、
  //   老版本心跳都落 0）。只查 `isFinite` 会让 0 通过守卫 ⇒ `0 < mtime` 为真时判 stale、
  //   为假时判 **fresh** —— 后者是**静默放行**，正是本判据最该防的形态。
  //   实测：这条由 `tests/adapter-staleness.test.ts` 第 63 行抓出（实现先错、测试先红）。
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(adapterMtimeMs)) {
    return { freshness: 'unknown', startedAtMs: 0, lagMs: 0 }
  }
  if (startedAtMs <= 0 || adapterMtimeMs <= 0) {
    return { freshness: 'unknown', startedAtMs: 0, lagMs: 0 }
  }
  if (startedAtMs < adapterMtimeMs) {
    return { freshness: 'stale', startedAtMs, lagMs: adapterMtimeMs - startedAtMs }
  }
  return { freshness: 'fresh', startedAtMs, lagMs: 0 }
}

/** 把滞后时长渲染成人读的一段（`11 小时 11 分`）。 */
export function renderLag(lagMs: number): string {
  if (!Number.isFinite(lagMs) || lagMs <= 0) return ''
  const sec = Math.floor(lagMs / 1000)
  const day = Math.floor(sec / 86400)
  const hour = Math.floor((sec % 86400) / 3600)
  const min = Math.floor((sec % 3600) / 60)
  if (day > 0) return `${day} 天 ${hour} 小时`
  if (hour > 0) return `${hour} 小时 ${min} 分`
  if (min > 0) return `${min} 分`
  return `${sec} 秒`
}

export interface StaleSummary {
  /** 跑旧代码的成员 id（滞后降序）。 */
  staleIds: readonly string[]
  /** 判不了的成员 id（缺 `startedAtMs` / 非适配器进程）。 */
  unknownIds: readonly string[]
  /** 最长的滞后时长（ms）。 */
  maxLagMs: number
  /** 渲染好的一行；**全体 fresh 时返回空串**（不占常读面）。 */
  line: string
}

/**
 * 汇总全体成员的新鲜度，渲染一行挂到 `manor_find` 上。
 *
 * **设计取舍**：全 fresh 时返回空串——常读面只在**有异常**时出声。
 * ⚠ 但这与 `inbox.ts` 的「空必须分型」不冲突：`unknownIds` 非空时**必须出声**
 *   （「判不了」是异常，不是安静）。
 */
export function summarizeStaleAdapters(
  rows: readonly { id: string; startedAtMs: number }[],
  adapterMtimeMs: number,
): StaleSummary {
  const stale: { id: string; lagMs: number }[] = []
  const unknownIds: string[] = []
  for (const r of rows) {
    const v = judgeAdapterFreshness(r.startedAtMs, adapterMtimeMs)
    if (v.freshness === 'stale') stale.push({ id: r.id, lagMs: v.lagMs })
    else if (v.freshness === 'unknown') unknownIds.push(r.id)
  }
  stale.sort((a, b) => b.lagMs - a.lagMs)
  const maxLagMs = stale.length > 0 ? (stale[0] as { lagMs: number }).lagMs : 0
  const parts: string[] = []
  if (stale.length > 0) {
    const head = stale
      .slice(0, 3)
      .map((s) => `${s.id}(${renderLag(s.lagMs)})`)
      .join(' ')
    const more = stale.length > 3 ? ` 等 ${stale.length} 个` : ''
    parts.push(`⚠ 跑旧代码 ${stale.length} 个：${head}${more}`)
  }
  if (unknownIds.length > 0) {
    const head = unknownIds.slice(0, 3).join(' ')
    const more = unknownIds.length > 3 ? ` 等 ${unknownIds.length} 个` : ''
    parts.push(`判不了 ${unknownIds.length} 个：${head}${more}`)
  }
  return {
    staleIds: stale.map((s) => s.id),
    unknownIds,
    maxLagMs,
    line: parts.length === 0 ? '' : parts.join(' · '),
  }
}
