/**
 * 庄园成员册 —— 登记层（纯函数 · 零 IO · 可离线测）
 *
 * 存在理由（2026-10-11 主人定调：「庄园需要有女仆名册，主要是进行成员管理」）：
 *   在此之前，庄园只有**状态层**（总线 `nodes/*.json` 的心跳）——
 *   「谁在线」查得到，「**我们有哪些人、各自担什么职责、谁已退役**」系统里没有一处权威答案。
 *   实测形态：`node_list` 里有 maid-01~05 的 profile，名册里只有 01/02/03，
 *   而「她们各担什么职责」散落在各自的 AGENTS.md / 语义文档 / 总女仆长的记忆里。
 *
 * ⇒ 本层补的是**登记层**，它与状态层分工明确（庄园语义文档 §4.1）：
 *   - 登记层（本文件 · 持久 · 权威）：**成员是谁** —— 心跳消失不改变它
 *   - 状态层（总线 · 易失 · 派生）：**成员此刻在不在** —— 登记在职不代表身体在跑
 *
 * 两条不变量（写死在这里，供测试直接断言）：
 *   - **N1 身份不靠心跳**：成员全部离线时，`mergeStatus` 仍须列出全部在职成员及其职责
 *   - **N2 退役只移不删**：退役只改 `status`/`retiredAtMs`，条目保留 ⇒ 可回退（改回 active）
 */

/** 成员状态。只有两态：在职 / 已退役（身体在不在跑属状态层，不在这里）。 */
export type MemberStatus = 'active' | 'retired'

/** 登记层的一条成员记录。所有字段**恒有值**——数字用 0 表示「无」，不用 null/undefined。 */
export interface MemberRecord {
  id: string
  /** 名（如「织」） */
  name: string
  /** 全名（如「月见织」） */
  alias: string
  /** 职责：她被聘来做的那一类活 */
  duty: string
  profile: string
  workdir: string
  dsHome: string
  status: MemberStatus
  hiredAtMs: number
  /** 0 = 从未退役 */
  retiredAtMs: number
  retireReason: string
  note: string
  updatedAtMs: number
}

export interface RosterFile {
  v: number
  updatedAtMs: number
  members: MemberRecord[]
}

export const ROSTER_VERSION = 1

/**
 * 「这个节点身份自述是庄园适配器」的判据值 —— **单一真源**。
 *
 * ★ 2026-10-14 从 `index.ts`（壳层）**下移到本纯层**：修前它定义在壳里，而
 *   `roster-registry.ts`（纯层）与 `stranded-bus.ts`（纯层）都在用同一个字面值
 *   ⇒ **依赖方向反了**（纯层依赖壳）。纯层可离线单测、壳层要起插件才可跑，
 *   方向一错，纯层的测试就得为了一个常量去拉起整个壳。
 *
 * 口径（与 `dsh-agent-nodeforge` 的 `MANOR_HARNESS` 同值，改一处要一起改）：
 *   它答的是「**这个身份有没有庄园适配器在轮询它的信箱**」——是**可算的事实**，
 *   不是价值判断，也**不是「id 长得像谁」**。
 */
export const MANOR_ADAPTER_HARNESS = 'alice-manor-adapter'

/**
 * 名册行的**行内标签** —— ★ 2026-10-14 从 `index.ts` 的 `execute` 内联逻辑**抽成纯函数**。
 *
 * 为什么抽出来（不是重构洁癖，是**它当时没有判据守**）：
 *   修前这段逻辑内联在工具 `execute` 里 ⇒ **测不到** ⇒ 它**没跟上**同一批的分档改动：
 *   汇总行已按 `harness` 分成「待登记 / 册外」，而行内 tag **只判 `registered`**
 *   ⇒ 同一个节点被**报两遍**，且行内那遍语气是错的（`⚠ 未登记` 喊人去做一件**不该做**的事）。
 *   ⇒ 教训：**渲染逻辑住在 `execute` 里 = 它不受任何测试保护**；
 *     分档这类「同一决定多个落点」的改动，漏掉没测试的那处是**必然**，不是偶然。
 *
 * @param r 名册行
 * @returns 行内标签（`⏹ 已退役` / `✓ 在线` / `· 离线` / `⚠ 未登记` / `ℹ 册外`）
 */
export function rowTag(r: RosterRow): string {
  if (r.registered) {
    if (r.status === 'retired') return '⏹ 已退役'
    return r.online ? '✓ 在线' : '· 离线'
  }
  // 未登记：**必须再看一眼 harness** —— 自述是适配器才叫「待登记」（该进册），
  //   其余是**册外事实**（不该进册，只报不催）。与汇总行的分档**同源判据**。
  const harness = String(r.harness !== undefined && r.harness !== null ? r.harness : '')
  return harness === MANOR_ADAPTER_HARNESS ? '⚠ 未登记' : 'ℹ 册外'
}

export function emptyRoster(nowMs: number): RosterFile {
  return { v: ROSTER_VERSION, updatedAtMs: nowMs, members: [] }
}

/** djb2：短、无依赖、跨平台稳定（只用于判「是否同一份」，不做任何安全用途）。 */
const djb2 = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * 名册指纹（写盘前 CAS 复核用）：回答「我以为我改的是这一份，磁盘上还是它吗？」
 *
 * 只取**影响语义**的字段、按键序稳定序列化 ⇒ 与 JSON 字段顺序、空白、缩进无关。
 * 判据（tests/roster-lock.test.ts）：成员任一字段变化 ⇒ 指纹必变；
 * 同一内容重新构造对象 ⇒ 指纹**不变**（否则 CAS 会永远误报冲突，退化成不可用）。
 */
export function rosterFingerprint(roster: RosterFile): string {
  const rows = roster.members
    .map((m) =>
      [
        m.id,
        m.name,
        m.alias,
        m.duty,
        m.profile,
        m.workdir,
        m.dsHome,
        m.status,
        String(m.hiredAtMs),
        String(m.retiredAtMs),
        m.retireReason,
        m.note,
        String(m.updatedAtMs),
      ].join('\u0001'),
    )
    .sort()
  return djb2(String(roster.v) + '\u0002' + String(roster.updatedAtMs) + '\u0002' + rows.join('\u0003'))
}

const asStr = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const asNum = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** 把一条来路不明的记录归一成 MemberRecord（缺字段补默认值，不抛）。 */
export function normalizeRecord(raw: unknown, nowMs: number): MemberRecord {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const status = asStr(r['status'], 'active')
  return {
    id: asStr(r['id'], ''),
    name: asStr(r['name'], ''),
    alias: asStr(r['alias'], ''),
    duty: asStr(r['duty'], ''),
    profile: asStr(r['profile'], asStr(r['id'], '')),
    workdir: asStr(r['workdir'], ''),
    dsHome: asStr(r['dsHome'], ''),
    status: status === 'retired' ? 'retired' : 'active',
    hiredAtMs: asNum(r['hiredAtMs'], nowMs),
    retiredAtMs: asNum(r['retiredAtMs'], 0),
    retireReason: asStr(r['retireReason'], ''),
    note: asStr(r['note'], ''),
    updatedAtMs: asNum(r['updatedAtMs'], nowMs),
  }
}

export interface ParseResult {
  ok: boolean
  roster: RosterFile
  error: string
}

/**
 * 解析成员册文本。
 * **fail-loud**：坏 JSON / 结构不符 ⇒ `ok=false` 且 `error` 说明原因，
 * 绝不静默返回空册——「空册」与「读坏了」是两件事（对齐 `manor_roster` 的纪律）。
 */
export function parseRoster(text: string, nowMs: number): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, roster: emptyRoster(nowMs), error: '成员册 JSON 解析失败：' + String(e) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, roster: emptyRoster(nowMs), error: '成员册根节点不是对象' }
  }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj['members'])) {
    return { ok: false, roster: emptyRoster(nowMs), error: '成员册缺 members 数组' }
  }
  const members = (obj['members'] as unknown[]).map((m) => normalizeRecord(m, nowMs))
  const dup = firstDuplicateId(members)
  if (dup !== '') {
    return { ok: false, roster: emptyRoster(nowMs), error: '成员册里有重复 id：' + dup }
  }
  return {
    ok: true,
    roster: {
      v: asNum(obj['v'], ROSTER_VERSION),
      updatedAtMs: asNum(obj['updatedAtMs'], nowMs),
      members,
    },
    error: '',
  }
}

/** 首个重复的 id（无重复返回空串）。重复 id 是**读坏了**，不是可修的小毛病。 */
export function firstDuplicateId(members: MemberRecord[]): string {
  const seen = new Set<string>()
  for (const m of members) {
    if (m.id === '') return '(空 id)'
    if (seen.has(m.id)) return m.id
    seen.add(m.id)
  }
  return ''
}

export function findMember(roster: RosterFile, id: string): MemberRecord | null {
  for (const m of roster.members) if (m.id === id) return m
  return null
}

export interface HireInput {
  id: string
  name?: string
  alias?: string
  duty?: string
  profile?: string
  workdir?: string
  dsHome?: string
  note?: string
}

export interface MutateResult {
  ok: boolean
  roster: RosterFile
  member: MemberRecord | null
  error: string
}

/** 聘用：登记一名成员。**已存在即拒绝**（不静默覆盖——改动用 `assign`）。 */
export function hire(roster: RosterFile, input: HireInput, nowMs: number): MutateResult {
  const id = input.id.trim()
  if (id === '') return { ok: false, roster, member: null, error: 'id 必填' }
  if (findMember(roster, id) !== null) {
    return { ok: false, roster, member: null, error: '成员 ' + id + ' 已在册（改名/调职用 assign，退役用 retire）' }
  }
  const rec: MemberRecord = {
    id,
    name: asStr(input.name, ''),
    alias: asStr(input.alias, ''),
    duty: asStr(input.duty, ''),
    profile: asStr(input.profile, id),
    workdir: asStr(input.workdir, ''),
    dsHome: asStr(input.dsHome, ''),
    status: 'active',
    hiredAtMs: nowMs,
    retiredAtMs: 0,
    retireReason: '',
    note: asStr(input.note, ''),
    updatedAtMs: nowMs,
  }
  const next: RosterFile = { ...roster, updatedAtMs: nowMs, members: [...roster.members, rec] }
  return { ok: true, roster: next, member: rec, error: '' }
}

/** 退役：**只改状态，不删条目**（N2）⇒ 可回退。重复退役报错，不静默成功。 */
export function retire(roster: RosterFile, id: string, reason: string, nowMs: number): MutateResult {
  const cur = findMember(roster, id)
  if (cur === null) return { ok: false, roster, member: null, error: '成员册里没有 ' + id }
  if (cur.status === 'retired') return { ok: false, roster, member: null, error: '成员 ' + id + ' 已是退役状态（退役于 ' + String(cur.retiredAtMs) + '）' }
  const updated: MemberRecord = { ...cur, status: 'retired', retiredAtMs: nowMs, retireReason: reason, updatedAtMs: nowMs }
  const next: RosterFile = {
    ...roster,
    updatedAtMs: nowMs,
    members: roster.members.map((m) => (m.id === id ? updated : m)),
  }
  return { ok: true, roster: next, member: updated, error: '' }
}

export interface AssignPatch {
  name?: string
  alias?: string
  duty?: string
  profile?: string
  workdir?: string
  dsHome?: string
  note?: string
  /** 复职：把 retired 改回 active 并清退役时间 */
  reactivate?: boolean
}

/** 调职/改名/复职：只改给到的字段（字段级合并）。 */
export function assign(roster: RosterFile, id: string, patch: AssignPatch, nowMs: number): MutateResult {
  const cur = findMember(roster, id)
  if (cur === null) return { ok: false, roster, member: null, error: '成员册里没有 ' + id }
  const updated: MemberRecord = {
    ...cur,
    name: patch.name !== undefined ? patch.name : cur.name,
    alias: patch.alias !== undefined ? patch.alias : cur.alias,
    duty: patch.duty !== undefined ? patch.duty : cur.duty,
    profile: patch.profile !== undefined ? patch.profile : cur.profile,
    workdir: patch.workdir !== undefined ? patch.workdir : cur.workdir,
    dsHome: patch.dsHome !== undefined ? patch.dsHome : cur.dsHome,
    note: patch.note !== undefined ? patch.note : cur.note,
    status: patch.reactivate === true ? 'active' : cur.status,
    retiredAtMs: patch.reactivate === true ? 0 : cur.retiredAtMs,
    retireReason: patch.reactivate === true ? '' : cur.retireReason,
    updatedAtMs: nowMs,
  }
  const next: RosterFile = {
    ...roster,
    updatedAtMs: nowMs,
    members: roster.members.map((m) => (m.id === id ? updated : m)),
  }
  return { ok: true, roster: next, member: updated, error: '' }
}

/** 状态层的一个观测（总线 `nodes/<id>.json` 里我们关心的那几个字段）。 */
export interface NodeObservation {
  id: string
  harness: string
  atMs: number
  pid: number
}

export interface RosterRow {
  id: string
  name: string
  alias: string
  duty: string
  status: MemberStatus
  /** 在册（登记层有这条） */
  registered: boolean
  /** 名册（状态层）有这条心跳 */
  seenOnBus: boolean
  online: boolean
  heartbeatAgeMs: number
  pid: number
  harness: string
}

export interface MergeResult {
  rows: RosterRow[]
  /** 登记在职但**从未上过总线**的成员（聘了没起过，或起法失败） */
  neverSeen: string[]
  /** 总线上有心跳但**登记层没有**的节点（野生节点 / 未登记的成员） */
  unregistered: string[]
  /**
   * ★ 2026-10-14 新增：`unregistered` 里**属于庄园之外**的那一半（主脑 / 别的 harness 的节点）。
   *
   * 为什么要拆：修前 `unregistered` 把**两种语义完全不同**的东西装进一个读数 ——
   *   ① 主脑的总线身份（`LAPTOP-BF4IAPLM-web-0`，`harness` 为空，**它本来就不该进成员册**）
   *   ② 未登记的成员（**该**被登记）
   * 混报的后果是**永久噪音**：每次读名册都报一句「⚠ 总线上有但未登记：LAPTOP-…-web-0」，
   *   而那句**永远为真、永远不需要动作** ⇒ 读者学会忽略整条读数（**假阳性毁的是整条防线的可信度**）。
   * ⇒ 拆成两档：`unregistered`（**待登记**：自述是庄园适配器 ⇒ 该进册）
   *   / `outsideRoster`（**册外**：不是庄园适配器 ⇒ 不该进册，只报事实）。
   *
   * 判据与 `send-guard.mjs` 的 `MANOR_ADAPTER_HARNESS` **同源**（同一件事只有一个判据值）：
   *   `harness === 'alice-manor-adapter'` 才可能是一个「该被登记的成员」。
   */
  outsideRoster: string[]
  activeCount: number
  retiredCount: number
  onlineCount: number
}

/**
 * 合并登记层与状态层。**这是本文件的核心**——两条不变量都在这里被行使：
 *   - N1：全部离线时，`rows` 仍含全部在职成员（身份不靠心跳）
 *   - 双向分歧显式报出（`neverSeen` / `unregistered`），不隐藏、不静默
 */
export function mergeStatus(
  roster: RosterFile,
  observations: NodeObservation[],
  nowMs: number,
  freshMs: number,
  opts?: { onlyActive?: boolean },
): MergeResult {
  const byId = new Map<string, NodeObservation>()
  for (const o of observations) byId.set(o.id, o)
  const rows: RosterRow[] = []
  const neverSeen: string[] = []
  const seenIds = new Set<string>()

  for (const m of roster.members) {
    const ob = byId.get(m.id)
    seenIds.add(m.id)
    let online = false
    let ageMs = -1
    if (ob !== undefined) {
      ageMs = nowMs - ob.atMs
      if (ageMs < 0) ageMs = -1
      else online = ageMs < freshMs
    } else {
      neverSeen.push(m.id)
    }
    rows.push({
      id: m.id,
      name: m.name,
      alias: m.alias,
      duty: m.duty,
      status: m.status,
      registered: true,
      seenOnBus: ob !== undefined,
      online,
      heartbeatAgeMs: ageMs,
      pid: ob !== undefined ? ob.pid : 0,
      harness: ob !== undefined ? ob.harness : '',
    })
  }

  const unregistered: string[] = []
  const outsideRoster: string[] = []
  for (const o of observations) {
    if (seenIds.has(o.id)) continue
    // ★ 分档（2026-10-14）：**自述是庄园适配器**才可能是「该被登记的成员」；
    //   其余（主脑的 cluster 身份、别的 harness 的节点）属**册外**，不该进成员册。
    //   ⚠ 判据读的是**身份自述**，不是「id 长得像谁」——与 send-guard 同源。
    if (String(o.harness !== undefined && o.harness !== null ? o.harness : '') === MANOR_ADAPTER_HARNESS) {
      unregistered.push(o.id)
    } else {
      outsideRoster.push(o.id)
    }
    const ageMs = nowMs - o.atMs
    rows.push({
      id: o.id,
      name: '',
      alias: '',
      duty: '',
      status: 'active',
      registered: false,
      seenOnBus: true,
      online: ageMs >= 0 && ageMs < freshMs,
      heartbeatAgeMs: ageMs >= 0 ? ageMs : -1,
      pid: o.pid,
      harness: o.harness,
    })
  }

  const onlyActive = opts !== undefined && opts.onlyActive === true
  const shown = onlyActive ? rows.filter((r) => r.status === 'active') : rows
  // 排序：**在册成员永远排在野生节点前面**。2026-10-11 实测：不分组时未登记的野生节点
  // 会插进成员之间，让「我们有哪些人」这个问题在视觉上答不清楚——名册的第一读者是人。
  shown.sort((a, b) => {
    if (a.registered !== b.registered) return a.registered ? -1 : 1
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.id.localeCompare(b.id)
  })

  return {
    rows: shown,
    neverSeen: neverSeen.sort(),
    unregistered: unregistered.sort(),
    outsideRoster: outsideRoster.sort(),
    activeCount: roster.members.filter((m) => m.status === 'active').length,
    retiredCount: roster.members.filter((m) => m.status === 'retired').length,
    // ★ 2026-10-14 修正：本读数与上面两个**同族**（都按**名册**算），而修前它数的是
    //   `rows.filter(r => r.online)` —— `rows` **含册外节点** ⇒ 名册 6 人、在线报 7
    //   （把主脑的总线身份算了进去）⇒ 出现「在职 6 · 此刻在线 7」这种**自相矛盾**的读数。
    //   ⚠ 与 `outsideRoster` 是**同一类病**（把两个不同的东西装进一个读数）—— 同一天第二处，
    //   且**第二处是第一处暴露出来的**（分档之后那个多出来的 1 才看得见）。
    //   判据：**分母是名册，不是 rows**。册外节点是**事实**，不是成员，不进这个计数。
    onlineCount: rows.filter((r) => r.online && r.registered).length,
  }
}
