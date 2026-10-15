/**
 * 收件箱分类 —— ④ 通信面的「**为什么它躺在那儿**」（纯函数 · 零 IO · 可离线测）
 *
 * 存在理由（2026-10-12 实测）：
 *   `manor_find` 早已会报「收件箱 待 4 死 0」——**可见面是有的**。但那个读数**回答不了
 *   「为什么它没被取」**：对 `kind:"result"` 的信封，答案是「**它永远不会被取**」；
 *   对 `kind:"chat"` 的信封，答案是「下一轮轮询就会取」。**同一个数字，两种完全不同的处置。**
 *
 *   实测形态：maid-01 的 4 条积压**全是 result**（**她那一侧**最旧 31 小时）、maid-04 那 1 条也是 result
 *   ——而两名成员**心跳都是新鲜的**。⇒ 这**不是**「消费侧没保活」（我原先写进 §5.4 的归因**是错的**），
 *   **是真没有消费者**：适配器的 `MANOR_KINDS` 只认 `task`/`chat`（有意克制「不越界，留给别的消费者」），
 *   而总线上**没有别的消费者**。⇒ 那些信躺到天荒地老。
 *
 * ⚠ **口径域（2026-10-12 由勘全域扫描更正 · 我原先那个数低估了一个数量级）**：
 *   本文所有读数（含工具输出）的域是 **「庄园成员的信箱」**——`manor_find` 只遍历名册成员。
 *   **总线全域**（`mailbox/*` 全部箱子）另有一批，**不在本工具的覆盖内**，实测（勘的扫描）：
 *   **无人认领 10 条 = result 7 · event 3**，最旧的是 `sim-node-a` 的 result —— **653.7 小时（27 天）**，
 *   另有 `primary` 的 event 361.7h×2、`node-a-3090` 的 event 355.1h。
 *   ⇒ 报数时必须带域：**「成员信箱里最旧 31 小时」≠「总线上最旧 31 小时」**（后者是 27 天）。
 *   ⇒ 也说明本工具是**必要不充分**：它答「成员信箱有没有搁浅」，不答「总线全域有没有」。
 *
 * 本层把「待 N」拆成两档（与 §5.3 任务台账同一课：**分类先于治理**）：
 *   - **可处理**（`claimable`）：kind 在 `MANOR_KINDS` 里 ⇒ 下一轮轮询就会被取走，不需要人管
 *   - **无人认领**（`unclaimed`）：其余 kind ⇒ 除非有人**改归属**，否则不会被取
 *
 * ⚠ **契约同源**：`MANOR_KINDS` 的真源是适配器 `projects/self/alice-manor/dispatch.mjs`。
 *   跨语言（TS ↔ `.mjs`）无法直接 import ⇒ 这里**复制一份**，并**由测试读那个文件逐字对账**
 *   （见 `tests/inbox.test.ts`「契约同源」一例）。
 *   **两处不可避免时，用测试把它们绑住**——而不是靠「记得同步」（那正是 `source-of-truth-guards`
 *   明确证伪过的做法：同一事实写两处 ⇒ 迟早静默漂移）。
 */

export const INBOX_VERSION = 1

/**
 * 本适配器**认领**的 kind（断言来自 `dispatch.mjs` 的 `MANOR_KINDS`）。
 * 改这里必须同时改那边——`tests/inbox.test.ts` 会读那个文件逐字对账，改一边就红。
 */
export const CLAIMABLE_KINDS = ['task', 'chat']

/** 无人认领件超过这个时长就算「搁浅」，值得报出来（缺省 6 小时）。 */
export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000

/** 一个信封里我们关心的两项（其余字段与本节无关）。 */
export interface InboxItem {
  /** 信封的 `kind`（来路不明一律按「不认识」处理）。 */
  kind: unknown
  /** 信封的 `createdAt`（ms）。非法值**不计龄**——不猜。 */
  createdAt: unknown
}

export interface InboxSummary {
  /** 信箱里全部待处理件（= 旧读数的「待 N」）。 */
  pending: number
  /** kind 属于 `CLAIMABLE_KINDS` ⇒ 会被适配器取走。 */
  claimable: number
  /** kind 不属于 ⇒ **不会被取**，除非改归属。 */
  unclaimed: number
  /** 全部件里最旧的年龄（ms）；空箱或全无合法 createdAt ⇒ 0。 */
  oldestAgeMs: number
  /** **无人认领件**里最旧的年龄（ms）；没有无人认领件 ⇒ 0。 */
  oldestUnclaimedAgeMs: number
  /** 无人认领件的 kind 分布（空 kind 计作 `'(无 kind)'`）。 */
  unclaimedKinds: Record<string, number>
  /** 有无人认领件**且**其最旧一条已超阈值 ⇒ 值得报出来。 */
  stale: boolean
}

const asFiniteMs = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/**
 * 把一批信封折成一段可读的分类读数。
 *
 * **fail-closed**：kind 缺失/大小写不同/非字符串 ⇒ 一律算**无人认领**
 *   （与适配器一致：`classifyIncoming` 的 `MANOR_KINDS.includes(kind)` 对它们全部为 false ⇒ `skip`）。
 *   「不知道能不能处理」时**不声称能处理**——否则读数会比现实乐观，而那正是本条要治的病。
 */
export function summarizeInbox(items: readonly InboxItem[], nowMs: number, staleAfterMs: number): InboxSummary {
  let claimable = 0
  let unclaimed = 0
  let oldestAgeMs = 0
  let oldestUnclaimedAgeMs = 0
  const unclaimedKinds: Record<string, number> = {}

  for (const it of items) {
    const kind = typeof it.kind === 'string' ? it.kind : ''
    const atMs = asFiniteMs(it.createdAt)
    const age = atMs === null ? 0 : Math.max(0, nowMs - atMs)
    if (age > oldestAgeMs) oldestAgeMs = age
    if (CLAIMABLE_KINDS.includes(kind)) {
      claimable += 1
      continue
    }
    unclaimed += 1
    if (age > oldestUnclaimedAgeMs) oldestUnclaimedAgeMs = age
    const key = kind === '' ? '(无 kind)' : kind
    unclaimedKinds[key] = (unclaimedKinds[key] ?? 0) + 1
  }

  const stale = unclaimed > 0 && oldestUnclaimedAgeMs > Math.max(0, staleAfterMs)
  return {
    pending: items.length,
    claimable,
    unclaimed,
    oldestAgeMs,
    oldestUnclaimedAgeMs,
    unclaimedKinds,
    stale,
  }
}

/** 小时数（一位小数，读数用）。 */
export function hoursOf(ms: number): string {
  return (Math.max(0, ms) / 3600000).toFixed(1)
}

/**
 * 渲染成一行——**挂到 `manor_find` 的收件箱字段上**。
 *
 * 形状规则：没有无人认领件时**保持旧读数的样子**（`待 N 死 M`），
 *   有才展开括注——这样「正常」不被噪音淹没，而「异常」一眼看得见（与 §5.3「分类先于治理」同源）。
 */
export function renderInbox(summary: InboxSummary, dead: number): string {
  const base = '收件箱 待 ' + String(summary.pending) + ' 死 ' + String(dead)
  if (summary.unclaimed === 0) return base
  const kinds = Object.entries(summary.unclaimedKinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => k + '×' + String(n))
    .join(' ')
  const warn = summary.stale ? '⚠ ' : ''
  return base
    + '（可处理 ' + String(summary.claimable)
    + ' · ' + warn + '无人认领 ' + String(summary.unclaimed)
    + ' [' + kinds + ']'
    + ' · 最旧 ' + hoursOf(summary.oldestUnclaimedAgeMs) + 'h'
    + '）'
}
