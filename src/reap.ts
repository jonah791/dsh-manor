/**
 * 收尸裁决（`reap`）—— 把「没人管的未完」变成**有主的决定**。
 *
 * 存在理由（2026-10-12 实测）：台账里躺着一条 `t-pwsh-probe-01`，**起于 115.6 小时前**，
 * 「有 start 无终态」= 静默失败。台账**报得出来**（未完 1 + 年龄 + 同类参照可对比），
 * 但**没有任何动作能处置它**。根因不是「发现不了」，是**处置路径不存在**。
 *
 * ⇒ 分层（沿用 `hold` / `claim` 的先例）：**事件流是历史，裁决记录是状态**。
 *   历史（`logs/actions/*.jsonl`）**一个字不改**（append-only 是它的性质，不是它的缺陷）；
 *   裁决另落 `<bus>/reap/<taskId>.json`；台账 = 历史 ⊕ 裁决 的折叠。
 *
 * ★ 为什么必须**分两档**而不是一个「已处理」：
 *   `dead`（它死了，没做成）与 `superseded`（它没做成，但目的已由别的方式达成）
 *   **对下一步的动作完全不同** —— 前者可能要重派，后者不用。
 *   「空必须分型」在这里的具体形态：把两者合成一个「已裁决」，
 *   就等于**替读的人决定「这些要不要重做」**。
 *
 * ⚠ 边界（诚实）：裁决**只对「未完」有意义**。已完成 / 失败 / 拒收都是**已成事实**，
 *   给它们收尸是改口，不是裁决。⇒ 写入侧拒收（见 `manor_reap`），
 *   读侧对「无处生效的裁决」**显式报出**（不静默吞）。
 */

/** 裁决词 —— 闭集（闭在类型上：新档必须改这里，不许用任意字符串）。 */
export type ReapVerdict = 'dead' | 'superseded'

/** 闭集的具体值（渲染指路与校验共用 ⇒ 单一真源）。 */
export const REAP_VERDICTS: readonly ReapVerdict[] = ['dead', 'superseded']

/** 裁决档位的中文释义（**给读的人看**，不是给机器看）。 */
export const REAP_LABEL: Readonly<Record<ReapVerdict, string>> = {
  dead: '判死（它没做成 ⇒ 可能要重派）',
  superseded: '已被取代（目的由别的方式达成 ⇒ 不用重做）',
}

export function isReapVerdict(v: unknown): v is ReapVerdict {
  return typeof v === 'string' && (REAP_VERDICTS as readonly string[]).includes(v)
}

/** 一条裁决记录。字段形态照 `hold` / `claim`：数字用 0、字符串用 '' 表示「无」。 */
export interface ReapRecord {
  taskId: string
  verdict: ReapVerdict
  /** **必填**：为什么判它死 / 被谁取代。空理由的裁决等于没裁决（写入口拒绝）。 */
  reason: string
  atMs: number
  /** 谁裁的（责任人留痕 —— 裁决是一个**决定**，不是一条数据）。 */
  by: string
}

/**
 * 解析一条裁决记录。**坏内容返回 `null`**（⇒ 调用方报错，不当「没有裁决」）。
 *
 * ⚠ 与 `parseClaim` 同一条纪律：**「坏」与「缺」必须分开**。
 *   把坏记录读成「没有裁决」会让一条已裁决的活**悄悄回到「没人管」**——
 *   那正好是这套机制要消灭的状态。
 */
export function parseReap(text: string): ReapRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const taskId = typeof o['taskId'] === 'string' ? o['taskId'] : ''
  const reason = typeof o['reason'] === 'string' ? o['reason'] : ''
  const by = typeof o['by'] === 'string' ? o['by'] : ''
  const atMs = typeof o['atMs'] === 'number' && Number.isFinite(o['atMs']) ? o['atMs'] : 0
  if (taskId === '') return null
  if (!isReapVerdict(o['verdict'])) return null
  if (reason.trim() === '') return null // 空理由的裁决不是裁决（写入口同样拒，读侧也拦）
  return { taskId, verdict: o['verdict'], reason, atMs, by }
}

export function buildReapRecord(i: {
  taskId: string
  verdict: ReapVerdict
  reason: string
  atMs: number
  by: string
}): ReapRecord {
  return { taskId: i.taskId, verdict: i.verdict, reason: i.reason.trim(), atMs: i.atMs, by: i.by }
}

export function serializeReap(r: ReapRecord): string {
  return JSON.stringify({
    v: 1,
    taskId: r.taskId,
    verdict: r.verdict,
    reason: r.reason,
    atMs: r.atMs,
    by: r.by,
  }, null, 2) + '\n'
}

/** 裁决记录的文件名（**单一真源**：写侧与读侧共用，不许各拼一份）。 */
export function reapFileNameOf(taskId: string): string {
  return taskId + '.json'
}

/**
 * 渲染裁决段（**可读的一行**）。`dead` 与 `superseded` **必须分开报数**（见文件头注）。
 * 一条都没有时返回空串（调用方据此不加噪音）。
 */
export function renderReapLine(counts: { dead: number; superseded: number }): string {
  const total = counts.dead + counts.superseded
  if (total === 0) return ''
  return '⚖ 已裁决 ' + String(total) + ' 条（判死 ' + String(counts.dead)
    + ' · 已被取代 ' + String(counts.superseded) + '）—— **它们不再计入「未完」**，'
    + '理由与裁决人存在各自的记录里（`reap/<taskId>.json`）'
}
