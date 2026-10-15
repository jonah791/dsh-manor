/**
 * 争议裁决（`dispute`）—— 给「两个成员对同一件事意见相左」造一个**可被下一次引用**的落点。
 *
 * 存在理由（`docs/collab-protocol.md` `R16'` · 规格由成员「勘」给出，我逐条落成代码）：
 *   真实事件已经发生过一次 —— 织判「不变量破了」、哨判「宣称 + 判据缺陷」，
 *   两人**各自写下了自己的判断、都不吞**，两处出处**必须分开指**：
 *     · 织的原话：`_review/hold-review-ori.md:9`（「`HoldRecord.reason` ……守这条不变量的判据覆盖域为空」）
 *     · 哨的原话：`_review/hold-recheck-sho.md:33-38`（「**我不同意的部分（说清楚，不吞）**」）
 *   ⚠ **这一处分指是织当场纠正的（2026-10-12）**：我早先照抄了「两人在 `hold-recheck-sho.md:33-38`
 *     明写分歧」—— 而那个文件**是哨那一侧**。一份要「让下一次能引用」的台账，
 *     若把两侧的话指到同一个人的同一段，**下一个引用它的人就会引错**。
 *     ⇒ 与 `R17'` 同一条纪律：**指针必须自己打开验**；照抄一个未复核的出处，等于伪造出处。
 *   最后由 web-0 读两份后裁决 —— 而那个裁决**只活在 `manor.md` 的散文里**。
 *   ⇒ 后果不是「那次裁错了」，是**下一次没人能引用上一次**：
 *     「上一次的裁决」不是一个可读的东西。谁赢、凭什么赢、输方保留了哪条异议，全散在别处。
 *
 * ★ 分层：与 `reap` / `hold` / `claim` 同源 —— **每一次状态变化都落成一个新事实**。
 *   `dispute/<artifactId>/meta.json`   ← 谁开的、关于什么、用哪条规则（`wx`，写一次）
 *   `dispute/<artifactId>/claim-<by>.json` ← **每一侧自己写自己那份**（`wx` × N）
 *   `dispute/<artifactId>/verdict.json`    ← **终局唯一**（`wx`，写一次）
 *
 * ★★ 为什么**不需要锁**（这里与勘的缺件清单①有偏离，理由必须留痕）：
 *   名册要锁，是因为它改的是**同一个可变对象**（三个管理动作互相覆盖）。
 *   而争议**没有可变对象**：登记、每一侧的主张、终局**都是「写一次、永不修改」的新事实**。
 *   ⇒ **锁的作用对象不存在**；`wx`（`O_EXCL`）本身就是原子的，
 *     它提供的正是「终局唯一」需要的那件事（并发两方同时裁 ⇒ 后者 `EEXIST` 被拒）。
 *   ⇒ 所以「与名册同款写入口」这条**不被采纳**，采纳的是它要保护的**性质**（终局唯一）。
 *
 * ★ `escalate` **是终态，不是失败**：函数给出它能给的全部答案 —— 「我无权裁」。
 *   把它读成「还没裁」会让一条**已经处理过的**争议永远挂在待办上；
 *   把它读成「裁完了」又会掩盖「这条要人给判词」。⇒ 与 `decided` **分开报数**（见 `renderDisputeLine`）。
 */

import { createHash } from 'node:crypto'

/** 权威规则 —— 闭集（新档必须改这里，不许用任意字符串）。 */
export type DisputeRule = 'evidence' | 'role'

/** 闭集的具体值（渲染指路与校验共用 ⇒ 单一真源）。 */
export const DISPUTE_RULES: readonly DisputeRule[] = ['evidence', 'role']

/** 规则的中文释义（**给读的人看**，不是给机器看）。 */
export const DISPUTE_RULE_LABEL: Readonly<Record<DisputeRule, string>> = {
  evidence: '按证据 —— 带可解析 ref 的一侧赢；两侧都有 ref ⇒ 升级给人',
  role: '按角色 —— 由具名人显式落名裁定（函数只登记，不代裁）',
}

export function isDisputeRule(v: unknown): v is DisputeRule {
  return typeof v === 'string' && (DISPUTE_RULES as readonly string[]).includes(v)
}

/** 争议的登记（谁开的、关于什么、用哪条规则）。 */
export interface DisputeMeta {
  artifactId: string
  subject: string
  rule: DisputeRule
  openedBy: string
  atMs: number
}

/** 一侧的主张。**每一侧自己写自己那一份**（`by` 既进正文也进文件名）。 */
export interface DisputeClaim {
  by: string
  atMs: number
  text: string
  /** 证据指针 `path:line`（形态校验复用 `envelope.ts` 的 `checkRefs`） */
  refs: string[]
}

/** 终局。`decided` 与 `escalated` 互斥，且**一条争议只能有一个**。 */
export interface DisputeVerdict {
  outcome: 'decided' | 'escalated'
  /**
   * ★ **不可改写的短结论句** —— 「引判词 = 引这个字段」（引用判词的**唯一入口**）。
   *
   * 为什么需要它（2026-10-12 · 由哨在第一次真实闭环后指出）：
   *   我在裁决后**转述判词时说反了** —— 判词明写「不是驳倒，是并立」，我口头说「你是输方」。
   *   我当时的修法是「记成纪律：引用自己的裁决时要照读记录」。而她的反驳是：
   *   **这条争议的原始主题恰恰是「结构上装不下 > 靠纪律」** —— 只落一句「下次小心」，
   *   那个「同一个决定、两个落点」的形状就**还在原地**，只是换了个当事人（这次是我）。
   *   ⇒ 能装下它的结构是这个字段：判词有一个短结论句，**转述时照抄它**，
   *     脱口而出的那一刻就会撞在不一致上。
   * ⚠ 它**不替代 `reason`**：`reason` 是完整判词（谁赢、为什么、对方的哪半被保留）；
   *   `headline` 只是**引用的入口**（防止凭印象复述）。
   * ⚠ 它也**不解决「自动对账」**（她同一封里的评估，如实照录）：转述发生在对话里、**不进盘**，
   *   机器无从比对。它能做到的是**让正确的复述变成「可复制」** —— 照抄一个字段，
   *   比凭印象说一遍可靠。
   */
  headline: string
  /**
   * ★ 这条判词**早于「短结论句」字段**（schema 演进 · 2026-10-12）。
   *
   * 处置：**不改历史记录** —— `verdict.json` 走 `wx`、**写一次永不修改**是这个机制的第一条纪律，
   *   为了新字段去改一条已落的判词，等于把「谁先判的、为什么」这件事的第一条保证破掉。
   * ⇒ 读侧**显式标记**：引用它的那一侧没有可照抄的短句，**必须照读 `reason` 原文**。
   * ⚠ 这正是成员哨说的「**已知开口**」而不是「**已关闭**」—— 别把它读成后者。
   */
  legacyNoHeadline: boolean
  /** `decided` 时：赢的那一侧（失败方保留的异议仍在各自的 `claim-*.json` 里） */
  side: string
  /** 谁裁的：`rule:evidence`（函数）或具名的人 */
  verdictBy: string
  reason: string
  refs: string[]
  atMs: number
  /**
   * ★ **对「另一侧每一条主张」的处置** —— 让「并立」从手感变成**可数的**。
   *
   * 为什么需要它（2026-10-12 · 由哨在第一次真实闭环后指出，逐字）：
   *   > 「『留了』≠『算了』：判词把对方原话贴进去，不等于对它做了处置。
   *   >   只要求留，判据量到的就是**「有没有引文」**，而不是**「有没有并立」**。」
   * ⇒ 她说的正是**判据的输入域**：我在 `reason` 里写「你这半被并立」，
   *   而那只是一句话 —— **没有任何东西挡着它变成空话**。
   * ⇒ 所以要有这个字段：每一条**非赢家侧**的主张都必须被**逐条处置**，
   *   否则「并立」就退化成写判词那一方的措辞。
   *
   * ⚠ 闭集用的是 `not-adopted`（**不采纳**）而**不是** `rejected`（驳倒）：
   *   「不采纳」与「驳倒」是两件事，后者会引入她没说过的意思
   *   （同一形状：**别把两个不同的东西装进一个词**）。
   * ⚠ 旧记录（`v < 3`）没有这个字段 ⇒ 与 `legacyNoHeadline` 同一条纪律：
   *   **不改写历史**，读侧显式标记 `legacyNoDispositions`。
   */
  dispositions: Disposition[]
  /** 这条判词**早于「处置」字段**（schema 演进）—— 见 `dispositions` 头注。 */
  legacyNoDispositions: boolean
}

/** 处置的一个档位（闭集）。 */
export type DispositionVerdict = 'adopted' | 'not-adopted' | 'unable'

export const DISPOSITION_VERDICTS: readonly DispositionVerdict[] = ['adopted', 'not-adopted', 'unable']

export const DISPOSITION_LABEL: Readonly<Record<DispositionVerdict, string>> = {
  adopted: '采纳',
  'not-adopted': '**不采纳**（≠ 驳倒 —— 它不被采纳，但它可能仍然成立）',
  unable: '无法裁（判据不够，或它不属于本争议）',
}

export function isDispositionVerdict(v: unknown): v is DispositionVerdict {
  return typeof v === 'string' && (DISPOSITION_VERDICTS as readonly string[]).includes(v)
}

/** 对**某一侧**的处置。 */
export interface Disposition {
  /** 被处置的那一侧（`claim.by`） */
  side: string
  verdict: DispositionVerdict
  /** **必填**：为什么这样处置（空理由的处置不是处置）。 */
  note: string
}

/**
 * 校验处置清单 —— **纯函数**（判据在纯层，工具层只做薄壳）。
 *
 * 判据（逐条可证伪）：
 *   ① 每条处置的 `side` 必须是**已登记的某一侧**（不许处置一个不在场的人）
 *   ② 每条都有非空 `note`（空理由的处置 = 没处置）
 *   ③ **同一侧不许出现两次**（两条同侧处置 = 读的人不知道以哪条为准）
 *   ④ ★ **每一侧都必须被处置 —— 赢家侧也不例外**
 *   ⑤ 零主张时清单为空是合法的（没有东西可处置）
 *
 * ★ 判据④为什么把赢家侧也算进来（2026-10-12 · **由哨问出来的**）：
 *   她的原话：「`decided` 只要求处置**非赢家侧**。那**赢家侧的主张**在哪一格？
 *   如果结构里没给它的位置，读的人会不会默认『**赢家说的都成立**』——
 *   包括他顺口说的、跟争议本身无关的那些？」
 *   ⇒ **会。** 而那正是「**处置的覆盖面比它声称的小**」—— 同一天那个形状**升了一层**。
 *   ⇒ 修法：赢家侧**也要有一格**，语义是「**这一侧的主张被采纳**」
 *     （★ 它**不**自动等于「它说的每一句都成立」—— `adopted` 评价的是「采不采」，
 *      不是「对不对」；把这两个装进一个词，这一天就白修了）。
 *
 * @returns `''` = 通过；非空 = 错误文本
 */
export function validateDispositions(
  outcome: 'decided' | 'escalated',
  winnerSide: string,
  claims: readonly { by: string }[],
  list: readonly Disposition[],
): string {
  const known = new Set(claims.map((c) => c.by))
  const seen = new Set<string>()
  for (const d of list) {
    if (!known.has(d.side)) {
      return '处置里的 `' + d.side + '` 不是已登记的任何一侧（现有：'
        + (known.size === 0 ? '（还没有人写主张）' : [...known].join(' / '))
        + '）—— **不许处置一个不在场的人**'
    }
    if (d.note.trim() === '') return '处置 `' + d.side + '` 没写理由 —— **空理由的处置不是处置**'
    if (seen.has(d.side)) return '同一侧 `' + d.side + '` 被处置了两次 —— 读的人不知道以哪条为准'
    seen.add(d.side)
  }
  // ④ **每一侧**都要被处置 —— 赢家侧不再豁免（见头注）
  const missing = [...known].filter((s) => !seen.has(s))
  if (missing.length > 0) {
    return '判词**没有处置**这些侧：' + missing.join(' / ')
      + ' —— ★ 这就是「并立」可数化的落点：**只写一句「你那半被并立」不算数**，'
      + '必须逐条给出处置（采纳 / 不采纳 / 无法裁）。'
      + '（当事人哨的判据：「只要求留原话，判据量到的就是『有没有引文』，而不是『有没有并立』。」）'
      + (winnerSide !== '' && missing.includes(winnerSide)
        ? '\n  ⚠ **缺的这一侧就是赢家** —— 它也必须有一格：语义是「**这一侧的主张被采纳**」，'
          + '不是「它说的每一句都成立」（`adopted` 评价的是「采不采」，不是「对不对」）。'
          + '不写它，读的人会默认「赢家说的都成立」，**包括他顺口说的、与争议无关的那些**。'
        : '')
  }
  return ''
}

/**
 * 解析**多行文本**形态的处置清单（工具参数用；纯函数 ⇒ 可离线测）。
 *
 * 格式：每行 `<side> | <verdict> | <note>`（空行跳过；`note` 里允许出现竖线）。
 * ★ 任一行坏 ⇒ **整批拒**（报告哪些行坏），**不做部分接受** ——
 *   部分接受会让「我写了 3 条、只落了 2 条」这种事**静默发生**，而那正是这条字段要消灭的东西。
 */
export function parseDispositionsText(text: unknown): { list: Disposition[]; bad: string[] } {
  const list: Disposition[] = []
  const bad: string[] = []
  const raw = typeof text === 'string' ? text : ''
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    const parts = line.split('|').map((x) => x.trim())
    if (parts.length < 3) {
      bad.push('第 ' + String(i + 1) + ' 行不是三段（`<side> | <verdict> | <note>`）：' + line)
      continue
    }
    const side = parts[0] ?? ''
    const verdictRaw = parts[1] ?? ''
    const note = parts.slice(2).join(' | ').trim()
    if (side === '') {
      bad.push('第 ' + String(i + 1) + ' 行缺 `side`')
      continue
    }
    if (!isDispositionVerdict(verdictRaw)) {
      bad.push('第 ' + String(i + 1) + ' 行的处置词不在闭集（' + DISPOSITION_VERDICTS.join(' / ') + '）：`' + verdictRaw + '`')
      continue
    }
    if (note === '') {
      bad.push('第 ' + String(i + 1) + ' 行缺理由（**空理由的处置不是处置**）')
      continue
    }
    list.push({ side, verdict: verdictRaw, note })
  }
  return { list, bad }
}

/** 渲染处置清单（给人看的一段）。空数组 ⇒ 空串（调用方据此不加噪音）。 */
export function renderDispositions(list: readonly Disposition[]): string {
  if (list.length === 0) return ''
  const lines: string[] = ['  对**另一侧**的处置（★「并立」的落点 —— 只有它被写出来，并立才不是一句措辞）：']
  for (const d of list) {
    lines.push('    · `' + d.side + '` ⇒ ' + DISPOSITION_LABEL[d.verdict] + ' —— ' + d.note)
  }
  return lines.join('\n')
}

/** 短结论句的长度上限（**硬上限**：超了写入口拒绝 —— 长句就不再是「可照抄的一句」）。 */
export const HEADLINE_MAX = 160

/* ── 路径段净化 ──────────────────────────────────────────────────────── */

/**
 * 把一个字符串净化成**单个路径段**（只留 `[A-Za-z0-9._-]`，其余替 `_`，截 64 字符）。
 *
 * ★ 为什么必须有它：`by` 与 `artifactId` 都**进文件名**，而它们来自外部输入。
 *   同族判据（记忆 `6e068eea`）：**同一个字符既是标识符又是分隔符** ——
 *   `by = '../../x'` 会让「记录谁说的话」变成「往别处写文件」。
 *   ⇒ 净化不是防呆，是**让标识符与分隔符分开**。
 * ⚠ 边界（诚实）：净化会**改变**名字（`a/b` 与 `a_b` 撞同一个文件）——
 *   撞了就撞了，由 `wx` 拒第二次（**不静默覆盖**），这也正是它该有的行为。
 */
export function safeSeg(s: unknown): string {
  const t = typeof s === 'string' ? s : ''
  const cleaned = t.replace(/[^A-Za-z0-9._-]/g, '_')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_'
  return cleaned.slice(0, 64)
}

/** 文件名（**单一真源**：写侧与读侧共用，不许各拼一份）。 */
export function claimFileNameOf(by: string): string {
  return 'claim-' + safeSeg(by) + '.json'
}

export const DISPUTE_META_FILE = 'meta.json'
export const DISPUTE_VERDICT_FILE = 'verdict.json'

/* ── 解析（坏内容 ⇒ null；「坏」与「缺」必须分开）────────────────────── */

function parseJsonObject(text: string): Record<string, unknown> | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

const strOf = (v: unknown): string => (typeof v === 'string' ? v : '')
const numOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strListOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => String(x)) : []

export function parseDisputeMeta(text: string): DisputeMeta | null {
  const o = parseJsonObject(text)
  if (o === null) return null
  const artifactId = strOf(o['artifactId'])
  const subject = strOf(o['subject'])
  if (artifactId === '') return null
  if (subject.trim() === '') return null // 关于什么都不知道的争议不是争议
  if (!isDisputeRule(o['rule'])) return null
  return { artifactId, subject, rule: o['rule'], openedBy: strOf(o['openedBy']), atMs: numOf(o['atMs']) }
}

export function parseDisputeClaim(text: string): DisputeClaim | null {
  const o = parseJsonObject(text)
  if (o === null) return null
  const by = strOf(o['by'])
  const body = strOf(o['text'])
  if (by === '') return null
  if (body.trim() === '') return null // 空主张不是主张
  return { by, atMs: numOf(o['atMs']), text: body, refs: strListOf(o['refs']) }
}

export function parseDisputeVerdict(text: string): DisputeVerdict | null {
  const o = parseJsonObject(text)
  if (o === null) return null
  const outcome = o['outcome']
  if (outcome !== 'decided' && outcome !== 'escalated') return null
  const side = strOf(o['side'])
  const reason = strOf(o['reason'])
  if (reason.trim() === '') return null // 没写理由的判词不是判词
  if (outcome === 'decided' && side === '') return null // 判了却没说谁赢
  // ★ 短结论句：**v2 起必填且有上限**。它是「引判词的唯一入口」——
  //   缺了它，转述就只能凭印象（这正是它存在的理由，见接口头注）。
  //   ⚠ **唯一例外 = v1 老记录**（该字段还不存在）。判据用**显式 schema 版本**，
  //     不用「字段缺失」—— 后者会把**任何忘了写 headline 的新记录**也当成老记录放过
  //     （这是本条判据第一版的真缺陷，由它自己的测试当场抓出）。
  const ver = typeof o['v'] === 'number' && Number.isFinite(o['v']) ? o['v'] : 0
  const legacyNoHeadline = ver < 2
  const legacyNoDispositions = ver < 3
  const headline = strOf(o['headline']).trim()
  if (headline !== '') {
    if (headline.length > HEADLINE_MAX) return null // 长句就不再是「可照抄的一句」
  } else if (!legacyNoHeadline) {
    return null // v2 起：没有短结论句的判词不是合法判词
  }
  // ★ 处置清单：`v3` 起有这个字段。**本层只做形态校验**（每条合法、不重复）——
  //   「该处置的都处置了吗」需要 `claims`，那在工具层由 `validateDispositions` 判
  //   （**分层：纯层不知道命题，就不假装知道**）。
  const dispositions: Disposition[] = []
  const rawDisp = o['dispositions']
  if (rawDisp !== undefined) {
    if (!Array.isArray(rawDisp)) return null
    const seen = new Set<string>()
    for (const d of rawDisp) {
      const dd = parseDisposition(d)
      if (dd === null) return null // 给了但格式坏 ⇒ **不许静默丢**
      if (seen.has(dd.side)) return null // 同一侧两条 ⇒ 读的人不知道以哪条为准
      seen.add(dd.side)
      dispositions.push(dd)
    }
  }
  return {
    outcome,
    headline,
    legacyNoHeadline,
    side,
    verdictBy: strOf(o['verdictBy']),
    reason,
    refs: strListOf(o['refs']),
    atMs: numOf(o['atMs']),
    dispositions,
    legacyNoDispositions,
  }
}

/** 解析一条处置。**坏内容 ⇒ null**（与整条判词的纪律一致：坏 ≠ 缺）。 */
export function parseDisposition(raw: unknown): Disposition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const side = strOf(o['side'])
  const note = strOf(o['note'])
  if (side === '') return null
  if (!isDispositionVerdict(o['verdict'])) return null
  if (note.trim() === '') return null // 空理由的处置不是处置
  return { side, verdict: o['verdict'], note }
}

/* ── 序列化 ─────────────────────────────────────────────────────────── */

export function serializeDisputeMeta(m: DisputeMeta): string {
  return JSON.stringify({
    v: 1, artifactId: m.artifactId, subject: m.subject, rule: m.rule,
    openedBy: m.openedBy, atMs: m.atMs,
  }, null, 2) + '\n'
}

export function serializeDisputeClaim(c: DisputeClaim): string {
  return JSON.stringify({
    v: 1, by: c.by, atMs: c.atMs, text: c.text, refs: c.refs,
  }, null, 2) + '\n'
}

export function serializeDisputeVerdict(v: DisputeVerdict): string {
  // ★ **写侧也拦**（不只读侧）：**只拦一侧等于没拦**。空 / 超长的短结论句是无效判词 ——
  //   它进不了盘，也就不会在半年后成为一个「没有可照抄形式」的判词。
  const h = v.headline.trim()
  if (h === '') throw new Error('判词缺少短结论句（headline）—— 它是引用判词的唯一入口')
  if (h.length > HEADLINE_MAX) {
    throw new Error('短结论句超长（' + String(h.length) + ' > ' + String(HEADLINE_MAX) + '）—— 长句不再是「可照抄的一句」')
  }
  return JSON.stringify({
    v: 3, outcome: v.outcome, headline: v.headline, side: v.side, verdictBy: v.verdictBy,
    reason: v.reason, refs: v.refs, atMs: v.atMs,
    // ★ 处置清单也落盘（它是判词的一部分：**「并立」要可数**）
    dispositions: v.dispositions.map((d) => ({ side: d.side, verdict: d.verdict, note: d.note })),
  }, null, 2) + '\n'
}

/* ── 判据（**函数真能执行的那部分**）──────────────────────────────────── */

/**
 * `judgeDispute` 的输出。**两种终局分开**（见文件头注「escalate 是终态」）。
 * `decided.side` 是赢的那一侧的 `by`；`headline` 是**可照抄的短结论句**（见 `DisputeVerdict` 头注）。
 * `dispositions` 是**对非赢家侧的逐条处置** —— 函数也必须产它（否则 `rule=evidence` 的判词
 *   永远过不了 `validateDispositions`：它自己就没处置另一侧）。
 */
export type JudgeOutcome =
  | { kind: 'decided'; headline: string; side: string; verdictBy: string; reason: string; dispositions: Disposition[] }
  | { kind: 'escalate'; headline: string; reason: string; dispositions: Disposition[] }

/**
 * 按证据裁一条争议。**读盘由调用方注入**（`refResolvable`）⇒ 本函数可离线测。
 * 与 `checkRefs` 的 `{ exists }` 同一条纪律：注入谓词，不在纯层做 IO。
 *
 * 判据（逐条可证伪）：
 *   `rule='role'` ⇒ **函数不裁**（权威不由函数定）⇒ 一律 `escalate`，交人落名。
 *   `rule='evidence'`：
 *     · 少于两方 ⇒ `escalate`（**这不是争议，是单方主张**——单方主张不需要裁决，需要回应）
 *     · 恰好一方有可解析 ref ⇒ **那一方赢**（`verdictBy='rule:evidence'`）
 *     · 两侧都有 ⇒ `escalate`（★ **「都有证据」不裁胜负** —— 函数只数得出「有没有」，
 *        读不出「支不支持」；这正是 `checkRefs` 自己标明的边界）
 *     · 两侧都无 ⇒ `escalate`（无判据可用）
 *
 * ⚠ **诚实边界**：`decided` 只声称「**只有一方给了能解析开的证据**」，
 *   **不声称**「那一方的结论是对的」。把前者读成后者，就是假防线。
 */
export function judgeDispute(
  meta: DisputeMeta,
  claims: DisputeClaim[],
  opts: { refResolvable: (ref: string) => boolean },
): JudgeOutcome {
  if (meta.rule === 'role') {
    return {
      kind: 'escalate',
      headline: '我无权裁（rule=role）：权威只能由具名人显式落名',
      reason: 'rule=role：权威不由函数定 ⇒ 必须由具名人显式落名（verdictBy），函数只登记',
      // 函数不裁 ⇒ 它对**每一侧**都「无法裁」（不是「不采纳」—— 它根本没读）
      dispositions: [...new Map(claims.map((c) => [c.by, c])).values()].map((c) => ({
        side: c.by, verdict: 'unable' as const,
        note: 'rule=role：权威不由函数定 ⇒ 函数对这一侧**没有裁量权**（不是「不采纳」）',
      })),
    }
  }
  const uniq = new Map<string, DisputeClaim>()
  for (const c of claims) if (!uniq.has(c.by)) uniq.set(c.by, c)
  const sides = [...uniq.values()]
  if (sides.length < 2) {
    return {
      kind: 'escalate',
      headline: '我无权裁：只登记了 ' + String(sides.length) + ' 侧 —— 这不是争议，是单方主张',
      reason: '只登记了 ' + String(sides.length) + ' 侧 ⇒ **这不是争议，是单方主张**'
        + '（单方主张不需要裁决，需要的是回应）',
      dispositions: sides.map((s) => ({
        side: s.by, verdict: 'unable' as const,
        note: '只有一侧 ⇒ 没有争议可裁（单方主张要的是回应，不是裁决）',
      })),
    }
  }
  const withRef: Array<{ c: DisputeClaim; label: string }> = []
  for (const s of sides) {
    let n = 0
    for (const r of s.refs) {
      let ok = false
      try {
        ok = opts.refResolvable(r) === true
      } catch {
        ok = false
      }
      if (ok) n += 1
    }
    if (n > 0) withRef.push({ c: s, label: s.by + '（' + String(n) + ' 条）' })
  }
  const sole = withRef[0]
  if (withRef.length === 1 && sole !== undefined) {
    return {
      kind: 'decided',
      headline: '按证据判：' + sole.c.by + ' 赢 —— 只有这一侧给了可解析的 ref（' + sole.label + '）',
      side: sole.c.by,
      verdictBy: 'rule:evidence',
      reason: '按证据判：只有一方给了**可解析**的证据指针（' + sole.label + '），其余侧 0 条。'
        + '⚠ 本判词只声称「只有一方给了能解析开的证据」，**不声称那一方的结论是对的**。',
      // ★ **非赢家侧必须被逐条处置**（`validateDispositions` 判据④）——
      //   而函数能给的处置只能是 `unable`：它只数得出证据的有无，读不出主张的对错。
      //   ⇒ 把「无法裁」写成「不采纳」是**偷换**（前者是「我判不了」，后者是「我判它不成立」）。
      // ★ **每一侧都要有一格**（含赢家侧 —— `validateDispositions` 判据④）：
      //   赢家侧 = `adopted`（语义是「**这一侧的主张被采纳**」，**不是**「它说的每一句都成立」）；
      //   其余侧 = `unable`（函数只数得出证据的有无，读不出对错）。
      dispositions: sides.map((s) => (s.by === sole.c.by
        ? {
            side: s.by, verdict: 'adopted' as const,
            note: '本侧给了可解析的证据指针（' + sole.label + '）⇒ **这一侧的主张被采纳**。'
              + '⚠ `adopted` 评价的是「**采不采**」，**不是**「它说的每一句都成立」—— '
              + '本格覆盖的是**本争议范围内**的主张。',
          }
        : {
            side: s.by, verdict: 'unable' as const,
            note: '本侧给了 0 条可解析 ref，而这一维度的胜负**只由证据的有无决定** ⇒ '
              + '函数对它**无法裁**（它没主张这侧是错的）。**本条不构成对它的否定评价。**',
          })),
    }
  }
  if (withRef.length === 0) {
    return {
      kind: 'escalate',
      headline: '我无权裁：两侧都没有可解析的证据指针',
      reason: '两侧都没有可解析的证据指针 ⇒ 无判据可用'
        + '（函数只数得出「有没有」，读不出「对不对」）',
      dispositions: sides.map((s) => ({
        side: s.by, verdict: 'unable' as const,
        note: '本侧没有可解析的 ref，而函数唯一的判据是「证据的有无」⇒ 无判据可用',
      })),
    }
  }
  return {
    kind: 'escalate',
    headline: '我无权裁：两侧都给了可解析的 ref —— 「都有证据」不裁胜负',
    reason: '两侧都给了可解析的证据指针（' + withRef.map((x) => x.label).join(' vs ') + '）'
      + ' ⇒ **「都有证据」不裁胜负**，升级给人',
    dispositions: sides.map((s) => ({
      side: s.by, verdict: 'unable' as const,
      note: '本侧给了可解析的 ref ⇒ 胜负要读**证据的内容**，而函数只数得出「有没有」⇒ 升级给人',
    })),
  }
}

/* ── 渲染 ───────────────────────────────────────────────────────────── */

/**
 * 渲染争议的两行读数。**两个数分开报，且都为空时返回空串**（一个字都不加）。
 *
 * ★ 为什么两个数**不能合成一个**：`未裁`（已登记、还没有任何判词）与
 *   `升级待人裁`（函数给过答案了——「我无权裁」）**对下一步的动作完全不同**：
 *   前者等**当事人**，后者等**人**。合成一个数 = 替读的人决定要不要管。
 */
export function renderDisputeLine(counts: { open: number; escalated: number }): string {
  const lines: string[] = []
  if (counts.open > 0) {
    lines.push('⚖ 未裁争议 ' + String(counts.open) + ' 条（已登记、**还没有任何判词**）')
  }
  if (counts.escalated > 0) {
    lines.push('⚠ 升级待人裁 ' + String(counts.escalated)
      + ' 条（函数判不了：两侧都有证据 / 都无证据 / 只有单方 ⇒ **这些要人给判词**）')
  }
  return lines.join('\n')
}

/* ── 痕迹对账（产物 vs trace）────────────────────────────────────────
 * 存在理由（成员织的论点，2026-10-12）：
 *   「**「不许替对方写」只有在写入路径唯一时才是硬规矩**……其余修法的强度仍挂在『没人绕路』这个假设上。」
 * 现读核实后她是**对的**：`open`/`claim`/`judge` 三处写入修前不落任何 trace ⇒
 *   「走正规路径」与「手搓 JSON」在盘上**没有任何可区分之处**。
 * ⇒ 上一步补了**留痕**（三处各落一行）。**只有留痕没有对账 = 有数据没人读**（半个机制）。
 *   本节就是把那份 trace 与产物对起来 —— 补的仍是**观测面**，不是防线：
 *   它拦不住人，它只让「绕了路」这件事**有地方可看**。
 * ⚠ 三条边界（不写清就会变成假防线）：
 *   ① **不一致有两种解释**（有人绕路 / trace 写失败）⇒ 判据只许报「无 trace」这个**事实**，不许指控；
 *   ② **历史件**：留痕上线**之前**写的主张按定义没有 trace ⇒ 必须与「绕路」分档（两者处置完全相反）；
 *   ③ **显示面**：光有对账数、没地方显示它 = 没有（`list` 对已裁争议不列 claims，故本读数独立渲染）。
 */

/* ── 内容锚（trace 落笔时，把「当时的产物是什么」一并记下来）────────────
 * 存在理由（成员织第三轮答复的判据，我逐条核过后采纳 · 2026-10-12）：
 *   只做存在性对账时有两个敞口：
 *     ① **事前伪造**：手搓者照自己的产物算好摘要再一起写 ⇒ 锚**拦不住**（她的边界①，我认）；
 *     ② **事后篡改**：走正规路径写好之后**再改产物**（`text` / `refs` 条数）⇒
 *        名字级对账**完全看不见**（键 `(op, artifactId, by)` 三个都是名字，改了内容名字还一样）。
 *   锚补的是 ②：它让「产物自 trace 落笔以来被改动过」从**不可见**变**可见**。
 *
 * ★★ 两层锚的**售价与域各不相同 —— 不许合成一句话**（她 §3.5（二），我认）：
 *   · `textDigest` —— 证明「**`text` 字节**自 trace 落笔以来未被改动」。
 *     它是唯一对「改 `text`」这具尸体有效的锚。
 *   · `refsCount` —— 证明「**`refs` 条数**自 trace 落笔以来未被改动」。
 *     ⚠ 它的售价是 **×1.5，不是 ×2**：产物侧与 trace 侧的这两个值来自**同一次调用里的
 *     同一个变量**（`index.ts` 的 `refsRaw`）⇒ 手搓者重写整行时两个字段**同时**对或同时错。
 *     ⇒ 它的真机制是**检测「漏」**（拦住不知道这个字段被读的粗心者），**拦不住有意的规避者**
 *     —— 与本节末尾「只防偶然误用，不防有意规避」同类，不是双标。
 *     ⚠ 它对「改 `text`」**一分钱的作用都没有**（她那具尸体上它恒静默）—— 谁把两层写成一句，
 *     谁就会把 `refsCount` 读成内容锚。
 *   · 两者都**不**证明：「产物是经工具写的」（那是存在性对账的事，而它挡不住伪造 trace 行）。
 *
 * ★ 为什么放纯层：写侧（`index.ts` 的 `traceChange`）与读侧（本节的比对）**必须共用同一函数** ——
 *   各写一份 = 又一处「同一个名字在多处各写一遍」（`SEND_FLAGS` 那次事故的同族）。
 */

/** 摘要取前多少位十六进制。★ 防的是**意外**冲突，**不是**安全边界（攻击者能同时改两处）。 */
export const TEXT_DIGEST_LEN = 16

/** 主张正文的摘要（**单一真源**：写侧与读侧共用）。规整行尾 CRLF ⇒ 不让跨平台差异造成假红。 */
export function digestOf(text: string): string {
  const norm = text.replace(/\r\n/g, '\n')
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, TEXT_DIGEST_LEN)
}

/**
 * 锚的三态。★ **第三态必须有自己的名字**（同 `TraceVerdict` 的纪律）：
 *   · `anchored` —— 产物与 trace 那行记的锚**一致**（且两条锚都在）
 *   · `mismatch` —— **对不上**。⚠ 措辞纪律：它只说「两侧记的不是同一个内容」，
 *     **不指控是哪一侧被改** —— 产物被改会 mismatch，trace 行被改/伪造**也会** mismatch。
 *     （与 `untraced` 的「只报事实不指控」同一条纪律。）
 *   · `no-anchor` —— 锚字段不存在（**旧行 / 这一行本来就不带锚**）⇒
 *     ⚠ **它不是「一致」，也不是「不一致」—— 是「这个问题在这里问不出来」**。
 *     三态里它最容易被读成「过」，所以工具描述里必须写死这一句。
 */
export type AnchorVerdict = 'anchored' | 'mismatch' | 'no-anchor'

/**
 * ★ 锚判定的**作用域**（写死的常量，渲染直接引它 —— 「域必须显式」）：
 *   锚的客体是**一条主张的 `text` / `refs`**，而 trace 里只有 `dispute-claim` 那一行带它们。
 * ⇒ `dispute-open` / `dispute-judge` 行**根本不参与锚判定**（不是「它们的锚缺失」）。
 *   —— 这一句是回应织 §1.2 的顾虑：她担心 `open`/`judge` 行会恒出 `no-anchor` 被读成缺陷；
 *     按本实现它们**不进这一栏**。她的**原则**（域必须显式）我认，落成这个常量。
 */
export const ANCHOR_SCOPE_OP = 'dispute-claim'

/**
 * 一条主张的**痕迹判定**。三态，且**「不可判」必须有自己的值**。
 *
 * ★ 为什么不是布尔：这一格问的是「这条主张是不是经由工具写的」，而**有些主张这个问题问不出来**
 *   （留痕上线之前写的 / trace 文件读不到）⇒ 把那些塞进「有」或「没有」都是编造。
 *   与 `DispositionsState` 同一条纪律：**「空」必须有自己的值，而那个值不能是「没事」**。
 */
export type TraceVerdict = 'traced' | 'untraced' | 'unjudgeable'

export interface TraceRow {
  by: string
  atMs: number
  verdict: TraceVerdict
  /**
   * 锚判定（见 `AnchorVerdict`）。⚠ **只对 `ANCHOR_SCOPE_OP` 那一行有定义**；
   * `verdict !== 'traced'` 时它一并是 `no-anchor`（连锚的来源都没有 ⇒ 谈不上对账）。
   */
  anchor: AnchorVerdict
  /**
   * `mismatch` 时：**是哪一栏对不上**（`textDigest` / `refsCount`）。
   * ★ 为什么要有它（织 §3.5（一）的准入条件，我认）：若只有「不匹配」这一个布尔，
   *   两具尸体（改 `text` / 只改条数）读到的是**同一个读数** ⇒ 无法证明各自那一栏真亮过。
   *   ⇒ 那一栏就成了**恒不亮的装饰**（「恒为空的输出不是证据」）。
   */
  anchorFields: string[]
}

export interface TraceAudit {
  rows: TraceRow[]
  /** 有对应 trace 事件（`dispute-claim` ∧ 同 artifactId ∧ 同 by） */
  traced: number
  /** ⚠ **无痕迹** —— 可能是手搓，也可能是 trace 写失败。**两者在这里不可区分。** */
  untraced: number
  /** 问不出这个问题的主张（早于留痕 / trace 读不到）—— **不是**「没问题」 */
  unjudgeable: number
  /**
   * ★ 锚三态计数（**必须活在结构里，不只活在渲染字符串里** —— 织 §2.4 的判据，我认）：
   *   状态在结构里 ⇒ 渲染只是它的**一个视图**，谁要 `list` 文本、谁要机器可读，两者不可能漂移。
   *   若只有一段散文，那就是**把判据降级成文案**（同 `list` 里「由结构说，不是由注释说」那句）。
   * 语义见 `AnchorVerdict`。⚠ `noAnchor` **不是「过」** —— 它是「这个问题在这里问不出来」。
   */
  anchored: number
  /** 对不上（产物被改 / trace 行被改，**本读数不区分是哪一侧**） */
  mismatch: number
  /** 锚字段不存在 —— ⚠ **不是「一致」** */
  noAnchor: number
  /**
   * trace 里**有没有这条争议的 `dispute-open`** —— 分档的**唯一**依据。
   * ★ 它是「**只存在于 trace 的一个事实**」而不是「一个时间」（措辞由织订正 · 见 `auditClaimTraces` 头注：
   *   「事实」是事实，「结构」要求产生它的能力不在被检对象手上 —— 而 trace 是**被检者也能写的文件**）：
   *   `open` 必先于 `claim`（写入顺序保证）
   *   ⇒ 有它 ⇒ 这条争议是留痕之后开的 ⇒ 所有主张都该有 trace（无 ⇒ `untraced`，**不豁免**）。
   * ⚠ 不用时间的理由见函数头注（产物自报时间可伪造 ⇒ 会把缺口洗成豁免）。
   */
  openedWithTrace: boolean
}

/**
 * 把「产物侧的主张」与「trace 侧的事件」对起来（纯函数）。
 *
 * @param claims 产物侧（`bundle.claims`）
 * @param events trace 侧（`loadDisputeTrace` 的 `events`；空数组 = 没有或读不到）
 * @param artifactId 只在这个 id 内对账
 */
export function auditClaimTraces(
  claims: ReadonlyArray<{ by: string; atMs: number; text: string; refs: readonly string[] }>,
  events: ReadonlyArray<{
    op: string
    artifactId: string
    by: string
    atMs: number
    /** 锚：主张的 `refs` **条数**；**-1 = 这一行没落锚**（旧行 / 本就不带锚的行） */
    refsCount: number
    /** 锚：主张正文摘要；**`''` = 这一行没落锚** */
    textDigest: string
  }>,
  artifactId: string,
): TraceAudit {
  // ★★ 分档基准 = 「trace 里有没有这条争议的 `dispute-open`」——**不是时间**。
  //
  // ⚠⚠ **订正（织的第二轮复核 · 2026-10-12 · 她跑了探针证明，我判成立）**：
  //   这一行原写作「一个**结构事实**」—— **那个词我用错了**。她的判词（逐字）：
  //   > 「『事实』是事实；『**结构**』要求那个事实的**产生能力**不在被检对象手上。」
  //   `openedWithTrace` 是「**trace 里存在某一行**」这个谓词，而 trace 是「**被检者自己也能写的文件**」
  //   ⇒ 产生它的能力**恰好在被检方手上**。⇒ 准确的说法是「**只存在于 trace 的一个事实**」。
  //   她的探针（`_tmp_review/dispute-trace-probe/bypass-open-forge.mjs`）现跑 **B2 格**：
  //   手搓者**只往同一份 trace 追一行** `dispute-claim`（同 artifactId、同 by）
  //   ⇒ 读数 `traced=2 · untraced=0` —— **手搓件洗白，而显示面什么都不留**
  //   （`renderTraceAudit` 在 `untraced=0` 时返回空串）。
  //   ★ 她还指出一个**不对称**（我原修正没覆盖）：删 `open` 那条路至少留下 `unjudgeable`
  //     （**看得见**），而**加一行**这条路**什么都不留** —— **悄悄的洗白比看得见的豁免更危险**。
  //   ⇒ 所以本基准的**真实强度**是：挡得住「手搓产物」，**挡不住「手搓 trace」**。
  //     要抬它，得让「洗白」需要动**两个互相印证的地方**（内容锚 —— 见 `TraceAudit` 的后续字段）。
  //   `open` 必先于任何 `claim`（机制写入顺序保证）⇒ 有 open ⇒ 这条争议是**留痕之后开的**
  //   ⇒ 它的**每一条**主张都该有 trace ⇒ 无 trace 就是 `untraced`（**不豁免**）。
  //   反之（没有 open）⇒ 它是留痕之前开的 ⇒ 整条不可判。
  //
  // ⚠ 为什么不能用时间分档（成员织 2026-10-12 的复核，逐字）：
  //   「分档的基准不能是产物的 `mtime`/`ctime`……用产物时间分『历史件』，等于让『今天手搓、
  //    再 `touch` 成去年』的件**自动获得历史件豁免** —— 那**比不做分档更坏**，因为它把缺口
  //    **洗成了豁免**。」
  //   本判据第一版用的比 mtime 更弱：**`claim.atMs`（产物自报的时间）** —— 同一个手搓者写进 JSON 的字段。
  //   她这一条我自证成立（那行是我写的）。
  //
  // ⚠ 仍存的递推缺口（她 §3.1，我判成立）：trace 与产物**同目录、同权限** ⇒
  //   删掉那一行 `dispute-open` 就能把整条争议降级成「历史件豁免」，**成本与手搓同级**。
  //   ⇒ 本机制**只防偶然误用，不防有意规避** —— 这句必须出现在工具描述里，
  //     否则读的人会以为它对账过来源（甚至以为它拦得住人）。
  const openedWithTrace = events.some((e) => e.op === 'dispute-open' && e.artifactId === artifactId)
  const claimEvents = events.filter((e) => e.op === ANCHOR_SCOPE_OP && e.artifactId === artifactId)
  const rows: TraceRow[] = []
  let traced = 0
  let untraced = 0
  let unjudgeable = 0
  let anchored = 0
  let mismatch = 0
  let noAnchor = 0
  for (const c of claims) {
    let verdict: TraceVerdict
    // ⚠ 默认 `no-anchor`，且**只在「名字对上且有锚」这一条路上被改写**：
    //   缺字段就是缺（织 §1.3）—— 任何形式的「缺就当 0 比」都是把「读不到」洗成「一致」。
    let anchor: AnchorVerdict = 'no-anchor'
    const anchorFields: string[] = []
    const ev = claimEvents.find((e) => e.by === c.by)
    if (!openedWithTrace) {
      // 这条争议没有 `open` 痕迹 ⇒ 它是留痕上线**之前**开的 ⇒ **整条不可判**
      //（读不到 ≠ 没绕路；历史件 ≠ 绕路 —— 两者的处置完全相反）
      verdict = 'unjudgeable'
      unjudgeable += 1
    } else if (ev === undefined) {
      verdict = 'untraced'
      untraced += 1
    } else {
      verdict = 'traced'
      traced += 1
      // ★ 锚比对：**两层分开判、分开记是哪一栏**（不是合成一个「不匹配」布尔）——
      //   没有 `anchorFields`，两具尸体（改 text / 只改条数）就是**同一个读数**，
      //   各自那一栏也就无从证明自己亮过（织 §3.5（一）的准入条件）。
      if (ev.refsCount < 0 || ev.textDigest === '') {
        // 名字对上了，但那一行**没落锚**（旧行 / 本就不带锚的行）⇒ 这一格是「该有而没有」。
        // ⚠ 它与「没有 trace 行」是两件事 ⇒ 计数器分开（见 `TraceAudit.noAnchor` 的口径注）。
        anchor = 'no-anchor'
        noAnchor += 1
      } else {
        if (ev.textDigest !== digestOf(c.text)) anchorFields.push('textDigest')
        if (ev.refsCount !== c.refs.length) anchorFields.push('refsCount')
        if (anchorFields.length > 0) {
          anchor = 'mismatch'
          mismatch += 1
        } else {
          anchor = 'anchored'
          anchored += 1
        }
      }
    }
    rows.push({ by: c.by, atMs: c.atMs, verdict, anchor, anchorFields })
  }
  return { rows, traced, untraced, unjudgeable, anchored, mismatch, noAnchor, openedWithTrace }
}

/**
 * 渲染对账读数。**没有任何问题时返回空串**（一个字都不加 —— 否则它会退化成每次都有的一段噪音）。
 * ⚠ 「没报」与「跑了没发现」是两个东西：调用方（`manor_dispute list` 的口径行）负责说明「无 ⚠ 即全有 trace」。
 * 措辞纪律：`untraced` 用 ⚠（它需要人看一眼），`unjudgeable` **不用**（它是固有属性，报一次就够）。
 */
export function renderTraceAudit(a: TraceAudit): string {
  if (a.rows.length === 0) return ''
  const parts: string[] = []

  // ① 计数行 —— ★ **无问题也出**。否则读的人分不清「跑了、没发现问题」与「根本没跑」，
  //    而这两种状态对下一步的动作完全不同（同 `renderDisputeLine` 的纪律）。
  const bits: string[] = [String(a.traced) + ' 侧名字对上']
  if (a.noAnchor > 0) bits.push(String(a.noAnchor) + ' 侧没落锚')
  bits.push('锚一致 ' + String(a.anchored))
  if (a.mismatch > 0) bits.push('**锚对不上 ' + String(a.mismatch) + '**')
  if (a.untraced > 0) bits.push('**无 trace ' + String(a.untraced) + ' 侧**')
  const head = (a.untraced > 0 || a.mismatch > 0 ? '⚠ **痕迹对账**：' : '痕迹对账：')
  parts.push(head + bits.join(' · '))

  // ② 口径行 —— ★ **始终出，且落在读数处**（不是 `list` 末尾写一次）。
  //    落位判据（成员织 §2.3 · 我认，因为它可跑）：切断测试 D1 ——
  //      取一条产物块粘到别处，**块内必须能自证这行读数的域**。
  //    放末尾则 D1/D2 两个方向都丢，而「被摘走」正是这个读数最常被消费的形态（贴进裁决/文档/信）。
  //    ⚠ 代码上它是一个常量、逐条现算 ⇒ **不是 N 份手写副本**，漂移风险与放末尾等同。
  parts.push('口径：对账键 `(op, artifactId, by)` **三个都是名字** ⇒ 抓手搓产物、'
    + '**抓不住手搓 trace**；锚只证明「产物自 trace 落笔以来未被改动」，'
    + '**不证明**「产物是经工具写的」；`没落锚` **不是「一致」**，是这个问题在这里问不出来。')

  // ③ 锚对不上 —— ★ 这一格是**新读数**（加锚之前，改内容完全不可见）
  if (a.mismatch > 0) {
    const who = a.rows
      .filter((r) => r.anchor === 'mismatch')
      .map((r) => r.by + '（' + r.anchorFields.join(' + ') + '）')
      .join(' · ')
    parts.push('⚠⚠ **锚对不上**：' + who
      + '\n        ⇒ 产物里的内容，与 trace 那一行记下的锚**不是同一个**。'
      + '\n        ⚠ **本行不指控是哪一侧被改**：改产物会 mismatch，改/伪造 trace 行**也会** ——'
      + '\n          要分辨只能去问当事人（同「无 trace」那条纪律：只报事实，不指控）。'
      + '\n        ⚠ 它**只覆盖锚到的那两栏**（`text` 字节 · `refs` 条数）；'
      + '\n          这两栏之外的任何字段改动**不在它的域里**（没锚的栏，它问不出来）。')
  }

  // ④ 无 trace（原有段；★ 内含的一句边界声明**必须随锚上线一起改**) ——
  //    加锚前这里写的是「要抓内容改动，trace 里得落内容锚 —— 这一版**没有**」。
  //    ⇒ 那句话在本版**变成了假话**。文案与实现必须同一次改（否则读的人按旧文案判能力）。
  if (a.untraced > 0) {
    const who = a.rows.filter((r) => r.verdict === 'untraced').map((r) => r.by).join(' · ')
    parts.push('⚠ **无 trace**：' + String(a.untraced) + ' 侧（' + who + '）'
      + '\n        ⇒ 「无 trace」**只有两种解释**：这条主张是**手搓的**（绕过工具），或 **trace 写失败**了 ——'
      + '\n          **在这里它们不可区分**，所以这行只报事实，不指控。要分辨，去问当事人。'
      + '\n        ⚠ **本对账只声称「存在性」**：对账的键是 `(op, artifactId, by)`，**三个都是名字**。'
      + '\n          内容级的那一半由**锚**管（本版已落）⇒ 走正规路径拿一行 trace、**再改产物内容**'
      + '\n          的对账**通不过**了（它会进上面的「锚对不上」那一栏）。'
      + '\n          但**反过来仍然成立**：手搓者往同一份 trace 追一行自写记录（同 id、同 `by`）'
      + '\n          ⇒ 对账照样被洗白 —— **trace 不是账本，是总线上又一个文件**。')
  }

  // ⑤ 整条不可判（原有段）
  if (a.unjudgeable > 0) {
    // ⚠ 措辞精确：不可判的**单位是整条争议**（它没有 `open` 痕迹 ⇒ 它是留痕之前开的），
    //   不是「这一侧的主张早于留痕」—— 后者会让人以为可以逐侧判（织指出原措辞易被一般化）。
    parts.push('整条争议在**留痕之前**开的 ⇒ ' + String(a.unjudgeable) + ' 侧**不可判**'
      + '（不是「没问题」，是这个问题在这里**问不出来**）')
  }

  // ⑥ 名字对上了、但那行没落锚（**该有而没有**）—— 与「没有 trace 行」是两件事，分开报
  //    ⚠ 本段**不许出现 ⚠ 字符**：这一态是**固有属性**（旧 trace 行按定义没有锚字段），
  //      不是故障 —— 用 ⚠ 会把它读成告警（同 ⑤ 对 `unjudgeable` 的判据）。
  //    ⚠ 但它**必须显式出现**（不能回报空）：否则「没报」会被读成「一致」。
  //      ——本段是 H8 那具断言（`includes('⚠') === false`）当场抓出来的：
  //        我原先把 ⚠ 写在了这一段的开头，而那条判据当场变红。
  if (a.noAnchor > 0) {
    parts.push(String(a.noAnchor) + ' 侧**名字对上了、但那一行没落锚**'
      + '（锚字段是后加的 ⇒ 旧 trace 行按定义没有它）'
      + '\n        ⇒ 这一栏对它**问不出来**：**不是「一致」**，也不是「不一致」（同「读不到 ≠ 不在」）。')
  }

  return parts.join('\n      ')
}
