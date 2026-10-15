/**
 * 暂不可发起（hold）—— ③ 任务与调度的**依赖面**（纯函数 · 零 IO · 可离线测）
 *
 * 存在理由（规格由成员「哨」与「澄」给出，我按她们的账落 · 2026-10-12）
 *
 *   E11 立的三个缺口里，「依赖」最贵——因为它的失败形态是**静默的**：
 *   没有机制时，「B 要等 A 完成」只能靠人记得 ⇒ 这不是机制，是运气。
 *
 * ★ 三条来自当事人的设计定调（逐条落成代码，不装饰）：
 *
 *   ① **位置与状态分开**（澄）：依赖**检查**在派活侧（唯一握有全局的地方）、
 *      依赖**状态**是账本上的常驻字段。⇒ 本模块只做**判定与解释**，落盘在调用方。
 *      ★ 她那句是设计口诀：「**这问题本身就不该问得出来。它需要被问，就说明账本少了一个字段。**」
 *
 *   ② **「为什么还没跑」不能是口供**（哨）：「如果答案是从我记录的依赖状态里读出来的，
 *      那它本质上还是『我怎么记的』——**错了就照着错译一遍，而且永远答得出来、永远不可复核**」。
 *      ⇒ 本条是硬约束，直接决定数据结构：**hold 记录只存「等谁」（指针），绝不存「它现在什么状态」**。
 *      状态每次由**外部原语**现读：依赖活在账本/信箱里的**自己那一行** + 属主的**心跳**。
 *      ★ 这与我在重建包的 SCHEMA 里同一天写的**同一条**：「包是冻结点，它引用的世界不是
 *        ⇒ **指针可内联，易变状态不可**」。两个领域、同一形状。
 *
 *   ③ **出口必须是三条**（哨）：依赖完成 · 依赖**变为不可能**（失败/撤销）· **超时**；
 *      且后两条**必须响**——不是自动放行，是**升级成「需要人看」**。
 *      ★ 「沉默的死锁比成环更危险：成环是显式的，某处会 fail-loud；死锁是活的，
 *        所有灯都不亮，挂三个月才发现。」⇒ 超时是**升级**，不是放行。
 *      她还补了一格我完全没想到的：依赖方**死了**而状态还是旧的「进行中」
 *      ⇒ 解释会**在线撒谎**（「在等依赖」）⇒ 答案里**必须含「依赖方现在还活着吗」**。
 *
 * ★ 可见面四件（哨给的，**缺一件就等于把「没人拿」升级成「没人看」**）：
 *   名字 · **异形** · 挂起者+依赖项 · 每轮都在。
 *   ⇒ `renderHolds` 用**异形**（独立符号 + 独立措辞 + 独立口径行），
 *     并在 `manor_find` 的常读面上留一行（否则它只活在专门工具里 = 没人看）。
 *
 * ★ 溯源行（澄）：就绪递到手上时，信封带一行**出处**（「自 X 起在等 Y，Y 已完成」）。
 *   两条硬要求：**不能是她问才给**（那和「靠人记得重试」同一个毛病，只是把脆弱挪到她那边）
 *   ⇒ 它必须**跟结果同一趟出来**（她的比喻：**像流水线上贴着的那张单子**）；
 *   且**不能靠她去读 hold 目录**——所以它拼进信封正文第一行。
 */

export const HOLD_VERSION = 2
/** hold 记录的目录名（相对总线根）。 */
export const HOLD_DIRNAME = 'hold'

/**
 * **挂起原因的闭集**（记录里只存这个，不存散文）。
 * 为什么是闭集：散文可以装下任何东西（包括依赖状态快照 —— 那正是 2026-10-12 修掉的缺陷）；
 * 闭集在**结构上**装不下状态快照 ⇒ 不变量由类型保证，而不是靠一条容易被绕开的判据。
 *
 * ⚠ **闭集必须闭在类型上，不能只闭在「今天的调用点」**（2026-10-12 由成员「织」第二轮复核抓出）：
 *   我第一版把 `HoldSpec.reason` 写成 `string` ⇒ `buildHoldRecord` 在结构上**装得下**散文，
 *   它能拒绝状态快照靠的是**今天那个唯一调用点没传这个字段**。
 *   ★ 她的证据极硬：**我自己的对照组能成立，恰恰因为构造器是开着的**
 *   （那句状态快照**原样穿过同一个 `buildHoldRecord`** 才被我抓住）。
 *   ⇒ **「不变量由『今天谁在调它』保证，不由结构保证」= 与修前一模一样的形状。**
 *   现在 `HoldSpec.reason?: HoldReasonCode` ⇒ 洞从**字节级**升成**编译器级**；
 *   对照组要绕过时**必须显式 `as unknown as` 并注明「故意绕」**（洞因此仍然可见）。
 */
export const HOLD_REASON_CODES = ['deps-pending', 'manual', 'capacity', 'unknown'] as const
export type HoldReasonCode = (typeof HOLD_REASON_CODES)[number]

/**
 * 缺省原因码 = `'unknown'`，**不是** `'deps-pending'`。
 * ⚠ 2026-10-12 织指出：拿 `HOLD_REASON_CODES[0]` 当缺省值，等于把「**没有原因**」
 *   **静默翻译成「依赖未就绪」** —— 缺字段变成了一条关于依赖状态的断言。**该 fail-loud。**
 */
export const HOLD_REASON_UNKNOWN: HoldReasonCode = 'unknown'

/** 一个值是不是闭集内的原因码（**读盘侧的守门判据**）。 */
export function isHoldReasonCode(v: unknown): v is HoldReasonCode {
  return typeof v === 'string' && (HOLD_REASON_CODES as readonly string[]).includes(v)
}

/** 优先级。**有真实机制效果**：同一轮可释放数超上限时，高优先级先走（不是装饰字段）。 */
export const PRIORITIES = ['high', 'normal', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]

/** 缺省超时（出口三）。超时**升级**、不自动放行。 */
export const DEFAULT_HOLD_TIMEOUT_MS = 6 * 3600_000
/**
 * 判「属主已死」的阈值 —— **有意宽于心跳新鲜阈值**（5min vs 30s）。
 * 理由与 `manor_patrol` 同一条：「避免抖动一次就触发」。
 * ⚠ 2026-10-12 活体验收当场抓出：只带布尔（在线/不在线）时，**一次心跳陈旧**就把活升成
 * `dep-dead`，而且那次升级**永久留在记录里**，与同一份输出里的现读 `wait` 自相矛盾。
 */
export const DEFAULT_DEAD_AFTER_MS = 300_000
/** 每轮最多释放几条（有界：不一次把一堆成员同时叫醒）。超出的**必须报出来**。 */
export const DEFAULT_RELEASE_BATCH = 3

import type { TaskOutcome } from './task-ledger.ts'
import type { ReapVerdict } from './reap.ts'
import { normalizeTimeoutSpec, type TimeoutSpec } from './timeout.ts'

/**
 * 依赖活在**可观测世界**里的状态。
 * `missing` = 账本/信箱/hold 三处都找不到 ⇒ **它不在世界上**（要 fail-loud，不是静默等）。
 */
export type DepState = 'done' | 'failed' | 'rejected' | 'unfinished' | 'pending' | 'held' | 'missing'

/**
 * 台账终态 → 依赖面状态。
 *
 * ★ **映射不是恒等，而且不对称 —— 这是设计，不是补丁**（2026-10-12 加第五态时由 tsc 逼出来的）：
 *   `reaped` 在依赖面的读法**必须看它是哪一档**：
 *     · `superseded`（目的已由别的方式达成）⇒ **视同 `done`**（依赖满足 ⇒ 放行）
 *     · `dead`（它没做成）⇒ **视同 `failed`**（依赖不可能 ⇒ 走出口二**升级给人看，绝不自动放行**）
 *   ⇒ 这正是 `reap.ts` 头注那句「两档不合流」在**另一根轴**上的形态：
 *     它们对「下一步动作」不同 —— 在台账上是「要不要重做」，在依赖面是「放行还是升级」。
 *
 * ⚠ 在此之前这里是 `state: t.outcome`（靠**字段名相同**隐式映射）——
 *   加第五态的那一刻它当场崩（tsc 抓出）。**隐式映射的代价：新档位不会自己长出来。**
 */
export function depStateOf(t: { outcome: TaskOutcome; reapVerdict: '' | ReapVerdict }): DepState {
  if (t.outcome === 'reaped') return t.reapVerdict === 'superseded' ? 'done' : 'failed'
  return t.outcome
}

/** 一个依赖项的现读视图（**每次判定现算，绝不落盘进 hold 记录**）。 */
export interface DepView {
  taskId: string
  state: DepState
  /** 属主成员 id（账本取 `to`）；未知为空串，**不猜** */
  owner: string
  /** 属主此刻是否在线（心跳新鲜）。`missing`/未知时为 false */
  ownerOnline: boolean
  /**
   * 属主心跳年龄（ms）；`-1` = 从未/读不到。
   * ★ 为什么带**年龄**而不是只带布尔：判「活」要取窄（30s），判「死」要取宽（5min）——
   *   中间地带**不作判**。这与 `manor_patrol` 已有纪律同一条
   *   （「判死阈值有意宽于心跳新鲜阈值，避免抖动一次就触发拉起」）。
   *   ⚠ 2026-10-12 活体验收当场抓出：只带布尔时，**心跳抖动一次**就会把一条活升成 `dep-dead`。
   */
  ownerAgeMs: number
  /** 这个状态**从哪读出来的**（可独立复核的定位符） */
  source: string
  /** 依赖已完成/终止的时刻（ms）；未知为 0 */
  endedAtMs: number
}

/**
 * 一条 hold 记录。★ **只有指针，没有状态**——`dependsOn` 是 taskId 列表，
 * 每个依赖**现在**什么状态由 `resolveDeps` 现算（见头注②）。
 */
export interface HoldRecord {
  v: number
  taskId: string
  /** 收件人（释放时投给谁） */
  to: string
  /** 派活人 */
  from: string
  kind: string
  text: string
  acceptance: string
  /**
   * ★ 任务性质（`owner` / `internal` / `probe`）—— **原样存派活侧的声明**；`''` = 未声明。
   *
   * 存在理由（`E12` 余件 · 2026-10-12）：**hold 是信封的第二条产出路**，而修前它
   *   **一个 `nature` 都没有**（现读核实）⇒ 释放时 `buildEnvelope` 不带该字段 ⇒
   *   **那条路的活必然漏声明** ⇒ 缺省按 `owner` 取严 ⇒ 内部建设的 hold 活失败**会推给主人**。
   *   ★ 这正是成员织那条推论的第二个实例：**「某条路忘了传某字段」在取严缺省下不会报错，
   *     它只会静默地把那条路全算进兜底档** —— 而审计把手（`natureDeclared` / `natureUndeclared`）
   *     会把它**数出来**（先落那个把手的好处在此兑现：它让这条缺口在上线前就可见）。
   *
   * ⚠ 与 `reason` **不同级**，别照抄它的写法：`reason` 是**必填的不变量**（类型即闭集）；
   *   `nature` 是**可选声明** —— 「未声明」是合法状态，且它的合法后果就是「取严」。
   *   ⇒ 类型上是普通 `string`；归一**只**在 `envelope.ts` 的 `natureOf` 发生（单一真源，别处不许判）。
   * ⚠ 空串**不写盘**（同 `reasonLegacy` 的纪律：记录不该带一个死键）。
   */
  nature: string
  /**
   * 超时预算声明（**可选** —— 未声明是合法状态，后果是「回落节点级参数」）。
   *
   * ★ 存在理由（2026-10-14 主人「解决硬顶参数化的问题」）：hold 是信封的**第二条产出路**，
   *   而 `nature` 已经吃过一次「这条路忘了传 ⇒ 那条路的活必然漏声明」的亏（见上）。
   *   ⇒ `timeout` 走**同一条路**：`HoldSpec.timeout` → 本字段 → `releaseHold` 传回 `buildEnvelope`。
   * ⚠ 与 `nature` 的关键差别：`nature` 未声明 ⇒ 消费侧**取严**（`owner`）；
   *   `timeout` 未声明 ⇒ 消费侧**回落节点级参数**（`--idleTimeoutMs` / `--hardCapMs`）——
   *   两者都「缺省有语义」，但语义不同 ⇒ 不许把 `natureOf` 的模式照搬过来。
   * ⚠ 空（`undefined`）**不写盘**（同 `nature` 空串纪律：记录不该带一个死键）。
   */
  timeout?: TimeoutSpec
  cwd: string
  priority: Priority
  /** 等谁（taskId 列表）。指针，非状态 */
  dependsOn: string[]
  heldAtMs: number
  /** **谁挂的**（哨④：任何成员都能把别人的活挂起而对方不知道 ⇒ 正解不是加权限，是留痕可见） */
  heldBy: string
  /**
   * **为什么挂** —— 一个**原因码**（不是散文）。
   *
   * ★ 2026-10-12 两位成员**独立复核**后我改的（这条比我自己抓到的深一层）：
   *   修前这里是散文 `'依赖未完成：t-A（进行中（无终态） · 属主 maid-03）'` ——
   *   那是**依赖状态的一份快照**，逐字命中头注②要禁的东西（「绝不存它现在什么状态」）。
   *   ⚠ 更尖的是**为什么没人发现**：拼这句话的代码住在 `index.ts` 的 `apply` 闭包里，
   *   而守不变量的那条判据喂的是**人手搓的良性串** ⇒ **夹具即世界**：
   *   判据的作用域被夹具形状限死，生产写入器改坏任何字段套件都不会红。
   *   ⇒ 修法两条一起：**① 这里只存码**（码的取值集合是闭集，结构上不可能装下状态快照）；
   *   **② 拼装抽成 `buildHoldRecord`，生产与测试走同一个函数**（判据的作用域因此覆盖生产形态）。
   *   而「**当时**为什么挂」那句完整解释**没丢** —— 它进了 `manor-hold.jsonl` 的 `hold-created`
   *   事件（**事件流是历史，记录是状态**：历史天然带时刻，状态不该带）。
   */
  reason: HoldReasonCode
  /**
   * ★ **v1 遗留原文隔离区**（2026-10-12 由成员「织」第二轮复核抓出 —— 我只堵了写的一侧）。
   *
   * 形态：`parseHoldFile` 修前把盘上的 `reason` **原样读回**，而**修前那批 v1 记录还躺在盘上**
   * —— 它们的 `reason` 里就是依赖状态快照 ⇒ 任何读 `rec.reason` 的消费者（`manor_holds`、
   * 诊断脚本、未来加的消费方）**仍然拿到口供**。⇒ 「不经过渲染层的任何读法」这个开口，我没关。
   *
   * 处置（取舍：**活不能丢，但原文不许冒充原因**）：
   *   - `reason` 归一到闭集内的 `'unknown'`（**响亮标「不知道」**，不是静默翻译成某个具体原因）
   *   - 盘上的原文**移到这个只读诊断字段**；**任何判定路径都不读它**（与 `reason` 同类，只是历史）
   *   - 渲染时**显式警告**「这条是旧格式遗留，原字段已隔离」
   *
   * ⚠ **存活必须由 `legacy` 保证，不能由「reason 恰好不合法」推断** —— 见 `legacy` 的字段注。
   */
  reasonLegacy: string
  /**
   * ★ **时代标记**（2026-10-12 · 织**第三轮**复核抓出，本轮最漂亮的一条）。
   *
   * 我上一版把「是不是遗留」**推断**成 `!isHoldReasonCode(reason)`，于是：
   *   `parse` 把 v1 记录归一成 `reason='unknown'`（**一个合法码**）⇒ 任何一次重写
   *   （升级留痕 / 清升级，走 `{ ...e.hold }`）把它连同 `reasonLegacy` 写回盘 ⇒
   *   下一次 `parse` 看到合法码 ⇒ **判定不是遗留 ⇒ 原文被清空**。
   *   ★ **原文是被它自己的载体字段清掉的**；蒸发后它与「新代码写出的真 `unknown`」**一模一样**
   *   —— 那正是 `reasonLegacy` 存在的**全部理由**被抹掉。而这条路径**今天就在跑**。
   *   ⇒ **「是不是遗留」不能由「reason 恰好不合法」推断**（重写会把不合法变成合法）。
   *   必须是一个**随记录一起持久化的字段** ⇒ 不变量才落在**结构**上
   *   （`source-of-truth-guards` 第四级：装不下 > 靠纪律）。
   *
   * **取舍（织交回给我裁的那条，这是我的答复）**：原文**活到这条记录消失**，不随重写蒸发。
   *   ① 蒸发的代价是**信息不可逆损失**，保留的代价只是一点磁盘 ⇒ **代价不对称，取严保原文**；
   *   ② 「这条记录是什么时代写的」**是一个事实**，不该随重写漂移；
   *   ③ 若它会在第一次重写时蒸发，`reasonLegacy` 的**全部存在理由**（可回溯）当场归零。
   */
  legacy: boolean
  /**
   * 出口三的超时**时长**（ms，自 `heldAtMs` 起算）。到点**升级**，不放行。
   * ⚠ 2026-10-12 由成员**织**与**哨**各自独立指出：旧字段名 `deadlineMs` 与字段注
   *   （「超时**时刻**」）说的是绝对时间戳，而代码算的是**时长** ⇒ 声明与实现不一致。
   *   现网自洽（写入的是时长），但**照旧字段注手写 hold JSON 的人**会写出绝对时间戳，
   *   于是 `nowMs - heldAtMs` 要几十年才追得上 ⇒ **超时永不触发**，只剩 dep-dead/dep-missing 兜底。
   *   ⇒ 改名（名字即文档）并保留旧名读取兼容。读旧记录请用 `deadlineAfterMsOf`。
   */
  deadlineAfterMs: number
  ttlMs: number
  /**
   * 升级留痕（非空 = 已升级，含原因码）。
   * ⚠ **必须可撤销**：现读裁决不再是 escalate 时要清掉 —— 否则一次抖动写的标记会永久留着，
   *   与现读裁决自相矛盾、还让计数长期虚高（2026-10-12 活体验收当场抓出）。
   */
  escalated: string
}

/** 出口裁决。`release` = 真投递；`escalate` = 升级成人看；`wait` = 继续等。 */
export interface ExitJudgement {
  action: 'release' | 'escalate' | 'wait'
  /** 原因码（稳定，可断言） */
  code: string
  /** 一句话人话理由 */
  reason: string
}

const asStr = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const asNum = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** 优先级解析。未知值 ⇒ `normal`（并把原值交还给调用方去留痕，**不静默吞**）。 */
export function parsePriority(v: unknown): { priority: Priority; error: string } {
  if (v === undefined || v === null || v === '') return { priority: 'normal', error: '' }
  const s = String(v).trim().toLowerCase()
  if ((PRIORITIES as readonly string[]).includes(s)) return { priority: s as Priority, error: '' }
  return { priority: 'normal', error: '未知优先级 "' + String(v) + '"（取 normal；可选：' + PRIORITIES.join('/') + '）' }
}

/**
 * 依赖列表解析。接受 `string` 或 `string[]`；去重保序；**拒空串**（空串当依赖 = 永远等一个不存在的东西）。
 * ⚠ 自依赖**在这里不判**——留给 `findCycle` 统一判，否则两条判据会在两处各写一遍（必然分叉）。
 */
export function parseDependsOn(v: unknown): { list: string[]; errors: string[] } {
  const errors: string[] = []
  let arr: unknown[] = []
  if (v === undefined || v === null || v === '') return { list: [], errors }
  if (typeof v === 'string') arr = [v]
  else if (Array.isArray(v)) arr = v
  else return { list: [], errors: ['dependsOn 形态不对（要 string 或 string[]）'] }
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of arr) {
    const s = asStr(item, '').trim()
    if (s === '') {
      errors.push('dependsOn 里有空项（空依赖 = 永远等一个不存在的东西）')
      continue
    }
    if (seen.has(s)) continue
    seen.add(s)
    list.push(s)
  }
  return { list, errors }
}

/** 优先级排序权重（大 = 先走）。 */
export function priorityRank(p: Priority): number {
  if (p === 'high') return 2
  if (p === 'low') return 0
  return 1
}

/**
 * 释放顺序：**先高优先级，同档先等得久的**。
 * 这是 `priority` 的**真实机制效果**（同一轮可释放数超上限时决定谁先走），不是装饰。
 */
export function sortHolds(holds: HoldRecord[]): HoldRecord[] {
  return [...holds].sort((a, b) => {
    const d = priorityRank(b.priority) - priorityRank(a.priority)
    if (d !== 0) return d
    return asNum(a.heldAtMs, 0) - asNum(b.heldAtMs, 0)
  })
}

/**
 * 成环检测（E11 判据③：**必须 fail-loud，不能静默死锁**）。
 * `edges`: taskId → 它等的 taskId 列表。返回环路径（含首尾同点）或 null。
 * 自依赖是长度 1 的环，由同一条判据覆盖。
 */
export function findCycle(edges: Map<string, string[]>): string[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = new Map<string, number>()
  const nodes = new Set<string>()
  for (const [k, vs] of edges) {
    nodes.add(k)
    for (const v of vs) nodes.add(v)
  }
  /** 显式栈（不用递归 —— 深链会爆栈，而环恰恰是深链的极端形态） */
  const found: string[] = []
  const visit = (start: string): boolean => {
    const stack: Array<{ node: string; idx: number }> = [{ node: start, idx: 0 }]
    const path: string[] = [start]
    color.set(start, GREY)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const outs = edges.get(top.node) ?? []
      if (top.idx >= outs.length) {
        color.set(top.node, BLACK)
        stack.pop()
        path.pop()
        continue
      }
      const next = outs[top.idx]!
      top.idx += 1
      const c = color.get(next) ?? WHITE
      if (c === GREY) {
        const at = path.indexOf(next)
        found.push(...(at < 0 ? path : path.slice(at)), next)
        return true
      }
      if (c === WHITE) {
        color.set(next, GREY)
        stack.push({ node: next, idx: 0 })
        path.push(next)
      }
    }
    return false
  }
  for (const n of nodes) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      if (visit(n)) return found
    }
  }
  return null
}

/**
 * **可观测世界**的快照 —— IO 层每轮**现读**后交进来的纯数据。
 *
 * 为什么单独抽出来：解释句必须**独立可核**（哨：「错了就照着错译一遍，而且永远答得出来、
 * 永远不可复核」）⇒ 判定逻辑只吃这一份快照，`resolveDeps`/`judgeExit`/`explainHold`
 * 全是**纯函数** ⇒ 同一份 world 重跑必得同一句话（可证伪形式），换一份 world 必得另一句。
 */
export interface WorldView {
  /** taskId → 账本读数（**已开始过**的活：账本来自动作日志，是「真的发生过什么」的原始记录） */
  ledger: Record<string, { state: DepState; owner: string; endedAtMs: number; source: string }>
  /** taskId → 还在信箱顶层（**没被取走**） */
  queued: Record<string, { owner: string }>
  /** taskId → 它自己也挂在 hold 里 */
  held: Record<string, { owner: string }>
  /** 成员 → 心跳年龄（ms）；`-1` = 无记录。**带年龄**，因为判死要取宽（见 `DepView.ownerAgeMs`） */
  heartbeatAgeMs: Record<string, number>
  /**
   * ★ 这一轮**读到在线面了吗**。
   * `false` ⇒ **整轮不作判**（既不释放也不升级）——因为「读不到」不是「都不在线」。
   * ⚠ 2026-10-12 活体验收抓出的第二处缺陷：读盘失败被 `catch { return [] }` 吞成空集 ⇒
   *   下游把「读不到」读成「所有人都不在线」⇒ **系统性误升级**（且同一条 hold 会被永久标上）。
   *   这正是本文档反复写的那条纪律：「**空**」与「**读不到**」是两件事。
   */
  onlineFaceOk: boolean
}

/**
 * 依赖状态解析 —— **纯函数**。顺序：账本 > 信箱 > hold > **找不到**。
 *
 * ★ 在线面的缺失（`onlineFaceOk === false`）在此**不打折**：一个读不到的世界里
 *   「谁在线」是**未知**而不是「都不在线」；未知由 `judgeWorld` 统一处理成「不作判」。
 */
export function resolveDeps(taskIds: string[], world: WorldView, freshMs = 30000): DepView[] {
  const ageOf = (id: string): number => {
    if (id === '') return -1
    const a = world.heartbeatAgeMs[id]
    return typeof a === 'number' && Number.isFinite(a) ? a : -1
  }
  /** 判活**取窄**（新鲜阈值）；`onlineFaceOk === false` ⇒ 一律 false（未知按不在线**呈现**，判死另由宽阈值把关）。 */
  const build = (id: string, state: DepState, owner: string, source: string, endedAtMs: number): DepView => {
    const age = ageOf(owner)
    return {
      taskId: id, state, owner,
      ownerOnline: world.onlineFaceOk && age >= 0 && age < freshMs,
      ownerAgeMs: age,
      source, endedAtMs,
    }
  }
  return taskIds.map((id) => {
    const l = world.ledger[id]
    if (l !== undefined) return build(id, l.state, l.owner, l.source, l.endedAtMs)
    const q = world.queued[id]
    if (q !== undefined) return build(id, 'pending', q.owner, '信箱 ' + q.owner + '（顶层，未被取走）', 0)
    const h = world.held[id]
    if (h !== undefined) return build(id, 'held', h.owner, 'hold/' + id + '.json', 0)
    return build(id, 'missing', '', '账本/信箱/hold 三处皆无', 0)
  })
}

/** 一次算全（每条 hold 的依赖视图 + 出口裁决）。
 *
 * ★ **在线面读不到 ⇒ 整轮不作判**（`online-face-unreadable`）：既不释放（可能误放）也不升级
 *   （会系统性误升级）。这是「空 ≠ 读不到」在判定层的落点 —— 2026-10-12 活体验收抓出的缺陷。
 */
export function judgeWorld(
  holds: HoldRecord[],
  world: WorldView,
  nowMs: number,
  opts: { deadAfterMs?: number; freshMs?: number } = {},
): Array<{ hold: HoldRecord; deps: DepView[]; exit: ExitJudgement }> {
  const freshMs = opts.freshMs ?? 30000
  if (!world.onlineFaceOk) {
    return holds.map((hold) => ({
      hold,
      deps: resolveDeps(hold.dependsOn, world, freshMs),
      exit: {
        action: 'wait' as const,
        code: 'online-face-unreadable',
        reason: '这一轮的**在线面读不到** ⇒ **不作判**：既不释放也不升级 —— 「读不到」不是「都不在线」',
      },
    }))
  }
  const deadAfterMs = opts.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS
  return holds.map((hold) => {
    const deps = resolveDeps(hold.dependsOn, world, freshMs)
    return { hold, deps, exit: judgeExit(hold, deps, nowMs, deadAfterMs) }
  })
}

/** 判定一条 hold 该走哪个出口。**纯函数：同一份 world 重跑必得同一句话**（哨的可证伪形式）。 */
export function judgeExit(
  hold: HoldRecord,
  deps: DepView[],
  nowMs: number,
  deadAfterMs = DEFAULT_DEAD_AFTER_MS,
): ExitJudgement {
  if (deps.length === 0) {
    // 不该发生：无依赖的活不会被挂起。出现了 ⇒ 是缺陷，响亮报
    return { action: 'escalate', code: 'no-deps', reason: '这条 hold 没有任何依赖却挂在 hold 里（不该发生）——需要人看' }
  }
  const missing = deps.filter((d) => d.state === 'missing')
  if (missing.length > 0) {
    return {
      action: 'escalate',
      code: 'dep-missing',
      reason: '依赖 ' + missing.map((d) => d.taskId).join('、') + ' 在账本/信箱/hold 三处都找不到 —— **它不在世界上**',
    }
  }
  const done = deps.filter((d) => d.state === 'done')
  if (done.length === deps.length) {
    return { action: 'release', code: 'deps-done', reason: '依赖全部完成（' + done.map((d) => d.taskId).join('、') + '）' }
  }
  const impossible = deps.filter((d) => d.state === 'failed' || d.state === 'rejected')
  if (impossible.length > 0) {
    return {
      action: 'escalate',
      code: 'dep-impossible',
      reason: '依赖 ' + impossible.map((d) => d.taskId + '（' + d.state + '）').join('、')
        + ' 已经**不可能**完成 ⇒ 这条活等不到，需要人裁决（改依赖 / 撤活 / 换人）',
    }
  }
  // ★ 哨⑥：依赖方**死了**而状态还是「进行中」⇒ 解释会**在线撒谎**。这一格必须在。
  //   ⚠ 判死**取宽**（`deadAfterMs`）：「不在新鲜阈值内」**不等于**「死了」——
  //   中间那一带（心跳陈旧但未超判死线）**不作判**，继续等（与 `manor_patrol` 同纪律）。
  const deadOwner = deps.filter((d) => d.state === 'unfinished' && !d.ownerOnline && d.ownerAgeMs >= deadAfterMs)
  if (deadOwner.length > 0) {
    return {
      action: 'escalate',
      code: 'dep-dead',
      reason: '依赖 ' + deadOwner.map((d) => d.taskId + '（属主 ' + (d.owner === '' ? '未知' : d.owner) + ' 心跳已停 ' + humanAge(d.ownerAgeMs) + '）').join('、')
        + ' 停在「进行中」而其属主已超判死线（' + humanAge(deadAfterMs) + '）⇒ **它不会自己走完**（这一格防的是「在线撒谎」）',
    }
  }
  if (nowMs - asNum(hold.heldAtMs, 0) >= asNum(hold.deadlineAfterMs, DEFAULT_HOLD_TIMEOUT_MS)) {
    const hung = deps.filter((d) => d.state !== 'done')
    return {
      action: 'escalate',
      code: 'timeout',
      reason: '已等 ' + humanAge(nowMs - asNum(hold.heldAtMs, 0)) + '，超过上限；仍卡在 '
        + hung.map((d) => d.taskId + '（' + d.state + '）').join('、') + ' ⇒ **升级成人看，不自动放行**',
    }
  }
  return { action: 'wait', code: 'waiting', reason: '依赖尚未就绪' }
}

/** 人类可读时距（一位小数 + 单位）。与 `stranded.mjs` 的 `humanAge` 同口径。 */
export function humanAge(ms: number): string {
  const m = Math.max(0, ms) / 60000
  if (m < 60) return m.toFixed(0) + ' 分钟'
  const h = m / 60
  if (h < 48) return h.toFixed(1) + ' 小时'
  return (h / 24).toFixed(1) + ' 天'
}

/** 依赖状态的中文名（解释句里用）。 */
export function stateLabel(s: DepState): string {
  switch (s) {
    case 'done': return '已完成'
    case 'failed': return '已失败'
    case 'rejected': return '被拒收'
    case 'unfinished': return '进行中（无终态）'
    case 'pending': return '在信箱里（还没被取）'
    case 'held': return '本身也在等（暂不可发起）'
    default: return '**找不到**'
  }
}

/**
 * 「这条活为什么还没跑」的**解释句** —— 独立可核版。
 *
 * 哨的可证伪形式：**拿这条活与依赖活两个活的真实状态重跑一遍解释器，要得到同一句话**。
 * ⇒ 本函数是纯函数，`deps` 由调用方**现读**；句子里每个事实都带**来源定位符**。
 */
export function explainHold(hold: HoldRecord, deps: DepView[], nowMs: number): string {
  const head = hold.taskId + ' 未跑：'
  if (deps.length === 0) return head + '这条 hold 没有依赖记录（账本缺字段，不是活的错）'
  const parts = deps.map((d) => {
    const nope = d.ownerAgeMs < 0 ? ' 无心跳记录' : (' 心跳停 ' + humanAge(d.ownerAgeMs))
    const owner = d.owner === '' ? '属主未知' : ('属主 ' + d.owner + (d.ownerOnline ? ' 在线' : ' **' + nope + '**'))
    return d.taskId + '（' + stateLabel(d.state) + ' · ' + owner + ' · 来源 ' + (d.source === '' ? '未知' : d.source) + '）'
  })
  const waited = humanAge(Math.max(0, nowMs - asNum(hold.heldAtMs, 0)))
  return head + '等 ' + parts.join(' 且 ') + ' · 已等 ' + waited
}

/**
 * **释放宽限**：依赖完成后**至少**要等过一个 sweep 周期，那条活才可能被释放
 * ⇒ 在宽限内报「应被释放」是**假异常**。缺省 = 2 个 sweep 周期（120s）。
 * 调用侧应按 `sweepIntervalMs` 传入（`max(本值, 2 × sweepIntervalMs)`）——纯判定层不读配置。
 */
export const DEFAULT_RELEASE_GRACE_MS = 120_000

/**
 * **反向扫描器**（哨②：「单向判定谁都会写，**能把判定翻过来证伪的才算防线**」）。
 * 回答两个问题：
 *   ① 哪些活**依赖已满足却没跑**（= 释放器没转 / 刚满足还没到下一轮）
 *   ② 哪些活**挂着但依赖方已不活**（= 依赖属主离线，或依赖已不可能/找不到）
 */
export function reverseScan(
  entries: Array<{ hold: HoldRecord; deps: DepView[] }>,
  nowMs: number,
  deadAfterMs = DEFAULT_DEAD_AFTER_MS,
  releaseGraceMs = DEFAULT_RELEASE_GRACE_MS,
): { readyButHeld: Array<{ taskId: string; reason: string }>; depDead: Array<{ taskId: string; reason: string }> } {
  const readyButHeld: Array<{ taskId: string; reason: string }> = []
  const depDead: Array<{ taskId: string; reason: string }> = []
  for (const e of entries) {
    const d = e.deps
    if (d.length === 0) continue
    if (d.every((x) => x.state === 'done')) {
      // ★ **窗口期**（2026-10-12 真活实测连报两次假异常之后加的）：sweep 是独立周期，
      //   「刚满足（正常等待）」与「释放器没转（真故障）」在**只看状态**时不可分 ⇒ 判据缺时间预算。
      //   代价不对称 ⇒ 取宽：假阳性毁的是**整条防线的可信度**（读者学会忽略它），漏报只推后一轮发现。
      const doneAt = d.map((x) => x.endedAtMs).filter((t) => t > 0)
      const missing = d.length - doneAt.length
      const lastDone = doneAt.length > 0 ? Math.max(...doneAt) : 0
      if (missing > 0) {
        // 完成时刻读不到 = **数据缺口**：不许静默（「静默失败 = 死亡温床」），也不许冒充「超期」。
        readyButHeld.push({ taskId: e.hold.taskId, reason: '⚠ 依赖已全部完成，但有 ' + String(missing) + ' 条的**完成时刻读不到**（账本缺终态时刻）⇒ 无法判断是否已过释放宽限 · ' + explainHold(e.hold, d, nowMs) })
      } else if (nowMs - lastDone >= releaseGraceMs) {
        readyButHeld.push({ taskId: e.hold.taskId, reason: '依赖已全部完成，但这条活仍在 hold 里（应被释放）· ' + explainHold(e.hold, d, nowMs) })
      }
      // 否则：**在宽限内 ⇒ 正常等待，沉默** —— 这一格正是修复掉的假阳性。
    }
    // 与 `judgeExit` 同一条判死线（取宽）：**不重复一套阈值**
    const bad = d.filter((x) => x.state === 'missing' || x.state === 'failed' || x.state === 'rejected' || (x.state === 'unfinished' && !x.ownerOnline && x.ownerAgeMs >= deadAfterMs))
    if (bad.length > 0) {
      depDead.push({ taskId: e.hold.taskId, reason: explainHold(e.hold, d, nowMs) })
    }
  }
  return { readyButHeld, depDead }
}

/**
 * 释放时拼的**溯源行**（澄：跟结果同一趟出来，不是她问才给）。
 * 一行、放正文最前、含**出处三件**：自何时起等 · 等谁 · 它何时完成的。
 */
export function buildTraceLine(hold: HoldRecord, deps: DepView[], nowMs: number): string {
  const doneAt = deps.map((d) => d.endedAtMs).filter((t) => t > 0)
  const lastDone = doneAt.length > 0 ? Math.max(...doneAt) : 0
  const waited = humanAge(Math.max(0, nowMs - asNum(hold.heldAtMs, 0)))
  return '【出处】这条活自 ' + new Date(asNum(hold.heldAtMs, 0)).toISOString() + ' 起在等 '
    + hold.dependsOn.join('、') + '（等了 ' + waited + '）；它们已完成'
    + (lastDone > 0 ? '（最后一条完成于 ' + new Date(lastDone).toISOString() + '）' : '')
    + ' ⇒ 现在才跑到你手上。'
}

/** 把溯源行拼到正文**之前**（同一趟）。 */
export function withTraceLine(text: string, trace: string): string {
  if (trace === '') return text
  return trace + '\n\n' + text
}

/**
 * 渲染 hold 清单 —— **异形**（哨四件的第二件：必须在**格式上长得不一样**，
 * 否则「我推了」就等于没推——那一行会被常规格式吸收掉）。
 */
export function renderHolds(
  entries: Array<{ hold: HoldRecord; deps: DepView[]; exit: ExitJudgement }>,
  nowMs: number,
  opts: { maxRows?: number; escalatedOnly?: boolean } = {},
): string {
  const maxRows = opts.maxRows ?? 20
  const list = opts.escalatedOnly === true ? entries.filter((e) => e.hold.escalated !== '') : entries
  if (list.length === 0) {
    return opts.escalatedOnly === true
      ? '✔ 没有已升级的挂起项'
      : '✔ 暂不可发起：0 条（没有活卡在依赖上）'
  }
  const ordered = sortHolds(list.map((e) => e.hold))
  const byId = new Map(list.map((e) => [e.hold.taskId, e]))
  const lines: string[] = []
  lines.push('⏸ **暂不可发起** ' + String(list.length) + ' 条 —— 这些活**读得到、但还不会跑**')
  lines.push('（与「可处理」「无人认领」都不同：那两类是**没人拿**；这一类是**还没轮到**。）')
  for (const h of ordered.slice(0, maxRows)) {
    const e = byId.get(h.taskId)!
    const mark = h.escalated !== '' ? '⚠ 需裁决[' + h.escalated + ']' : '· 等依赖'
    lines.push(mark + ' **' + h.taskId + '** ｜ 派给 ' + h.to + ' ｜ 优先级 ' + h.priority + ' ｜ 挂起者 ' + h.heldBy)
    // ★ 2026-10-12 两位成员独立复核后的形状：记录里只有**原因码**（闭集，结构上装不下状态快照），
    //   而「**当时**为什么挂」的完整解释住在 **trace 的事件流**里
    //   —— **事件流是历史，记录是状态**：历史天然带时刻，状态不该带。
    const atIso = asNum(h.heldAtMs, 0) > 0 ? new Date(asNum(h.heldAtMs, 0)).toISOString() : '时刻不详'
    lines.push('   挂起原因码：' + h.reason + '（挂起于 ' + atIso + '）—— 码是**闭集**，'
      + '记录里**不含任何状态快照**；当时的完整解释在 trace（`manor-hold.jsonl` 的 `hold-created` 行）')
    // ★ 哨的第⑤问：**「第二个调用点忘了传 reason」除了正则和读 tail 之外，还有别的东西会响吗？**
    //   答：**有 —— 就在这里响**。`reason='unknown'` 而依赖非空，说明**生产者没声明它明明知道的原因**
    //   （否则 trace/散文那一面不会那么具体）⇒ 机器面被迫降级成解析散文。⇒ 在**可见面上**点出来。
    //   ⚠ **归并口径的纠正（哨 2026-10-12 回执 · 同批次）**：这条是**两个来源的归并点** ——
    //     「生产者确实没声明」与「值读不出来」。**修 `662` 之前**两者都会落进这个条件里；
    //     修后「值读不出来」一定带 `reasonLegacy` 隔离原文 ⇒ **被 `reasonLegacy === ''` 排除**
    //     ⇒ 这个条件现在**精确地**只剩「生产者没声明」一种来源。
    //     ⇒ 但归并点**必须自述它在归并什么**（否则读的人会把两类外推成一类）：文案里写清口径。
    if (h.reason === HOLD_REASON_UNKNOWN && h.dependsOn.length > 0 && h.reasonLegacy === '') {
      lines.push('   ⚠ **机器面不知道原因**（`unknown` 而依赖非空）—— 生产者没声明它明明知道的原因。'
        + '这正是「忘了传原因码」在**可见面**上的形状（不必有人去读 trace 才能发现）。')
      lines.push('   ⚠ **口径**：本条是**两个来源的归并点**——「生产者没声明」与「值读不出来」；'
        + '后者一定带 `reasonLegacy` 隔离原文，已被排除 ⇒ 落进这里的**只可能是前者**。'
        + '⇒ 读法：当「生产者没声明」处理，**不要外推成「这个活恰好没原因」**。')
    }
    // ★ 旧格式遗留**必须显形**（织第二轮复核：写的一侧收紧了，可盘上的 v1 记录还在）——
    //   隔离的原文不许冒充「原因」，读者必须知道这条记录来自哪个时代的格式。
    if (h.reasonLegacy !== '') {
      lines.push('   ⚠ **旧格式遗留**：这条记录的 `reason` 不在闭集里 ⇒ 已归一到 `unknown`，'
        + '原文（**只读诊断，不可当现状读**）隔离为：' + h.reasonLegacy)
    }
    lines.push('   现在的状态（**现读**）：' + explainHold(h, e.deps, nowMs))
    lines.push('   出口裁决：' + e.exit.action + '（' + e.exit.code + '）—— ' + e.exit.reason)
  }
  if (ordered.length > maxRows) lines.push('（另有 ' + String(ordered.length - maxRows) + ' 条未列出——先把上面这些处置掉。）')
  lines.push('——')
  lines.push('**口径**：这里说的是**现在**的状态，每个事实都带来源定位符（账本/信箱/hold/心跳）；')
  lines.push('**证据不在本条记录里** —— 记录只存「等谁」（指针），状态每次现读（易变状态不可落盘）。')
  lines.push('**出口三条**：依赖完成 ⇒ 自动投递（带一行出处）· 依赖不可能 / 属主已死 / 超时 ⇒ **升级成人看，不自动放行**。')
  return lines.join('\n')
}

/**
 * `manor_find` 上留的那一行（哨四件的第四件：**每轮都在**）。
 * 它是**入口**：只报数 + 指路，细节归 `manor_holds`（免得常读面被撑爆）。
 * 无挂起项时返回空串 —— 一个字都不加（否则它会退化成每次都在的噪音）。
 */
export function renderHoldLine(count: number, escalated: number): string {
  if (count <= 0) return ''
  return '⏸ 暂不可发起 ' + String(count) + ' 条（依赖未满足 · 不会自己跑'
    + (escalated > 0 ? ' · **' + String(escalated) + ' 条需裁决**' : '') + ' · 见 manor_holds）'
}

/** 一条 hold 记录的 JSON 文本（落盘用；形状与 `parseHoldFile` 对账）。
 *  空的 `reasonLegacy` **不写盘**（v2 记录不该带一个死键；读回时缺字段 ⇒ `''`，往返仍一致）。 */
export function serializeHold(h: HoldRecord): string {
  const out: Record<string, unknown> = { ...h }
  if (out['reasonLegacy'] === '') delete out['reasonLegacy']
  // ★ 未声明 ⇒ **不写盘**（同纪律：记录不该带一个死键）；读回时缺字段 ⇒ `''`，往返仍一致。
  if (out['nature'] === '') delete out['nature']
  return JSON.stringify(out, null, 2) + '\n'
}

/**
 * 解析一条 hold 记录。**坏记录 fail-loud**（返回 error），不静默丢弃 ——
 * 「我读不到」与「它不在」是两件事（与名册同一条纪律）。
 */
export function parseHoldFile(text: string): { ok: boolean; record: HoldRecord | null; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, record: null, error: '不是合法 JSON：' + String(e) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, record: null, error: '记录不是对象' }
  }
  const r = raw as Record<string, unknown>
  const taskId = asStr(r['taskId'], '').trim()
  if (taskId === '') return { ok: false, record: null, error: '缺 taskId' }
  const to = asStr(r['to'], '').trim()
  if (to === '') return { ok: false, record: null, error: '缺 to（释放时不知道投给谁）' }
  const deps = parseDependsOn(r['dependsOn'])
  if (deps.list.length === 0) return { ok: false, record: null, error: '缺 dependsOn（没有依赖的活不该在 hold 里）' }
  const pri = parsePriority(r['priority'])
  // ★ 读盘侧的守门（2026-10-12 · 织第二轮复核）：**写的一侧收紧了不够** ——
  //   修前那批 v1 记录还躺在盘上，它们的 `reason` 就是状态快照，修前的读法**原样读回**
  //   ⇒ 任何不经渲染层的消费者仍拿到口供。
  //   处置：合法码照读；**不合法/缺字段 ⇒ 归一到 `'unknown'`（响亮标「不知道」，不静默翻译成某个具体原因）
  //   并把原文移进 `reasonLegacy` 隔离区**（活不能丢，但原文不许冒充原因）。
  const reasonRaw = r['reason']
  const reasonOk = isHoldReasonCode(reasonRaw)
  // ★ 时代标记**由字段承载、不从 reason 的值推断**（织第三轮复核：推断会被重写抹掉）：
  //   `legacy` 一旦为真就**随记录持久化** ⇒ 重写不会清空 `reasonLegacy`。
  const v = asNum(r['v'], HOLD_VERSION)
  const legacy = r['legacy'] === true || v < HOLD_VERSION || !reasonOk
  // ★ **时代标记只许说「怎么解读」，不许说「这个值读不出来」**（织第四轮复核 · 2026-10-12）：
  //   `legacy` 的三个来源里，只有 `!reasonOk` 在说**这个值**；`v < HOLD_VERSION` 与 `r['legacy'] === true`
  //   说的是**时代**。把它当全称量词（「来自旧时代 ⇒ 这一代的话一律不可信」）会**扔掉读得出来的东西**：
  //   合法码被降级成 `unknown`，而 `reasonLegacy` 那一格因 `reasonOk === true` 落成 `''`
  //   ⇒ **那个码哪都没留底**（往返判据看不见：两次归化结果相同），而可见面（`590` 那条点名）
  //   正好被这个三元组命中 ⇒ **反着点名「生产者没声明」，而它其实声明了**。
  //   ⇒ 分域：**时代 → 怎么解读（隔离警告 / 原文放哪）；值 → `isHoldReasonCode` 说了算**。
  //   ⚠ 这条不是洁癖：`HOLD_VERSION` 2→3 那天，现网所有 v2 记录都满足 `v < HOLD_VERSION`
  //   ⇒ 旧写法会让**整代的 reason 码一起丢底**，而每条上面都挂「生产者没声明」。
  const reason: HoldReasonCode = reasonOk ? (reasonRaw as HoldReasonCode) : HOLD_REASON_UNKNOWN
  const reasonLegacy = legacy ? (typeof reasonRaw === 'string' && !reasonOk ? reasonRaw : asStr(r['reasonLegacy'], '')) : ''
  return {
    ok: true,
    error: '',
    record: {
      // ⚠ **保留记录自己的 `v`，不要改写成当前版本** —— 若写回 `HOLD_VERSION`，
      //   下次 parse 就判不出「它来自旧时代」，`reasonLegacy` 又会被清掉（= 重新制造织抓出的那个 bug）。
      //   `v` 是**时代标记的载体之一**，所以它必须随记录持久化。
      v,
      taskId,
      to,
      from: asStr(r['from'], ''),
      kind: asStr(r['kind'], 'task'),
      text: asStr(r['text'], ''),
      acceptance: asStr(r['acceptance'], ''),
      // ★ 缺字段 ⇒ `''`（= **未声明** ⇒ 消费侧取严）。语义上它与「声明了空串」同后果，
      //   但来源不同：旧记录**结构上无法**声明过它（字段当时不存在）——所以这里不假造「声明」。
      nature: asStr(r['nature'], ''),
      cwd: asStr(r['cwd'], '.'),
      priority: pri.priority,
      dependsOn: deps.list,
      heldAtMs: asNum(r['heldAtMs'], 0),
      heldBy: asStr(r['heldBy'], ''),
      reason,
      reasonLegacy,
      legacy,
      // 旧名兼容：`deadlineMs` 那版写的是**时长**（现网自洽），照读；两处都没有才取缺省。
      deadlineAfterMs: asNum(
        r['deadlineAfterMs'],
        asNum(r['deadlineMs'], DEFAULT_HOLD_TIMEOUT_MS),
      ),
      ttlMs: asNum(r['ttlMs'], 86400000),
      escalated: asStr(r['escalated'], ''),
    },
  }
}

/** 读旧字段名 `deadlineMs` 时代的记录（诊断用；新代码一律用 `deadlineAfterMs`）。 */
export function deadlineAfterMsOf(hold: HoldRecord): number {
  return asNum(hold.deadlineAfterMs, DEFAULT_HOLD_TIMEOUT_MS)
}

/** `buildHoldRecord` 的输入：**生产写入器与测试共用同一份规格**。 */
export interface HoldSpec {
  taskId: string
  to: string
  from: string
  kind: string
  text: string
  acceptance: string
  /**
   * 任务性质声明（**可选** —— 未声明是合法状态，后果是「取严」）。
   * ⚠ 它与 `reason` 不同级：后者是**必填的不变量**，前者是**可选声明**
   *   （理由见 `HoldRecord.nature` 的字段注）。`buildHoldRecord` 归一：非字符串 ⇒ `''`。
   */
  nature?: string
  /**
   * 超时预算（**可选**）。归一两处：`buildHoldRecord`（**形状**）+ `manor_dispatch`（**范围，拒发**）。
   * ⚠ 类型取宽（`unknown`）：hold 记录会被**读回**（磁盘 JSON），类型不可信。
   */
  timeout?: unknown
  cwd: string
  priority: Priority
  dependsOn: string[]
  heldAtMs: number
  heldBy: string
  /** 超时**时长**（ms），自 `heldAtMs` 起算 */
  deadlineAfterMs: number
  ttlMs: number
  /** 原因码（**类型即闭集**；**必填** —— 见下方字段注：缺省值本身就是一条断言） */
  reason: HoldReasonCode
}

/**
 * 组装一条 hold 记录 —— ★★ **生产写入器与测试走同一个函数**。
 *
 * 存在理由（2026-10-12 · 两位成员**独立复核**得出，我照收）：修前这段拼装住在
 * `index.ts` 的 `apply` 闭包里（只能在真插件组合里跑）⇒ 测试碰不到它 ⇒
 * 守「记录只存指针」那条判据的**作用域被夹具形状限死**（夹具喂良性串、生产喂状态快照）。
 * ★ 哨的原话是根因：**「整个 tests/ 里没有任何用例执行写入路径 ⇒ 生产记录形状的每一条
 * 不变量，今天都由人手搓的 HoldRecord 代守；写入器改坏任何字段，套件都不会红。」**
 * ⇒ 真修法不是把断言写得更狠，是**让夹具与生产共用同一个写入函数**。
 *
 * ⚠ 本函数**不读时间**（`heldAtMs` 由调用方给）—— 与全层同一条纪律：无隐式状态依赖。
 */
export function buildHoldRecord(spec: HoldSpec): HoldRecord {
  // ★ 哨的第⑤问（「第二个调用点忘了传 `reason`，除了正则和读 tail 之外还有别的东西会响吗？」）——
  //   答：**两层响**。① **类型层**：`HoldSpec.reason` 是必填的 `HoldReasonCode`，
  //   `src/` 参与 `tsc` ⇒ 新调用点忘了传是**编译错误**（这正是「装在结构上」而不是「靠正则看调用点」）。
  //   ② **运行期兜底**（本行）：绕过类型、或来自**未经类型检查的调用方**（测试是 `node` 直接跑 .ts）
  //   时，归一成 `unknown` —— 并且 `renderHolds` 会对「`unknown` 而依赖非空」**在可见面上点名**
  //   （那正是「生产者没声明它明明知道的原因」的形状）。
  //   ⚠ **不抛异常**：插件与宿主同进程，逃逸异常会杀死 web（§5.24）；响亮不等于要炸。
  const reason: HoldReasonCode = isHoldReasonCode(spec.reason) ? spec.reason : HOLD_REASON_UNKNOWN
  // ★ 超时预算（2026-10-14）：归一在 `timeout.ts`（只收有限正数；全空 ⇒ `null` ⇒ **不写字段**）。
  //   ⚠ 与 `nature` **不同**：那个归一成 `''` 也要**写上**（消费侧要判「声明的还是兜底的」——
  //     `natureDeclaredOf` 是那个取严缺省唯一的审计把手）；这个不写 ——
  //     「没写」= 未声明 ⇒ 执行侧回落节点级参数（无审计把手需求）。
  const timeoutSpec = normalizeTimeoutSpec(spec.timeout)
  return {
    v: HOLD_VERSION,
    taskId: spec.taskId,
    to: spec.to,
    from: spec.from,
    kind: spec.kind,
    text: spec.text,
    acceptance: spec.acceptance,
    // ★ 归一：**只有字符串才算声明**（`undefined` / 别的类型 ⇒ `''` = 未声明 ⇒ 消费侧取严）。
    //   ⚠ 闭集校验不在这里 —— 那是 `manor_dispatch` 的职责（它拒发闭集外的值）；
    //     本行只保证**形状**，语义归一在 `natureOf`（单一真源，别处不许判）。
    nature: typeof spec.nature === 'string' ? spec.nature : '',
    ...(timeoutSpec === null ? {} : { timeout: timeoutSpec }),
    cwd: spec.cwd,
    priority: spec.priority,
    dependsOn: [...spec.dependsOn],
    heldAtMs: spec.heldAtMs,
    heldBy: spec.heldBy,
    reason,
    reasonLegacy: '',
    legacy: false,
    deadlineAfterMs: spec.deadlineAfterMs,
    ttlMs: spec.ttlMs,
    escalated: '',
  }
}
