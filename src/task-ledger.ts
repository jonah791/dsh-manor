/**
 * 庄园任务台账 —— 作业层（纯函数 · 零 IO · 可离线测）
 *
 * 存在理由（2026-10-11 实测缺口）：
 *   庄园此前**只有动作日志**（`logs/actions/*.jsonl` 一行一阶段），没有**任务台账**。
 *   于是两个问题都答不出来：
 *     ① 「派出去的活，现在什么状态？」——要人肉 grep 131 个文件
 *     ② 「失败的那批，为什么失败？该找谁？」——失败**无人追**
 *   实测读数（2026-10-11 全量 131 文件）：任务成功 55 · 任务失败 **18**（超时 9 · exit=1 9）
 *   ⇒ 失败率 **24.7%**，而系统里**没有任何一处**把这个数当指标看。
 *
 * 本层只做一件事：**把动作日志折成任务台账**（谁派给谁 · 什么状态 · 为什么失败 · 多久）。
 *
 * ⚠ 五个口径坑（都是 2026-10-11 现场踩出来的，已固化成尸体测试 —— 它们是本文件的**规格**）：
 *   C1 `stage:"failed"` **不等于**任务失败 —— 同一 stage 也用于**警告/降级**
 *      （实测：`meta.cwd` 越界降级也打 `failed`，而那个任务 `done` 了）。
 *      ⇒ 唯一判据是 **`humanText` 以「任务未完成」开头**，不是 stage，也不是 ok 字段。
 *   C2 同一 `actionId` 可**同时**有 `failed` 与 `done` 两行 ⇒ 归并时**终态以 done 为准**，
 *      否则降级警告会把成功任务误记成失败（实测污染：真失败 18 被数成 32）。
 *   C3 `kind` 字段**只存在于 chat 类**动作；task 类动作**没有** `kind`、只有 `taskId`。
 *      ⇒ 识别任务只能看 **`detail.taskId` 是否存在**，用 `kind==='task'` 去筛会**恒为空**。
 *   C4 `stage:"failed"` 里还有**拒收**一类（正文为空 / cwd 越界被拒）——那不是故障，**是防线在工作**。
 *      它与「越界 → 降级执行（**不拒收**）」是同一维度的**相反策略** ⇒ 必须分成不同终态，否则
 *      「6 条静默失败」这种假警报会把正常拒收说成系统坏了。
 *   C5 行的**顺序不可信**：降级警告行可以出现在 `start` 行**之前**（真实样本差 8ms）
 *      ⇒ 失败行必须**先收集、最后统一判**；流式判定会把警告误判成拒收。
 *
 * 实测全量读数（2026-10-11，132 个日志 / 76 个任务）：
 *   stage:"failed" 共 32 行 = 真失败 18（超时 9 + exit≠0 9）+ 降级警告 7 + 拒收 7 —— **分解无余量**
 */

import { renderReapLine, type ReapRecord, type ReapVerdict } from './reap.ts'
// 任务性质（`owner`/`internal`/`probe`）的**单一真源**在信封契约里 —— 本层只做归一与透传，
// 不自己判（自判会分叉：`natureOf` 的「未声明 ⇒ 取严 owner」必须全链只有一处）。
import { DEFAULT_TASK_NATURE, natureDeclaredOf, natureOf, viaKindOf, type TaskNature } from './envelope.ts'

/** 动作日志里的一行（JSONL）。只有本层用得到的字段，其余原样保留在 detail。 */
export interface ActionEvent {
  at: string
  actionId: string
  stage: string
  humanText: string
  detail: Record<string, unknown>
}

/** 任务失败的分类。`none` = 没失败。 */
export type FailureKind = 'none' | 'timeout' | 'exec-error' | 'unknown'

/** 拒收原因。`none` = 不是拒收。 */
export type RejectKind = 'none' | 'empty-body' | 'cwd-rejected' | 'rejected-other' | 'unknown'

/**
 * 任务终态（四态）。
 *   - `done`       跑完了
 *   - `failed`     **起了会话**但执行失败（超时 / exit≠0）
 *   - `rejected`   **拒收**：根本没起会话（正文为空 / cwd 越界被拒）
 *                  ⇒ 这是防线在**正确工作**，与「静默失败」是相反的东西，必须分开
 *   - `unfinished` 有 start 但无终态 ⇒ **静默失败**，最该追的一类
 *   - `reaped`     **未完但已有裁决**（判死 / 已被取代）⇒ 它**不是未完**：那是一个**有主的决定**
 *
 * ⚠ **第五态 `reaped` 是 2026-10-12 补的，补的理由值得记**：最初「已裁决」只落在
 *   `summarizeTasks` 的计数里（把已裁决的从 `unfinished` 移走），而 `outcome` **没变**。
 *   ⇒ 结果：`manor_tasks` 说「未完 0」，而 `manor_task_watch` 说「未完 1」
 *     —— **同一个概念、两个判据实现**（一个读计数、一个直接读 `outcome`）。
 *   活体验收当场抓到（我先改了第三条读路，以为好了；**读数说没有**）。
 *   ⇒ 修法不是「让 task_watch 也读 summarize」，而是**让状态本身变**。
 */
export type TaskOutcome = 'done' | 'failed' | 'rejected' | 'unfinished' | 'reaped'

/** 台账里的一条任务记录。所有字段恒有值——数字用 0 表示「无」，字符串用 '' 表示「无」。 */
export interface TaskRecord {
  taskId: string
  actionId: string
  /** 派给谁（取 `detail.profile`；日志未记时为空串，**不猜**） */
  to: string
  /** 谁派的（取 `detail.from`） */
  from: string
  acceptance: string
  /**
   * 任务**性质**（`owner` / `internal` / `probe`；闭集在 `envelope.ts`）。
   *
   * ★ 唯一用途：**决定这条活的失败要不要打扰主人**（2026-10-12 主人问「怎么发了一堆任务失败」）。
   * ⚠ **恒有值**：日志里没声明 ⇒ `owner`（**取严** —— 漏报主人的活比多报噪音更坏）。
   *   归一在 `foldTasks` 里做**一次**，消费侧直接用，**不许各自判**（各处判会分叉）。
   */
  nature: TaskNature
  /**
   * ★ `nature` 是**声明的**（`true`）还是**缺省兜底**的（`false`）—— 取严缺省的**审计把手**。
   *
   * 为什么必须有它（成员织 · 2026-10-12 · 我认）：`nature` 归一之后，「**未声明**」与
   *   「**显式声明 `owner`**」**同貌** ⇒ 数不出缺省点了几次火，也分不清系统是健康的、
   *   还是**靠缺省在扛**。而这直接决定 `owner` 那道取严闸门是「罕见兜底」还是
   *   「洪水原样放回」（见 `envelope.ts` 的 `natureDeclaredOf` 头注）。
   * ⚠ `false` = 「没写」**或**「写了闭集外的值」—— 后者同样不是一次有效声明。
   */
  /**
   * ★ 写信封的**调用点**（`meta.via` · Step B · 2026-10-15）—— 缺口要答的那一格：
   *   「**这条 taskId 是被哪条调用点造出来的**」。
   *
   * 为什么别的字段替代不了它（`G-provenance` 三种病同貌的根因）：
   *   · `nature` 答「要不要打扰主人」，**答不了来路**；
   *   · `from` 答「谁派的」，而它**有两种语义**（节点 id ×212 / 成员 id ×141，实测）
   *     ⇒ 字段本身答不了「哪条**代码路**造的」；
   *   · `envelopeId`（Step A）是 **join key**（反查信封全文）⇒ 来路**可推断**，
   *     但推断要**再读一次盘**，而台账是纯函数（不该做 IO）。
   *   ⇒ 本格是**已解出的来路**：不反查、可分类、且「我不认识的那条路」当场可见。
   *
   * ⚠ 空串 = **没盖章**（Step B 之前的历史信封 / 某条路还没接上）——**不是**「走了空的那条路」。
   * ⚠ 三态**不可合并**（分类用 `viaKindOf`）：`known` / `unknown`（**枚举漏格的信号**）/ `none`。
   */
  via: string
  natureDeclared: boolean
  startedAtMs: number
  /**
   * ★ **信封的出生时刻**（派活方造这封信的时刻）—— 与 `startedAtMs`（成员**开始跑**的时刻）
   *   相减 ⇒ 「派活 → 开始」的时延**从不可测变成可测量**。
   *
   * 为什么需要它（成员织 · 2026-10-13 · SPEC §7-1 点名要的，原话照录）：
   *   「不可判档的代价方向是『少报漏』……**若这个理由不成立**，那么 `t-trace-anchor-v1`
   *    就是**一条真漏**。⇒ **我没有能证实/证伪它的仪器**：总线上没有**派活时刻**的记录。」
   *
   * ⚠ **`0` = 「没记」，不是「刚刚」**（同 `natureDeclared` 的「空必须分型」纪律）：
   *   字段缺失或非数字一律落 0，**不许**兜成 `startedAtMs`/`now()`——那会把「不知道」
   *   伪装成「零延迟」，而零延迟恰好会**证实**「信封总是被立刻取走」那个待验证假设。
   */
  envelopeCreatedAtMs: number
  endedAtMs: number
  outcome: TaskOutcome
  failureKind: FailureKind
  rejectKind: RejectKind
  /** 非空 = 该任务有过**降级/警告**（如 cwd 越界降级执行）——任务仍可能 done，故不是终态 */
  warning: string
  /** 终端跑动时长（ms）；未完成为 0 */
  ms: number
  stdoutChars: number
  stderrChars: number
  /** 终态那行的原文（诊断用；失败时即失败原因） */
  tail: string
  /**
   * 收尸裁决（2026-10-12 · 把「没人管的未完」变成「有主的决定」）。
   *
   * ★ **只对「未完」生效**：完成 / 失败 / 拒收都是**已成事实**，给它们收尸是改口不是裁决。
   *   ⇒ 写入侧拒收（`manor_reap` 先折一遍台账确认它确实未完），读侧对「无处生效的裁决」显式报出。
   * ★ 空串 = **还没人裁决** = 现状：这条活**没人管**（那正是本机制要消灭的状态）。
   */
  reapVerdict: '' | ReapVerdict
  /** 裁决理由（裁决时必填）；空串 = 未裁决。**空理由的裁决不是裁决**（读侧也拦）。 */
  reapReason: string
  /** 裁决时刻（ms；0 = 未裁决） */
  reapAtMs: number
}

const asStr = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const asNum = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** 失败原因的唯一前缀判据（口径坑 C1：不用 stage，不用 ok）。 */
export const FAILURE_PREFIX = '任务未完成'

/** 解析一行 JSONL。坏行返回 null（**不抛**——一行坏不该带塌整个台账）。 */
export function parseActionLine(line: string): ActionEvent | null {
  const t = line.trim()
  if (t === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(t)
  } catch {
    return null
  }
  // 数组也是 `typeof 'object'` —— 显式拒掉，否则 `[]` 会被当成一条空事件（裸测试抓出的真缺陷）
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const detail = r['detail']
  return {
    at: asStr(r['at'], ''),
    actionId: asStr(r['actionId'], ''),
    stage: asStr(r['stage'], ''),
    humanText: asStr(r['humanText'], ''),
    detail: detail !== null && typeof detail === 'object' ? (detail as Record<string, unknown>) : {},
  }
}

/** 解析整份日志文本（多行 JSONL）。 */
export function parseActionLog(text: string): ActionEvent[] {
  const out: ActionEvent[] = []
  for (const line of text.split('\n')) {
    const ev = parseActionLine(line)
    if (ev !== null) out.push(ev)
  }
  return out
}

const msOf = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * 这条事件是不是**任务失败**。
 * 口径坑 C1：`stage` 不可信（警告也用 failed）⇒ 只看 `humanText` 前缀。
 */
export function isTaskFailure(humanText: string): boolean {
  return humanText.startsWith(FAILURE_PREFIX)
}

/** 失败原因分类。非失败返回 `none`。 */
export function classifyFailure(humanText: string): FailureKind {
  if (!isTaskFailure(humanText)) return 'none'
  if (humanText.includes('超时')) return 'timeout'
  if (humanText.includes('exit=')) return 'exec-error'
  return 'unknown'
}

/**
 * 拒收原因分类。非拒收返回 `none`。
 * 口径坑 C4：`stage:"failed"` 里还有**拒收**这一类（正文为空 / cwd 越界被拒），
 * 它们与「降级执行（**不拒收**）」是同一维度的**相反策略**，必须分开。
 */
export function classifyReject(humanText: string): RejectKind {
  if (isTaskFailure(humanText)) return 'none'
  if (humanText.includes('不拒收')) return 'none'
  if (humanText.includes('正文为空')) return 'empty-body'
  if (humanText.includes('越界')) return 'cwd-rejected'
  if (humanText.includes('被拒') || humanText.includes('拒收')) return 'rejected-other'
  return 'unknown'
}

interface Bucket {
  taskId: string
  actionId: string
  to: string
  from: string
  acceptance: string
  /**
   * 任务**性质**（`owner` / `internal` / `probe`；闭集在 `envelope.ts`）。
   *
   * ★ 唯一用途：**决定这条活的失败要不要打扰主人**（2026-10-12 主人问「怎么发了一堆任务失败」）。
   * ⚠ **恒有值**：日志里没声明 ⇒ `owner`（**取严** —— 漏报主人的活比多报噪音更坏）。
   *   归一在 `foldTasks` 里做**一次**，消费侧直接用，**不许各自判**（各处判会分叉）。
   */
  nature: TaskNature
  /**
   * ★ `nature` 是**声明的**（`true`）还是**缺省兜底**的（`false`）—— 取严缺省的**审计把手**。
   *
   * 为什么必须有它（成员织 · 2026-10-12 · 我认）：`nature` 归一之后，「**未声明**」与
   *   「**显式声明 `owner`**」**同貌** ⇒ 数不出缺省点了几次火，也分不清系统是健康的、
   *   还是**靠缺省在扛**。而这直接决定 `owner` 那道取严闸门是「罕见兜底」还是
   *   「洪水原样放回」（见 `envelope.ts` 的 `natureDeclaredOf` 头注）。
   * ⚠ `false` = 「没写」**或**「写了闭集外的值」—— 后者同样不是一次有效声明。
   */
  /**
   * ★ 写信封的**调用点**（`meta.via` · Step B · 2026-10-15）—— 缺口要答的那一格：
   *   「**这条 taskId 是被哪条调用点造出来的**」。
   *
   * 为什么别的字段替代不了它（`G-provenance` 三种病同貌的根因）：
   *   · `nature` 答「要不要打扰主人」，**答不了来路**；
   *   · `from` 答「谁派的」，而它**有两种语义**（节点 id ×212 / 成员 id ×141，实测）
   *     ⇒ 字段本身答不了「哪条**代码路**造的」；
   *   · `envelopeId`（Step A）是 **join key**（反查信封全文）⇒ 来路**可推断**，
   *     但推断要**再读一次盘**，而台账是纯函数（不该做 IO）。
   *   ⇒ 本格是**已解出的来路**：不反查、可分类、且「我不认识的那条路」当场可见。
   *
   * ⚠ 空串 = **没盖章**（Step B 之前的历史信封 / 某条路还没接上）——**不是**「走了空的那条路」。
   * ⚠ 三态**不可合并**（分类用 `viaKindOf`）：`known` / `unknown`（**枚举漏格的信号**）/ `none`。
   */
  via: string
  natureDeclared: boolean
  startedAtMs: number
  /**
   * ★ **信封的出生时刻**（派活方造这封信的时刻）—— 与 `startedAtMs`（成员**开始跑**的时刻）
   *   相减 ⇒ 「派活 → 开始」的时延**从不可测变成可测量**。
   *
   * 为什么需要它（成员织 · 2026-10-13 · SPEC §7-1 点名要的，原话照录）：
   *   「不可判档的代价方向是『少报漏』……**若这个理由不成立**，那么 `t-trace-anchor-v1`
   *    就是**一条真漏**。⇒ **我没有能证实/证伪它的仪器**：总线上没有**派活时刻**的记录。」
   *
   * ⚠ **`0` = 「没记」，不是「刚刚」**（同 `natureDeclared` 的「空必须分型」纪律）：
   *   字段缺失或非数字一律落 0，**不许**兜成 `startedAtMs`/`now()`——那会把「不知道」
   *   伪装成「零延迟」，而零延迟恰好会**证实**「信封总是被立刻取走」那个待验证假设。
   */
  envelopeCreatedAtMs: number
  endedAtMs: number
  hasStart: boolean
  done: boolean
  /** 所有 stage=failed 行的原文（**先收集、最后统一判**——行序不可信，见下） */
  failedTexts: string[]
  ms: number
  stdoutChars: number
  stderrChars: number
  tail: string
}

/**
 * 把事件流折成任务台账。
 *
 * 两条归并规则（对应口径坑 C2/C3）：
 *   - **只有带 `detail.taskId` 的事件进台账**（C3：chat 不进，且 chat 本来就没有 taskId）
 *   - **终态以 `done` 为准**：同任务既有 failed 行又有 done 行时记 done（C2）
 */
/**
 * 把动作日志折成台账。
 *
 * `reaps` 缺省 = **不接裁决**（既有调用点零回归）；给了就参与折叠 ——
 * **历史一个字不改，裁决是叠在它上面的一层状态**（见 `reap.ts` 头注）。
 */
export function foldTasks(
  events: ActionEvent[],
  reaps?: ReadonlyMap<string, ReapRecord>,
): TaskRecord[] {
  const buckets = new Map<string, Bucket>()
  for (const ev of events) {
    const taskId = asStr(ev.detail['taskId'], '')
    if (taskId === '') continue
    let b = buckets.get(taskId)
    if (b === undefined) {
      b = {
        taskId,
        actionId: ev.actionId,
        to: asStr(ev.detail['profile'], ''),
        from: asStr(ev.detail['from'], ''),
        acceptance: asStr(ev.detail['acceptance'], ''),
        // 初值 = **取严档**；下面按日志声明覆盖（只在非空时覆盖 —— 空串不是「声明了空」）
        nature: DEFAULT_TASK_NATURE,
        // 初值 = **未声明**（与取严档配套：这个默认值是**兜底**、不是声明 —— 审计把手在这里生效）
        natureDeclared: false,
        // 初值 = **空串 = 没盖章**（不是「走了空的那条路」）—— 读取侧只在拿到非空串时覆盖
        via: '',
        // 初值 0 = **没记**（不是「刚刚」）—— 读取侧只在拿到正数时覆盖（见下）
        envelopeCreatedAtMs: 0,
        startedAtMs: 0,
        endedAtMs: 0,
        hasStart: false,
        done: false,
        failedTexts: [],
        ms: 0,
        stdoutChars: 0,
        stderrChars: 0,
        tail: '',
      }
      buckets.set(taskId, b)
    }
    const atMs = msOf(ev.at)
    if (b.actionId === '' && ev.actionId !== '') b.actionId = ev.actionId
    const to = asStr(ev.detail['profile'], '')
    if (to !== '') b.to = to
    const from = asStr(ev.detail['from'], '')
    if (from !== '') b.from = from
    const acc = asStr(ev.detail['acceptance'], '')
    if (acc !== '') b.acceptance = acc
    // 任务性质：**非空才覆盖**（空串 = 日志没记，不是「记了个空」）⇒ 初值取严档保留。
    const nat = ev.detail['nature']
    if (typeof nat === 'string' && nat !== '') {
      b.nature = natureOf(nat)
      // ★ 审计把手：**声明**与**兜底**必须分开记（否则「未声明」与「显式 owner」同貌，
      //   缺省的点火率就数不出来）。闭集外的值 ⇒ false（它不是一次有效声明）——与「没写」同档。
      b.natureDeclared = natureDeclaredOf(nat)
    }
    // 来路（`meta.via` · Step B）：**非空才覆盖**（同 `nature` 纪律 —— 空串 = 没盖章，
    //   不是「记了个空」）。
    //   ⚠ **不归一成闭集**：未知值**原样保留** ⇒ 消费侧能把它分类成 `unknown`
    //     （**枚举漏格的信号**）；一旦在这里归一，这个信号就被抹成缺省值、再也看不见。
    const viaRaw = ev.detail['via']
    if (typeof viaRaw === 'string' && viaRaw !== '') b.via = viaRaw
    // 信封出生时刻（派活时刻）：**只在拿到正数时覆盖** —— 0 / 缺失 = 日志没记，
    //   保留初值 0（「没记」与「零延迟」是两件事，不许混）。
    const envAt = asNum(ev.detail['envelopeCreatedAtMs'], 0)
    if (envAt > 0 && (b.envelopeCreatedAtMs === 0 || envAt < b.envelopeCreatedAtMs)) {
      b.envelopeCreatedAtMs = envAt
    }

    if (ev.stage === 'start') {
      b.hasStart = true
      if (b.startedAtMs === 0 || (atMs > 0 && atMs < b.startedAtMs)) b.startedAtMs = atMs
    }
    if (ev.stage === 'done') {
      b.done = true
      b.endedAtMs = atMs
      b.tail = ev.humanText
      b.ms = asNum(ev.detail['ms'], b.ms)
      b.stdoutChars = asNum(ev.detail['stdoutChars'], b.stdoutChars)
      b.stderrChars = asNum(ev.detail['stderrChars'], b.stderrChars)
    }
    // ⚠ **先收集、不判**：降级警告行可能出现在 start 行**之前**（真实样本差 8ms），
    //    流式判定会把「有警告 + 尚无 start」误判成拒收。行序不可信 ⇒ 终态统一在最后判。
    if (ev.stage === 'failed') {
      b.failedTexts.push(ev.humanText)
      b.ms = asNum(ev.detail['ms'], b.ms)
      b.stdoutChars = asNum(ev.detail['stdoutChars'], b.stdoutChars)
      b.stderrChars = asNum(ev.detail['stderrChars'], b.stderrChars)
      if (b.endedAtMs === 0) b.endedAtMs = atMs
    }
    // stage 行的读数（stdout/stderr 在这里最全）
    if (ev.stage === 'stage') {
      if (b.stdoutChars === 0) b.stdoutChars = asNum(ev.detail['stdoutChars'], 0)
      if (b.stderrChars === 0) b.stderrChars = asNum(ev.detail['stderrChars'], 0)
    }
  }

  const out: TaskRecord[] = []
  for (const b of buckets.values()) {
    // ── 终态判定：四态，判据只在这一处（不散落在循环里）──
    const taskFail = b.failedTexts.find((t) => isTaskFailure(t))
    const otherFail = b.failedTexts.filter((t) => !isTaskFailure(t))
    let outcome: TaskOutcome
    let failureKind: FailureKind = 'none'
    let rejectKind: RejectKind = 'none'
    let warning = ''
    let tail = b.tail
    if (b.done) {
      outcome = 'done'
      // 完成了但过程里有降级警告 ⇒ 记下（任务仍算成功，警告照样不吞）
      warning = b.hasStart && otherFail.length > 0 ? (otherFail[0] ?? '') : ''
    } else if (taskFail !== undefined) {
      outcome = 'failed'
      failureKind = classifyFailure(taskFail)
      tail = taskFail
      warning = otherFail.length > 0 ? (otherFail[0] ?? '') : ''
    } else if (b.hasStart) {
      // 起了会话却无终态 ⇒ **真静默失败**（最该追的一类）
      outcome = 'unfinished'
      tail = otherFail.length > 0 ? (otherFail[0] ?? '') : ''
      // ★ 第五态（2026-10-12）：未完**但已有裁决** ⇒ 它**不是未完**，是一个有主的决定。
      //   ⚠ 必须在**这里**改 `outcome`，而不是只在 `summarizeTasks` 里改计数 ——
      //   否则任何**直接读 `outcome`** 的地方（如 `manor_task_watch`）都会把它当未完
      //   ⇒ 实测分叉：台账说「未完 0」、守望说「未完 1」（同一条活、同一个时刻）。
      if (reaps !== undefined && reaps.has(b.taskId)) outcome = 'reaped'
    } else if (otherFail.length > 0) {
      // 没起会话 + 有拒收行 ⇒ **拒收**（防线正确工作，不是故障）
      outcome = 'rejected'
      rejectKind = classifyReject(otherFail[0] ?? '')
      tail = otherFail[0] ?? ''
    } else {
      outcome = 'unfinished'
    }
    // ── 收尸裁决（2026-10-12）：**只对「未完」生效** ──
    // 完成 / 失败 / 拒收都是**已成事实**，给它们收尸是改口不是裁决 ⇒ 这里不生效；
    // 但**不静默**：裁决照样带上，渲染层对「无处生效的裁决」显式报警（它是一条异常）。
    const rp = reaps === undefined ? undefined : reaps.get(b.taskId)
    out.push({
      taskId: b.taskId,
      actionId: b.actionId,
      to: b.to,
      from: b.from,
      acceptance: b.acceptance,
      nature: b.nature,
      natureDeclared: b.natureDeclared,
      via: b.via,
      envelopeCreatedAtMs: b.envelopeCreatedAtMs,
      startedAtMs: b.startedAtMs,
      endedAtMs: b.endedAtMs,
      outcome,
      failureKind,
      rejectKind,
      warning,
      ms: b.ms,
      stdoutChars: b.stdoutChars,
      stderrChars: b.stderrChars,
      tail,
      reapVerdict: rp === undefined ? '' : rp.verdict,
      reapReason: rp === undefined ? '' : rp.reason,
      reapAtMs: rp === undefined ? 0 : rp.atMs,
    })
  }
  out.sort((a, b) => b.startedAtMs - a.startedAtMs)
  return out
}

/** 单成员的计数。 */
export interface MemberTally {
  member: string
  total: number
  done: number
  failed: number
  rejected: number
  unfinished: number
}

/**
 * 一条**回执**（成员交回的成果信封）的最小投影 —— 取自信箱，**不是**动作日志。
 *
 * ★ 2026-10-14 新增（⑥ 面「质量验收」后半格的**可见面**）。
 *
 * 为什么要有它：台账（动作日志）折的是「**派活侧**」的事实；而「**判据满没满足**」
 *   要的是**回执**（成员交回的信封 `meta.evidence`）—— **两个不同的域**。
 *   修前那一格**没有可见面**：`manor_tasks` 自写着「本行不答后半格」，而**数据在盘上**
 *   （现读：656 封带 meta 的信封里 **106 封有 evidence**）⇒ 又一次「**数据在、可见面不在**」
 *   （与 E13 那次「仪器早就有、只被自己引用」同型）。
 *
 * ⚠ **它不是「判据满足了」的证据**（这一格必须写死在输出里）：
 *   收到回执只证明「**有人交了东西**」，不证明「**交的东西满足了那条判据**」——
 *   后者需要**另一份不是作者写的重建**（技能 `acceptance-integrity` §十）。
 */
export interface ReceiptLite {
  /** 信封 id（可回盘核对） */
  id: string
  /** 对应任务（信封 `meta.taskId`；空串 = 没带） */
  taskId: string
  /** 交回方（信封 `from`） */
  from: string
  /** `meta.status`（ok / blocked / …） */
  status: string
  /** 带了几条证据（`meta.evidence` 的长度） */
  evidenceCount: number
  /** 证据总字符数（`inline.data` 与 `chars` 之和；用来判「是不是空手交的」） */
  evidenceChars: number
  /** `meta.unverified` 条数（**成员自己标的未验证项** —— 诚实形状，不是缺陷） */
  unverifiedCount: number
  /** 信封出生时刻（ms） */
  createdAtMs: number
}

/**
 * 从原始信封数组里抽出回执投影 —— **纯函数**（零 IO，可离线测）。
 *
 * 判据（每条都取严，不猜）：
 *   - **只有 `kind:"result"` / `kind:"task"` 才可能是回执** —— ★ 2026-10-14 真调当场抓出：
 *     初版把「有 `meta` 但没 taskId」一律算 orphan，**真盘读出 363 个**，而其中
 *     **353 个是 `kind:"chat"`** —— chat 是**对话**，**本来就不该有 taskId**
 *     ⇒ 它们**不是 orphan，是我判据的错**。⇒ 「把两个不同的东西装进一个读数」的第四次
 *     （且是我在**刚写下那条判据之后**又犯的）。
 *     ⚠ **正解**：先按 `kind` 筛（那才是信封**自述的类型**），再判 taskId。
 *   - `kind:"result"` 而**没带 taskId** ⇒ 这才是真 orphan（成员交成果但没指明是哪条活）
 *   - `evidenceCount` 只数 `evidence` 数组的长度；**非数组一律记 0**（不把「形状怪」当「有证据」）
 *   - `evidenceChars` 累加 `inline.data` 的字符数（无 `inline` 则用 `chars` 字段），**不虚报**
 *
 * @param envelopes - 原始信封对象数组（形状未知，逐字段取严）
 * @returns `{ receipts, orphanCount }` —— `orphanCount` 是**该带 taskId 却没带**的回执数
 */
export function extractReceipts(envelopes: readonly unknown[]): { receipts: ReceiptLite[]; orphanCount: number } {
  const receipts: ReceiptLite[] = []
  let orphanCount = 0
  for (const raw of envelopes) {
    const e = raw as Record<string, unknown> | undefined
    if (e === undefined || e === null || typeof e !== 'object') continue
    const meta = e['meta'] as Record<string, unknown> | undefined
    // 无 meta ⇒ 不是回执（普通 chat / 派活信封），不算 orphan 也不算回执
    if (meta === undefined || meta === null || typeof meta !== 'object') continue
    // ★★ 先按 kind 筛：**只有 `result` 才是回执**（2026-10-14 由成员勘当场抓出并纠正）。
    //   修前这里写的是 `kind !== 'result' && kind !== 'task' ⇒ continue` —— 把 `task` 也当回执候选。
    //   ⚠ **`task` 是「派活」信封**（方向**与回执相反**：作者 → 执行者），
    //     把它计进回执面会**高估**「收到回执」的个数（实测 **125 封 `task` 里有 114 封带 taskId**，
    //     全部落进回执面 ⇒ 那一格虚高 **114**）。
    //   ⚠ 这是**同一次失误的漏网**：源码头注早记过「初版把 `chat` 算 orphan，真盘 363 里 353 是 chat
    //     ⇒ 是我判据的错」—— **修了 chat，没修 task**。
    //   ★ 勘给的判据原话（我复算逐字相符）：「**只有 `kind:"result"` 才『该带 taskId』**」
    //     ⇒ 真 orphan **31 → 20**（另 11 个是 `task` 被错当回执）。
    const kind = asStr(e['kind'], '')
    if (kind !== 'result') continue
    const taskId = asStr(meta['taskId'], '').trim()
    if (taskId === '') { orphanCount += 1; continue }
    const ev = meta['evidence']
    const evList = Array.isArray(ev) ? ev : []
    let chars = 0
    for (const item of evList) {
      const it = item as Record<string, unknown> | undefined
      if (it === undefined || it === null || typeof it !== 'object') continue
      const inline = it['inline'] as Record<string, unknown> | undefined
      const inlineData = inline !== undefined && inline !== null ? inline['data'] : undefined
      if (typeof inlineData === 'string') chars += inlineData.length
      else chars += Math.max(0, Math.trunc(asNum(it['chars'], 0)))
    }
    const un = meta['unverified']
    receipts.push({
      id: asStr(e['id'], ''),
      taskId,
      from: asStr(e['from'], ''),
      status: asStr(meta['status'], ''),
      evidenceCount: evList.length,
      evidenceChars: chars,
      unverifiedCount: Array.isArray(un) ? un.length : 0,
      createdAtMs: asNum(e['createdAt'], 0),
    })
  }
  return { receipts, orphanCount }
}

/**
 * 回执面的汇总 —— 把「派活侧写了判据」与「回执侧交回证据」**并排**，**不合流**。
 *
 * ⚠ **三格必须分开**（合流就等于替读的人下结论）：
 *   ① 写了判据（派活侧，台账）② 收到回执（回执侧，信箱）③ **判据是否满足**（**本函数不答**）
 *
 * @param acceptanceByTask - taskId → 该活派活时写的判据（空串 = 没写）
 * @param receipts - `extractReceipts` 的产物
 * @param reapedTaskIds - **已裁决**（`reap/`）的 taskId 集（**可选**；缺省 = 不区分 ⇒ 零回归）。
 *   ⚠ 由 IO 层读盘给 —— **纯函数不读盘**（与 `knownIds` 同纪律）。
 * @returns 各档计数 + 「有判据但无回执」的清单（**最该追的一档**）
 */
export function summarizeReceipts(
  acceptanceByTask: ReadonlyMap<string, string>,
  receipts: readonly ReceiptLite[],
  reapedTaskIds?: ReadonlySet<string>,
): {
  /** 有回执的任务数（去重后的 taskId 数） */
  tasksWithReceipt: number
  /** 其中**带 ≥1 条证据**的任务数 */
  tasksWithEvidence: number
  /** 其中**空手交**（有回执但 evidenceCount=0）的任务数 */
  tasksWithEmptyEvidence: number
  /** **写了判据却没有回执**的 taskId（最该追的一档：判据悬空） */
  acceptanceWithoutReceipt: string[]
  /** **有回执但派活时没写判据**的 taskId（第二档：无法对账） */
  receiptWithoutAcceptance: string[]
  /**
   * ★★ 2026-10-14 新增：**已裁决**（`reap/`）而**判据悬空**的 taskId。
   * ⚠ 为什么要分开报（真调当场抓出）：`t-pwsh-probe-01` 已被裁决 `superseded`，
   *   而修前它**仍挂在「最该追的一档」里** ⇒ **回执面与台账口径分叉**：
   *   台账报「未完 **0**」（裁决后不计入未完，`manor_reap` 的纪律），
   *   而回执面照旧报「判据悬空 **1**」 ⇒ 两个读数**对同一件事给了相反答案**。
   *   ⇒ 修法：**不隐藏**（它仍在读数里），但**移到独立一格**并标注裁决词 ——
   *     「已裁决」是**有主的决定**，不是「没人管」（同 `manor_reap` 分档纪律）。
   */
  acceptanceWithoutReceiptReaped: string[]
  /**
   * ★★ 2026-10-15 新增：**带未验证项**（`meta.unverified` 非空）的 taskId 清单。
   *
   * 动机（论文 arXiv:2610.16117v1 UnCoBench · §1/§5「Incomplete」形态）：
   *   论文实测——**可靠设置下表现相近的模型，在「同事给了正确但不足的证据」时急剧分化**，
   *   且**强模型也普遍不做针对性追问**（GPT-5.6 Sol 53.4% / DeepSeek-V4.1-Flash **86.7%**
   *   的 trace **完全没有 corrective follow-up**）。⇒ 结论是「**鲁棒性 ≠ 基线解题强度**」，
   *   光靠「记得去核实」不管用 —— **缺口信息必须送到主 agent 眼前**。
   *
   * 庄园的对应事实：成员**早就在诚实标注**「这些我没验证」（`adapter.mjs:643`：
   *   `ok ? [] : [partial ? '任务被撞顶中断，产物未经主脑复现' : '任务结果未经主脑复现']`），
   *   而 `ReceiptLite.unverifiedCount` **被抽取却从未被任何渲染消费** —— 数据一直在，
   *   **缺的只是显示面**（与 `G-adapter-noreload` 的修法同构）。
   *
   * ⚠ **语义边界（不许读过头）**：这是**作者自报的未验证项**，**不是**复核结论、
   *   **不是**「判据没满足」。它回答的是「**她自己说哪些没验证**」——
   *   而「判据满没满足」仍需**另一份不是作者写的重建**（同 `:536` 段末那条纪律）。
   * ⚠ **与 `status` 不合并**：`failed` 台账已经知道（不是缺口）；真正危险的是
   *   **`partial`（撞顶但有产物）** —— 台账会显示它有产物，**却不说「产物未经复现」**。
   */
  tasksWithUnverified: string[]
} {
  const withReceipt = new Set(receipts.map((r) => r.taskId))
  // ★ 未验证项：**非空即入格**（`unverifiedCount` 由 `extractReceipts` 逐字段取严填出，
  //   非数组一律记 0 ⇒ 这里不会把「形状怪」当「有未验证项」）
  const withUnverified = new Set(receipts.filter((r) => r.unverifiedCount > 0).map((r) => r.taskId))
  const withEvidence = new Set(receipts.filter((r) => r.evidenceCount > 0).map((r) => r.taskId))
  const emptyEvidence = new Set(receipts.filter((r) => r.evidenceCount === 0).map((r) => r.taskId))
  const acceptanceWithoutReceipt: string[] = []
  const acceptanceWithoutReceiptReaped: string[] = []
  const receiptWithoutAcceptance: string[] = []
  for (const [taskId, acc] of acceptanceByTask) {
    if (acc.trim() === '' || withReceipt.has(taskId)) continue
    // ★ 已裁决的活**不再算「没人追」**（它有一个有主的决定）—— 但它**仍显形**（不隐藏）
    if (reapedTaskIds !== undefined && reapedTaskIds.has(taskId)) acceptanceWithoutReceiptReaped.push(taskId)
    else acceptanceWithoutReceipt.push(taskId)
  }
  for (const taskId of withReceipt) {
    const acc = acceptanceByTask.get(taskId)
    if (acc === undefined || acc.trim() === '') receiptWithoutAcceptance.push(taskId)
  }
  return {
    tasksWithReceipt: withReceipt.size,
    tasksWithEvidence: withEvidence.size,
    tasksWithEmptyEvidence: emptyEvidence.size,
    acceptanceWithoutReceipt: acceptanceWithoutReceipt.sort(),
    acceptanceWithoutReceiptReaped: acceptanceWithoutReceiptReaped.sort(),
    receiptWithoutAcceptance: receiptWithoutAcceptance.sort(),
    tasksWithUnverified: [...withUnverified].sort(),
  }
}

/**
 * 失败族（**复盘的输入**）：按「失败类型 × 成员」**交叉**聚合的失败清单。
 *
 * 动机（论文 AREAL-RSI · arXiv:2610.18083v1 §4.2 的复盘三问 · 主人 2026-10-14
 *   「可参考优化爱丽丝庄园的协作范式」）：
 *   论文的 campaign 后复盘要问「哪些取向有用 / 哪些发现能泛化出本任务 / 哪些重复操作该成技能」，
 *   而它的输入是 `E_n`（**完成的证据**）。庄园的失败证据却是**散的**——
 *   `byKind`（按类型）与 `byMember`（按成员）各自独立、**没有交叉** ⇒
 *   能答「超时 10 条」，**答不了「谁超时、在哪类活上超时」** ⇒ **模式浮不出来**，
 *   「从失败里提取改进」就无从下手（论文自己点名的难点③：任务进展**不会自动**改进下一个过程）。
 *   ⇒ 本字段补的**不是结论，是复盘的原料**。
 *
 * ⚠ **它是聚合，不是归因**（照论文自己的口径 `Comparisons are descriptive`）：
 *   同一个簇只说明「这些活长在一起」，**不说明因果**；且样本量小（现读 19 条失败 / 105 分母）
 *   ⇒ **不许**据此说「某成员不行」这类话。**多算一步就是编造。**
 * ⚠ 簇内 taskId **不静默截断**：超出 `MAX_CLUSTER_IDS` 的用 `more` 计数（空/截断必须分型）。
 */
export interface FailureCluster {
  /** 失败类型（`unknown` = 分类不出来，**不猜**） */
  kind: FailureKind
  /** 成员（`(未记成员)` = 早期动作日志无 profile 字段，**不猜**） */
  member: string
  count: number
  /** 簇内 taskId（字典序；最多 `MAX_CLUSTER_IDS` 个） */
  taskIds: string[]
  /** 被省略的条数（0 = 全给了） */
  more: number
}

/** 每个失败簇最多列出的 taskId 数（超出用 `more` 计数，不静默丢） */
export const MAX_CLUSTER_IDS = 6

export interface TaskSummary {
  total: number
  done: number
  failed: number
  /** 拒收（正文为空 / cwd 越界被拒）—— **不算失败**，它是防线在工作 */
  rejected: number
  /**
   * 有 start 无终态 **且没人裁决** —— 真静默失败，**最该追的一类**。
   * ⚠ 语义（2026-10-12 收窄）：**已裁决的不再计这里**（它们已从「没人管」变成「有主的决定」）。
   *   要知道「一共多少条有 start 无终态」，用 `unfinished + reaped.dead + reaped.superseded`。
   */
  unfinished: number
  /**
   * 已裁决的未完件 —— **分两档，不合流**（`dead` 可能要重派 · `superseded` 不用）。
   * 合成一个数就等于**替读的人决定「这些要不要重做」**。
   */
  reaped: { dead: number; superseded: number }
  /**
   * ⚠ **裁决无处生效**的条数（裁决存在，但那条活已是 done / failed / rejected）。
   * 这是**异常**，必须显形：它意味着有人对一条已成事实的活改口，或记录被手工塞了进来。
   */
  orphanReaps: number
  /** 跑完了、但过程里有降级警告的任务数（警告不吞，也不因此判失败） */
  warned: number
  /**
   * 失败率 = failed / (done + failed)。
   * **拒收与未完都不进分母**：拒收是防线正确工作（算进去会冤枉系统），
   * 未完既非成功也非失败（算进任一侧都是编造）。
   * 分母为 0 时返回 0（不是 NaN——NaN 会让所有下游比较静默失效）。
   */
  failureRate: number
  byKind: Record<'timeout' | 'exec-error' | 'unknown', number>
  byReject: Record<'empty-body' | 'cwd-rejected' | 'rejected-other' | 'unknown', number>
  /**
   * ★ **取严缺省的点火率分子**（`natureDeclared === false` 的条数）—— **审计把手**。
   *
   * 为什么必须有（成员织 · 2026-10-12 · 我认）：`DEFAULT_TASK_NATURE` 的点火率
   *   **≡ 声明漏写率**（`natureOf` 只在声明不合法时落缺省 —— 构造决定）。
   *   ⇒ 数不出这个数，就**分不清系统是健康的、还是靠缺省在扛**；
   *     而这两种情形下「取严」是**相反的两件事**：罕见兜底 vs **把当初要拦的洪水原样放回**。
   * ⚠ 与 `failureRate` 同一条纪律：**分子与分母一起报**（分母 = `total`）。
   */
  natureUndeclared: number
  /**
   * ★ **来路分布**（`G-provenance` **Step B** · 2026-10-15）：按 `TaskRecord.via` 分类计数。
   *
   * 缺口要答的那一格是「**分母里那些 taskId 各自是被哪条调用点造出来的**」——
   *   此前它**在读数里没有这一格** ⇒ 三种病同貌：① 派活方没声明 · ② 日志没记 ·
   *   ③ **枚举本身漏了格子**。⇒ 本组数把 ③ 从「想不出来」变成**可算**：
   *
   *   · `viaUnknown` —— **我不认识的那条路**（不在 `KNOWN_ENVELOPE_VIAS` 里）：
   *     **枚举漏格的信号**，最该出声的一格。非 0 ⇒ 有我没登记过的写者在造活。
   *   · `viaNone` —— **没盖章**（Step B 之前的历史信封 / 某条路还没接上）。
   *   ⚠ 两者**不可合并**（`unknown` ≠ `none`）：并成一格则「有我没见过的路在造活」静默消失。
   * ⚠ 与 `natureUndeclared` 同纪律：**分子与分母一起报**（分母 = `total`）。
   */
  viaUnknown: number
  viaNone: number
  byMember: MemberTally[]
  /**
   * **失败族**（按「失败类型 × 成员」交叉聚合）—— **复盘的原料**，见 `FailureCluster` 头注。
   * 空数组 = 这一批里没有失败（**与「读不到」不是一回事**：读不到走上层报错路径）。
   * 排序确定性：count 降序 → member 字典序 → kind 字典序（同一份数据每次渲染同一顺序）。
   */
  failureClusters: FailureCluster[]
}

/** 汇总台账。 */
export function summarizeTasks(tasks: TaskRecord[]): TaskSummary {
  let done = 0
  let failed = 0
  let rejected = 0
  let unfinished = 0
  let warned = 0
  const reaped = { dead: 0, superseded: 0 }
  let orphanReaps = 0
  let natureUndeclared = 0
  // ★ 来路分布（Step B · 2026-10-15）：三态各自计数（`unknown` 与 `none` **不合并**）
  let viaUnknown = 0
  let viaNone = 0
  const byKind = { timeout: 0, 'exec-error': 0, unknown: 0 }
  const byReject = { 'empty-body': 0, 'cwd-rejected': 0, 'rejected-other': 0, unknown: 0 }
  const members = new Map<string, MemberTally>()
  // 失败族（见 FailureCluster 头注）：与 byKind **不同口径** —— 它覆盖**全部失败**
  // （含 `failureKind === 'none'` 的未分类者），而 byKind 只覆盖已分类的。
  // ⇒ 两个读数的和**本来就不等**，渲染时明说（口径必须与读数同体，§5.9 规则 6）。
  const clusterMap = new Map<string, { kind: FailureKind; member: string; ids: string[] }>()
  for (const t of tasks) {
    const key = t.to !== '' ? t.to : '(未记成员)'
    let m = members.get(key)
    if (m === undefined) {
      m = { member: key, total: 0, done: 0, failed: 0, rejected: 0, unfinished: 0 }
      members.set(key, m)
    }
    m.total += 1
    // ★ 取严缺省的点火率分子（见 `TaskSummary.natureUndeclared` 头注）——
    //   与 outcome 分支**无关**，单独一趟数（免得四处分头记账、迟早对不上）。
    if (!t.natureDeclared) natureUndeclared += 1
    // ★ 来路分布（Step B）：分类走**单一真源** `viaKindOf` —— 别处不许自己写
    //   `includes` 判断（两处各判 = 契约分叉，与 `natureOf` 头注里那条纪律同形）。
    const vk = viaKindOf(t.via)
    if (vk === 'unknown') viaUnknown += 1
    else if (vk === 'none') viaNone += 1
    // 裁决统计**独立一趟**（与 outcome 分支无关）—— 免得四处分头记账、迟早对不上。
    if (t.reapVerdict !== '') {
      // ★ 生效判据用 **`outcome === 'reaped'`**（而不是 `outcome === 'unfinished'`）：
      //   第五态补上之后，「已裁决」这件事**本身就是 outcome 的一部分**了。
      if (t.outcome === 'reaped') reaped[t.reapVerdict] += 1
      else orphanReaps += 1
    }
    if (t.outcome === 'done' && t.warning !== '') warned += 1
    if (t.outcome === 'done') {
      done += 1
      m.done += 1
    } else if (t.outcome === 'failed') {
      failed += 1
      m.failed += 1
      if (t.failureKind !== 'none') byKind[t.failureKind] += 1
      // 失败族：**交叉**聚合（同一个 key 只累一次——判据单一真源，两处分头记账迟早对不上）
      const clusterKey = t.failureKind + '\u0000' + key
      let cluster = clusterMap.get(clusterKey)
      if (cluster === undefined) {
        cluster = { kind: t.failureKind, member: key, ids: [] }
        clusterMap.set(clusterKey, cluster)
      }
      cluster.ids.push(t.taskId)
    } else if (t.outcome === 'rejected') {
      rejected += 1
      m.rejected += 1
      if (t.rejectKind !== 'none') byReject[t.rejectKind] += 1
    } else if (t.outcome === 'reaped') {
      // ★ 已裁决的未完**不是缺口** ⇒ 不进 `unfinished`（它已在上面那趟计入 `reaped`）。
      //   把它写成独立分支（而不是靠 `reapVerdict === ''` 兜）是为了让**读代码的人**
      //   一眼看到「第五态不是未完」—— 判据的形状要跟语义同构。
    } else {
      if (t.reapVerdict === '') {
        unfinished += 1
        m.unfinished += 1
      }
    }
  }
  const denom = done + failed
  const byMember = Array.from(members.values()).sort((a, b) => b.total - a.total)
  // 失败族构造（见 `FailureCluster` 头注）：排序**确定性**（count 降 → member 升 → kind 升），
  // 簇内 taskId 字典序，超出上限用 `more` 计数（**不静默截断**——截断必须显形）。
  const failureClusters: FailureCluster[] = Array.from(clusterMap.values())
    .map((c) => {
      const ids = [...c.ids].sort()
      return {
        kind: c.kind,
        member: c.member,
        count: ids.length,
        taskIds: ids.slice(0, MAX_CLUSTER_IDS),
        more: Math.max(0, ids.length - MAX_CLUSTER_IDS),
      }
    })
    .sort((a, b) => b.count - a.count
      || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0)
      || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  return {
    total: tasks.length,
    done,
    failed,
    rejected,
    unfinished,
    reaped,
    orphanReaps,
    warned,
    failureRate: denom === 0 ? 0 : failed / denom,
    natureUndeclared,
    viaUnknown,
    viaNone,
    byKind,
    byReject,
    byMember,
    failureClusters,
  }
}

/**
 * 把失败族渲染成人读行（**纯函数**，与两个渲染入口共用：`manor_tasks` 的结构化输出 + `renderLedger`）。
 *
 * ⚠ 为什么**抽成导出的纯函数**而不是内联在工具 `execute` 里：**渲染逻辑住在 `execute` 里
 *   就不受任何测试保护**（成员勘指出过同型的 `rowTag` 教训 —— 那条渲染分支 bug 在 412 项
 *   全绿的情况下也照样存在）。抽出来，测试可以**直接喂它**。
 *
 * ⚠ 空数组 ⇒ 返回空数组：**不编造「无失败」这句文案**。空必须由调用方**分型**
 *   （「这批活没有失败」与「读不到日志」是两件事，本函数看不见后者）。
 *
 * @param clusters - `summarizeTasks` 的 `failureClusters`
 * @returns 每行一个簇（`<类型> × <成员>：N 条（id, id, …另有 k 条）`）
 */
export function renderFailureClusters(clusters: readonly FailureCluster[]): string[] {
  return clusters.map((c) => {
    const ids = c.taskIds.join(', ') + (c.more > 0 ? '，…另有 ' + String(c.more) + ' 条' : '')
    return c.kind + ' × ' + c.member + '：' + String(c.count) + ' 条（' + ids + '）'
  })
}

/**
 * 「过滤后为空」的专用文案 —— **它不是「全域为空」**。
 *
 * ★ 存在理由（2026-10-12 实测）：台账有 96 条任务，而带 `outcome=unfinished` 过滤时
 *   渲染说「**没有任何任务记录**（不是「读不到」——是日志里确实没有带 taskId 的动作）」
 *   —— 那句话在**全域非空**时是**撒谎**：它把「这个筛选条件没有命中」说成了
 *   「整个日志里什么都没有」，**会让人去查一个并不存在的问题**。
 *   同一形状（**空必须分型**）在别处已出现多次。
 *
 * @param filters 生效的筛选条件（如 `['outcome=unfinished']`）；空数组 = 没有过滤
 * @param allCount 过滤**前**的总条数
 * @param shownTotal 过滤**后**的总条数
 * @returns 命中「有过滤 ∧ 过滤后为空」⇒ 该文案；否则 `''`（调用方据此走正常渲染）
 */
export function renderFilteredEmptyNote(filters: readonly string[], allCount: number, shownTotal: number): string {
  if (filters.length === 0 || shownTotal !== 0) return ''
  return '任务台账｜**过滤后 0 条**（条件：' + filters.join(' · ') + '）'
    + '\n  ⚠ **这不是「全域为空」** —— 全域共 ' + String(allCount) + ' 条。'
    + '「过滤后为空」（说的是这个筛选条件）与「没有任何任务记录」（说的是整个台账）是两件事；'
    + '把前者读成后者，会让人去查一个并不存在的问题。'
}

/** 渲染汇总成给人看的一段。**空台账与读不到台账必须长得不一样**。 */
/**
 * ★★ **读数的抬头**（时刻行）—— **单一真源**，所有出口都必须叠它。
 *
 * 为什么它是独立函数、而不是 `renderTasks` 的正文第一行
 * （2026-10-12 · 成员织用**行号**抓出我，根因是她的判词）：
 *   我写成正文第一行 ⇒ 凡**绕过正文**的出口就都丢了它，**而结构化字段照常返回**：
 *     · 出口① `s.total === 0` 的**前置返回**（在本文件里，**早于**那一行）；
 *     · 出口② `renderFilteredEmptyNote`（它的**签名里没有 `nowMs`** ⇒ 结构上带不了）。
 *   ⇒ 那两条路上，盘上是「**字段说 11:17 查的、正文一个字没说**」，而两者都自报「这份读数」。
 *   ★ 她的原话：「时刻行被写成了『正文的第一行』，不是『读数的抬头』。凡是绕过正文的路径就都丢了它。」
 *   ⇒ 修法照她给的结构判断：**让时刻行在所有分支之前生成、当抬头叠加** ——
 *     **让分支消失，比让两处同步便宜**。
 *
 * ⚠ 未给 `nowMs` ⇒ **不假造时刻**，而是**响亮说「问不出来」**（同「空必须分型」的纪律）。
 */
export function renderAsOf(nowMs: number): string {
  return nowMs > 0
    ? '本读数**截至** ' + new Date(nowMs).toISOString()
      + '（本地 ' + new Date(nowMs).toLocaleString('zh-CN') + '）'
    : '⚠ **本读数没有时刻**（调用方没给 `nowMs`）——「这是哪一刻的」在这里**问不出来**'
}

/**
 * ★★ **整份台账读数的唯一产出者** —— 抬头 + 正文，一次给全。
 *
 * 为什么要有它（而不是让调用方自己拼 `renderAsOf` + 正文渲染器）：
 *   成员织 2026-10-12 追问了一句「**那个正文渲染器现在还导出吗？**」，并给了那个洞的形状：
 *   > 「W9-② 枚举的是『**当时有几个生产者**』。若正文渲染器仍可被外部调用，或将来多一条产出
 *   >   `rendered` 的路径 ⇒ ② 只看那一条拼接语句，**照样绿**，而新路径没有抬头。」
 *   ⇒ 与「**枚举式守卫在命名空间扩张时静默失效**」同一个形状。
 *   ⇒ 治法不是再加一条守卫，是**让第二个生产者不存在**（把「装不下」做到导出面上）。
 *   实测当时的状态：正文渲染器**仍在导出**，而且**我自己的测试有十几处在直接调它** ——
 *   那些测试正是「拿正文当整份读数用」的**示范**。⇒ 洞是真的。
 *
 * 落法：正文渲染器**改为私有**（不导出）；本函数是**唯一**能产出整份读数的地方。
 */
export function renderLedger(
  s: TaskSummary,
  rows: TaskRecord[],
  maxRows: number,
  nowMs: number,
  /**
   * 三个**受控的**变化点（除此之外，整份读数的形状不接受外部拼装）：
   * · `bodyOverride` —— 正文替身（如「过滤后为空」那条专用文案）；**抬头照旧由本函数产**；
   * · `prefixLines` —— 额外前缀行（错误 / 裁决记录读不出），插在**抬头之后、正文之前**；
   * · `extraLines` —— **尾部补充面**（★ 2026-10-14 新增：回执面 —— 它的**域与正文不同**
   *   （信箱 vs 动作日志），所以放尾部并**自带域标注**，不挤进正文里与台账读数混读）。
   */
  opts: { bodyOverride?: string; prefixLines?: readonly string[]; extraLines?: readonly string[] } = {},
): string {
  const head = [renderAsOf(nowMs), ...(opts.prefixLines ?? [])].join('\n')
  const body = opts.bodyOverride !== undefined ? opts.bodyOverride : renderBody(s, rows, maxRows, nowMs)
  const extra = opts.extraLines !== undefined && opts.extraLines.length > 0
    ? '\n' + opts.extraLines.join('\n')
    : ''
  return head + '\n' + body + extra
}

/** 正文（**私有**：外部拿不到它 ⇒ 就没有第二个整份读数的生产者）。判据见文件末尾的注释。 */
function renderBody(s: TaskSummary, rows: TaskRecord[], maxRows: number, nowMs: number): string {
  if (s.total === 0) return '任务台账｜**没有任何任务记录**（不是「读不到」——是日志里确实没有带 taskId 的动作）'
  const pct = (s.failureRate * 100).toFixed(1)
  const lines: string[] = []
  // ⚠ **本函数不产抬头**（时刻行由 `renderLedger` 叠在最前）——
  //   理由见 `renderAsOf` 的头注：写成正文第一行，会让**绕过正文的出口**静默丢掉它。
  //   判据在测试里：**只有一处生产者** ⇒ 抬头出现次数恒为 1。
  lines.push(
    '任务台账｜共 ' + String(s.total) + ' 个任务'
    + ' · 成功 ' + String(s.done)
    + ' · 失败 ' + String(s.failed) + '（超时 ' + String(s.byKind.timeout)
    + ' · exit≠0 ' + String(s.byKind['exec-error'])
    + ' · 其他 ' + String(s.byKind.unknown) + '）',
  )
  lines.push(
    '拒收 ' + String(s.rejected)
    + '（正文为空 ' + String(s.byReject['empty-body'])
    + ' · cwd 越界 ' + String(s.byReject['cwd-rejected'])
    + ' · 其他 ' + String(s.byReject['rejected-other'] + s.byReject.unknown) + '）'
    + ' —— **不是失败，是防线在工作**',
  )
  if (s.warned > 0) lines.push('降级警告过的任务 ' + String(s.warned) + ' 个（跑完了，但过程有警告）')
  lines.push('失败率 ' + pct + '%（分母 = 成功+失败 = ' + String(s.done + s.failed) + '；拒收与未完都不计入）')
  // ★ **失败族**（论文 AREAL-RSI §4.2 复盘三问的原料 · 主人 2026-10-14「可参考优化协作范式」交办）：
  //   `byKind`（按类型）与 `byMember`（按成员）各自独立 ⇒ 能答「超时 10 条」，**答不了
  //   「谁超时、在哪类活上超时」** ⇒ **模式浮不出来**，「从失败里提取改进」无从下手
  //   （论文自己点名的难点③：任务进展**不会自动**改进下一个过程）。
  //   ⚠ 它是**聚合不是归因**（照论文的口径 `Comparisons are descriptive`）：同一簇只说
  //   「这些活长在一起」，**不说因果**；样本量小 ⇒ **不许**据此说「某成员不行」这类话。
  //   ⚠ 口径与上面那行**不同**：上面只数**已分类**的失败，本段覆盖**全部失败**（含未分类者）
  //   ⇒ 两组数的**和本来就不等**，别对账（同「两个域不合流」那条纪律）。
  const clusterLines = renderFailureClusters(s.failureClusters)
  if (clusterLines.length > 0) {
    lines.push('失败族（**类型 × 成员**交叉 · 复盘的原料）｜' + String(s.failed) + ' 条失败聚成 '
      + String(clusterLines.length) + ' 簇：')
    for (const line of clusterLines.slice(0, 6)) lines.push('  · ' + line)
    if (clusterLines.length > 6) {
      // **不静默截断**（空 / 截断必须分型 —— 同 `more` 字段的纪律）
      lines.push('  …另有 ' + String(clusterLines.length - 6) + ' 簇（完整清单见结构化输出的 failureClusters）')
    }
  }
  // ★ **取严缺省的点火率**（成员织 · 2026-10-12 · 我认）—— **始终出，哪怕为 0**：
  //   不报这个数，「取严」就只是一句**无法检验的主张**（数不出它兜了几次底）；
  //   而 0 与非 0 是**相反的两件事**，读的人必须一眼分得开。
  //   它非 0 时的含义是硬的：`DEFAULT_TASK_NATURE` 的点火率 **≡ 声明漏写率**（构造决定）
  //   ⇒ 声明有洞时，这个缺省就是把当初要拦的洪水**原样放回**（详见 `envelope.ts` 的 `natureDeclaredOf`）。
  lines.push('`nature` 声明面｜**未声明 ' + String(s.natureUndeclared) + ' / ' + String(s.total) + ' 条**'
    + '（**全期口径**，含字段上线前派的历史任务 —— 那些**结构上无法**声明）'
    + (s.natureUndeclared === 0
      ? '｜取严缺省**没点火** ⇒ 声明覆盖完整'
      : '｜这些按 `owner` 取严 ⇒ 它们的失败**会推给主人**；内部建设/探针请显式声明 `internal` / `probe`'))
  // ★ **来路分布**（`G-provenance` **Step B** · 2026-10-15）—— 与上一行**同一族**：
  //   上一行答「这条活的失败**要不要打扰主人**」，本行答「**这条活是被哪条路造出来的**」。
  //   缺口原话：分母里那些 taskId **各自是被哪条调用点造出来的**，读数里**没有这一格**
  //   ⇒ 三种病在盘上同貌：① 派活方没声明 · ② 日志没记 · ③ **枚举本身漏了格子**。
  //   ⚠ `unknown` 与 `none` **不合并**（并成一格则「有我没见过的路在造活」静默消失）：
  //     · `unknown` = **我不认识的那条路** ⇒ **枚举漏格**，最该出声的一格；
  //     · `none` = **没盖章**（Step B 之前的历史信封 / 某条路还没接上）。
  //   ⚠ **始终出**（同上一行纪律）：0 与非 0 是**相反的两句话**，读的人必须一眼分得开。
  const viaKnown = s.total - s.viaUnknown - s.viaNone
  lines.push('信封来路｜**已知 ' + String(viaKnown) + ' · 未知 ' + String(s.viaUnknown)
    + ' · 未盖章 ' + String(s.viaNone) + ' / ' + String(s.total) + ' 条**'
    + (s.viaUnknown > 0
      ? '｜⚠ **未知来路非 0** ⇒ 有**我没登记过的写者**在造活（`KNOWN_ENVELOPE_VIAS` 漏格）'
        + ' —— 去补那份清单，不是改这一行'
      : '｜无未知来路')
    + (s.viaNone > 0 ? '；「未盖章」含 Step B（2026-10-15）之前的历史信封' : ''))
  //   ⚠⚠ **首次实跑就撞上的一次域陷阱**（2026-10-12 10:59 · 现读 102/102）：这个数是**全期**的，
  //     而它含 `nature` 字段上线**之前**派的历史任务——那些任务**结构上无法**声明（字段当时不存在）。
  //     单看这个数会把「历史」读成「当前全漏」——**我第一眼就是这么读的**。
  //     ⇒ 所以域标注**必须在读数里**（`§5.9` 规则 6：读数必须自带范围标注）。
  //     ⚠ 自动按时间分档需要一个「**字段上线时刻**」的锚 —— 2026-10-13 织的 SPEC 给出了取法
  //       （锚 = 宿主进程 `processStartMs`，**不是** mtime、**不是** commit）；分档落地中。
  //     这一条与 `failureRate` 的分母纪律同源：**分子分母一起报，且说清它们覆盖哪个域**。
  // ★ **派活 → 开始的时延**（2026-10-13 加 · 织 SPEC §7-1 点名要的那格的消费侧）。
  //   动机（原话）：「不可判档的代价方向是『少报漏』……**我没有能证实/证伪它的仪器**：
  //   总线上没有**派活时刻**的记录。」⇒ 有了 `envelopeCreatedAtMs`，这条时延成为可测量，
  //   分档里那个「不可判」档的成因当场消解。
  //   ⚠ **分母必须一起报**：只有拿到出生时刻的记录才进这个统计（`n` 是它的分母）。
  //     `n` 小的时候这个数没有统计意义 —— 所以**不静默**：n 随行给出。
  {
    const timed = rows.filter((r) => r.envelopeCreatedAtMs > 0 && r.startedAtMs > 0)
    const n = timed.length
    if (n > 0) {
      const delays = timed.map((r) => Math.max(0, r.startedAtMs - r.envelopeCreatedAtMs)).sort((a, b) => a - b)
      const med = delays[Math.floor((n - 1) / 2)]!
      const mx = delays[n - 1]!
      const human = (x: number): string =>
        x >= 3600000 ? (x / 3600000).toFixed(1) + ' 小时'
          : x >= 60000 ? String(Math.max(1, Math.round(x / 60000))) + ' 分钟'
            : (x / 1000).toFixed(1) + ' 秒'
      lines.push('派活→开始时延｜中位 ' + human(med) + ' · 最长 ' + human(mx)
        + '（**分母 ' + String(n) + ' 条**记了信封出生时刻 —— 其余是字段上线前派的，**读不出**）')
    } else {
      // 「没有样本」与「样本健康」是两件事 —— 空必须分型（同 `renderFilteredEmptyNote` 的纪律）。
      lines.push('派活→开始时延｜**问不出来**：没有任何一条记录同时带`信封出生时刻`与`开始时刻`'
        + '（不是「零延迟」—— 是这两格凑不齐）')
    }
  }
  if (s.unfinished > 0) {
    // ★ **「未完」必须带上年龄，否则它会撒谎**（2026-10-12 实测）：一条「**刚 start 60 秒**」的活
    //   与一条「**start 了三天**」的活，在这一行里**长得一模一样** —— 而我把前者当成后者，
    //   差点在勘**正跑着**的时候判她死了。⇒ 年龄 + 同类典型耗时**一起给**；**判不判死仍归人**。
    const un = rows.filter((r) => r.outcome === 'unfinished' && r.startedAtMs > 0)
    let ageNote = ''
    const human = (x: number): string =>
      x >= 3600000 ? (x / 3600000).toFixed(1) + ' 小时' : String(Math.max(1, Math.round(x / 60000))) + ' 分钟'
    if (nowMs > 0 && un.length > 0) {
      const oldest = un.reduce((a, b) => (a.startedAtMs <= b.startedAtMs ? a : b))
      const ageMs = Math.max(0, nowMs - oldest.startedAtMs)
      // 同类参照：**同一成员已完成任务的单次最长耗时**（没有就不给参照 —— **不编**）
      const sameTo = rows.filter((r) => r.outcome === 'done' && r.to === oldest.to && r.ms > 0)
      const ref = sameTo.length > 0 ? Math.max(...sameTo.map((r) => r.ms)) : 0
      ageNote = ' · **最老的一条起于 ' + human(ageMs) + ' 前**（'
        + (oldest.to === '' ? '未记成员' : oldest.to) + ' · `' + oldest.taskId + '`）'
        + (ref > 0
          ? '；**同一成员已完成任务的最长耗时 ' + human(ref) + '** ⇒ 明显超过它才谈得上「卡住」'
          : '（同类参照：该成员没有已完成任务可对照）')
    } else if (nowMs <= 0) {
      ageNote = ' ⚠ **未给 `nowMs` ⇒ 年龄不可算**（本行只答「有 start 无终态」，'
        + '**不区分「在飞」与「已死」**）'
    }
    lines.push('⚠ 未完 ' + String(s.unfinished) + ' 个 = 有 start 无终态' + ageNote
      + ' —— **「还在跑」与「静默失败」是两类**，后者才是该追的')
  }
  // ── 收尸裁决（2026-10-12）──
  // ★ **有主的那一批必须显形**：收尸的全部意义是把「没人管」变成「有主的决定」，
  //   而如果它不出现，读的人只会看到「未完数变小了」——**那正好读成「问题消失了」**。
  const reapLine = renderReapLine(s.reaped)
  if (reapLine !== '') lines.push(reapLine)
  if (s.orphanReaps > 0) {
    lines.push('⚠ **裁决无处生效 ' + String(s.orphanReaps) + ' 条** —— 那些活已是 done / failed / rejected，'
      + '而裁决**只对「未完」有意义** ⇒ 要么有人对已成事实的活改口，要么记录是手工塞进来的'
      + '（原文件未动，见 `reap/`）')
  }
  if (s.byMember.length > 0) {
    lines.push('按成员（「未记成员」= 早期动作日志无 profile 字段，**不猜**）：')
    for (const m of s.byMember) {
      lines.push('  ' + m.member + ' · 共 ' + String(m.total) + ' · 成 ' + String(m.done)
        + ' · 败 ' + String(m.failed) + ' · 拒 ' + String(m.rejected) + ' · 未完 ' + String(m.unfinished))
    }
  }
  // ★ 成本口径（2026-10-12 · ⑥ 面「该有」里缺的一格）。判据先行：
  //   **`ms > 0` 才算样本** —— `ms=0` 的语义是「日志里算不出耗时」（缺 `start` 行 /
  //   时间戳不可解），**不是「耗时 0 秒」**。把它当 0 计入会**系统性低估**中位与总计，
  //   而且低估得看不出来（分布本身不会报错）。故有效样本与无样本**分开报**。
  //   用中位而非均值：耗时是长尾分布（实测有 1012s 被杀的超时任务）。
  const timed = rows.filter((r) => r.ms > 0)
  const dur = (x: number): string =>
    x >= 3600000
      ? (x / 3600000).toFixed(1) + ' 小时'
      : x >= 60000
        ? (x / 60000).toFixed(1) + ' 分钟'
        : (x / 1000).toFixed(1) + ' 秒'
  if (timed.length === 0) {
    lines.push(
      '成本口径｜**无样本**（' + String(rows.length) + ' 条记录里没有一条算得出耗时'
      + ' —— 缺 `start` 行或时间戳不可解）',
    )
  } else {
    const ms = timed.map((r) => r.ms).sort((a, b) => a - b)
    // 外层已保证 timed.length > 0 ⇒ ms 非空，`!` 在此语义正确（不是掩盖 undefined）
    const n = ms.length
    const mid = n % 2 === 1 ? ms[(n - 1) / 2]! : Math.round((ms[n / 2 - 1]! + ms[n / 2]!) / 2)
    const totalMs = ms.reduce((a, b) => a + b, 0)
    lines.push(
      '成本口径｜有耗时 ' + String(timed.length) + ' 条 · **中位 ' + dur(mid) + '**'
      + ' · 最长 ' + dur(ms[n - 1]!) + ' · 总计 ' + dur(totalMs),
    )
    const per: string[] = []
    for (const m of s.byMember) {
      const mine = timed
        .filter((r) => (r.to === '' ? '未记成员' : r.to) === m.member)
        .map((r) => r.ms)
        .sort((a, b) => a - b)
      if (mine.length === 0) continue
      // 上面刚 continue 掉空数组 ⇒ `!` 在此语义正确
      per.push(m.member + ' 中位 ' + dur(mine[mine.length >> 1]!) + '（n=' + String(mine.length) + '）')
    }
    if (per.length > 0) lines.push('  ' + per.join(' · '))
    if (timed.length < rows.length) {
      lines.push(
        '  ⚠ 另 ' + String(rows.length - timed.length) + ' 条**无耗时样本**'
        + '（`ms=0` = 算不出，**不等于 0 秒**）⇒ 未计入以上分布',
      )
    }
  }
  // ★ 判据面（2026-10-12 · ⑥ 面「质量验收」格里**能做的那一半**）。裁决边界先写死：
  //   本行只答「**我派活时写没写判据**」（数据在台账里，是我负责的那一侧）；
  //   **不答「判据满没满足」** —— 那要那个活的回执（在信箱信封的 `meta.evidence`），
  //   且对账需要**另一份不是作者写的重建**（技能 `acceptance-integrity` §十）。
  //   ⚠ 空必须分型：全无判据时报「本面为空」而不是 `0 个` —— 后者会被读成「都合格」。
  const withAcc = rows.filter((r) => r.acceptance.trim() !== '')
  if (withAcc.length === 0) {
    lines.push(
      '判据面｜**本面为空**：' + String(rows.length) + ' 条任务里没有一条带验收判据'
      + '（`manor_dispatch` 的 `acceptance` 恒空 ⇒ 派活侧无判据，**不是「都合格」**）',
    )
  } else {
    const missing = rows.filter((r) => r.acceptance.trim() === '')
    lines.push(
      '判据面｜**派活侧**：有判据 ' + String(withAcc.length) + ' / ' + String(rows.length) + ' 个任务'
      + (missing.length > 0 ? ' · **无判据 ' + String(missing.length) + ' 个**' : ''),
    )
    for (const t of missing.slice(0, 5)) {
      lines.push('  ⚠ 无判据：' + t.taskId + ' → ' + (t.to !== '' ? t.to : '(未记成员)'))
    }
    if (missing.length > 5) lines.push('  …另有 ' + String(missing.length - 5) + ' 个（截断）')
    lines.push(
      '  ⚠ 本行只答「**我派活时写没写判据**」，**不答「判据满没满足」** ——'
      + '后者要那个活的回执（信箱信封 `meta.evidence`），且对账需要**另一份不是作者写的重建**',
    )
  }
  const shown = rows.slice(0, maxRows)
  if (shown.length > 0) {
    lines.push('明细（最近 ' + String(shown.length) + ' 条）：')
    for (const t of shown) {
      const mark = t.outcome === 'done'
        ? '✔'
        : (t.outcome === 'failed' ? '✖' : (t.outcome === 'rejected' ? '⛔' : '…'))
      const secs = t.ms > 0 ? (t.ms / 1000).toFixed(0) + 's' : '-'
      const kind = t.failureKind !== 'none'
        ? '/' + t.failureKind
        : (t.rejectKind !== 'none' ? '/' + t.rejectKind : '')
      lines.push('  ' + mark + ' ' + t.taskId + ' → ' + (t.to !== '' ? t.to : '(未记成员)')
        + ' · ' + t.outcome + kind + ' · ' + secs + (t.warning !== '' ? ' · ⚠有警告' : ''))
    }
  }
  return lines.join('\n')
}
