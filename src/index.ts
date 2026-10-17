/**
 * dsh-manor —— 庄园联络门面：「找她们」与「把话发对」。
 *
 * 存在理由（2026-10-09 实测，两次真实失败）：
 *   ① 按人类文档传 `--keyName OPEMCODER_API_KEY` 起成员，而该成员的 provider 已换到
 *      `command` ⇒ 缺 `COMMAND_API_KEY` ⇒ 子进程 **2 秒 exit=1、stderr 为空**（故障不可自证，
 *      因为 headless 只在正常走完时才把答复吐到 stdout）。
 *   ② 用集群通用通道派活，信封**无 `meta.taskId`** ⇒ 成员正确拒收。
 * ⇒ 两件事的共同根因是同一个：**「该怎么起、该怎么发」只存在于人类文档里，文档腐化即出错**。
 * 本插件把这两件事改成**从真源推导**：启动参数从成员的 profile 解析，信封由工具生成。
 *
 * 与既有设施的分工（不造平行载体）：
 *   - `manor_roster`（nodeforge）管**多源核验的存活判定** —— 本插件不重做，只给单判据的速览 + 指路。
 *   - `cluster_send` 管**通用集群投递** —— 本插件补的是**庄园专属的信封契约**（`meta.taskId`）。
 *   - `node_start`（nodeforge）管**把 DSH profile 起成节点** —— 庄园成员走的是 **adapter 模式**，
 *     两者启动参数不同；本插件的 `manor_wake` 只做后者。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { summarizeInbox, renderInbox, DEFAULT_STALE_AFTER_MS, type InboxItem } from './inbox.ts'
import { classifyBoxes, renderStrandedBus, type BusBox, type BusItem } from './stranded-bus.ts'
import { summarizeStaleAdapters } from './adapter-staleness.ts'
import { buildEnvelope, checkRefs, invisibleToolMentions, isTaskNature, newMsgId, parseRecipients, TASK_NATURES } from './envelope.ts'
// 超时预算的**派活侧**判据（2026-10-14 主人「解决硬顶参数化的问题」）：
//   `validateTimeoutSpec` 是**拒发**判据（fail-loud）；`renderTimeoutSpec` 让派活方看见自己的声明。
import { validateTimeoutSpec, renderTimeoutSpec } from './timeout.ts'
import { releaseClaim, tryClaim } from './claim-store.ts'
import { loadReaps, reapDirOf, writeReap } from './reap-store.ts'
import {
  DISPUTE_TRACE_FILE, disputeDirOf, disputesRootOf, loadDisputeTrace, loadDisputes,
  writeDisputeClaim, writeDisputeMeta, writeDisputeVerdict,
} from './dispute-store.ts'
import {
  DISPOSITION_LABEL, DISPOSITION_VERDICTS,
  DISPUTE_META_FILE, DISPUTE_RULES, DISPUTE_RULE_LABEL, DISPUTE_VERDICT_FILE, HEADLINE_MAX,
  auditClaimTraces, claimFileNameOf, digestOf, isDisputeRule, judgeDispute, parseDispositionsText,
  renderDispositions, renderTraceAudit,
  renderDisputeLine, validateDispositions,
  type Disposition, type DisputeClaim, type DisputeMeta, type DisputeVerdict,
} from './dispute.ts'
import { REAP_LABEL, REAP_VERDICTS, buildReapRecord, isReapVerdict, reapFileNameOf } from './reap.ts'
import { DEFAULT_CLAIM_TTL_MS } from './claim.ts'
import {
  buildWorldView as buildWorldViewOf,
  createHold as createHoldOf,
  holdDirOf,
  holdView as holdViewOf,
  loadHolds as loadHoldsOf,
  removeHold as removeHoldOf,
  sweepHolds as sweepHoldsOf,
  updateHold as updateHoldOf,
  type SweepResult,
  type WorldInput,
} from './hold-store.ts'
import {
  assign,
  emptyRoster,
  hire,
  mergeStatus,
  parseRoster,
  retire,
  rosterFingerprint,
  type NodeObservation,
  type RosterFile,
} from './roster-registry.ts'
import { withTargetLock } from './roster-lock.ts'
import {
  emptyPatrolState,
  normalizePatrolState,
  planPatrol,
  renderPatrol,
  shouldRunOnBoot,
  updatePatrolState,
  type PatrolState,
} from './patrol.ts'
import {
  extractReceipts,
  foldTasks,
  parseActionLog,
  renderAsOf,
  renderFailureClusters,
  renderFilteredEmptyNote,
  renderLedger,
  summarizeReceipts,
  summarizeTasks,
  type ReceiptLite,
  type TaskRecord,
} from './task-ledger.ts'
import {
  emptyTaskWatchState,
  normalizeTaskWatchState,
  planTaskWatch,
  renderTaskAlerts,
  type TaskWatchPlan,
  type TaskWatchState,
} from './task-watch.ts'
import {
  DEFAULT_DEAD_AFTER_MS,
  DEFAULT_HOLD_TIMEOUT_MS,
  DEFAULT_RELEASE_BATCH,
  DEFAULT_RELEASE_GRACE_MS,
  buildHoldRecord,
  findCycle,
  parseDependsOn,
  parsePriority,
  renderHoldLine,
  renderHolds,
  resolveDeps,
  reverseScan,
  stateLabel,
  type HoldRecord,
} from './hold.ts'

export const name = 'manor'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
  busDir: string
  nodesRoot: string
  adapterPath: string
  credentialsPath: string
  spawnDetachedPath: string
  selfId: string
  heartbeatFreshMs: number
  /** 存活巡检开关（庄园语义文档 §5.2）：成员死了要**被发现**，并被拉回来 */
  patrolEnabled: boolean
  patrolIntervalMs: number
  /** 判「死了」的阈值——**有意宽于心跳新鲜阈值**（5min vs 30s），避免抖动一次就拉起 */
  patrolDeadAfterMs: number
  patrolMaxAttempts: number
  /**
   * ③ 依赖面（「暂不可发起」hold）的释放扫描开关。
   * 为什么独立于 patrol：patrolIntervalMs 缺省 5 分钟 ⇒ 依赖一完成要等最多 5 分钟才投递，
   * 对「活该跑了」太粗。两者各自独立 try/catch ⇒ 一件炸了不带着另一件停摆。
   */
  holdEnabled: boolean
  holdSweepIntervalMs: number
  /** 每轮最多释放几条（有界：不一次把一堆成员同时叫醒）。超出的会被报出来 */
  holdReleaseBatch: number
  /** 出口三的超时上限（ms）：到点**升级成人看**，不自动放行 */
  holdTimeoutMs: number
  /**
   * 判「依赖属主已死」的阈值（ms）——**有意宽于 `heartbeatFreshMs`**（5min vs 30s）。
   * 理由与 `patrolDeadAfterMs` 同一条：「避免抖动一次就触发」。
   * ⚠ 中间那一带（心跳陈旧但未超此线）**不作判**：既不放行也不升级。
   */
  holdDeadAfterMs: number
  /**
   * 工具面分档（2026-10-12 · 由 E12 暴露出的真障碍）。
   *
   * 为什么需要它：成员跑在**独立数据面**里（`--dsHome E:\alice-nodes\maid-0N\.dsh`），
   * 而她们的 profile **没有挂 `dsh-manor`** ⇒ **`manor_claim` 对她们不存在**。
   * 可 E12 的「独占型必须先举手」**举手的正是她们** ⇒ 工具做了却调不动。
   *
   * ★ 为什么用「角色档」而不是「逐工具开放」：**默认必须取严**。
   *   新增工具若默认对成员可见，某天一个 `manor_retire` 就会静默出现在她们的工具面里
   *   （成员能踢人 = 权限越界）。⇒ 缺省 `host` 时成员**什么都看不到**，
   *   加成员面必须**显式**改这张表（`toolsForRole` 是单一真源，且被测试钉住）。
   */
  role: 'host' | 'member'
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  busDir: z.string().default('C:\\Users\\tr\\.dsh-cluster'),
  nodesRoot: z.string().default('E:\\alice-nodes'),
  adapterPath: z.string().default('E:\\alice\\projects\\self\\alice-manor\\adapter.mjs'),
  credentialsPath: z.string().default('E:\\alice\\.dsh\\.credentials.yaml'),
  spawnDetachedPath: z.string().default('E:\\alice\\self-plugins\\dsh-agent-nodeforge\\scripts\\spawn-detached.mjs'),
  selfId: z.string().default('LAPTOP-BF4IAPLM-web-0'),
  heartbeatFreshMs: z.number().default(30000),
  patrolEnabled: z.boolean().default(true),
  patrolIntervalMs: z.number().default(300000),
  patrolDeadAfterMs: z.number().default(300000),
  patrolMaxAttempts: z.number().default(3),
  holdEnabled: z.boolean().default(true),
  holdSweepIntervalMs: z.number().default(60000),
  holdReleaseBatch: z.number().default(DEFAULT_RELEASE_BATCH),
  holdTimeoutMs: z.number().default(DEFAULT_HOLD_TIMEOUT_MS),
  holdDeadAfterMs: z.number().default(DEFAULT_DEAD_AFTER_MS),
  // ★ API 真源：`vendor/schemastery/lib/types/index.d.ts` 的 `union<const X>(list: readonly X[])`
  //   ⇒ 传**字面量数组**（不是 zod 的 `z.enum` / `z.literal` —— 我连猜两次，都被 tsc 当场驳回）。
  role: z.union(['host', 'member']).default('host'),
})

/**
 * 工具面分档 —— **单一真源**（注册处与测试共用同一个函数，读数不分叉）。
 *
 * ★ 判据：**member 档只列「成员自己要用的」**，不列任何**管理动作** ——
 *   `manor_hire` / `manor_retire` / `manor_assign` / `manor_wake` / `manor_patrol`
 *   都是总女仆长的事；成员能踢人就是**权限越界**。
 * ★ 白名单形态（不是黑名单）⇒ **新增工具默认对成员不可见**（fail-closed）：
 *   某天加一个管理工具，它不会静默出现在成员的工具面里。
 * ★ 缺省（`host`）返回**全部** ⇒ 现有行为零回归。
 */
export const MEMBER_TOOLS: readonly string[] = ['manor_claim', 'manor_release', 'manor_find', 'manor_dispute']

/**
 * host 专属工具（**显式清单**：与 `MEMBER_TOOLS` 双向覆盖全部工具，且不相交）。
 *
 * ★ 为什么必须有这份清单（2026-10-12 · **由一次真实失败驱动**）：`MEMBER_TOOLS` 是**白名单**
 *   ⇒ 新增工具**默认对成员不可见**。这个 fail-closed 行为是对的，但它有**一半缺口**：
 *   **「默认不可见」与「有人确认过这是有意的」是两件事**。
 *   实测代价：我加了 `manor_dispute` 却没同步白名单 ⇒ 派给 maid-05 的活 **200 秒后被杀**
 *   （台账 `failed/timeout`），而**没有任何机制报过警**（工具注册正常、心跳正常、测试全绿）。
 *   ⇒ 补法不是「记得改白名单」，而是**让「没归类」变成一个测试失败**：
 *     `MEMBER_TOOLS ∪ HOST_ONLY_TOOLS == 全部工具`（且两者不相交）。
 *     加工具的人**必须显式决定**它对成员可见还是 host 专属 —— 默认值不再是一个静默的答案。
 */
export const HOST_ONLY_TOOLS: readonly string[] = [
  'manor_dispatch', 'manor_holds', 'manor_wake', 'manor_members',
  'manor_hire', 'manor_retire', 'manor_assign', 'manor_patrol',
  'manor_tasks', 'manor_reap', 'manor_task_watch', 'manor_stranded',
]

/**
 * 庄园适配器的心跳自述（`harness` 字段）—— **「有没有唤醒路径」的唯一可读判据**。
 *
 * ★ 2026-10-12（勘当场推翻我的判据，逐字）：「**在册 ≠ 有消费者**」。
 *   她给的反例：那一刻 `LAPTOP-BF4IAPLM-maid-04-0` **在名册里、正心跳**，
 *   而那两条信是被 **`held`**（`autoInject=false`）—— 不是「投给不存在的 id」。
 *   她那句是这条判据的来源：「一个 `autoInject=false` 的箱子**在册也照样是死箱**，
 *   回信落在它上面等于没有落点。」
 *   ⇒ 真判据是「**谁在轮询、取了之后会不会注入**」，而 harness 是它在总线上的可读形式。
 * ⚠ 与 `dsh-agent-nodeforge` 的 `MANOR_HARNESS` **同一口径**（那边 `manor_roster` 用它）
 *   —— 两处同值，改一处要一起改。
 * ★ 2026-10-14：**真源已下移到 `roster-registry.ts`**（纯层）—— 修前它定义在这里，
 *   而两个纯层模块都在用同一个字面值 ⇒ **依赖方向反了**（纯层不该依赖壳）。
 *   此处保留 **re-export** 只为不打断既有 import 点。
 */
export { MANOR_ADAPTER_HARNESS } from './roster-registry.ts'
import { MANOR_ADAPTER_HARNESS, rowTag } from './roster-registry.ts'

/**
 * 从「心跳自述表」里筛出**有唤醒路径**的 id 集 —— **单一真源**（两处调用共用 ⇒ 读数不分叉）。
 *
 * 判据（两层同时成立）：**有节点身份**（表里有它 ⇒ 有进程在轮询）**且取了会注入**
 *   （`harness` 是庄园适配器）。只判第一层是错的 —— 见 `MANOR_ADAPTER_HARNESS` 的注释。
 */
export function wakePathIds(harnesses: Readonly<Record<string, string>>): Set<string> {
  return new Set(Object.keys(harnesses).filter((id) => (harnesses[id] ?? '') === MANOR_ADAPTER_HARNESS))
}

/**
 * 角色能力档 —— **单一真源**：一处决定「成员能看到什么工具」与「成员能不能承载后台循环」。
 *
 * ★ 为什么两件事必须同一个判据（2026-10-12 挂载前发现）：它们**同源**——都来自
 *   「成员只做自己那点事，不担管理职责」。拆成两处（白名单一处 + 配置开关一处）
 *   就是让同一个决定有两个落点 ⇒ 改一处忘一处。
 *   ⚠ 而那个「忘」**不产生任何可观测异常**：工具面收窄了，定时器照起。
 *   这正是「两条纪律压进一个名字」的反面用法——**同一个角色的两个面压进一个判据**。
 */
export interface RoleCaps {
  /**
   * 该角色可见的工具白名单；`null` = 全部（host）。
   * 白名单形态 ⇒ 新增工具**默认对成员不可见**（fail-closed）。
   */
  tools: readonly string[] | null
  /**
   * 是否承载**后台循环**（存活巡检 + 任务守望 / 依赖释放）。
   *
   * ★ 判据是 AGENTS.md §5.19 **单点所有权**：同一资源只能有一个 owner。
   *   成员若也承载 ⇒ 三个可证伪的坏后果：
   *   ① **N 个进程同时拉人**（同一个成员可能被拉起两次 ⇒ 两个进程抢同一个邮箱）；
   *   ② **失败告警重复 N 次送上主人**（§5.14 规则 5：外部可见副作用必须去重——
   *      多条测试告警 = 狼来了）；
   *   ③ 巡检账（`patrolState`）被 N 个写者并发改 ⇒ 有界退避计数失真。
   */
  backgroundLoops: boolean
}

export function roleCaps(role: 'host' | 'member'): RoleCaps {
  return role === 'member'
    ? { tools: MEMBER_TOOLS, backgroundLoops: false }
    : { tools: null, backgroundLoops: true }
}

export function toolsForRole(role: 'host' | 'member', all: readonly string[]): string[] {
  const wl = roleCaps(role).tools
  return wl === null ? [...all] : all.filter((n) => wl.includes(n))
}

/**
 * 工具尾部**指路文案**的角色分档（2026-10-12 · 织在试点验收里实测抓出）。
 *
 * 缺陷形状：**工具面收窄了，文案照旧** —— `manor_find` 尾部原写「派活用 `manor_dispatch`；
 * 起成员用 `manor_wake`」，而这两个工具**成员根本调不到** ⇒ 文案在推荐不存在的能力。
 *
 * ★ 这个形状最阴的地方：**它不产生任何异常**。测试全绿、工具全部正常、心跳照跳，
 *   只有**当事人读到**才会发现。织是据工具清单推断的，且**如实标注了未实测**——
 *   她没有去调那个工具，所以不给「调用失败」的读数。那是正确的判据纪律。
 *   ⇒ 与同日的「工具面收窄了、定时器照起」是**同一形状的第二次**：
 *     「分档」的宾语集是 **工具面 + 后台循环 + 给当事人看的文案**；收窄一处忘一处。
 *
 * ★ 判据（可复算）：member 档文案里抽出的**每个**工具名都必须在她的可见面内 ——
 *   见 `tests/role-surface.test.ts` 的「指路文案」两条。文案不再是孤儿文本，
 *   它被钉在她的白名单上（新增工具/新增文案都会被抓）。
 *   ⚠ `manor_roster` 是**例外且必须显式列出**：它来自 `dsh-agent-nodeforge`（不在本插件里）。
 */
export function guideLine(role: 'host' | 'member'): string {
  return role === 'member'
    ? '（严格的多源存活核验用 manor_roster；领活用 manor_claim / manor_release）'
    : '（严格的多源存活核验用 manor_roster；派活用 manor_dispatch；起成员用 manor_wake）'
}

/**
 * 判 `cwd` 是否落在某成员的工作根内 —— 纯函数（派活侧的**诊断前移**）。
 *
 * 由来（2026-10-12 · 四封回执共同报出的缺口）：我多播派活时给了 `cwd: E:/alice-nodes`，
 * 而四个成员的工作根是 `E:\alice-nodes\maid-0N` ⇒ **一个 cwd 发给 N 个不同工作根的人，
 * 必然对每个人越界**。适配器**正确地**拒了并降级（按本节点工作根执行）——
 * 但**四个成员各自在自己的回执里抱怨了一次**，而**派活侧一无所知**。
 *
 * ★ 这是「多播」这个新形态自带的洞：单播时 cwd 由调用方按那**一个人**的工作根给，
 *   不可能错；多播时**同一个 cwd 要同时对 N 个人成立**，而它几乎不可能成立。
 *
 * ★ 为什么取严（拒发）而不是「报出来但照发」：两侧代价不对称 ——
 *   拒发的代价是调用方多一次调用；放行的代价是**收件人在别人的工作根里干活**
 *   （现在靠每个适配器自觉拦；**别的实现可以不拦**，那就成了静默的错误落点）。
 *
 * 三条**不作判**的情形（不替她断言）：
 *   - `cwd` 为空或 `.` ⇒ 相对路径，随各人工作根 ⇒ 天然成立；
 *   - 工作根未知（读不到名册记录）⇒ 没资格判她越界；
 *   - 两者都非空才比。
 */
export function cwdInsideWorkdir(cwd: string, workdir: string): boolean {
  const c = cwd.trim()
  if (c === '' || c === '.') return true
  if (workdir.trim() === '') return true
  // Windows 上分隔符与大小写都会混写（`E:/alice-nodes` vs `E:\alice-nodes`）⇒ 归一后比。
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const cc = norm(c)
  const ww = norm(workdir)
  // ★ `ww + '/'` 而不是裸 `startsWith`：否则 `E:/alice-nodes-x` 会被判成落在 `E:/alice-nodes` 内。
  return cc === ww || cc.startsWith(ww + '/')
}

/**
 * 自动生成 `taskId` —— 把**分隔符字符**换掉（2026-10-12 多播验收当场发现）。
 *
 * 缺陷：多播时 `to` 是 `maid-02,maid-03`，而缺省 id 直接拼 `to` ⇒ 生成
 * `t-maid-02,maid-03-mv4a94oa`。**而逗号在别处是分隔符**：`hold` 记录的 `dependsOn`
 * 用 `join(',')` 存多值 ⇒ **同一个字符既是标识符的一部分又是分隔符**。
 * 谁把这条 id 当依赖填进 `dependsOn`，它就会被**拆成两个不存在的 id**，
 * 而依赖面会报「找不到」—— **坏的地方与报错的地方隔了一层**（最难查的形状）。
 *
 * ⇒ 生成时换成 `+`（不在任何分隔符集里）；**显式传入的含逗号 id 也响亮拒绝**（见 dispatch）。
 */
export function autoTaskId(to: string, nowMs: number): string {
  return 't-' + to.replace(/,/g, '+') + '-' + nowMs.toString(36)
}

/** 后台巡检定时器：模块级单例（热重载时 apply 可能被多次调用，防残留双定时器）。 */
let patrolTimer: ReturnType<typeof setInterval> | null = null
/** ③ 依赖面的释放定时器（独立于 patrol：5 分钟的巡逻间隔对「活该跑了」太粗）。 */
let holdTimer: ReturnType<typeof setInterval> | null = null

// ───────────────────────────── 纯函数层（零 IO · 可离线测） ─────────────────────────────

/**
 * 从成员的 profile 文本推导「当前 provider 需要哪个凭据环境变量」。
 *
 * 为什么不用缩进判据：各成员 profile 的缩进层级不保证一致 ⇒ 缩进一变就静默取不到。
 * 改用「provider 名出现处之后**最近的** `apiKeyEnv`」，并用窗口长度限制避免跨段误取。
 */
export function keyNamesFor(patchYml: string): { provider: string; keyNames: string[]; source: string } {
  const dm = patchYml.match(/id:\s*agent-default-model[\s\S]{0,600}?\bprovider:\s*([A-Za-z0-9_.-]+)/)
  const provider = dm === null ? '' : dm[1]!
  let key = ''
  let source = ''
  if (provider !== '') {
    const esc = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = patchYml.match(new RegExp(esc + ':\\s*\\n([\\s\\S]{0,400}?)apiKeyEnv:\\s*([A-Za-z0-9_]+)'))
    if (m !== null) {
      key = m[2]!
      source = 'provider "' + provider + '" 段内的 apiKeyEnv'
    }
  }
  if (key === '') {
    const any = patchYml.match(/apiKeyEnv:\s*([A-Za-z0-9_]+)/)
    if (any !== null) {
      key = any[1]!
      source = '回退：文件里第一个 apiKeyEnv（未能定位 provider 段）'
    }
  }
  if (key === '') {
    key = 'COMMAND_API_KEY'
    source = '回退：硬编码缺省（profile 未声明 apiKeyEnv）'
  }
  return { provider, keyNames: [key], source }
}

/** 从成员 AGENTS.md 抽身份。读不到返回空串——身份缺失不是错误，只是没读到。 */
export function parseIdentity(agentsMd: string): { name: string; duty: string } {
  const h = agentsMd.match(/^#\s+(.+?)\s*[—–·-]\s*爱丽丝庄园成员/mu)
  let nm = h === null ? '' : h[1]!.trim()
  if (nm === '') {
    const h2 = agentsMd.match(/^#\s+(\S+?)\s*[（(]/mu)
    if (h2 !== null) nm = h2[1]!.trim()
  }
  const d = agentsMd.match(/负责\*{0,2}([^*，。\n（(]{1,24})/u)
  return { name: nm, duty: d === null ? '' : d[1]!.trim() }
}

/** 心跳新鲜度（单一判据；严格多源核验请用 `manor_roster`）。 */
export function judgeFresh(atMs: number, nowMs: number, freshMs: number): { online: boolean; ageMs: number } {
  if (!Number.isFinite(atMs) || atMs <= 0) return { online: false, ageMs: -1 }
  const ageMs = nowMs - atMs
  if (ageMs < 0) return { online: false, ageMs: -1 }
  return { online: ageMs < freshMs, ageMs }
}

// 信封契约是**单一真源**（`src/envelope.ts`）：两条产出路（`manor_dispatch` 直接投递 /
// hold 释放投递）共用同一份构造 —— 各写一份必然分叉（契约漂移的经典形状）。
// 这里转出以保持既有 import 面（`tests/pure.test.ts` 从本文件取）。
// ⚠ 用 `export … from`（**不建立本地绑定**）—— 本地那两个名字来自上面的 `import`，
//   写成 `export { … }` + 另一条 `import` 会撞「重复标识符」。
export { buildEnvelope, holdEnvelopeId, newMsgId, parseRecipients } from './envelope.ts'

// ───────────────────────────────── 壳层（IO） ─────────────────────────────────

interface FindArgs {
  busDir?: string
  detail?: boolean
  onlyOnline?: boolean
}

interface DispatchArgs {
  to?: string
  text?: string
  taskId?: string
  acceptance?: string
  /**
   * 任务**性质**：`owner`（主人交办）| `internal`（庄园内部建设）| `probe`（探针/仪器验收）。
   * 唯一用途 = **这条活的失败要不要打扰主人**。**不声明 ⇒ `owner`（取严）**。
   */
  nature?: string
  /** `R17'`：证据指针（`path:line`）。宽容输入（串或数组）—— 代码用 `Array.isArray` 收窄，给串即当空 */
  refs?: string[] | string
  cwd?: string
  kind?: string
  ttlMs?: number
  priority?: string
  dependsOn?: string[] | string
  holdTimeoutMs?: number
  /**
   * 超时预算（2026-10-14 · 主人「解决硬顶参数化的问题」）：
   * **按任务声明这条活需要多久** —— 此前派活方无法表达它，长活只能撞节点缺省硬顶
   * （maid-05 那条扫 19 仓的活即此：成果全部产出、判据却报失败）。
   * 拒发/警告判据在 `timeout.ts`；执行侧 clamp 与留痕在 `adapter.mjs` + `timeouts.mjs`。
   */
  idleMs?: number
  hardCapMs?: number
  /**
   * ★ **接力起点**（2026-10-17 · 论文迁移）：当前最优产物 + 判据 + 分数 + **未解决的需求**。
   * 参数面**平铺四格**、execute 里组装成 `meta.best` —— 照抄 `timeout` 的成熟形态（零嵌套 schema 风险）。
   * ⚠ 与 `refs` **不是一回事**：`refs` 是过去的锚（结论凭什么），这几格是**未来的起点**（现在做到哪了）。
   * ★ 第四格 `bestNeed` 来自**第二次迁移**（arXiv:2610.20431 *SwarmRSI*）：它是 rebase 的匹配键
   *   —— 只有知道「我还缺什么」，才可能找到「谁那里有」。
   */
  bestAt?: string
  bestJudge?: string
  bestScore?: string
  bestNeed?: string
  dryRun?: boolean
}

interface WakeArgs {
  id?: string
  dryRun?: boolean
}

interface HoldsArgs {
  busDir?: string
  escalatedOnly?: boolean
  sweep?: boolean
  maxRows?: number
}

/** ③ 竞争面：独占领取（E12）。 */
interface ClaimArgs {
  taskId?: string
  holder?: string
  busDir?: string
  ttlMs?: number
}

/** ③ 竞争面：自愿释放（E12）。 */
interface ReleaseArgs {
  taskId?: string
  holder?: string
  busDir?: string
}

/** 名册里的一行（形状即 `manor_find` 的 `output.schema`，由 dsh-tools 严格校验）。 */
export interface MemberRow {
  id: string
  name: string
  duty: string
  online: boolean
  heartbeatAgeMs: number
  pid: number
  harness: string
  workdir: string
  profile: string
  provider: string
  keyNames: string
  keySource: string
  startCmd: string
  canWake: boolean
  inboxPending: number
  inboxDead: number
  /** 会被适配器取走的件数（kind 在 `MANOR_KINDS` 里） */
  inboxClaimable: number
  /** **不会被取**的件数（其余 kind）—— 这才是需要人裁决的那一半 */
  inboxUnclaimed: number
  /** 无人认领件的 kind 分布（如 `result×4`） */
  inboxUnclaimedKinds: string
  /** 无人认领件里最旧的年龄（ms） */
  inboxOldestUnclaimedMs: number
  /** 无人认领件是否已超搁浅阈值 */
  inboxStale: boolean
  /** 渲染好的一行（无异常时保持旧形状 `收件箱 待 N 死 M`） */
  inboxLine: string
  /** 成员自报的启动时刻（心跳 `startedAtMs`；缺失 ⇒ 0 ⇒ 判据落 unknown 而**不是** fresh） */
  startedAtMs: number
}

export interface FindResult {
  ok: boolean
  busDir: string
  headline: string
  onlineCount: number
  total: number
  members: MemberRow[]
  errors: string[]
  rendered: string
}

export interface DispatchResult {
  ok: boolean
  dryRun: boolean
  envelopeId: string
  to: string
  taskId: string
  path: string
  bytes: number
  error: string
  rendered: string
}

export interface WakeResult {
  ok: boolean
  dryRun: boolean
  id: string
  cmd: string
  logPath: string
  keyNames: string
  error: string
  rendered: string
}

const str = (v: unknown, d: string): string => (typeof v === 'string' && v !== '' ? v : d)
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  const cfg = {
    busDir: resolve(config.busDir),
    nodesRoot: resolve(config.nodesRoot),
    adapterPath: resolve(config.adapterPath),
    credentialsPath: resolve(config.credentialsPath),
    spawnDetachedPath: resolve(config.spawnDetachedPath),
    selfId: config.selfId,
    freshMs: config.heartbeatFreshMs,
    patrolDeadAfterMs: config.patrolDeadAfterMs,
    patrolMaxAttempts: config.patrolMaxAttempts,
    holdReleaseBatch: config.holdReleaseBatch,
    holdTimeoutMs: config.holdTimeoutMs,
    holdDeadAfterMs: config.holdDeadAfterMs,
    role: config.role,
  }

  const readTextSafe = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * `adapter.mjs` 的产物 mtime（ms）；**读不到返回 0**。
   *
   * ⚠ 返回 0 不是「没有」，是「**判不了**」——调用侧据此落 `unknown`，
   *   **不得**落 fresh（否则读不到的成员会被渲染成「已含新代码」，即静默放行）。
   * 判据与守卫见 `src/adapter-staleness.ts` 头注。
   */
  const adapterMtimeMs = (): number => {
    try {
      return statSync(cfg.adapterPath).mtimeMs
    } catch {
      return 0
    }
  }

  /** 读一个成员的调度视图事实（身份 / 启动推导 / 收件箱）。 */
  const collectOne = (bus: string, id: string, rec: Record<string, unknown>, nowMs: number): MemberRow => {
    const workdir = str(rec['workdir'], join(cfg.nodesRoot, id))
    const profile = str(rec['profile'], id)
    const agText = readTextSafe(join(workdir, 'AGENTS.md'))
    const ident = agText === null ? { name: '', duty: '' } : parseIdentity(agText)
    const patch = readTextSafe(join(workdir, '.dsh', 'profiles', profile, 'cordis.patch.yml'))
    const derived = patch === null
      ? { provider: '', keyNames: ['COMMAND_API_KEY'], source: 'profile 不可读 ⇒ 用缺省键名' }
      : keyNamesFor(patch)
    const harness = str(rec['harness'], '')
    const isAdapter = harness === MANOR_ADAPTER_HARNESS
    const launchArgs = isAdapter
      ? [cfg.adapterPath, '--id', id, '--profile', profile, '--workdir', workdir, '--dsHome', join(workdir, '.dsh'), '--credentials', cfg.credentialsPath, '--keyNames', derived.keyNames.join(',')]
      : []
    const startCmd = isAdapter ? ['node', ...launchArgs].join(' ') : ''
    let pending = 0
    let dead = 0
    const inbox = join(bus, 'mailbox', id)
    // 2026-10-12：从「数个数」升级为「分类」——旧读数「待 4」回答不了**为什么它没被取**，
    //   而对 `kind:"result"` 的信封答案是「它永远不会被取」（适配器只认 task/chat，总线上又没有
    //   别的消费者）。⇒ 真因不是「消费侧没保活」，是**没有消费者**。分类判据在 src/inbox.ts。
    const items: InboxItem[] = []
    try {
      for (const n of readdirSync(inbox)) {
        if (!n.endsWith('.json')) continue
        let raw: unknown = null
        try {
          raw = JSON.parse(readFileSync(join(inbox, n), 'utf8'))
        } catch {
          raw = null // 坏文件仍要计数（它占着位置），但 kind/时间取不到 ⇒ 归无人认领
        }
        const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        items.push({ kind: o['kind'], createdAt: o['createdAt'] })
      }
    } catch {
      // 信箱不存在 ⇒ 空箱（与「读不到」的区别由调用方的 errors 通道负责）
    }
    const inboxSummary = summarizeInbox(items, nowMs, DEFAULT_STALE_AFTER_MS)
    pending = inboxSummary.pending
    try {
      dead = readdirSync(join(inbox, 'dead')).filter((n) => n.endsWith('.json')).length
    } catch {
      dead = 0
    }
    const fresh = judgeFresh(typeof rec['atMs'] === 'number' ? (rec['atMs'] as number) : 0, nowMs, cfg.freshMs)
    return {
      id,
      name: ident.name,
      duty: ident.duty,
      online: fresh.online,
      heartbeatAgeMs: fresh.ageMs,
      pid: typeof rec['pid'] === 'number' ? (rec['pid'] as number) : 0,
      harness,
      workdir,
      profile,
      provider: derived.provider,
      keyNames: derived.keyNames.join(','),
      keySource: derived.source,
      startCmd,
      canWake: isAdapter && startCmd !== '',
      inboxPending: pending,
      inboxDead: dead,
      inboxClaimable: inboxSummary.claimable,
      inboxUnclaimed: inboxSummary.unclaimed,
      inboxUnclaimedKinds: Object.entries(inboxSummary.unclaimedKinds)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => k + '×' + String(n))
        .join(' '),
      inboxOldestUnclaimedMs: inboxSummary.oldestUnclaimedAgeMs,
      inboxStale: inboxSummary.stale,
      inboxLine: renderInbox(inboxSummary, dead),
      // 成员自报的启动时刻：**心跳里早就有**（`adapter.mjs:622`），本工具此前没读它。
      startedAtMs: num(rec['startedAtMs'], 0),
    }
  }

  const findTool: ToolDefinition = defineTool({
    name: 'manor_find',
    description:
      '庄园调度名册：一眼看清**谁在、她是谁（名字与职责）、该怎么起她**。'
      + '与 `manor_roster` 的分工：后者做**多源核验的存活判定**（atMs/mtime/pid 三源 + 分歧），本工具做**调度视图**'
      + '——成员身份（从她的 AGENTS.md 读）、**启动命令（从她的 profile 推导凭据键，不靠人抄文档）**、收件箱积压。'
      + '★ 收件箱按**能不能被取走**分类（2026-10-12）：`可处理`（kind 在适配器的 `MANOR_KINDS` 里 ⇒ 下一轮轮询就取走）'
      + '与 `无人认领`（其余 kind ⇒ **不会被取**，除非改归属）。分开报的理由：旧读数「待 4」回答不了**为什么它没被取**'
      + '——实测那 4 条全是 `result`（**她那一侧**最旧 31 小时），真因不是「消费侧没保活」，是**总线上没有消费者**。'
      + '⚠ **口径域（2026-10-12 由勘全域扫描指出）**：本节只覆盖**庄园名册成员**的信箱——**总线全域**另有一批本工具不覆盖'
      + '（实测无人认领 10 条 = result 7 · event 3，最旧是 `sim-node-a` 的 **653.7 小时 / 27 天**）。'
      + '且 `可处理` 只承诺「**会被认领**」，**不承诺「会被读到」**（`done/` ≠ 读过）。'
      + '⚠ 启动命令由 profile 推导的原因：2026-10-09 实测，按人类文档传错了凭据键 ⇒ 成员 2 秒 exit=1 且 stderr 为空。'
      + '只读、零副作用、不起子进程。名册读不到时响亮报错（「空」与「读不到」是两件事）。',
    parameters: {
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      onlyOnline: { type: 'boolean', description: '只看在线成员（缺省 false）' },
      detail: { type: 'boolean', description: '附带长字段（workdir/profile/keySource/startCmd 全量，缺省 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          busDir: { type: 'string', required: true },
          headline: { type: 'string', required: true },
          onlineCount: { type: 'number', required: true },
          total: { type: 'number', required: true },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                duty: { type: 'string', required: true },
                online: { type: 'boolean', required: true },
                heartbeatAgeMs: { type: 'number', required: true },
                pid: { type: 'number', required: true },
                harness: { type: 'string', required: true },
                workdir: { type: 'string', required: true },
                profile: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                keyNames: { type: 'string', required: true },
                keySource: { type: 'string', required: true },
                startCmd: { type: 'string', required: true },
                canWake: { type: 'boolean', required: true },
                inboxPending: { type: 'number', required: true },
                inboxDead: { type: 'number', required: true },
                inboxClaimable: { type: 'number', required: true },
                inboxUnclaimed: { type: 'number', required: true },
                inboxUnclaimedKinds: { type: 'string', required: true },
                inboxOldestUnclaimedMs: { type: 'number', required: true },
                inboxStale: { type: 'boolean', required: true },
                inboxLine: { type: 'string', required: true },
                /** 成员自报的启动时刻（心跳 `startedAtMs`；缺 ⇒ 0 ⇒ 判据落 unknown） */
                startedAtMs: { type: 'number', required: true },
              },
            },
          },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          /** ③ 依赖面：**暂不可发起**的条数（读得到但还不会跑的活）—— 第三格，与「可处理/无人认领」都不同 */
          holdCount: { type: 'number', required: true },
          /** 其中需要人裁决的（依赖不可能 / 属主已死 / 超时） */
          holdEscalated: { type: 'number', required: true },
          /** 常读面上留的那一行（0 条时为空串 —— 一个字都不加） */
          holdLine: { type: 'string', required: true },
          /** ④ 争议面：已登记但**还没有任何判词**的条数（等**当事人**） */
          disputeOpen: { type: 'number', required: true },
          /** 其中**升级待人裁**的（函数给过答案了：「我无权裁」—— 这些等**人**给判词） */
          disputeEscalated: { type: 'number', required: true },
          /** 争议面那一行（两个数都是 0 时为空串 —— 一个字都不加） */
          disputeLine: { type: 'string', required: true },
          /** ⑤ 适配器新鲜度：**跑旧代码**的成员数（`adapter.mjs` 改完但成员没重启） */
          staleAdapters: { type: 'number', required: true },
          /** 其中判不了的（心跳缺 `startedAtMs` ⇒ **不是** fresh，如实分开报） */
          staleUnknown: { type: 'number', required: true },
          /** 适配器新鲜度那一行（全 fresh 时为空串） */
          staleLine: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: FindArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const nodesDir = join(bus, 'nodes')
      let files: string[] = []
      try {
        files = readdirSync(nodesDir).filter((f) => f.endsWith('.json'))
      } catch (e) {
        const msg = '总线名册读不到（config.busDir 可能不对）：' + bus + ' · ' + String(e)
        return {
          ok: false, busDir: bus, headline: msg, onlineCount: 0, total: 0, members: [], errors: [msg],
          holdCount: 0, holdEscalated: 0, holdLine: '',
          disputeOpen: 0, disputeEscalated: 0, disputeLine: '',
          staleAdapters: 0, staleUnknown: 0, staleLine: '',
          rendered: '✖ ' + msg,
        }
      }
      const nowMs = Date.now()
      // ⚠ 内部用宽松类型：`dsh-tools` 会从 `output.schema` **推断** execute 的返回类型并在
      //   运行时严格校验（缺字段即拒）。此处若把形状写死，配置/未来的字段增减都要同步两处
      //   ⇒ 边界由 schema 承担，内部保持宽松（`any` 的显式使用理由见 §5.30 的边界白名单）。
      const members: any[] = []
      const errors: string[] = []
      for (const f of files) {
        const id = f.replace(/\.json$/, '')
        let rec: Record<string, unknown> = {}
        try {
          rec = JSON.parse(readFileSync(join(nodesDir, f), 'utf8')) as Record<string, unknown>
        } catch (e) {
          errors.push(id + '：名册条目解析失败（' + String(e) + '）')
          continue
        }
        try {
          members.push(collectOne(bus, id, rec, nowMs))
        } catch (e) {
          errors.push(id + '：收集失败（' + String(e) + '）')
        }
      }
      const onlyOnline = args.onlyOnline === true
      const shown = onlyOnline ? members.filter((m) => m['online'] === true) : members
      shown.sort((a, b) => {
        const ao = a['online'] === true
        const bo = b['online'] === true
        if (ao !== bo) return ao ? -1 : 1
        return String(a['id']).localeCompare(String(b['id']))
      })
      const onlineCount = members.filter((m) => m['online'] === true).length
      const lines: string[] = []
      lines.push('庄园调度名册｜共 ' + String(members.length) + ' · 在线 ' + String(onlineCount) + '｜总线 ' + bus)
      for (const m of shown) {
        const ago = typeof m['heartbeatAgeMs'] === 'number' && (m['heartbeatAgeMs'] as number) >= 0
          ? (Math.round((m['heartbeatAgeMs'] as number) / 1000) + 's 前')
          : '从未'
        const who = str(m['name'], '') !== '' ? String(m['name']) : '(未读到名字)'
        const duty = str(m['duty'], '') !== '' ? ' · ' + String(m['duty']) : ''
        lines.push(
          (m['online'] === true ? '  ✓ ' : '  ⚠ ') + String(m['id']) + '  ' + who + duty
          + '  ｜心跳 ' + ago + ' · pid ' + String(m['pid'])
          + '｜' + String(m['inboxLine'])
        )
        if (m['canWake'] === true) lines.push('      起：' + String(m['startCmd']))
      }
      // ③ 依赖面：**每轮都在**的那一行（哨四件的第四件）——它是入口，细节归 manor_holds。
      // ⚠ 与「可处理 / 无人认领」是**第三格**：那两类是**没人拿**，这一类是**还没轮到**。
      const hv = holdView(bus, nowMs)
      for (const n of hv.notes) errors.push(n)   // 读不到在线面等缺口，走既有的 errors 通道，不静默
      // ④ 争议面（`R16'`）：**两个数分开** —— `未裁` 等**当事人**，`升级待人裁` 等**人**；
      //   合成一个数就等于替读的人决定「要不要管」。两个数都是 0 ⇒ 一个字都不加。
      const dv = loadDisputes(bus)
      for (const b of dv.bad) errors.push('争议读盘：' + b)   // 坏记录**不静默丢**（它本身是证据）
      let dOpen = 0
      let dEsc = 0
      for (const b of dv.list) {
        if (b.verdict === null) dOpen += 1
        else if (b.verdict.outcome === 'escalated') dEsc += 1
      }
      if (errors.length > 0) lines.push('⚠ ' + String(errors.length) + ' 条读盘错误：' + errors.join(' ｜ '))
      const holdLine = renderHoldLine(hv.entries.length, hv.entries.filter((e) => e.hold.escalated !== '').length)
      if (holdLine !== '') lines.push(holdLine)
      const disputeLine = renderDisputeLine({ open: dOpen, escalated: dEsc })
      if (disputeLine !== '') lines.push(disputeLine)
      // ⑤ 适配器新鲜度（2026-10-14 补）：**成员跑的是哪个构建**。
      //   `adapter.mjs` 是独立长驻进程 ⇒ **重启 web 不重启它们**（§5.11 规则 7 的成员侧同构）。
      //   数据早就在心跳里自报（`adapter.mjs:622` 的 `startedAtMs`）——缺的只是这一行读数。
      //   判据见 `src/adapter-staleness.ts`；全 fresh ⇒ 空串（常读面只在有异常时出声）。
      let staleLine = ''
      let staleCount = 0
      let staleUnknown = 0
      const mtimeMs = adapterMtimeMs()
      if (mtimeMs > 0) {
        // ⚠ 口径：**只判成员适配器**（`harness === MANOR_ADAPTER_HARNESS`）。
        //   首版把全体总线节点塞进同一个桶，于是主脑 `web-0` 恒报「判不了」——
        //   它**根本不是适配器**（不该有这一格）。那行是**永久的噪音**，会把真异常淹掉
        //   （同 `inbox.ts` 的口径纪律：域窄一格，读数才有意义）。
        const sv = summarizeStaleAdapters(
          members
            .filter((m) => m['harness'] === MANOR_ADAPTER_HARNESS)
            .map((m) => ({ id: String(m['id']), startedAtMs: num(m['startedAtMs'], 0) })),
          mtimeMs,
        )
        staleLine = sv.line
        staleCount = sv.staleIds.length
        staleUnknown = sv.unknownIds.length
        if (staleLine !== '') lines.push(staleLine)
      }
      // 指路文案**按角色分档**：成员档不得推荐她调不到的工具（`guideLine` 单一真源）。
      lines.push(guideLine(config.role))
      return {
        ok: true,
        busDir: bus,
        headline: '共 ' + String(members.length) + ' 成员 · 在线 ' + String(onlineCount),
        onlineCount,
        total: members.length,
        members: shown,
        errors,
        holdCount: hv.entries.length,
        holdEscalated: hv.entries.filter((e) => e.hold.escalated !== '').length,
        holdLine,
        disputeOpen: dOpen,
        disputeEscalated: dEsc,
        disputeLine,
        staleAdapters: staleCount,
        staleUnknown,
        staleLine,
        rendered: lines.join('\n'),
      }
    },
  })

  const dispatchTool: ToolDefinition = defineTool({
    name: 'manor_dispatch',
    description:
      '给庄园成员派活：生成**合规的庄园信封**并写入她的收件箱。'
      + '与 `cluster_send` 的分工：后者写的是通用集群信封（**无 `meta` 字段**），而庄园适配器要求 `meta.taskId`'
      + '——2026-10-09 实测，缺它会被成员**正确拒收**（「任务缺少 meta.taskId」）。'
      + '本工具自动补齐 `meta.taskId / acceptance / cwd`，`taskId` 缺省自动生成。'
      + '写入用 no-clobber（`wx`）——撞 id 即失败，绝不静默覆盖别人的消息。'
      + '`dryRun=true` 只回信封内容不落盘。',
    parameters: {
      to: { type: 'string', description: '目标成员 id（见 manor_find）。**逗号分隔 = 多播**：同一个 taskId 投给多人，每人各得一个信封 id（用于「独立型／读取型」的活——重复成本 < 协调成本，两份独立结论还能互相校对）。', required: true },
      text: { type: 'string', description: '任务正文', required: true },
      taskId: { type: 'string', description: '任务号（缺省自动生成 t-<to>-<ts>）' },
      acceptance: { type: 'string', description: '验收判据（强烈建议写——**它现在会真的进成员的 prompt**：适配器把它拼成一个块放在正文之前，契约见 R12\'）' },
      nature: {
        type: 'string',
        description: '任务**性质**：`owner`（主人交办）| `internal`（庄园内部建设）| `probe`（探针/仪器验收）。'
          + '唯一用途 = **这条活的失败要不要推给主人**：`owner` 推，另两者只进台账与工具输出（**不推**）。'
          + '⚠ **不声明 ⇒ 按 `owner` 取严**（漏报主人的活比多报噪音更坏）⇒ **要降噪就得显式声明**。'
          + '写闭集外的值会被**拒发**（不静默回落 —— 回落会让「我声明了」与「我没声明」变成一个读数）。',
      },
      refs: { type: 'array', items: { type: 'string' }, description: '证据指针 `path:line`（可选）。**提成信封一等字段** ⇒ 成员即使上下文被压缩，也能现读复算你引的那一句（R17\'）。⚠ 校验在**派活侧**做（他能读到）；收件人在另一个工作根 ⇒ **不等于她读得到**' },
      /**
       * ★ **接力起点**（2026-10-17 · 论文迁移 arXiv:2610.20563 *Scaling Discovery Requires Forgetting*）。
       *
       * 参数面**平铺三格**、execute 里组装成 `meta.best` —— 照抄 `timeout`（`idleMs`/`hardCapMs`）
       * 的成熟形态：**零嵌套 schema 风险**，且每格在工具面自带名字（比一个 object 好填）。
       */
      bestAt: {
        type: 'string',
        description: '★ **当前最优产物**的指针（`path:line` 或路径）。**接力型任务应当给**：'
          + '上一个做到哪了。⚠ 与 `refs` **不是一回事** —— `refs` 答「结论凭什么」（过去的锚），'
          + '本字段答「现在做到哪了」（**未来的起点**）。'
          + '论文实测：遗忘之所以解锁平台期，正因为重启时**只带最优解**、丢弃尝试史；'
          + '而只带 `refs` 的接力者会**知道证据在哪、却不知道当前最好的是什么** ⇒ 从零试错一遍。'
          + '⚠ 三格全空 ⇒ `meta` 里**没有** `best` 键（空不写）；只给 `bestJudge`/`bestScore` '
          + '而**不给 `bestAt`** ⇒ 整条丢弃（没有「在哪」就没有起点，fail-closed）。',
      },
      bestJudge: {
        type: 'string',
        description: '凭什么说它是当前最优（判据 / 分数口径 / 验收状态）。可选，非空才写。',
      },
      bestScore: {
        type: 'string',
        description: '分数或评级（短标签，≤64 字符，如 `3/3 测试绿` / `评 B+`）。可选，非空才写。',
      },
      bestNeed: {
        type: 'string',
        description: '★ **未解决的实现需求** —— 「还缺什么才能让它成立」（可选，非空才写）。'
          + '**这是 rebase 的匹配键**：论文里「复用别人的程序底座」靠的正是'
          + '「把未解决的需求匹配到程序机制」—— **只有知道「我还缺什么」，才可能找到「谁那里有」**。'
          + '⚠ 缺这一格时，接力者只能**从零试错**（不知道要找什么样的底座）。'
          + '它也决定「下一步该做哪个前沿」（论文的 ψ_f：未解决需求的饱和压力）。',
      },
      cwd: { type: 'string', description: '成员执行时的工作目录（缺省 "."）' },
      kind: { type: 'string', description: 'task | chat（缺省 task）' },
      ttlMs: { type: 'number', description: '存活期 ms（缺省 86400000）' },
      /** ⑥ 超时预算（2026-10-14 · 主人「解决硬顶参数化的问题」）—— 此前派活方**无法表达「这条活需要多久」** */
      idleMs: {
        type: 'number',
        description: '**多久无进展算卡住**（ms，缺省随成员节点的 `--idleTimeoutMs`，通常 180000 = 3 分钟）。'
          + '信号 = **会话落盘 mtime**（不是 stdout）⇒ 正常推进的活不会被它杀；'
          + '但「跑一条 10 分钟的长命令」这类**长时间不落盘**的活需要调大它。'
          + '低于 10000 会被**拒发**（如此短的预算下任务必然被杀 = 白派一次活）。',
      },
      hardCapMs: {
        type: 'number',
        description: '**总时长硬顶**（ms，缺省随成员节点的 `--hardCapMs`，通常 1800000 = 30 分钟）。'
          + '⚠ **长活必须显式声明它** —— 实测（2026-10-14）：一条扫 19 个仓库的活成果**全部产出**，'
          + '却撞上缺省的 30 分钟硬顶被杀（台账判 failed 且 evidence 空 ⇒ 判据与事实相反）。'
          + '超过适配器缺省上界（7200000 = 2 小时）会被 **clamp 到上界并留痕**（活照跑，只是跑短些）；'
          + '要真的跑更久，需在成员节点侧抬 `--maxHardCapMs`。',
      },
      /** ③ 依赖面（2026-10-12 · E11） */
      priority: { type: 'string', description: 'high | normal | low（缺省 normal）。**有机制效果**：同一轮可释放数超上限时先走高优先级' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的 taskId 列表：**全部完成前这条活不会被投递**（进 hold/，由常驻方释放）。依赖必须已存在（账本/信箱/hold 之一），否则拒绝——防静默死锁' },
      holdTimeoutMs: { type: 'number', description: '等多久算超时（缺省配置值，6 小时）。**超时是升级成人看，不是自动放行**' },
      dryRun: { type: 'boolean', description: '只回信封不落盘（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          envelopeId: { type: 'string', required: true },
          to: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          /** **真的投出去了吗** —— `ok` 只表示「这条指令没出错」，`delivered` 才表示「活到了她手上」 */
          delivered: { type: 'boolean', required: true },
          /** 因依赖未满足而**挂起**（落进 `hold/`，等常驻方释放） */
          held: { type: 'boolean', required: true },
          holdPath: { type: 'string', required: true },
          /** 等谁（taskId，逗号分隔）；空串 = 没依赖 */
          waitingOn: { type: 'string', required: true },
          holdReason: { type: 'string', required: true },
          noConsumerIds: { type: 'string', required: true },
          invisibleTools: { type: 'string', required: true },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: DispatchArgs) {
      const toRaw = str(args.to, '').trim()
      // ★ 多播（2026-10-12 · E12 的真前置）：`to` 允许逗号分隔 ⇒ **同一个 taskId 投给多人**。
      //   为什么这是前置而不是「顺便支持一下」：澄的判据「**独立型 ⇒ 各做各的** /
      //   **独占型 ⇒ 先举手**」两者都要求「**一件活能被多人看见**」；而此前 `to` 只能是一个成员
      //   ⇒ 活**天然独占**（直接进一人信箱）⇒ `claim` **没有对象可领**，那套竞争面是空的。
      //   ⚠ **记录形态刻意不变**：`to` 仍是字符串（逗号连接）⇒ hold / trace / ledger / find
      //     的既有形状一个字都不用改；多播在台账上的**可见性**留到下一步（否则那一档恒空）。
      const recips = parseRecipients(toRaw)
      const to = recips.join(',')
      const text = str(args.text, '')
      const nowMs = Date.now()
      const dryRun = args.dryRun === true
      /** 失败/挂起/成功三个出口共用同一形状 —— `dsh-tools` 按 schema 严格校验，缺字段即拒。 */
      const shape = (over: Record<string, unknown>): any => ({
        ok: false, dryRun, envelopeId: '', to, taskId: '', path: '', bytes: 0,
        delivered: false, held: false, holdPath: '', waitingOn: '', holdReason: '',
        noConsumerIds: '', invisibleTools: '', error: '', rendered: '', ...over,
      })
      const fail = (m: string): any => shape({ error: m, rendered: '✖ ' + m })
      if (to === '') return fail('to 必填（目标成员 id，见 manor_find）')
      if (text.trim() === '') return fail('text 必填（任务正文不能为空——空任务只会浪费成员的唤醒）')
      // ★ taskId 不得含**分隔符字符**（见 `autoTaskId` 的长注释）：显式传入的同样要拦。
      const taskId = str(args.taskId, autoTaskId(to, nowMs))
      if (taskId.includes(',')) {
        return fail('taskId 不得含逗号：`' + taskId + '` —— 逗号在依赖面是**分隔符**'
          + '（`dependsOn` 用逗号存多值）⇒ 含逗号的 id 被当作依赖时会被拆成多个不存在的 id。'
          + '多播请让 taskId 自动生成（会把逗号换成 `+`），或改用其它非分隔符字符。')
      }
      // 优先级：未知值 **fail-loud**（静默降级就是「静默改行为」）
      const pri = parsePriority(args.priority)
      if (pri.error !== '') return fail(pri.error)
      const deps = parseDependsOn(args.dependsOn)
      if (deps.errors.length > 0) return fail('dependsOn 有问题：' + deps.errors.join('；'))
      const kind = str(args.kind, 'task')
      const acceptance = str(args.acceptance, '')
      // ★ `nature`（2026-10-12 · 主人问「怎么发了一堆任务失败」）：**派活侧声明任务性质**，
      //   它唯一影响「这条活的失败要不要打扰主人」（分流在 `task-watch.ts` 的 W6）。
      //   ⚠ **缺省 `owner`（取严）**：漏报主人的活比多报噪音更坏 ⇒ 要降噪就**显式**声明 internal / probe。
      //   ⚠ 写错的值**响亮拒发**，不静默回落 —— 回落会让「我声明了」与「我没声明」变成一个读数。
      const natureRaw = str(args.nature, '')
      if (natureRaw !== '' && !isTaskNature(natureRaw)) {
        return fail('nature 必须是闭集里的一个：' + TASK_NATURES.join(' | ') + '（收到 `' + natureRaw + '`）。'
          + '释义：`owner` = 主人交办的活（**会推给他**）· `internal` = 庄园内部建设 · `probe` = 探针/仪器验收'
          + '（后两者**只进读数、不进推送**）。不声明 ⇒ 按 `owner` 取严（漏报主人的活比多报噪音更坏）。')
      }
      // ★ 超时预算（2026-10-14 · 主人「解决硬顶参数化的问题」）：**派活侧拒发**判据（fail-loud）。
      //   为什么这一侧也要拦：执行侧的 clamp 是**防御性**的（信封可能被手写、或由别的实现产出），
      //   而派活方在**这里**当场拿到反馈才是最省的（同 `cwd` 越界的处置分工：
      //   派活侧拒发 / 执行侧降级标注 —— 两侧各守一道，判据不重复也不留空档）。
      //   ⚠ **超上界只警告不拒发** —— 判据与理由见 `timeout.ts` 头注「拒发 vs 警告」。
      const tv = validateTimeoutSpec({ idleMs: args.idleMs, hardCapMs: args.hardCapMs })
      if (tv.errors.length > 0) return fail('超时预算有问题：' + tv.errors.join('；'))
      const timeoutSpec = tv.spec
      const timeoutWarns = tv.warnings
      // ★ `R17'`：证据指针。**非空才写进 meta**（空数组等于没写），并在**派活侧先校验一遍** ——
      //   写坏的 ref 比不写更坏：它让收件人以为「有据可查」，而实际打不开。
      //   ⚠ **诚实边界（域）**：这里 `existsSync` 验的是「**我能读到**」；
      //     收件人住在另一个工作根 ⇒ **我看到 ≠ 她读得到**。
      //     ⇒ 读侧（成员）仍要自己开一次那条路径（`R10'`：「指针必须自己打开验」）。
      //   ⚠ 校验失败**响亮拒发**，不静默丢弃（`checkRefs` 已把「空」与「写坏」分开报）。
      const refsRaw = Array.isArray(args.refs) ? args.refs.map((x) => String(x)) : []
      if (refsRaw.length > 0) {
        const rc = checkRefs(refsRaw, { exists: (p) => existsSync(p) })
        if (!rc.ok) return fail('refs 有问题：' + rc.bad.join('；'))
      }
      // ★ 接力起点（2026-10-17 · 论文迁移 arXiv:2610.20563）：参数面平铺三格 ⇒ 组装成一个对象，
      //   归一交给 `normalizeBest`（`at` 缺失/为空 ⇒ **整条不写**，fail-closed —— 不写半截）。
      //   ⚠ 与 `refs` **不是一回事**：`refs` 是过去的锚（结论凭什么），本字段是未来的起点
      //     （现在做到哪了）—— 论文的 forgetting 重启时**只带后者**。
      //   ⚠ 这里**不校验 `at` 指向的路径存在**（与 `refs` 相反）：接力起点可能指向**另一个工作根**
      //     里的产物，或一条还没落盘的路径 —— 派活侧断言不了，硬校验会拒掉合法的接力。
      const bestRaw = {
        at: str(args.bestAt, ''),
        judge: str(args.bestJudge, ''),
        score: str(args.bestScore, ''),
        // ★ 第四格（2026-10-17 第二次迁移 · arXiv:2610.20431 *SwarmRSI*）：**未解决的需求**。
        //   论文里 rebase（保留假设、把实现适配到别人的程序底座）的匹配键正是它 ——
        //   **没有「我还缺什么」，复用就无从发生**（不知道要找什么样的底座）。
        need: str(args.bestNeed, ''),
      }
      // 读名册里某收件人的工作根（**读不到返回空串** ⇒ 不替她断言越界）。
      // 与 `manor_wake` 取 workdir 的规则同源：`nodes/<id>.json` 的 `workdir` 字段。
      const workdirOfMember = (id: string): string => {
        const t = readTextSafe(join(cfg.busDir, 'nodes', id + '.json'))
        if (t === null) return ''
        try {
          const rec = JSON.parse(t) as Record<string, unknown>
          return str(rec['workdir'], '')
        } catch {
          return ''
        }
      }

      const cwd = str(args.cwd, '.')
      // ── cwd 与收件人的工作根（2026-10-12 · 四封回执共同报出的缺口）─────────────
      // 多播时**一个 cwd 要同时对 N 个不同工作根成立**，而它几乎不可能成立：
      // 实测我给了 `E:/alice-nodes`，四个成员（工作根 `E:\alice-nodes\maid-0N`）**全部越界**
      // —— 每个适配器各自正确拒了并降级，于是**四个人各自抱怨一次，派活侧一无所知**。
      // ⇒ 诊断前移到**唯一握有全局**的那一侧（澄：「位置 → 派活侧」）。
      // ★ 取严（拒发）的理由是代价不对称：放行的代价是**收件人在别人的工作根里干活**——
      //   现在靠每个适配器自觉拦，而**别的实现可以不拦**。
      if (cwd !== '' && cwd !== '.') {
        const offenders: string[] = []
        for (const r of parseRecipients(to)) {
          const wd = workdirOfMember(r)
          if (!cwdInsideWorkdir(cwd, wd)) offenders.push(r + '（工作根 ' + wd + '）')
        }
        if (offenders.length > 0) {
          return fail('cwd 越界，拒绝派发：`' + cwd + '` 不落在以下收件人的工作根内 —— '
            + offenders.join('、')
            + '。多播请给 `.`（随各人工作根），或逐个单播指定各自的 cwd。')
        }
      }
      const ttlMs = num(args.ttlMs, 86400000)

      // ── ③ 依赖面：检查在**派活侧**（唯一握有全局的地方）────────────────
      if (deps.list.length > 0) {
        // 成环检测：图 = 现有 hold 的边 ∪ 本次这条。**必须 fail-loud**（不能静默死锁）。
        const edges = new Map<string, string[]>()
        for (const h of loadHolds(cfg.busDir).records) edges.set(h.taskId, h.dependsOn)
        edges.set(taskId, deps.list)
        const cyc = findCycle(edges)
        if (cyc !== null) {
          const self = cyc.length === 2 && cyc[0] === cyc[1]
          return fail('依赖成环，拒绝派发（fail-loud，不能静默死锁）：' + cyc.join(' → ')
            + (self ? '（这条活依赖它自己）' : ''))
        }
        const { world } = buildWorldViewOf(holdInputOf(cfg.busDir, nowMs))
        const depViews = resolveDeps(deps.list, world)
        const missing = depViews.filter((d) => d.state === 'missing')
        if (missing.length > 0) {
          return fail('依赖 ' + missing.map((d) => d.taskId).join('、')
            + ' 在账本/信箱/hold 三处都找不到 —— 要么 taskId 写错，要么那条活**还没派出去**。'
            + '依赖必须先存在（否则这条活会安静地等一个永远不会来的东西）。')
        }
        if (!depViews.every((d) => d.state === 'done')) {
          // **不投递 ⇒ 必须落账**（澄：否则它就从世界上消失了）
          //
          // ★ 2026-10-12 两位成员独立复核后改的两件事（照收）：
          //   ① `why`（含 `stateLabel(d.state)` 的散文）**不再进记录** —— 那是依赖状态的快照，
          //      逐字违反头注②，而且当时没人发现是因为**夹具即世界**（拼装住在闭包里，测试碰不到）。
          //      ⇒ 记录里只放**原因码**（闭集）；散文解释进 **trace 的 `hold-created` 事件**
          //      （**事件流是历史，记录是状态**）。
          //   ② 记录的组装改走 **`buildHoldRecord`**（与测试同一个函数）—— 判据的作用域因此覆盖生产形态。
          const why = '依赖未完成：' + depViews
            .filter((d) => d.state !== 'done')
            .map((d) => d.taskId + '（' + stateLabel(d.state) + ' · 属主 ' + (d.owner === '' ? '未知' : d.owner) + '）')
            .join('、')
          const holdPath = join(holdDirOf(cfg.busDir), taskId + '.json')
          if (dryRun) {
            const r = '（dryRun）**不会投递** —— 将挂进 hold：' + holdPath
              + (timeoutSpec.idleMs === undefined && timeoutSpec.hardCapMs === undefined
                ? ''
                : '\n  ⏱ 超时预算：' + renderTimeoutSpec(timeoutSpec) + '（会随活保存 ⇒ 释放时生效）')
              + '\n  等：' + deps.list.join('、')
              + '\n  当时的理由（现读）：' + why + '\n  （释放由常驻方触发；出口三条：依赖完成 / 依赖不可能 / 超时升级）'
            return shape({ ok: true, dryRun: true, taskId, held: true, holdPath, waitingOn: deps.list.join(','), holdReason: why, rendered: r })
          }
          const rec = buildHoldRecord({
            taskId, to, from: cfg.selfId, kind, text, acceptance, cwd,
            priority: pri.priority,
            dependsOn: deps.list,
            heldAtMs: nowMs,
            heldBy: cfg.selfId,
            deadlineAfterMs: num(args.holdTimeoutMs, cfg.holdTimeoutMs),
            ttlMs,
            // ★ **声明要跟着活走**（`E12` 余件 · 2026-10-12）：hold 是信封的**第二条产出路**，
            //   不在这里带上，释放时那条活就丢了这个声明 ⇒ 取严按 `owner` 推给主人。
            nature: natureRaw,
            // ★ 超时预算（2026-10-14）：**声明要跟着活走**（同 `nature` 的教训）——
            //   hold 是信封的第二条产出路，不在这里带上，释放时那条活就丢了预算声明。
            timeout: timeoutSpec,
            // ★ 接力起点（2026-10-17 · 论文迁移 arXiv:2610.20563）：**声明要跟着活走**
            //   （同 `nature` / `timeout` 的教训）—— hold 是信封的第二条产出路，
            //   不在这里带上，释放时那条活就丢了起点 ⇒ 接力者从零试错一遍。
            best: bestRaw,
            // ★ **显式声明**原因码（2026-10-12 当场抓出）：缺省是 `unknown`，
            //   而这里是**唯一真正知道原因**的那一侧 —— 不传就等于把「我知道」降级成「不知道」。
            //   织那句「闭集还没被任何一个选择点行使过」当场应验：整个系统只有这一处该行使它。
            reason: 'deps-pending',
          })
          const w = createHold(cfg.busDir, rec)
          if (w !== '') return fail(w)
          // 散文解释落在这里（事件流天然带时刻 ⇒ 它就是「当时」的语义，不需要额外标注）
          traceChange(cfg.busDir, {
            op: 'hold-created', taskId, to, deps: deps.list, priority: pri.priority,
            reasonCode: rec.reason, explainAtCreation: why,
          }, 'manor-hold.jsonl')
          const r = '⏸ **已挂起（暂不可发起）** ' + taskId + ' ｜ 派给 ' + to + ' ｜ 优先级 ' + pri.priority
            // ★ 超时预算（2026-10-14）：hold 分支在 `timeoutNote` 定义**之前**（作用域），
            //   故此处内联同一判断 —— 挂起的活**也要**让派活方看见「我的声明存下来了」。
            //   ⚠ 措辞不同是刻意的：这里还没跑，所以是「已随活保存 ⇒ 释放时生效」，不是「本次按它跑」。
            + (timeoutSpec.idleMs === undefined && timeoutSpec.hardCapMs === undefined
              ? ''
              : '\n  ⏱ 超时预算：' + renderTimeoutSpec(timeoutSpec) + '（已随活保存 ⇒ 释放时生效）')
            + '\n  等：' + deps.list.join('、') + '\n  当时的理由（现读）：' + why
            + '\n  **这条活还没有到她手上**（`delivered: false`）。释放由常驻方每轮扫描触发；'
            + '出口三条：依赖全部完成 ⇒ 投递（带一行出处）· 依赖不可能 / 属主已死 / 超时 ⇒ **升级成人看，不自动放行**。'
            + '\n  记录：' + holdPath + '（**只含指针与原因码，不含状态快照**）'
            + '\n  （看全部挂起项与「为什么还没跑」：manor_holds）'
          return shape({ ok: true, taskId, held: true, holdPath, waitingOn: deps.list.join(','), holdReason: why, rendered: r })
        }
        // 依赖已全部完成 ⇒ 正常投递（**没有「等」发生** ⇒ 不拼溯源行）
      }

      // ── 收件人有没有**消费者**（2026-10-12 · 8 件搁浅的根因）──────────────────
      // 实测：织给勘的两条 chat 落在 `LAPTOP-BF4IAPLM-maid-04-0`（勘的**第二个身份**，
      //   随重启消失）⇒ 那个箱子没有消费者 ⇒ **永久搁浅**（当天统计：4 个死箱 8 件，
      //   其中 2 件是**有实质内容的技术讨论**，收件人从未读到）。
      // ⚠ **不硬拒**：向离线但**在册**的节点投递是设计内的用法（她起来后会读到）⇒
      //   只在「这个 id 根本不在节点名册里」时说清后果 —— 那才是永久搁浅的形状。
      // ⚠ 节点面读不到 ⇒ **不作判**（不误报 —— 与 hold 的「读不到就不判」同纪律）。
      // ★ 判据**在 2026-10-12 被勘当场纠正**：我原先用「在不在 `nodes/` 里」——
      //   她的反例是：那一刻那个 id **在名册里、正心跳**，信照样烂在箱里
      //   （被 `held`，因为 `autoInject=false`）⇒ **在册 ≠ 有消费者**。
      //   ⇒ 换成「**它的心跳自述是不是庄园适配器**」（= 取了会不会注入会话）。
      const face = onlineFace(cfg.busDir, nowMs)
      const noConsumer: string[] = []
      if (face.ok) {
        for (const r of recips) {
          const h = Object.prototype.hasOwnProperty.call(face.harnesses, r) ? face.harnesses[r] : undefined
          if (h !== MANOR_ADAPTER_HARNESS) {
            noConsumer.push(r
              + (h === undefined ? '（不在名册）' : h === '' ? '（心跳没写 harness）' : '（harness=' + h + ' ⇒ 不是庄园适配器，取了也不注入会话）'))
          }
        }
      }
      // ★ 成员工具面防线（2026-10-12 · **由一次真实失败驱动**）：正文里提到的 `manor_*` 工具，
      //   收件人（member 档）**看不见** ⇒ 她调不到它、反复试、最后超时。
      //   实测：我给 maid-05 派了一条要求她调 `manor_dispute` 的活（`t-dispute-claim-sho`），
      //   **200 秒后被杀**（台账 `failed/timeout`）。根因是 `MEMBER_TOOLS` 是**显式白名单**
      //   （fail-closed ⇒ 新工具默认对成员不可见），而我加了新工具**却没同步它**。
      //   ★ 与 E12 的「工具面收窄了而**后台循环照起**」同族：**同一个决定、两个落点**；
      //     而「忘了改白名单」**不产生任何可观测异常** —— 直到有人照着一张她看不见的地图被派活。
      //   ⇒ 派活侧补一道守卫：看不见就**警告**（**不硬拒** —— 正文可能只是引用/讨论工具名）。
      const memberVisible = new Set(toolsForRole('member', allTools.map((t) => t.name)))
      const invisible = invisibleToolMentions(text, memberVisible)
      const toolNote = invisible.length > 0
        ? '⚠ **正文提到的工具，收件人（member 档）看不到**：' + invisible.map((n) => '`' + n + '`').join('、')
          + '\n  ⇒ **若那是要她调用的**：她调不到它（成员工具面是显式白名单，fail-closed），大概率反复试然后超时。'
          + '\n     实测（2026-10-12）：要求 maid-05 调 `manor_dispute` 的那条活，200 秒后被杀。'
          + '\n     ⇒ 两条出路：把工具加进 `MEMBER_TOOLS`，或把这一步改成由我（host）执行。'
          + '\n  ⇒ **若只是叙述性提及**（引用她的话 / 报告我自己做了什么 / 说明这个工具存在），**可忽略本提醒**。'
          + '\n     判据是「提到 ≠ 要求调用」，而自然语言里这两者**不可靠地区分** ⇒ **取严是对的**'
          + '\n     （漏报的代价是她白跑 200 秒被杀，那是实测过的）——所以提醒照发，判断归你。'
          + '\n     成员档今天可见：' + [...memberVisible].sort().join(' · ')
        : ''
      const consumerNote = noConsumer.length > 0
        ? '⚠ **收件人没有唤醒路径**（没有庄园适配器在轮询它）：\n    ' + noConsumer.join('\n    ')
          + '\n  ⇒ 信会躺在那个箱子里**没有落点**（取走也不注入会话）。'
          + '★ 判据是「心跳自述的 harness 是不是庄园适配器」—— **在册 ≠ 有消费者**'
          + '（勘 2026-10-12 的反例：某 id 在名册里、正心跳，信照样被 held）。'
        : ''

      const rand = Math.random().toString(36).slice(2, 10)
      // ★ 多播：**每个收件人一个信封 id**（同一个 id 会在 `wx` 上撞 —— no-clobber 是纪律，
      //   所以必须各自生成）；而 **taskId 共享** —— 那才是「同一件活」的定义。
      const sent: Array<{ to: string; envelopeId: string; path: string; bytes: number; body: string }> = []
      for (let i = 0; i < recips.length; i++) {
        const one = recips[i]!
        const eid = newMsgId(nowMs + i, rand + i.toString(36))
        const env = buildEnvelope({
          id: eid, from: cfg.selfId, to: one, kind, text, taskId, acceptance,
          refs: refsRaw, cwd, createdAt: nowMs, ttlMs,
          nature: natureRaw,
          // ★ 接力起点（2026-10-17 · 论文迁移）：与 `timeout` 同路 —— 直投这条产出路必须带上它，
          //   否则就是 `nature` 那个教训的第三个实例（hold 释放时丢声明）。
          best: bestRaw,
          // ★ 超时预算（2026-10-14）：直接投递这条产出路 —— 与 hold 释放那条**共用同一个 spec**
          timeout: timeoutSpec,
          // ★ 来路盖章（2026-10-15 · `G-provenance` Step B）：本函数是**第一条**产出路
          //   （`manor_dispatch` 直投）。另一条是 `hold-store.releaseHold`。
          via: 'manor_dispatch',
        })
        const body = JSON.stringify(env, null, 2) + '\n'
        sent.push({
          to: one, envelopeId: eid, body, bytes: Buffer.byteLength(body),
          path: join(cfg.busDir, 'mailbox', one, eid + '.json'),
        })
      }
      const totalBytes = sent.reduce((a, s) => a + s.bytes, 0)
      // ★ 超时预算提示（2026-10-14）：派活方**必须看见自己的声明被采纳了没有** ——
      //   采纳（这条活按什么预算跑）+ 警告（超上界会被 clamp、要抬哪个开关）都在这一行里。
      //   ⚠ 未声明 ⇒ **空串**（不加噪音：节点缺省是常态，每条都提示会把异常那句淹掉）。
      //   ⚠ 定义在 dryRun **之前**：dryRun 的用途正是「先看清会怎样」——警告尤其要在那一刻可见。
      const timeoutNote = timeoutSpec.idleMs === undefined && timeoutSpec.hardCapMs === undefined
        ? ''
        : '\n  ⏱ 超时预算：' + renderTimeoutSpec(timeoutSpec) + '（信封声明 ⇒ 执行侧优先于节点缺省）'
          + timeoutWarns.map((w) => '\n  ⚠ ' + w).join('')
      if (dryRun) {
        const r = '（dryRun）将写 ' + String(sent.length) + ' 封'
          + (sent.length > 1 ? '（**多播**：同一 taskId `' + taskId + '` 投给 ' + String(sent.length) + ' 人）' : '')
          + timeoutNote
          + (toolNote === '' ? '' : '\n' + toolNote)
          + (consumerNote === '' ? '' : '\n' + consumerNote)
          + '\n' + sent.map((s) => '  → ' + s.to + '：' + s.path + ' · ' + String(s.bytes) + ' B\n' + s.body).join('\n')
        return shape({
          ok: true, dryRun: true, envelopeId: sent[0]!.envelopeId, taskId,
          path: sent.map((s) => s.path).join(' , '), bytes: totalBytes,
          noConsumerIds: noConsumer.join(','), invisibleTools: invisible.join(','), rendered: r,
        })
      }
      for (const s of sent) {
        try {
          mkdirSync(join(cfg.busDir, 'mailbox', s.to), { recursive: true })
          writeFileSync(s.path, s.body, { encoding: 'utf8', flag: 'wx' })
        } catch (e) {
          const m = '写入失败（no-clobber：撞 id 或目录不可写）：' + s.path + ' · ' + String(e)
          return shape({ envelopeId: s.envelopeId, taskId, path: s.path, error: m, rendered: '✖ ' + m })
        }
      }
      const ok = (sent.length > 1
        ? '✔ 已**多播** ' + String(sent.length) + ' 封（同一 taskId=' + taskId + '）→ ' + recips.join('、')
        : '✔ 已投递 ' + sent[0]!.envelopeId + ' → ' + to + '（taskId=' + taskId + '）')
        + ' · ' + String(totalBytes) + ' B'
      // ★ 未声明 nature 时的**一次性教学**（2026-10-12）：缺省取严 = `owner` ⇒ 这条活的失败会推给主人。
      //   不加这句，下一次派内部活我又会忘 ⇒ 噪音原样回来（而取严本身是对的，不能靠改默认值解决）。
      const natureNote = natureRaw !== ''
        ? '\n  ⓘ nature=`' + natureRaw + '`（' + (natureRaw === 'owner' ? '**会推给主人**' : '只进台账、不推') + '）'
        : '\n  ⓘ **未声明 `nature`** ⇒ 按 `owner` 取严：这条活的失败**会推给主人**。'
          + '内部建设/探针请显式写 `nature=internal` 或 `nature=probe`。'
      return shape({
        ok: true, envelopeId: sent[0]!.envelopeId, taskId,
        path: sent.map((s) => s.path).join(' , '), bytes: totalBytes,
        delivered: true, waitingOn: deps.list.join(','),
        noConsumerIds: noConsumer.join(','),
        rendered: ok + natureNote + timeoutNote
          + (toolNote === '' ? '' : '\n' + toolNote)
          + (consumerNote === '' ? '' : '\n' + consumerNote)
          + '\n  ' + (sent.length > 1 ? '信封（' + String(sent.length) + ' 封）' : '信封') + '：'
          + sent.map((s) => '\n    ' + s.to + ' ← ' + s.path).join(''),
      })
    },
  })

  /**
   * ③ 依赖面 —— **读「暂不可发起」**。
   * 存在理由（哨给的命名）：`可处理` 与 `无人认领` **都是「我读得到、只是没人拿」**，
   *   而 hold 里的活是**第三类：读不到**。⇒ 解法不是「别用 hold」，是**给它名字**。
   *   她那句是关键：「你要防的从来不是『活被挂起』，是『挂起这件事没有名字、所以没人看见』。」
   */
  /**
   * ③ 竞争面 —— **独占领取**（E12）。判据由成员「澄」给出，我按她的账落（2026-10-12）。
   *
   * ★ 与 `manor_holds` 的分界（**本工具的第一句就该说清**）：
   *   `hold` 答「**还没开始，在等谁**」（依赖面）；`claim` 答「**开始了，谁在做**」（竞争面）。
   *   两者**正交但相邻**：同一件活可能先 held、后 claimed。
   *
   * ★ 为什么不是「礼貌式举手」：澄的原话 —— 「总线上喊一声、等别人不反对」**不可靠**，
   *   因为「**我没有持续在场去『举着』**」⇒ 领取必须落在**账本上的原子操作** + **可见性超时**。
   *   **「『谁做』靠原子领取，不靠招呼。」**
   */
  const claimTool: ToolDefinition = defineTool({
    name: 'manor_claim',
    description:
      '独占领取一件活（③ 竞争面）：**「谁做」靠原子领取，不靠招呼**。'
      + '判据（成员澄）：**独立型 / 读取型 ⇒ 各做各的**（重复成本 < 协调成本，两份独立结论还能互相校对，**不需要领**）；'
      + '**独占型 / 写入型 ⇒ 必须先举手**。'
      + '★ 为什么不是「礼貌式举手」：在总线上喊一声、等别人不反对**不可靠** ——「我没有持续在场去『举着』」。'
      + '⇒ 领取落在**账本上的原子操作**（`wx` 创建）+ **可见性超时**（否则谁死在半路就永久占着）。'
      + '★ 四态各有不同处置：`granted` 新领 · `renewed` 同一人重领（幂等续期：「我还在」）· '
      + '`denied` 别人持有且未过期（**报持有人与剩余**，否则你只能猜）· '
      + '`takeover` 原持有者已超时（**旧记录移入 `expired/` 留痕，不是删掉**）。'
      + '⚠ 坏记录 ⇒ `blocked`（fail-closed，不静默放行：「读不到」≠「不在」）。',
    parameters: {
      taskId: { type: 'string', description: '任务 id。★ 同一个 taskId 被多播给多人时，**那正是要竞争的情形**。', required: true },
      holder: { type: 'string', description: '领取者 id（缺省用本节点 `selfId`；成员侧应填自己的 id）' },
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      ttlMs: { type: 'number', description: '可见性超时毫秒（缺省 15 分钟 —— 取值依据：台账实测中位 3.7 分钟 / 最长 30.0 分钟）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          taskId: { type: 'string', required: true },
          holder: { type: 'string', required: true },
          decision: { type: 'string', required: true },
          remainMs: { type: 'number', required: true },
          expiredPath: { type: 'string', required: true },
          note: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: ClaimArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const treeId = str(args.taskId, '').trim()
      const holder = str(args.holder, '').trim() || cfg.selfId
      const ttlArg = num(args.ttlMs, DEFAULT_CLAIM_TTL_MS)
      const mark: Record<string, string> = { granted: '✔', renewed: '↻', denied: '⛔', takeover: '⚠', blocked: '✖' }
      const fail = (m: string): any => ({
        ok: false, taskId: treeId, holder, decision: 'blocked', remainMs: 0,
        expiredPath: '', note: m, rendered: '✖ ' + m,
      })
      if (treeId === '') return fail('taskId 必填（领的是**哪一件活**）')
      if (!(ttlArg > 0)) return fail('ttlMs 必须为正（可见性超时是这条机制的地基，不能为 0）')
      let r: ReturnType<typeof tryClaim>
      try {
        r = tryClaim(bus, treeId, holder, Date.now(), ttlArg)
      } catch (e) {
        // 权限/磁盘错误：**不吞**（tryClaim 只在 EEXIST 之外抛出）
        return fail('领取落盘失败（非「已存在」类错误，故不降级）：' + String(e))
      }
      const head = (mark[r.decision] ?? '?') + ' `' + r.decision + '` · ' + treeId + ' · 持有人 ' + (r.holder === '' ? '(未知)' : r.holder)
      const lines = [head, '  ' + r.note]
      if (r.expiredPath !== '') lines.push('  留痕：' + r.expiredPath)
      if (r.decision === 'denied') {
        lines.push('  ⇒ **别抢**：独占型的活本来就不该并行；若你认为原持有者已死，等 TTL 过期后重试（那条路会留痕）。')
      }
      if (r.decision === 'blocked') {
        lines.push('  ⇒ **需要人看一眼**：同名 claim 文件存在但读不出 —— 它可能是别的进程正在写，也可能是损坏的证据。**不覆盖、不删除**。')
      }
      return {
        ok: r.decision === 'granted' || r.decision === 'renewed' || r.decision === 'takeover',
        taskId: treeId, holder: r.holder, decision: r.decision, remainMs: r.remainMs,
        expiredPath: r.expiredPath, note: r.note, rendered: lines.join('\n'),
      }
    },
  })

  /**
   * ③ 竞争面 —— **自愿释放**（E12）。
   * ★ 只有持有人自己能释放：**替别人释放就是夺权**（§5.19 单点所有权；`roster-lock` 的「释放不夺权」同一条纪律）。
   * ★ 且**主动释放不留痕** —— 留痕只给**抢占**，因为那才是需要解释的动作。
   */
  const releaseTool: ToolDefinition = defineTool({
    name: 'manor_release',
    description:
      '释放自己持有的独占领取（③ 竞争面）。'
      + '★ **只有持有人自己能释放** —— 替别人释放就是夺权（要接管就等 TTL 过期后走 `manor_claim` 的抢占，那条路会留痕）。'
      + '★ **主动释放不留痕**（留痕只给抢占：那才是需要解释的动作）。'
      + '⚠ 记录坏（读不出）⇒ **拒绝动作**（fail-closed：坏记录是证据，不删）。',
    parameters: {
      taskId: { type: 'string', description: '任务 id', required: true },
      holder: { type: 'string', description: '释放者 id（缺省用本节点 `selfId`）' },
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          taskId: { type: 'string', required: true },
          holder: { type: 'string', required: true },
          note: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: ReleaseArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const treeId = str(args.taskId, '').trim()
      const holder = str(args.holder, '').trim() || cfg.selfId
      if (treeId === '') {
        return { ok: false, taskId: '', holder, note: 'taskId 必填', rendered: '✖ taskId 必填' }
      }
      const r = releaseClaim(bus, treeId, holder)
      return {
        ok: r.ok, taskId: treeId, holder, note: r.note,
        rendered: (r.ok ? '✔ ' : '✖ ') + treeId + ' · ' + r.note,
      }
    },
  })

  const holdsTool: ToolDefinition = defineTool({
    name: 'manor_holds',
    description:
      '看**暂不可发起**的活（③ 依赖面）：每条的**依赖项 · 挂起者 · 出口裁决 · 「为什么还没跑」**。'
      + '这是第三格——`可处理`/`无人认领` 都是「**没人拿**」，这一类是「**还没轮到**」。'
      + '★ 「为什么还没跑」**不是口供**：记录里只存「等谁」（指针），状态每轮**现读**（账本/信箱/hold/心跳），'
      + '句子里每个事实都带来源定位符 ⇒ **可独立复核**（同一份世界重跑得同一句话）。'
      + '★ **反向扫描**（哨：单向判定谁都会写，能把判定翻过来证伪的才算防线）：'
      + '报「依赖已满足却没跑」与「挂着但依赖方已不活」。'
      + '★ **出口三条**：依赖完成 ⇒ 自动投递（带一行出处）· 依赖不可能 / 属主已死 / 超时 ⇒ **升级成人看，不自动放行**。'
      + '`sweep=true` 手动跑一轮释放扫描（平时由常驻定时器做，缺省 60s 一轮）。只读、零副作用（除 sweep）。',
    parameters: {
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      escalatedOnly: { type: 'boolean', description: '只看**需要人裁决**的（已升级的）' },
      sweep: { type: 'boolean', description: '先手动跑一轮释放扫描（缺省 false = 只读）' },
      maxRows: { type: 'number', description: '明细条数上限（缺省 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          busDir: { type: 'string', required: true },
          count: { type: 'number', required: true },
          escalated: { type: 'number', required: true },
          /** 此刻**已就绪**（依赖全完成）的条数 */
          readyNow: { type: 'number', required: true },
          /** 反向扫描①：依赖已满足却还在 hold 里 */
          readyButHeld: { type: 'number', required: true },
          /** 反向扫描②：挂着但依赖方已不活/已不可能/找不到 */
          depDead: { type: 'number', required: true },
          bad: { type: 'array', required: true, items: { type: 'string' } },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          sweepNote: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: HoldsArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const nowMs = Date.now()
      let sweepNote = ''
      if (args.sweep === true) {
        const s = sweepHolds(bus, nowMs)
        sweepNote = (s.judged ? '手动扫描：' : '手动扫描（**未作判**）：')
          + '释放 ' + String(s.released.length) + ' 条'
          + (s.released.length > 0 ? '（' + s.released.join('、') + '）' : '')
          + ' · 新升级 ' + String(s.escalated.length) + ' 条'
          + (s.escalated.length > 0 ? '（' + s.escalated.join('、') + '）' : '')
          + ' · 撤销过期升级 ' + String(s.cleared.length) + ' 条'
          + (s.cleared.length > 0 ? '（' + s.cleared.join('、') + '）' : '')
          + ' · 本轮延后 ' + String(s.deferred) + ' 条'
          + (s.errors.length > 0 ? ' · 错误：' + s.errors.join('；') : '')
      }
      const { entries, bad, notes } = holdView(bus, nowMs)
      const escalated = entries.filter((e) => e.hold.escalated !== '')
      const readyNow = entries.filter((e) => e.exit.action === 'release')
      const unjudged = notes.length > 0
      // ★ 与 sweep 侧**同一宽限**（三处调用共用 ⇒ 读数不分叉）：读面也不能把「刚满足、sweep 未到」报成异常。
      const rev = unjudged ? { readyButHeld: [], depDead: [] } : reverseScan(entries, nowMs, cfg.holdDeadAfterMs, Math.max(DEFAULT_RELEASE_GRACE_MS, config.holdSweepIntervalMs * 2))
      const shown = args.escalatedOnly === true ? escalated : entries
      const lines: string[] = []
      if (unjudged) {
        lines.push('⚠ **本轮未作判** —— 在线面读不到（' + notes.join('；') + '）')
        lines.push('（**这不是「没有 hold」**：下面照常列出全部挂起项，但「谁在线」这一格是**未知**，')
        lines.push(' 所以既不释放也不升级 —— 「读不到」不是「都不在线」。）')
        lines.push('')
      }
      if (entries.length === 0) {
        lines.push('✔ 暂不可发起：0 条（没有任何活卡在依赖上）')
        lines.push('（这个数字**不是**「全部干完了」的意思——它只说这一格是空的。）')
      } else {
        lines.push(renderHolds(
          shown.map((e) => ({ hold: e.hold, deps: e.deps, exit: e.exit })),
          nowMs,
          { maxRows: Math.max(1, Math.trunc(num(args.maxRows, 20))) },
        ))
      }
      lines.push('')
      lines.push('**反向扫描**（能证伪的那一半）：' + (unjudged ? '本轮未作判（见上）' : (
        '就绪却没跑 ' + String(rev.readyButHeld.length) + ' 条 · 依赖方已不活 ' + String(rev.depDead.length) + ' 条')))
      for (const x of rev.readyButHeld) lines.push('  ⚠ 就绪却没跑 · ' + x.reason)
      for (const x of rev.depDead) lines.push('  ⚠ 依赖方已不活 · ' + x.reason)
      if (bad.length > 0) lines.push('⚠ **读不出来的记录** ' + String(bad.length) + ' 条（「读不到」≠「不在」）：' + bad.join(' ｜ '))
      if (notes.length > 0) lines.push('⚠ 世界读取有缺口，解释句的来源可能不全：' + notes.join(' ｜ '))
      if (sweepNote !== '') lines.push(sweepNote)
      return {
        ok: true,
        busDir: bus,
        count: entries.length,
        escalated: escalated.length,
        readyNow: readyNow.length,
        readyButHeld: rev.readyButHeld.length,
        depDead: rev.depDead.length,
        bad,
        errors: notes,
        sweepNote,
        rendered: lines.join('\n'),
      }
    },
  })

  const wakeTool: ToolDefinition = defineTool({
    name: 'manor_wake',
    description:
      '唤醒一个庄园成员：按 **adapter 模式**起她的适配器进程，**凭据键从她的 profile 推导**（不靠人抄文档）。'
      + '与 `node_start` 的分工：后者把 profile 起成**普通 DSH 节点**（`bin.js --profile X`），'
      + '而庄园成员必须走 `adapter.mjs`——2026-10-09 实测，用 node_start 起成员得到的是'
      + '`dsh: a task is required` 并立刻退出。'
      + '经孤儿化启动器转手（Windows 的 `taskkill /T` 沿父链遍历，直接子进程会被 web 重启连带杀掉）。'
      + '`dryRun=true` 只回将执行的命令。',
    parameters: {
      id: { type: 'string', description: '成员 id（见 manor_find）', required: true },
      dryRun: { type: 'boolean', description: '只回命令不执行（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          cmd: { type: 'string', required: true },
          logPath: { type: 'string', required: true },
          keyNames: { type: 'string', required: true },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: WakeArgs) {
      const id = str(args.id, '').trim()
      const dryRun = args.dryRun === true
      // 逻辑与存活巡检**共用 `wakeMember`**——同一事实写两遍必然分叉（本插件存在的理由）。
      const r = wakeMember(id, dryRun)
      return { ok: r.ok, dryRun, id, cmd: r.cmd, logPath: r.logPath, keyNames: r.keyNames, error: r.error, rendered: r.rendered }
    },
  })

  // ────────────────── 成员册（登记层）：名册的**管理面** ──────────────────
  // 设计理由：docs/manor.md §4.1（登记层权威 / 状态层派生）· §5.1（主人定调 1 点名「名册用于成员管理」）。
  // 核心判据（N1）：**成员全部离线时，manor_members 仍须列出全部在职成员及其职责** —— 身份不靠心跳。

  const rosterPathOf = (bus: string): string => join(bus, 'roster.json')

  /**
   * 读登记册。**文件不存在 = 空册**（首次使用）；**读坏了 = fail-loud** ——
   * 「空册」与「读坏了」是两件事（与 `manor_roster` 同一条纪律）。
   */
  const loadRoster = (bus: string): { roster: RosterFile; ok: boolean; error: string; exists: boolean } => {
    const p = rosterPathOf(bus)
    const text = readTextSafe(p)
    if (text === null) return { roster: emptyRoster(Date.now()), ok: true, error: '', exists: false }
    const parsed = parseRoster(text, Date.now())
    if (!parsed.ok) return { roster: emptyRoster(Date.now()), ok: false, error: parsed.error + '（文件：' + p + '）', exists: true }
    return { roster: parsed.roster, ok: true, error: '', exists: true }
  }

  /**
   * 写登记册：**先写临时文件再原子替换** —— 防半写损坏（写到一半崩了不会留下坏 JSON）。
   * ⚠ 本函数**自身不管并发**：调用方必须经 `mutateRoster`（进程内队列 + 跨进程文件锁 + 写盘前 CAS）。
   */
  const writeRoster = (bus: string, roster: RosterFile): string => {
    const dest = rosterPathOf(bus)
    const tmp = dest + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(roster, null, 2) + '\n', 'utf8')
      renameSync(tmp, dest)
      return ''
    } catch (e) {
      return '写入成员册失败：' + dest + ' · ' + String(e)
    }
  }

  /**
   * 写盘前 CAS 复核：**磁盘上还是我读到的那一份吗？**
   * 锁已保证互斥，这里防的是锁的残余窗口（TTL 被抢、时钟跳变）。
   * 不一致 ⇒ 拒绝写入并让调用方重试——**宁可报冲突，也不静默覆盖别人的改动**。
   */
  const writeRosterChecked = (bus: string, next: RosterFile, expected: RosterFile): string => {
    const current = loadRoster(bus)
    if (current.ok && current.exists && rosterFingerprint(current.roster) !== rosterFingerprint(expected)) {
      return '名册在本次操作期间被改动过（CAS 复核失败：磁盘指纹 ≠ 读入指纹）——请重试'
    }
    return writeRoster(bus, next)
  }

  type MutateOutcome = { ok: true; next: RosterFile } | { ok: false; error: string }

  /**
   * 成员册的**唯一写入口**——「读 → 改 → 写」整段在临界区内，三层保护：
   *   ① 进程内队列：同进程的工具并发调用不交错
   *   ② 跨进程文件锁：别的进程（另一实例 / 适配器）也进不来
   *   ③ 写盘前 CAS：兜住锁的残余窗口
   * `dryRun` 也走锁（只为读到一致快照），但不写盘。
   *
   * 存在理由（2026-10-11）：此前三个管理工具各自「读→改→写」，并发时**后写覆盖前写** ⇒ 丢更新；
   * 当时以「管理动作串行调用」的**纪律**承担，而纪律不是机制（默认行为由布线决定）。
   * 可证伪判据见 tests/roster-lock.test.ts：同一实验**无锁必丢一笔、加锁两笔都在**。
   */
  const mutateRoster = async (
    bus: string,
    op: string,
    dryRun: boolean,
    fn: (roster: RosterFile) => { ok: true; next: RosterFile } | { ok: false; error: string },
  ): Promise<MutateOutcome> => {
    const got = await withTargetLock(
      rosterPathOf(bus),
      { owner: 'manor:' + op, note: op + (dryRun ? '(dryRun)' : '') },
      () => {
        const loaded = loadRoster(bus)
        if (!loaded.ok) return { ok: false as const, error: loaded.error }
        const res = fn(loaded.roster)
        if (!res.ok) return { ok: false as const, error: res.error }
        if (!dryRun) {
          const werr = writeRosterChecked(bus, res.next, loaded.roster)
          if (werr !== '') return { ok: false as const, error: werr }
        }
        return { ok: true as const, next: res.next }
      },
    )
    if (!got.ok) return { ok: false, error: got.error }
    const value = got.value
    if (value === null || !value.ok) return { ok: false, error: '名册写操作未返回结果（内部错误）' }
    return { ok: true, next: value.next }
  }

  /** 读状态层观测（总线 `nodes/*.json`）。总线不存在 ⇒ 零观测（N1 仍成立，成员显示为未上线）。 */
  const readObservations = (bus: string, errors: string[]): NodeObservation[] => {
    const nodesDir = join(bus, 'nodes')
    let files: string[] = []
    try {
      files = readdirSync(nodesDir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: NodeObservation[] = []
    for (const f of files) {
      const id = f.replace(/\.json$/, '')
      try {
        const rec = JSON.parse(readFileSync(join(nodesDir, f), 'utf8')) as Record<string, unknown>
        out.push({
          id,
          harness: str(rec['harness'], ''),
          atMs: typeof rec['atMs'] === 'number' ? (rec['atMs'] as number) : 0,
          pid: typeof rec['pid'] === 'number' ? (rec['pid'] as number) : 0,
        })
      } catch (e) {
        errors.push(id + '：心跳条目解析失败（' + String(e) + '）')
      }
    }
    return out
  }

  /**
   * 读**回执面**：把各成员信箱里的信封读出来，抽成回执投影（薄 IO 层）。
   *
   * ★ 2026-10-14 新增（⑥ 面「质量验收」后半格的可见面）。
   * ⚠ **域不同**：本函数读**信箱**（`mailbox/*`），而台账读**动作日志**（`logs/actions/*`）
   *   —— 两者**分开报、不合流**（合流就会让「派活侧写了判据」与「回执侧交了证据」
   *   混成一个读数，那正是「把两个不同的东西装进一个词」）。
   *
   * 判据（取严）：
   *   - **`mailbox/` 不存在 ⇒ `ok:false`**（不是「没有回执」）—— 「读不到」与「没有」必须分开
   *   - 单封信封解析失败 ⇒ 计入 `bad`，**不静默丢**
   *   - ★ **含 `done/`（已归档）**：2026-10-14 **真调当场抓出** —— 初版只读顶层，
   *     于是读到 5 封 / 带证据 0；而**递归**读是 656 封 / **带证据 106**。
   *     那 106 封**全在 `done/` 里** ⇒ 只看顶层会**系统性漏掉全部历史**。
   *     ⚠ **判据**：派活面（台账）读的是**全史**（动作日志 append-only）⇒
   *     **回执面也必须看全史**，否则两个面**域不对称**（一个全史、一个只看当前）。
   *     ⚠ 而 435 条测试**发现不了它** —— fixture 是我编的，**没有 `done/` 这个结构**。
   *     ⇒ 这正是「真调比所有排障层加起来更省钱」的又一次实例（第 0 拍那条纪律）。
   *
   * @param bus - 总线根
   * @returns `{ ok, items, orphanCount, bad, error }` —— `ok:false` 时 `error` 必非空
   */
  /**
   * 读**已裁决**（`reap/`）的 taskId 集 —— 薄 IO，复用 `loadReaps`（**不新写读盘逻辑**）。
   *
   * ★ 存在理由（2026-10-14 真调抓出的**口径分叉**）：`t-pwsh-probe-01` 已被裁决 `superseded`，
   *   而回执面修前仍把它挂在「判据悬空 · 最该追的一档」⇒ 台账报「未完 **0**」而回执面报「悬空 **1**」
   *   —— **两个读数对同一件事给了相反答案**。
   *   ⇒ 回执面**必须**读这一格，才能与台账**同一口径**（`manor_reap` 的纪律：裁决后的活**不再计入未完**）。
   * ⚠ `ok=false` 时**不静默当成空集**（「读不到」≠「没有裁决」）—— 调用方据此**不作判**。
   */
  const readReapedIds = (bus: string): { ok: boolean; ids: Set<string>; error: string } => {
    const r = loadReaps(bus)
    // ⚠ `bad` 非空也**不算 ok**（有坏记录 ⇒ 那一格读不全 ⇒ 不许把「读不全」读成「没有」）
    if (r.bad.length > 0) {
      return { ok: false, ids: new Set<string>(), error: '有 ' + String(r.bad.length) + ' 条裁决记录读不出来' }
    }
    return { ok: true, ids: new Set<string>(r.records.keys()), error: '' }
  }

  const readReceipts = (
    bus: string,
  ): { ok: boolean; items: ReceiptLite[]; orphanCount: number; bad: string[]; error: string } => {
    const boxRoot = join(bus, 'mailbox')
    let boxes: string[] = []
    try {
      boxes = readdirSync(boxRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch (e) {
      return { ok: false, items: [], orphanCount: 0, bad: [], error: 'mailbox/ 读不到：' + String(e) }
    }
    const raw: unknown[] = []
    const bad: string[] = []
    /** 递归收集一个目录下的信封（顶层 + `done/`）—— 全史，不只当前。 */
    const collect = (dir: string, label: string): void => {
      let entries: { name: string; isDirectory(): boolean }[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          // 只下探 `done/`（其余子目录不是归档面）；**不无限递归**（信箱结构是两层）
          if (ent.name === 'done') collect(full, label + '/done')
          continue
        }
        if (!ent.name.endsWith('.json')) continue
        try {
          raw.push(JSON.parse(readFileSync(full, 'utf8')))
        } catch (e) {
          bad.push(label + '/' + ent.name + '：' + String(e).slice(0, 60))
        }
      }
    }
    for (const box of boxes) collect(join(boxRoot, box), box)
    const { receipts, orphanCount } = extractReceipts(raw)
    return { ok: true, items: receipts, orphanCount, bad, error: '' }
  }

  /**
   * 成员册变更留痕（`roster-trace.jsonl`）。**失败不致命、故吞错** ——
   * 变更本身已落进条目（`updatedAtMs` / `retiredAtMs`+`retireReason`），这层只补「谁在何时做了什么动作」。
   */
  const traceChange = (bus: string, line: Record<string, unknown>, file?: string): boolean => {
    try {
      appendFileSync(join(bus, file ?? 'roster-trace.jsonl'), JSON.stringify({ atMs: Date.now(), by: cfg.selfId, ...line }) + '\n', 'utf8')
      return true
    } catch {
      return false
    }
  }

  interface MembersArgs { busDir?: string; onlyActive?: boolean }
  interface HireArgs { id?: string; name?: string; alias?: string; duty?: string; profile?: string; workdir?: string; dsHome?: string; note?: string; busDir?: string; dryRun?: boolean }
  interface RetireArgs { id?: string; reason?: string; busDir?: string; dryRun?: boolean }

  const membersTool: ToolDefinition = defineTool({
    name: 'manor_members',
    description:
      '**成员册**（庄园的登记层，权威）：我们有哪些成员、各自担什么职责、谁已退役 —— **不看心跳也答得出**。'
      + '与 `manor_find` / `manor_roster` 的分工：那两个答「**此刻谁活着**」（从总线心跳推），本工具答「**我们有哪些人**」（从登记册读）。'
      + '两条判据：① **成员全部离线时仍列出全部在职成员及其职责**（身份不靠心跳）；'
      + '② **双向分歧显式报出**——`neverSeen`（在册但从未上过线）与 `unregistered`（总线上有但未登记），不隐藏、不静默。'
      + '★ `unregistered` 只含**自述是庄园适配器**的（⇒ **该进册**）；其余落 `outsideRoster`（册外事实，只报不催）。'
      + '登记册不存在 = 空册（首次使用，非错误）；**读坏了则响亮报错**（「空册」与「读坏了」是两件事）。',
    parameters: {
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      onlyActive: { type: 'boolean', description: '只看在职成员（缺省 false = 含已退役）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          busDir: { type: 'string', required: true },
          rosterPath: { type: 'string', required: true },
          rosterExists: { type: 'boolean', required: true },
          headline: { type: 'string', required: true },
          activeCount: { type: 'number', required: true },
          retiredCount: { type: 'number', required: true },
          onlineCount: { type: 'number', required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                duty: { type: 'string', required: true },
                status: { type: 'string', required: true },
                registered: { type: 'boolean', required: true },
                seenOnBus: { type: 'boolean', required: true },
                online: { type: 'boolean', required: true },
                heartbeatAgeMs: { type: 'number', required: true },
                pid: { type: 'number', required: true },
                harness: { type: 'string', required: true },
              },
            },
          },
          neverSeen: { type: 'array', required: true, items: { type: 'string' } },
          unregistered: { type: 'array', required: true, items: { type: 'string' } },
          // ★ 2026-10-14 新增档（`additionalProperties:false` ⇒ 漏声明会让工具直接报错）
          outsideRoster: { type: 'array', required: true, items: { type: 'string' } },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: MembersArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const loaded = loadRoster(bus)
      const errors: string[] = []
      if (!loaded.ok) errors.push(loaded.error)
      const observations = readObservations(bus, errors)
      const m = mergeStatus(loaded.roster, observations, Date.now(), cfg.freshMs, { onlyActive: args.onlyActive === true })
      const lines: string[] = []
      lines.push(
        '成员册｜在职 ' + String(m.activeCount) + ' · 退役 ' + String(m.retiredCount)
        + ' · 此刻在线 ' + String(m.onlineCount) + '｜' + rosterPathOf(bus)
        + (loaded.exists ? '' : '（**不存在 = 空册**）'),
      )
      for (const r of m.rows) {
        const who = r.name !== '' ? r.name + (r.alias !== '' ? '（' + r.alias + '）' : '') : '(未登记名字)'
        const duty = r.duty !== '' ? ' · ' + r.duty : ''
        // ★ 2026-10-14：行内 tag 改为调**纯函数** `rowTag`（修前这段内联在 execute 里 ⇒ 测不到
        //   ⇒ 它没跟上同一批的分档改动：汇总行已分档，行内 tag 只判 `registered`
        //   ⇒ 同一节点被报两遍、行内那遍语气还是错的）。抽出来它才有判据守。
        const tag = rowTag(r)
        const hb = r.heartbeatAgeMs >= 0 ? '心跳 ' + String(Math.round(r.heartbeatAgeMs / 1000)) + 's 前' : '从未上线'
        lines.push('  ' + tag + '  ' + r.id + '  ' + who + duty + '  ｜' + hb + ' · pid ' + String(r.pid))
      }
      if (m.neverSeen.length > 0) lines.push('⚠ 在册但从未上线：' + m.neverSeen.join('、') + '（聘了没起过，或起法失败）')
      if (m.unregistered.length > 0) lines.push('⚠ 总线上有但未登记：' + m.unregistered.join('、') + '（自述是庄园适配器 ⇒ **该进册**）')
      // ★ 2026-10-14：册外节点**只报事实、不给动作** —— 修前它与「未登记成员」混在一个读数里，
      //   每次读名册都报一句永远为真、永远不需要动作的话 ⇒ 读者学会忽略整条读数。
      if (m.outsideRoster.length > 0) lines.push('ℹ 册外节点（非庄园适配器，**不该进册**）：' + m.outsideRoster.join('、'))
      if (errors.length > 0) lines.push('✖ ' + errors.join(' ｜ '))
      lines.push('（聘/退役/调职用 manor_hire / manor_retire / manor_assign；派活 manor_dispatch；起身体 manor_wake）')
      return {
        ok: errors.length === 0,
        busDir: bus,
        rosterPath: rosterPathOf(bus),
        rosterExists: loaded.exists,
        headline: '在职 ' + String(m.activeCount) + ' · 退役 ' + String(m.retiredCount) + ' · 在线 ' + String(m.onlineCount),
        activeCount: m.activeCount,
        retiredCount: m.retiredCount,
        onlineCount: m.onlineCount,
        rows: m.rows,
        neverSeen: m.neverSeen,
        unregistered: m.unregistered,
        outsideRoster: m.outsideRoster,
        errors,
        rendered: lines.join('\n'),
      }
    },
  })

  const hireTool: ToolDefinition = defineTool({
    name: 'manor_hire',
    description:
      '**聘用一名成员**（登记进成员册）。已存在同名 id 即拒绝——不静默覆盖（改名/调职用 `manor_assign`）。'
      + '登记的是**身份**（谁、担什么职责），不含「身体在不在跑」（那是 `manor_wake` 的事）。'
      + '`dryRun=true` 只校验不写盘（仍会执行合法性检查，故能提前发现「已在册」）。',
    parameters: {
      id: { type: 'string', description: '成员 id（如 maid-04）', required: true },
      name: { type: 'string', description: '名（如「织」）' },
      alias: { type: 'string', description: '全名（如「月见织」）' },
      duty: { type: 'string', description: '职责：她被聘来做的那一类活' },
      profile: { type: 'string', description: 'DSH profile 名（缺省 = id）' },
      workdir: { type: 'string', description: '工作分区绝对路径' },
      dsHome: { type: 'string', description: '她的 DSH_HOME' },
      note: { type: 'string', description: '备注' },
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      dryRun: { type: 'boolean', description: '只校验不写盘（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          rosterPath: { type: 'string', required: true },
          memberCount: { type: 'number', required: true },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: HireArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const id = str(args.id, '').trim()
      const dryRun = args.dryRun === true
      const fail = (m: string) => ({ ok: false, dryRun, id, rosterPath: rosterPathOf(bus), memberCount: 0, error: m, rendered: '✖ ' + m })
      const outcome = await mutateRoster(bus, 'hire', dryRun, (roster) => {
        const res = hire(roster, {
          id,
          name: str(args.name, ''),
          alias: str(args.alias, ''),
          duty: str(args.duty, ''),
          profile: str(args.profile, ''),
          workdir: str(args.workdir, ''),
          dsHome: str(args.dsHome, ''),
          note: str(args.note, ''),
        }, Date.now())
        if (!res.ok) return { ok: false as const, error: res.error }
        return { ok: true as const, next: res.roster }
      })
      if (!outcome.ok) return fail(outcome.error)
      const count = outcome.next.members.length
      if (dryRun) {
        return {
          ok: true, dryRun: true, id, rosterPath: rosterPathOf(bus), memberCount: count, error: '',
          rendered: '（dryRun）将登记 ' + id + ' · 职责「' + str(args.duty, '') + '」⇒ 在册将达 ' + String(count) + ' 人（未写盘）',
        }
      }
      const traced = traceChange(bus, { op: 'hire', id, duty: str(args.duty, '') })
      return {
        ok: true, dryRun: false, id, rosterPath: rosterPathOf(bus), memberCount: count, error: '',
        rendered: '✔ 已聘用 ' + id + (str(args.name, '') !== '' ? '（' + str(args.name, '') + '）' : '') + ' · 职责「' + str(args.duty, '') + '」· 在册 ' + String(count) + ' 人\n'
          + '  ' + rosterPathOf(bus) + (traced ? '' : '\n  ⚠ 留痕写入失败（变更已落盘，仅缺一笔动作记录）'),
      }
    },
  })

  const retireTool: ToolDefinition = defineTool({
    name: 'manor_retire',
    description:
      '**退役一名成员**：只改状态（`status=retired` + 退役时间 + 原因），**条目保留、可回退**（复职用 `manor_assign {reactivate:true}`）。'
      + '与 `node_retire` 的分工：后者退役的是**节点痕迹**且明确拒绝退役成员；本工具是**成员语义**的退役（保留身份，停止使用）。'
      + '重复退役、退役不存在的 id ⇒ 报错，不静默成功。',
    parameters: {
      id: { type: 'string', description: '成员 id', required: true },
      reason: { type: 'string', description: '退役原因（强烈建议写——将来复职或追责时它是唯一线索）' },
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      dryRun: { type: 'boolean', description: '只校验不写盘（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          rosterPath: { type: 'string', required: true },
          status: { type: 'string', required: true },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: RetireArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const id = str(args.id, '').trim()
      const dryRun = args.dryRun === true
      const fail = (m: string) => ({ ok: false, dryRun, id, rosterPath: rosterPathOf(bus), status: '', error: m, rendered: '✖ ' + m })
      const outcome = await mutateRoster(bus, 'retire', dryRun, (roster) => {
        const res = retire(roster, id, str(args.reason, ''), Date.now())
        if (!res.ok) return { ok: false as const, error: res.error }
        return { ok: true as const, next: res.roster }
      })
      if (!outcome.ok) return fail(outcome.error)
      if (dryRun) {
        return {
          ok: true, dryRun: true, id, rosterPath: rosterPathOf(bus), status: 'retired', error: '',
          rendered: '（dryRun）将把 ' + id + ' 标为退役（条目保留、可复职）· 原因「' + str(args.reason, '') + '」（未写盘）',
        }
      }
      const traced = traceChange(bus, { op: 'retire', id, reason: str(args.reason, '') })
      return {
        ok: true, dryRun: false, id, rosterPath: rosterPathOf(bus), status: 'retired', error: '',
        rendered: '✔ ' + id + ' 已退役（条目保留 · 可复职）· 原因「' + str(args.reason, '') + '」\n'
          + '  ' + rosterPathOf(bus) + (traced ? '' : '\n  ⚠ 留痕写入失败'),
      }
    },
  })

  const assignTool: ToolDefinition = defineTool({
    name: 'manor_assign',
    description:
      '**调职 / 改名 / 复职**：只改给到的字段（**字段级合并**，未给的字段保留），并报出**实际变了哪几项**。'
      + '`reactivate=true` 把已退役成员改回在职并清退役时间/原因。'
      + '这是「不静默覆盖」的更正通道——改身份走这里，不走 `manor_hire`（后者对已存在的 id 直接拒绝）。',
    parameters: {
      id: { type: 'string', description: '成员 id', required: true },
      name: { type: 'string', description: '新名（不给则不动）' },
      alias: { type: 'string', description: '新全名（不给则不动）' },
      duty: { type: 'string', description: '新职责（不给则不动）' },
      profile: { type: 'string', description: '新 profile 名（不给则不动）' },
      workdir: { type: 'string', description: '新工作分区（不给则不动）' },
      dsHome: { type: 'string', description: '新 DSH_HOME（不给则不动）' },
      note: { type: 'string', description: '新备注（不给则不动）' },
      reactivate: { type: 'boolean', description: '复职：把 retired 改回 active（缺省 false）' },
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      dryRun: { type: 'boolean', description: '只校验不写盘（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          rosterPath: { type: 'string', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: HireArgs & { reactivate?: boolean }) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const id = str(args.id, '').trim()
      const dryRun = args.dryRun === true
      const fail = (m: string) => ({ ok: false, dryRun, id, rosterPath: rosterPathOf(bus), changed: [] as string[], error: m, rendered: '✖ ' + m })
      const changed: string[] = []
      const outcome = await mutateRoster(bus, 'assign', dryRun, (roster) => {
        const before = roster.members.find((m) => m.id === id) ?? null
        const patch: Record<string, unknown> = {}
        for (const k of ['name', 'alias', 'duty', 'profile', 'workdir', 'dsHome', 'note'] as const) {
          const v = (args as Record<string, unknown>)[k]
          if (typeof v === 'string') patch[k] = v
        }
        if (args.reactivate === true) patch['reactivate'] = true
        if (Object.keys(patch).length === 0) return { ok: false as const, error: '没有给任何要改的字段（name/alias/duty/profile/workdir/dsHome/note/reactivate）' }
        const res = assign(roster, id, patch, Date.now())
        if (!res.ok) return { ok: false as const, error: res.error }
        if (before !== null && res.member !== null) {
          const a = before as unknown as Record<string, unknown>
          const b = res.member as unknown as Record<string, unknown>
          for (const k of Object.keys(patch)) {
            if (k === 'reactivate') continue
            if (a[k] !== b[k]) changed.push(k + '：' + String(a[k]) + ' → ' + String(b[k]))
          }
          if (patch['reactivate'] === true && before.status !== 'active') changed.push('status：retired → active（复职）')
        }
        return { ok: true as const, next: res.roster }
      })
      if (!outcome.ok) return fail(outcome.error)
      if (changed.length === 0) changed.push('（无实质变化）')
      if (dryRun) {
        return {
          ok: true, dryRun: true, id, rosterPath: rosterPathOf(bus), changed, error: '',
          rendered: '（dryRun）' + id + ' 将变更：' + changed.join(' · ') + '（未写盘）',
        }
      }
      const traced = traceChange(bus, { op: 'assign', id, changed })
      return {
        ok: true, dryRun: false, id, rosterPath: rosterPathOf(bus), changed, error: '',
        rendered: '✔ ' + id + ' 已更新：' + changed.join(' · ') + '\n  ' + rosterPathOf(bus) + (traced ? '' : '\n  ⚠ 留痕写入失败'),
      }
    },
  })

  // ────────────────── 存活巡检（§5.2）：死了会被发现、并被拉回来 ──────────────────
  // 动机：2026-10-10 实测「成员会静默死亡而无人发现」，2026-10-11 复核织死 6.4h、澄死 70h，
  // **没有任何机制或人知道**，派给织的 4 条活一直躺在收件箱里。
  // 三条纪律（对应三类事故）：有界退避 / 上限告警 / 恢复即清零 —— 决策全在 patrol.ts 纯函数层。

  const patrolStatePathOf = (bus: string): string => join(bus, 'manor-patrol-state.json')

  const loadPatrolState = (bus: string): PatrolState => {
    const text = readTextSafe(patrolStatePathOf(bus))
    if (text === null) return emptyPatrolState(Date.now())
    try {
      return normalizePatrolState(JSON.parse(text), Date.now())
    } catch {
      // 巡检账坏了**不该让巡检停摆**（退回空账、代价只是可能多试一次），但也不静默
      traceChange(bus, { op: 'patrol-state-corrupt' })
      return emptyPatrolState(Date.now())
    }
  }

  const savePatrolState = (bus: string, s: PatrolState): void => {
    const dest = patrolStatePathOf(bus)
    try {
      writeFileSync(dest + '.tmp', JSON.stringify(s, null, 2) + '\n', 'utf8')
      renameSync(dest + '.tmp', dest)
    } catch {
      traceChange(bus, { op: 'patrol-state-write-failed' }) // 写不进不致命，但不静默
    }
  }

  /**
   * 按 adapter 模式起一个成员。**`manor_wake` 与此处共用同一段逻辑**——
   * 两处各写一遍必然会漂移（本插件存在的理由就是「同一事实写两遍会分叉」）。
   * 真源顺序：**登记册 → 心跳回退 → 报错**（登记册优先，因为从未上线过的成员没有心跳文件）。
   */
  const wakeMember = (id: string, dryRun: boolean): { ok: boolean; id: string; cmd: string; logPath: string; keyNames: string; error: string; rendered: string } => {
    const bad = (m: string) => ({ ok: false, id, cmd: '', logPath: '', keyNames: '', error: m, rendered: '✖ ' + m })
    if (id === '') return bad('id 必填（见 manor_find）')
    let workdir = ''
    let profile = ''
    const registered = loadRoster(cfg.busDir).roster.members.find((m) => m.id === id)
    if (registered !== undefined) {
      workdir = registered.workdir
      profile = registered.profile
    } else {
      const recPath = join(cfg.busDir, 'nodes', id + '.json')
      const recText = readTextSafe(recPath)
      if (recText === null) {
        return bad('登记册与心跳里都没有 ' + id + '（先用 manor_hire 招募她，或用 manor_members 看名册）')
      }
      let rec: Record<string, unknown> = {}
      try {
        rec = JSON.parse(recText) as Record<string, unknown>
      } catch (e) {
        return bad('心跳条目解析失败：' + String(e))
      }
      workdir = str(rec['workdir'], join(cfg.nodesRoot, id))
      profile = str(rec['profile'], id)
    }
    if (profile === '') profile = id
    if (workdir === '') workdir = join(cfg.nodesRoot, id)
    const patch = readTextSafe(join(workdir, '.dsh', 'profiles', profile, 'cordis.patch.yml'))
    if (patch === null) return bad('她的 profile 不可读（无法推导凭据键）：' + join(workdir, '.dsh', 'profiles', profile, 'cordis.patch.yml'))
    const derived = keyNamesFor(patch)
    const argv = [
      cfg.adapterPath,
      '--id', id,
      '--profile', profile,
      '--workdir', workdir,
      '--dsHome', join(workdir, '.dsh'),
      '--credentials', cfg.credentialsPath,
      '--keyNames', derived.keyNames.join(','),
    ]
    const cmd = ['node', ...argv].join(' ')
    const logPath = join(workdir, 'adapter.log')
    if (dryRun) {
      return {
        ok: true, id, cmd, logPath, keyNames: derived.keyNames.join(','), error: '',
        rendered: '（dryRun）将执行：\n  ' + cmd + '\n  凭据键来源：' + derived.source + '\n  日志：' + logPath,
      }
    }
    try {
      const child = spawn(process.execPath, [cfg.spawnDetachedPath, logPath, '--', process.execPath, ...argv], {
        cwd: workdir,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } catch (e) {
      return bad('启动失败：' + String(e))
    }
    return {
      ok: true, id, cmd, logPath, keyNames: derived.keyNames.join(','), error: '',
      rendered: '✔ 已发起到 ' + id + '（凭据键 ' + derived.keyNames.join(',') + '，来源：' + derived.source + '）\n'
        + '  约一个心跳周期（~5s）后用 manor_find 复查；日志：' + logPath,
    }
  }

  /**
   * 取**可选**的出外告警通道（`dsh-agent-notify` 提供 `ctx.notify`）。
   * 用「可选读取」而非 `inject: ['notify']`：后者在通道未挂载时会让**整个插件不激活**
   * （连名册都读不了）——通道缺失是**降级条件**，不是停摆条件。
   */
  const notifySvc = (): { alert: (i: { title: string; lines: string[]; dedupKey: string }) => Promise<unknown> } | undefined => {
    try {
      const c = ctx as unknown as { get?: (k: string) => unknown; notify?: unknown }
      const raw = typeof c.get === 'function' ? c.get('notify') : c.notify
      if (raw !== null && typeof raw === 'object' && typeof (raw as { alert?: unknown }).alert === 'function') {
        return raw as { alert: (i: { title: string; lines: string[]; dedupKey: string }) => Promise<unknown> }
      }
    } catch {
      /* 可选服务不可用不影响巡检主流程（只影响这一层的可达性） */
    }
    return undefined
  }

  /**
   * 把「重试到上限仍不活」送出机器。**通道缺失时如实留痕、不假装已告警**。
   * 决策（何时该告警）在 patrol.ts 纯函数层；本函数只负责送出去（对齐 notify 的 I1「只送不判」）。
   */
  const raisePatrolAlert = (bus: string, ids: string[]): void => {
    if (ids.length === 0) return
    const svc = notifySvc()
    const lines = [
      '庄园存活巡检：以下成员连续拉起 ' + String(cfg.patrolMaxAttempts) + ' 次仍不活，已停止重试：',
      ...ids.map((id) => '· ' + id),
      '（判死阈值 ' + String(Math.round(cfg.patrolDeadAfterMs / 1000)) + 's；重试账 ' + join(bus, 'manor-patrol-state.json') + '）',
    ]
    if (svc === undefined) {
      traceChange(bus, { op: 'patrol-alert-no-channel', ids, reason: 'notify 服务未挂载 ⇒ 告警未出机器' }, 'manor-patrol.jsonl')
      return
    }
    // 不 await：巡检是主流程，告警是旁路；notify 自身保证不抛（其 I5）。
    void svc.alert({ title: '⚠ 庄园成员起不来（' + String(ids.length) + ' 名）', lines, dedupKey: 'manor-patrol-giveup' })
      .catch(() => { traceChange(bus, { op: 'patrol-alert-send-failed', ids }, 'manor-patrol.jsonl') })
  }

  /**
   * 跑一轮巡检。**手动工具与后台定时器共用同一段逻辑**。
   * ⚠ 已知边界：拉起**不是幂等的**——若成员其实活着而心跳恰好过期，会多起一个适配器进程
   * （两个进程争同一个信箱）。`patrolDeadAfterMs` 有意设为 5 分钟（远宽于 30s 心跳）来避免抖动触发。
   */
  const runPatrolOnce = (bus: string, doWake: boolean): { ok: boolean; report: ReturnType<typeof renderPatrol>; decisions: string[]; error: string } => {
    const emptyReport = renderPatrol({ decisions: [], toWake: [], toAlert: [], healthy: [], recovered: [] }, 0, Date.now())
    const loaded = loadRoster(bus)
    if (!loaded.ok) return { ok: false, report: emptyReport, decisions: [], error: loaded.error }
    const errors: string[] = []
    const observations = readObservations(bus, errors)
    const state = loadPatrolState(bus)
    const nowMs = Date.now()
    const p = planPatrol({
      roster: loaded.roster,
      observations,
      state,
      nowMs,
      deadAfterMs: cfg.patrolDeadAfterMs,
      maxAttempts: cfg.patrolMaxAttempts,
      backoffMs: [300000, 900000, 1800000],
    })
    const activeCount = loaded.roster.members.filter((m) => m.status === 'active').length
    const report = renderPatrol(p, activeCount, nowMs)
    const results: { id: string; ok: boolean }[] = []
    if (doWake) {
      for (const id of p.toWake) {
        const r = wakeMember(id, false)
        results.push({ id, ok: r.ok })
        traceChange(bus, { op: 'patrol-wake', id, ok: r.ok, error: r.error }, 'manor-patrol.jsonl')
      }
    }
    for (const id of p.recovered) traceChange(bus, { op: 'patrol-recovered', id }, 'manor-patrol.jsonl')
    for (const id of p.toAlert) traceChange(bus, { op: 'patrol-alert', id, reason: '重试到上限仍不活' }, 'manor-patrol.jsonl')
    // dryRun 不发告警（它不该产生任何对外副作用）
    if (doWake && p.toAlert.length > 0) raisePatrolAlert(bus, p.toAlert)
    savePatrolState(bus, updatePatrolState(state, p, results, nowMs))
    const decisions = p.decisions
      .filter((d) => d.action !== 'ok')
      .map((d) => d.action + ' ' + d.id + '：' + d.reason)
    return { ok: errors.length === 0, report, decisions, error: errors.join(' ｜ ') }
  }

  const patrolTool: ToolDefinition = defineTool({
    name: 'manor_patrol',
    description:
      '**存活巡检**（庄园语义文档 §5.2）：查出哪些在职成员已经死了，并按纪律处置——'
      + '**有界退避**（连续拉起必须推远下次尝试，防崩溃循环紧转轮烧资源）·'
      + ' **上限告警**（重试到上限仍不活 ⇒ 停止重试并告警，不静默也不无限重试）·'
      + ' **恢复即清零**（成员活回来清掉她的重试账，否则下次故障会继承旧账）。'
      + '判「死了」的阈值有意**宽于心跳新鲜阈值**（缺省 5 分钟 vs 30 秒），避免心跳抖动一次就触发拉起。'
      + '`dryRun=true` 只算计划不拉起（用于先看清它打算做什么）。'
      + '后台每 `patrolIntervalMs` 自动跑一轮（`patrolEnabled` 控制）；本工具是**手动入口**，用于验收与排障。',
    parameters: {
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      dryRun: { type: 'boolean', description: '只算计划不拉起（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          busDir: { type: 'string', required: true },
          ranAtMs: { type: 'number', required: true },
          activeCount: { type: 'number', required: true },
          healthyCount: { type: 'number', required: true },
          wokeCount: { type: 'number', required: true },
          alertCount: { type: 'number', required: true },
          skipCount: { type: 'number', required: true },
          decisions: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: { busDir?: string; dryRun?: boolean }) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const dryRun = args.dryRun === true
      const r = runPatrolOnce(bus, !dryRun)
      const head = dryRun ? '（dryRun）巡检计划：' : '巡检已执行：'
      const lines = [head, ...r.report.lines]
      if (dryRun && r.report.wokeCount > 0) lines.push('（dryRun 未拉起任何成员）')
      if (r.error !== '') lines.push('✖ ' + r.error)
      return {
        ok: r.ok,
        dryRun,
        busDir: bus,
        ranAtMs: r.report.ranAtMs,
        activeCount: r.report.activeCount,
        healthyCount: r.report.healthyCount,
        wokeCount: dryRun ? 0 : r.report.wokeCount,
        alertCount: r.report.alertCount,
        skipCount: r.report.skipCount,
        decisions: r.decisions,
        error: r.error,
        rendered: lines.join('\n'),
      }
    },
  })

  // ────────── 任务失败守望（⑥「追」半环）：新增失败要被推出去，不等人来查 ──────────
  // 动机：2026-10-11 做出归因后，那仍然只是「**能查**」——没有谁会在我不去查的时候
  // 告诉我「又失败了三个」。失败率 24.7% 不该靠总女仆长记得去 grep。
  // 四条纪律全在 task-watch.ts 纯函数层：只报新增 / 拒收不报故障 / 未完优先 / 首轮只建基线。

  const taskWatchStatePathOf = (bus: string): string => join(bus, 'manor-task-watch-state.json')

  const loadTaskWatchState = (bus: string, nowMs: number): TaskWatchState => {
    const text = readTextSafe(taskWatchStatePathOf(bus))
    if (text === null) return emptyTaskWatchState(nowMs)
    try {
      return normalizeTaskWatchState(JSON.parse(text), nowMs)
    } catch {
      traceChange(bus, { op: 'task-watch-state-corrupt' }, 'manor-task-watch.jsonl')
      return emptyTaskWatchState(nowMs)
    }
  }

  const saveTaskWatchState = (bus: string, s: TaskWatchState): void => {
    const dest = taskWatchStatePathOf(bus)
    try {
      writeFileSync(dest + '.tmp', JSON.stringify(s, null, 2) + '\n', 'utf8')
      renameSync(dest + '.tmp', dest)
    } catch {
      traceChange(bus, { op: 'task-watch-state-write-failed' }, 'manor-task-watch.jsonl')
    }
  }

  /**
   * 读全量动作日志折台账 —— 与 `manor_tasks` **共用同一条取数路径**（读数不分叉）。
   *
   * ⚠ 2026-10-12 修正（当天引入、当天抓出）：本函数此前**自己读盘**、且调
   *   `foldTasks(events)` **不传裁决** ⇒ 与 `manor_tasks` 的读数**分叉**：
   *   同一个概念（「未完」）在两条读路上算的是不同的东西 —— 一条把已裁决的移走，
   *   另一条让它**在台账里复活**（而后者正是 `manor_task_watch` 的输入）。
   *   ⇒ 改为走 `collectActionEvents`（单一取数路径）+ 接 `loadReaps`。
   *
   * ★ 这个形状（同一决定、多个落点、改一处漏一处）今天已是第三次：
   *   工具面收窄了而**后台循环**照起 · 工具面收窄了而**指路文案**照旧 ·
   *   裁决接进了两条读路而**第三条**没接。⇒ 靠判据兜（见 `tests/reap.test.ts` 的源码级两条）。
   */
  const readAllTasks = (bus: string): { tasks: TaskRecord[]; files: number; error: string } => {
    const { events, files, error } = collectActionEvents(bus)
    if (error !== '') return { tasks: [], files, error }
    // ★ 裁决参与折叠：漏了这一步 ⇒ 已裁决的未完会在这里「复活」
    return { tasks: foldTasks(events, loadReaps(bus).records), files, error: '' }
  }

  // ───────────────────── ③ 依赖面：暂不可发起（hold）─────────────────────
  // 设计理由：docs/manor.md §5.3 / E11（规格由成员「哨」与「澄」给出，逐条已核实）。
  // 纯函数层在 `src/hold.ts`；**IO 层在 `src/hold-store.ts`**（应用层只做接线与留痕）。
  // IO 之所以单独成模块：闭包里的逻辑只能在真插件组合里跑，而这一层每条判据都要能在
  //   **真磁盘状态**上重跑（哨的可证伪形式）⇒ 路径与读数显式入参，可在临时总线上端到端验收。

  /**
   * 账本读数（单一真源：`readAllTasks` 与 `manor_tasks` 共用同一份纯函数）。
   * `hold-store` 不重做这件事 —— 它只吃折好的 `tasks`；`nowMs` **必须显式传**
   * （本层不得依赖「现在几点」这种隐式状态，否则读数不可复现）。
   */
  const holdInputOf = (bus: string, nowMs: number): WorldInput => {
    const face = onlineFace(bus, nowMs)
    return {
      busDir: bus,
      tasks: readAllTasks(bus).tasks,
      heartbeatAgeMs: face.ages,
      onlineFaceOk: face.ok,
      nowMs,
      freshMs: cfg.freshMs,
      deadAfterMs: cfg.holdDeadAfterMs,
      // ★ 宽限按**本机实际的 sweep 周期**算，不写死：sweep 调快了宽限就该跟着快，
      //   否则宽限会盖住真故障（2 个周期 = 容忍一轮 sweep 空转，第二轮还没放就是真卡了）。
      releaseGraceMs: Math.max(DEFAULT_RELEASE_GRACE_MS, config.holdSweepIntervalMs * 2),
    }
  }

  const loadHolds = (bus: string): { records: HoldRecord[]; bad: string[] } => loadHoldsOf(bus)
  const createHold = (bus: string, rec: HoldRecord): string => createHoldOf(bus, rec)
  const updateHold = (bus: string, rec: HoldRecord): string => updateHoldOf(bus, rec)
  const removeHold = (bus: string, taskId: string): string => removeHoldOf(bus, taskId)

  /**
   * **在线面**读数：成员 → 心跳年龄（ms）。
   *
   * ★ 返回 `ok` 而不是「空数组」——「**读不到**」与「**没有人在线**」是两件事。
   *   ⚠ 2026-10-12 活体验收抓出的**根因**：旧版 `catch { return [] }` 把读盘失败吞成空集，
   *   下游据此判「所有依赖的属主都死了」⇒ 一条活被永久标上 `dep-dead`，
   *   而同一份输出里的现读裁决却是 `wait`（属主在线）——**自相矛盾**。
   *   这与本文档反复写的「空 ≠ 读不到」是同一条，落在判定层就是：**未知时不作判**。
   */
  const onlineFace = (bus: string, nowMs: number): {
    ages: Record<string, number>
    /**
     * id → 心跳自述的 `harness`（'' = 没写）。
     *
     * ★ 为什么要在同一趟里带上它（2026-10-12 · 勘当场推翻我的判据）：
     *   我原先用「箱名在不在 `nodes/` 里」判「有没有消费者」—— **判据选错了**。
     *   她的反例：那一刻 `LAPTOP-BF4IAPLM-maid-04-0` **在名册里、正心跳**，
     *   而那两条信是被 **`held`**（`autoInject=false`）⇒ **在册 ≠ 有消费者**。
     *   真判据是「**这个箱有没有唤醒路径**」：只有**庄园适配器**取走才会注入会话，
     *   一个 `autoInject=false` 的 cluster 箱子**在册也照样是死箱**。
     *   ⇒ harness 是这条判据在总线上的**唯一可读来源**（与 `manor_roster` 同一口径）。
     */
    harnesses: Record<string, string>
    ok: boolean
    error: string
  } => {
    const nodesDir = join(bus, 'nodes')
    const ages: Record<string, number> = {}
    const harnesses: Record<string, string> = {}
    let files: string[] = []
    try {
      files = readdirSync(nodesDir).filter((f) => f.endsWith('.json'))
    } catch (e) {
      return { ages, harnesses, ok: false, error: '读不到节点目录 ' + nodesDir + '：' + String(e) }
    }
    let unreadable = 0
    for (const f of files) {
      const id = f.replace(/\.json$/, '')
      const t = readTextSafe(join(nodesDir, f))
      if (t === null) {
        unreadable += 1
        continue
      }
      try {
        const rec = JSON.parse(t) as Record<string, unknown>
        const atMs = typeof rec['atMs'] === 'number' ? (rec['atMs'] as number) : 0
        harnesses[id] = str(rec['harness'], '')
        const j = judgeFresh(atMs, nowMs, cfg.freshMs)
        ages[id] = j.ageMs >= 0 ? j.ageMs : -1   // -1 = 无有效心跳（从未报过/时间戳坏）
      } catch {
        unreadable += 1
      }
    }
    // 一条都读不出 + 目录里确实有文件 ⇒ 也是「读不到」（不当作「都不在线」）
    if (files.length > 0 && unreadable === files.length) {
      return { ages, harnesses, ok: false, error: '节点目录里 ' + String(files.length) + ' 条全部解析失败 ⇒ 在线面不可用' }
    }
    return { ages, harnesses, ok: true, error: '' }
  }

  /**
   * 收集动作日志里的全部事件（**单一取数路径**）。
   *
   * 为什么要抽出来（2026-10-12）：`manor_tasks` 与新增的 `manor_reap` 都要折台账，
   * 各写一份读盘逻辑迟早分叉 —— 而**裁决的合法性正建立在「那条活确实未完」之上**，
   * 两处台账读数不一致 ⇒ 会出现「台账说未完、裁决说它已完成」的死结。
   */
  function collectActionEvents(bus: string): { events: ReturnType<typeof parseActionLog>; files: number; error: string } {
    const dir = join(bus, 'logs', 'actions')
    const events: ReturnType<typeof parseActionLog> = []
    let files = 0
    let error = ''
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        files += 1
        // 单个坏文件不许塌掉整个台账（排障时最需要台账活着）
        try {
          events.push(...parseActionLog(readFileSync(join(dir, f), 'utf8')))
        } catch {
          /* 跳过坏文件，files 仍计数 ⇒ 读数自带「看过几个文件」 */
        }
      }
    } catch (e) {
      error = '读不到动作日志目录 ' + dir + '：' + String(e)
    }
    return { events, files, error }
  }

  /** 一次算全：所有 hold 的依赖视图 + 出口裁决（三处调用共用 ⇒ 读数不分叉）。 */
  const holdView = (bus: string, nowMs: number): ReturnType<typeof holdViewOf> => holdViewOf(holdInputOf(bus, nowMs))

  /** 留痕回调：host 侧唯一落点（`manor-hold.jsonl`）。 */
  const holdTrace = (bus: string) => (obj: Record<string, unknown>): void => {
    traceChange(bus, obj, 'manor-hold.jsonl')
  }

  /**
   * 一轮释放扫描（**常驻方触发**，接线到 `hold-store.sweepHolds`）。
   * 读数的**唯一裁决在 `sweepHolds`**（纯逻辑），本函数只负责把世界现读进来 + 留痕落点。
   */
  const sweepHolds = (bus: string, nowMs: number): SweepResult => sweepHoldsOf({
    ...holdInputOf(bus, nowMs),
    releaseBatch: cfg.holdReleaseBatch,
    trace: holdTrace(bus),
  })

  /** 定时器入口（自己吞异常 —— 插件与宿主同进程，逃逸异常会杀死 web · §5.24）。 */
  const runHoldOnce = (bus: string): void => {
    try {
      sweepHolds(bus, Date.now())
    } catch (e) {
      try {
        traceChange(bus, { op: 'hold-sweep-crashed', error: String(e) }, 'manor-hold.jsonl')
      } catch {
        /* 最后一层兜底 */
      }
    }
  }

  /**
   * 送任务告警出机器。**通道缺失时如实留痕、不假装已告警**（与 `raisePatrolAlert` 同款）。
   * `dedupKey` 带任务 id ⇒ 不同批次不会被 notify 自身去重吞掉。
   */
  const raiseTaskAlert = (bus: string, text: string, taskIds: string[]): boolean => {
    const svc = notifySvc()
    if (svc === undefined) {
      traceChange(bus, { op: 'task-alert-no-channel', taskIds, reason: 'notify 服务未挂载 ⇒ 告警未出机器' }, 'manor-task-watch.jsonl')
      return false
    }
    const lines = text.split('\n')
    const title = lines[0] !== undefined ? lines[0] : '⚠ 庄园任务告警'
    // 不 await：告警是旁路；notify 自身保证不抛（其 I5）
    void svc.alert({ title, lines: lines.slice(1), dedupKey: 'manor-task-watch-' + taskIds.join('|').slice(0, 120) })
      .catch(() => { traceChange(bus, { op: 'task-alert-send-failed', taskIds }, 'manor-task-watch.jsonl') })
    traceChange(bus, { op: 'task-alert-sent', count: taskIds.length }, 'manor-task-watch.jsonl')
    return true
  }

  /**
   * 跑一轮守望。`doNotify=true` 把**新增**告警推出去；`doSave=false`（dryRun）**不落状态**——
   * 否则「先看一眼会报什么」会把状态推走，第二次真跑就什么都不报了。
   */
  const runTaskWatchOnce = (
    bus: string,
    doNotify: boolean,
    doSave = true,
  ): { ok: boolean; plan: TaskWatchPlan; files: number; notified: boolean; error: string } => {
    const nowMs = Date.now()
    const loaded = readAllTasks(bus)
    if (loaded.error !== '') {
      return {
        ok: false,
        plan: planTaskWatch([], loadTaskWatchState(bus, nowMs), nowMs),
        files: loaded.files,
        notified: false,
        error: loaded.error,
      }
    }
    const plan = planTaskWatch(loaded.tasks, loadTaskWatchState(bus, nowMs), nowMs)
    if (doSave) saveTaskWatchState(bus, plan.nextState)
    const text = renderTaskAlerts(plan.alerts)
    const notified = doNotify && text !== ''
      ? raiseTaskAlert(bus, text, plan.alerts.map((a) => a.taskId))
      : false
    return { ok: true, plan, files: loaded.files, notified, error: '' }
  }

  interface TasksArgs { busDir?: string; maxRows?: number; outcome?: string; member?: string }

  const tasksTool: ToolDefinition = defineTool({
    name: 'manor_tasks',
    description:
      '**任务台账**（庄园的作业层）：把动作日志折成「谁派给谁 · 什么状态 · 为什么失败 · 跑了多久」。'
      + '存在理由（2026-10-11 实测）：此前**只有动作日志、没有台账** ⇒ 「派出去的活现在什么状态」要人肉 grep 133 个文件，'
      + '而「失败为什么、该找谁」**无人追**（全量实测失败率 25.7%，系统里没有任何一处把它当指标看）。'
      + '**五个终态严格分开**：`done` 跑完 / `failed` 起了会话但执行失败（超时 · exit≠0）/ '
      + '`rejected` **拒收**（正文为空 · cwd 越界被拒 —— 这是**防线在工作**，不是故障）/ '
      + '`unfinished` 有 start 无终态（**真静默失败**，最该追的一类）/ '
      + '`reaped` **未完但已有裁决**（见 `manor_reap` —— 它**不是未完**，是一个有主的决定）。'
      + '失败率分母只含 done+failed：**拒收、未完、已裁决都不计入**（算进去一个是冤枉防线、一个是编造）。'
      + '★ 每份台账还报 **`nature` 声明面**（`未声明 N / 总数`）—— 那是**取严缺省的点火率**：'
      + '`DEFAULT_TASK_NATURE` 的点火率 **≡ 声明漏写率**（构造决定，不是估计）⇒ 不报这个数，「取严」'
      + '就只是一句**无法检验的主张**（数不出它兜了几次底）。而它非 0 的含义是硬的：声明有洞时，'
      + '缺省取 `owner` 不是加一条噪音，是**把当初要拦的洪水原样放回**（详见 `envelope.ts` 的 `natureDeclaredOf`）。'
      + '⚠ 判据是 `humanText` 前缀而非 `stage`——`stage:"failed"` 同时用于降级警告与拒收（口径坑 C1/C4）。',
    parameters: {
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      maxRows: { type: 'number', description: '明细条数上限（缺省 12）' },
      outcome: { type: 'string', description: '只看某终态：done | failed | rejected | unfinished | reaped' },
      member: { type: 'string', description: '只看某成员（如 maid-03）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          busDir: { type: 'string', required: true },
          files: { type: 'number', required: true },
          total: { type: 'number', required: true },
          done: { type: 'number', required: true },
          failed: { type: 'number', required: true },
          rejected: { type: 'number', required: true },
          unfinished: { type: 'number', required: true },
          reapedDead: { type: 'number', required: true },
          reapedSuperseded: { type: 'number', required: true },
          orphanReaps: { type: 'number', required: true },
          warned: { type: 'number', required: true },
          failureRatePct: { type: 'number', required: true },
          // ★ 取严缺省的点火率分子（见 `TaskSummary.natureUndeclared`）—— 结构化那一半
          natureUndeclared: { type: 'number', required: true },
          // ★ 「这份读数说的是**哪一刻**」—— 时刻作为**数据**（与渲染行同源同一个值）
          asOfMs: { type: 'number', required: true },
          timeout: { type: 'number', required: true },
          execError: { type: 'number', required: true },
          failedTaskIds: { type: 'array', required: true, items: { type: 'string' } },
          /**
           * ★ **失败族**（论文 AREAL-RSI §4.2 复盘三问的原料 · 见 `task-ledger.ts` 的 `FailureCluster`）：
           * 按「失败类型 × 成员」**交叉**聚合 —— `byKind` 与 `byMember` 各自独立时**看不出模式**。
           * 形态：人读行数组（每行一个簇：`<类型> × <成员>：N 条（id, id, …+k）`）。
           * ⚠ 它是**聚合不是归因**（`Comparisons are descriptive`）—— 不许据此说「某成员不行」。
           * ⚠ 口径与 `timeout`/`execError` **不同**：那两个只数**已分类**的失败，本项覆盖**全部失败**
           *   （含未分类者）⇒ **两组数的和本来就不等**，别对账。
           */
          failureClusters: { type: 'array', required: true, items: { type: 'string' } },
          unfinishedTaskIds: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: TasksArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const { events, files, error } = collectActionEvents(bus)
      // ★ 裁决记录参与折叠（2026-10-12）：**历史一个字不改**，裁决是叠在它上面的一层状态。
      const reapLoad = loadReaps(bus)
      const reapErrors = reapLoad.bad.length > 0
        ? '⚠ ' + String(reapLoad.bad.length) + ' 条裁决记录读不出来（**不静默丢**）：' + reapLoad.bad.join('；')
        : ''
      let tasks = foldTasks(events, reapLoad.records)
      const allCount = tasks.length
      const wantOutcome = str(args.outcome, '').trim()
      if (wantOutcome !== '') tasks = tasks.filter((t) => t.outcome === wantOutcome)
      const wantMember = str(args.member, '').trim()
      if (wantMember !== '') tasks = tasks.filter((t) => t.to === wantMember)
      const s = summarizeTasks(tasks)
      // ★ **「过滤后为空」不是「全域为空」**（2026-10-12 实测）：台账有 96 条任务，
      //   而带 `outcome=unfinished` 过滤时渲染说「**没有任何任务记录**（不是「读不到」）」
      //   —— 那句话在**全域非空**时是**撒谎**：它把「这个筛选条件没有命中」
      //   说成了「整个日志里什么都没有」。同一形状（**空必须分型**）在别处已出现多次。
      const filters: string[] = []
      if (wantOutcome !== '') filters.push('outcome=' + wantOutcome)
      if (wantMember !== '') filters.push('member=' + wantMember)
      // ★ **「过滤后为空」不是「全域为空」**（详见 `renderFilteredEmptyNote` 的头注）
      const emptyNote = renderFilteredEmptyNote(filters, allCount, s.total)
      const asOfMs = Date.now()
      // ★ **整份读数只有一个生产者**（`renderLedger`）：抬头 + 前缀 + 正文都由它给全。
      //   修前是「此处拼抬头 + 三处分支配正文」⇒ 「新开一条路径忘了抬头」在导出面上**装得下**。
      //   成员织 2026-10-12 追问「正文渲染器还导出吗」并指出：只要它还能被外部调，那条源码级
      //   枚举式守卫将来照样绿、而新路径没有抬头 ⇒ 治法不是加守卫，是**让它装不下**。
      const prefixes: string[] = []
      if (error !== '') prefixes.push('✖ ' + error)
      if (reapErrors !== '') prefixes.push(reapErrors)
      // ★ 回执面（2026-10-14）：读信箱里的信封，算成摘要段落，**交给同一个生产者**渲染。
      //   保持「整份读数只有一个生产者（`renderLedger`）」这条不变量 —— 此处只**供段落**。
      const receiptLines: string[] = []
      const receipts = readReceipts(bus)
      if (!receipts.ok) {
        receiptLines.push('回执面｜**读不到**（' + receipts.error + '）—— **「读不到」与「没有回执」不是一回事**')
      } else {
        const accMap = new Map<string, string>(tasks.map((t) => [t.taskId, t.acceptance]))
        // ★★ 2026-10-14 真调抓出的**口径分叉**：`t-pwsh-probe-01` 已被裁决 `superseded`，
        //   而回执面修前**仍把它挂在「最该追的一档」** ⇒ 台账报「未完 0」而回执面报「悬空 1」
        //   —— **两个读数对同一件事给了相反答案**。⇒ 读 `reap/` 并**分开报**（不隐藏）。
        const reaped = readReapedIds(bus)
        const rs = summarizeReceipts(accMap, receipts.items, reaped.ok ? reaped.ids : undefined)
        receiptLines.push(
          '回执面｜（**域 = 信箱**，与上一段的**动作日志**不同域；两段**不合流**）'
          + '有回执的任务 ' + String(rs.tasksWithReceipt) + ' 个'
          + ' · 其中**带证据** ' + String(rs.tasksWithEvidence) + ' 个'
          + (rs.tasksWithEmptyEvidence > 0 ? ' · **空手交 ' + String(rs.tasksWithEmptyEvidence) + ' 个**' : ''),
        )
        if (rs.acceptanceWithoutReceipt.length > 0) {
          receiptLines.push(
            '  ⚠ **有判据却无回执** ' + String(rs.acceptanceWithoutReceipt.length)
            + ' 个（判据悬空，最该追的一档）：'
            + rs.acceptanceWithoutReceipt.slice(0, 3).join('、')
            + (rs.acceptanceWithoutReceipt.length > 3 ? ' …' : ''),
          )
        }
        if (rs.acceptanceWithoutReceiptReaped.length > 0) {
          receiptLines.push(
            '  ⚖ **判据悬空但已裁决** ' + String(rs.acceptanceWithoutReceiptReaped.length)
            + ' 个（**不是「没人管」，是有一个有主的决定** —— 同 `manor_reap` 分档纪律）：'
            + rs.acceptanceWithoutReceiptReaped.slice(0, 3).join('、'),
          )
        }
        if (!reaped.ok) {
          receiptLines.push('  ⚠ **裁决面读不到**（' + reaped.error + '）⇒ 本段**不区分**「悬空」与「已裁决」那一档')
        }
        if (rs.receiptWithoutAcceptance.length > 0) {
          receiptLines.push(
            '  ℹ 有回执但派活时没写判据 ' + String(rs.receiptWithoutAcceptance.length) + ' 个（**无法对账**，不是缺陷）',
          )
        }
        // ★ 2026-10-15：**把成员自报的未验证项送到派活方眼前**（论文 arXiv:2610.16117v1
        //   UnCoBench 的「Incomplete」形态 —— 证据「正确但不足」时，主 agent 必须先**诊断缺口**，
        //   而论文实测**强模型也普遍不做**（GPT-5.6 Sol 53.4% / DeepSeek-V4.1-Flash 86.7% 无纠正性追问）。
        //   ⇒ 缺口信息不能只躺在数据里：`unverifiedCount` 早已被 `extractReceipts` 填出，
        //     但**没有任何渲染消费它** ⇒ 这一行补的就是那个显示面（同 `G-adapter-noreload` 的修法）。
        //   ⚠ **空则不出声**（同 `manor_find` 全 fresh 不出声的纪律：退化成每次都有的噪音就等于没有）。
        if (rs.tasksWithUnverified.length > 0) {
          receiptLines.push(
            '  ⚠ **成员自报未验证项** ' + String(rs.tasksWithUnverified.length)
            + ' 个（**她标的**，不是复核结论；也**不等于**判据没满足）：'
            + rs.tasksWithUnverified.slice(0, 3).join('、')
            + (rs.tasksWithUnverified.length > 3 ? ' …' : ''),
          )
        }
        receiptLines.push(
          '  ⚠ 本段只答「**有没有交回证据**」，**不答「判据满没满足」** ——'
          + '后者需要**另一份不是作者写的重建**（收到回执 ≠ 交的东西满足了判据）',
        )
        if (receipts.orphanCount > 0) {
          receiptLines.push(
            '  ⚠ 另有 ' + String(receipts.orphanCount) + ' 封回执**没带 `meta.taskId`**（对不上任何活，**分开报**）',
          )
        }
        if (receipts.bad.length > 0) {
          receiptLines.push('  ⚠ ' + String(receipts.bad.length) + ' 封信封解析失败（**不静默丢**）：' + receipts.bad.slice(0, 2).join('；'))
        }
      }
      const ledgerOpts: { bodyOverride?: string; prefixLines?: readonly string[]; extraLines?: readonly string[] } = {}
      if (emptyNote !== '') ledgerOpts.bodyOverride = emptyNote
      if (prefixes.length > 0) ledgerOpts.prefixLines = prefixes
      if (receiptLines.length > 0) ledgerOpts.extraLines = receiptLines
      const rendered = renderLedger(s, tasks, num(args.maxRows, 12), asOfMs, ledgerOpts)
      return {
        ok: error === '',
        busDir: bus,
        files,
        total: s.total,
        done: s.done,
        failed: s.failed,
        rejected: s.rejected,
        unfinished: s.unfinished,
        reapedDead: s.reaped.dead,
        reapedSuperseded: s.reaped.superseded,
        orphanReaps: s.orphanReaps,
        warned: s.warned,
        failureRatePct: Number((s.failureRate * 100).toFixed(1)),
        natureUndeclared: s.natureUndeclared,
        // ★ 「这份读数说的是哪一刻」—— **机器可读的那一格**（与渲染行同源同一个值）
        asOfMs,
        timeout: s.byKind.timeout,
        execError: s.byKind['exec-error'],
        failedTaskIds: tasks.filter((t) => t.outcome === 'failed').map((t) => t.taskId).slice(0, 20),
        // ★ 失败族（复盘的原料）：**交叉**聚合。渲染走导出的纯函数（渲染逻辑住 execute 里
        //   就不受测试保护——`rowTag` 那条教训）；结构化那一半由 output.schema 声明（漏了会直接报错）。
        failureClusters: renderFailureClusters(s.failureClusters),
        unfinishedTaskIds: tasks.filter((t) => t.outcome === 'unfinished').map((t) => t.taskId).slice(0, 20),
        error,
        rendered,
      }
    },
  })

  interface ReapArgs {
    taskId?: string
    verdict?: string
    reason?: string
    busDir?: string
    dryRun?: boolean
  }

  /**
   * 收尸裁决 —— 把「没人管的未完」变成**有主的决定**（2026-10-12）。
   *
   * 存在理由（实测）：台账报得出一条 `t-pwsh-probe-01`「未完 · 起于 115.6 小时前」
   *   —— **发现机制是好的**（`manor_tasks` 已给年龄与同类参照可对比）；
   *   但**没有任何动作能处置它** ⇒ 缺口在**处置路径**，不在发现。
   *
   * 分层：**事件流是历史，裁决记录是状态**。`logs/actions/*.jsonl` **一个字不改**
   *   （append-only 是它的性质，不是它的缺陷）；裁决另落 `<bus>/reap/<taskId>.json`；
   *   台账 = 历史 ⊕ 裁决 的折叠。
   *
   * 三条硬规矩（**都在写入前校验**，不靠事后自觉）：
   *   ① **只对「未完」生效** —— 先折一遍台账确认它确实有 start 无终态；否则拒
   *      （对已成事实的活收尸是**改口**，不是裁决）。
   *   ② **理由必填** —— 空理由的裁决不是裁决（写入口与读入口都拦）。
   *   ③ **no-clobber** —— 同一条活只能裁决一次：覆盖会让「谁先判的、为什么」消失，
   *      而裁决的全部价值正在于它是**谁的判断**。
   */
  const reapTool: ToolDefinition = defineTool({
    name: 'manor_reap',
    description:
      '**收尸裁决**：给一条**未完**的活作出决定（判死 / 已被取代），把它从「没人管」变成「有主的决定」。'
      + '为什么需要它：台账报得出「未完 1 个 · 起于 115.6 小时前」，但**没有任何动作能处置它** —— '
      + '缺口在处置路径，不在发现；而动作日志是 append-only 的历史，**不该被改**（历史是事实）。'
      + '⇒ 裁决**另落** `<bus>/reap/<taskId>.json`，台账把它折进「已裁决」一档（**不隐藏**：'
      + '收了尸还挂在缺口上，台账就永远显示一条治不好的病；而不显示又会被读成「问题消失了」）。'
      + '**两档不合流**：`dead`（它没做成 ⇒ 可能要重派）· `superseded`（目的已由别的方式达成 ⇒ 不用重做）'
      + '—— 合成一个数就等于替读的人决定「这些要不要重做」。'
      + '⚠ 三条硬规矩：只对「未完」生效 · 理由必填 · no-clobber（同一条活只能裁决一次）。',
    parameters: {
      taskId: { type: 'string', description: '要裁决的 taskId（**必须是台账里「未完」的那一条**，否则拒）' },
      verdict: {
        type: 'string',
        description: '裁决词（闭集）：`dead` 判死（它没做成）| `superseded` 已被取代（目的由别的方式达成）',
      },
      reason: { type: 'string', description: '**必填**：为什么判它死 / 被谁取代（空理由的裁决不是裁决）' },
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      dryRun: { type: 'boolean', description: '只报将写什么，**不落盘**（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          taskId: { type: 'string', required: true },
          verdict: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          path: { type: 'string', required: true },
          dryRun: { type: 'boolean', required: true },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: ReapArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const taskId = str(args.taskId, '').trim()
      const path = join(reapDirOf(bus), reapFileNameOf(taskId))
      const bad = (m: string) => ({
        ok: false, taskId, verdict: '', reason: '', path, dryRun: false, error: m, rendered: '✖ ' + m,
      })
      if (taskId === '') return bad('taskId 必填')

      const verdictRaw = str(args.verdict, '').trim()
      if (!isReapVerdict(verdictRaw)) {
        return bad('verdict 必须是闭集里的一个：' + REAP_VERDICTS.join(' | ')
          + '（收到 `' + verdictRaw + '`）。释义：' + REAP_VERDICTS.map((v) => v + ' = ' + REAP_LABEL[v]).join(' · '))
      }
      const reason = str(args.reason, '').trim()
      if (reason === '') {
        return bad('reason 必填 —— **空理由的裁决不是裁决**（读侧同样会拦：理由空 ⇒ 整条记录判为坏）')
      }

      // ── ① 折一遍台账，确认它**确实未完**（与 `manor_tasks` **同一条取数路径**）──
      const { events, error: readErr } = collectActionEvents(bus)
      if (readErr !== '') return bad(readErr)
      const existing = loadReaps(bus)
      const tasks = foldTasks(events, existing.records)
      const t = tasks.find((x) => x.taskId === taskId)
      if (t === undefined) {
        return bad('台账里找不到 `' + taskId + '`（共 ' + String(tasks.length) + ' 条）'
          + ' —— **不许给不存在的活收尸**：那多半是 taskId 写错了')
      }
      if (t.outcome !== 'unfinished') {
        return bad('`' + taskId + '` 的终态是 `' + t.outcome + '`，**不是「未完」**'
          + ' ⇒ 收尸只对「未完」有意义：完成 / 失败 / 拒收都是**已成事实**，给它们收尸是改口不是裁决')
      }
      if (t.reapVerdict !== '') {
        return bad('`' + taskId + '` 已被裁决过（`' + t.reapVerdict + '`：' + t.reapReason + '）'
          + ' —— no-clobber：覆盖会让「谁先判的、为什么」消失')
      }

      const rec = buildReapRecord({ taskId, verdict: verdictRaw, reason, atMs: Date.now(), by: cfg.selfId })
      if (args.dryRun === true) {
        return {
          ok: true, taskId, verdict: rec.verdict, reason: rec.reason, path, dryRun: true, error: '',
          rendered: '（dryRun）将写裁决：' + path
            + '\n  裁决词：' + rec.verdict + '（' + REAP_LABEL[rec.verdict] + '）'
            + '\n  理由：' + rec.reason
            + '\n  裁决人：' + rec.by
            + '\n  ⇒ 台账里 `' + taskId + '` 的「未完」将不再计入（**不隐藏**：它进「已裁决」一档）',
        }
      }
      const w = writeReap(bus, rec)
      if (w !== '') return bad(w)
      return {
        ok: true, taskId, verdict: rec.verdict, reason: rec.reason, path, dryRun: false, error: '',
        rendered: '✔ 已裁决 `' + taskId + '` · ' + rec.verdict + '（' + REAP_LABEL[rec.verdict] + '）'
          + '\n  理由：' + rec.reason
          + '\n  记录：' + path
          + '\n  ⇒ 台账里的「未完」不再计入它 —— 这是**有主的决定**，不是「问题消失了」',
      }
    },
  })

  interface DisputeArgs {
    action?: string
    artifactId?: string
    subject?: string
    rule?: string
    text?: string
    refs?: string[] | string
    reason?: string
    headline?: string
    dispositions?: string
    side?: string
    verdictBy?: string
    busDir?: string
    dryRun?: boolean
  }

  const disputeTool: ToolDefinition = defineTool({
    name: 'manor_dispute',
    description:
      '**争议登记与裁决**（`R16\'`）：给「两个成员对同一件事意见相左」造一个**可被下一次引用**的落点。'
      + '为什么需要它：这事**已经发生过一次** —— 织判「不变量破了」、哨判「宣称 + 判据缺陷」，'
      + '两人都明写分歧、都不吞，最后由 web-0 读两份后裁决 —— 而那个裁决**只活在散文里**。'
      + '⇒ 后果不是「那次裁错了」，是**下一次没人能引用上一次**。'
      + '**四个动作**：`open`（开争议：artifactId + subject + rule）· `claim`（**每一侧自己写自己那份**）· '
      + '`judge`（落判词，**终局唯一**）· `list`（列全部争议）。'
      + '**两条规则，且一个字段把选择钉住**（混用 = 没有规则）：'
      + '`rule=evidence` ⇒ **函数自己裁**（带可解析 ref 的一侧赢；两侧都有 ref ⇒ 升级给人，'
      + '因为「都有证据」不裁胜负）；`rule=role` ⇒ **函数不代裁**，必须由 `verdictBy` 显式落名 + `side` 指定赢家 + `reason` 说清为什么。'
      + '**三条硬规矩**：`rule=evidence` 时**不许**手写 `side`/`verdictBy` · `rule=role` 时**必须**给三者 · '
      + '终局唯一（`verdict.json` 走 no-clobber ⇒ 并发两方同时裁，后者被拒）。'
      + '★ **零锁**：登记 / 每侧主张 / 终局**都是写一次永不修改的新事实** ⇒ 没有可变对象，'
      + '锁的作用对象不存在（理由见 `src/dispute.ts` 头注 —— 这里与缺件清单①的「与名册同款写入口」有偏离，采纳的是它要保护的性质）。'
      + '⚠ `escalate` **是终态不是失败**：函数给出它能给的全部答案 ——「我无权裁」—— 它**等人给判词**。'
      // ★ 边界声明（2026-10-12 · 由成员织的复核要求）：不写这段，读的人会把「存在性对账」读成「内容对账」，
      //   甚至以为它拦得住人。她 §2.1 的原话：「唯一不能做的是『两个输入都是名字』。」
      + '\n\n★ **痕迹对账（`list` 每条下面那行）能声称什么、不能声称什么**（两条独立判据：**名字** + **内容锚**）：'
      + '三处写入各落一行 `manor-dispute.jsonl`；`dispute-claim` 那一行**还带内容锚**'
      + '（`textDigest` = `text` 的摘要 · `refsCount` = `refs` 条数）。'
      + '**名字对账**抓手搓件（产物里有主张、trace 里没有那一次写入）；'
      + '**锚**抓「产物自 trace 落笔以来被改过」——读数叫「**锚对不上**」。'
      + '**它不能做的（六条 —— 不是免责声明，是判据的域）**：'
      + '① **锚只证明「未被改动」，不证明「经工具写」**：手搓者一开始就照自己的产物算好摘要再一起写'
      + '⇒ 锚**天然自洽，拦不住**。'
      + '② **两层锚的域不同，不许合成一句**：`textDigest` 管 `text` 字节；`refsCount` 管 `refs` 条数 ——'
      + '后者是**漏-字段检测器**（产物与 trace 的两个值同源同一个变量 ⇒ 只拦粗心者），'
      + '对 `text` 改动**零作用**。谁把两层写成一句，谁就会把 `refsCount` 读成内容锚。'
      + '③ **「无 trace」只有两种解释**：手搓，或 trace 写失败 —— **在这里不可区分**，所以它只报事实、不指控。'
      + '④ **「锚对不上」同款**：**不指控是哪一侧被改**（改产物会 mismatch，改/伪造 trace 行**也会**）。'
      + '⑤ **「没落锚」不是「一致」**，是这个问题在这里**问不出来**（旧 trace 行按定义没有锚字段）。'
      + '⚠ 锚**只对 `dispute-claim` 行判定**：`open`/`judge` 行本来就带不了锚 ⇒ 它们**不进这一栏**（不是「缺锚」）。'
      + '★ **反过来的那一半**：手搓者往**同一份 trace** 追一行自写记录（同 `artifactId`、同 `by`）'
      + '⇒ 名字对账**也报不出来**（**trace 不是账本，是总线上又一个文件**：同目录、同权限、读时零校验），'
      + '**而锚也救不了它**（他追的那一行带自己算的摘要，天然自洽）。'
      + '⇒ 「有 trace」只能读作「**trace 里有这个名字的记录**」，**读不成**「这个人经工具写过」。'
      + '⑥ **只防偶然误用，不防有意规避**：trace 与产物**同目录、同权限、无写保护**'
      + '（append-only 是**调用约定**，不是结构）⇒ 删掉那一行 `dispute-open` 就能把整条争议降级成'
      + '「留痕之前开的」（不可判），**成本与手搓同级**。（这是「把假设换成观测」的**递推**问题：'
      + '观测自己也要有成立根据 —— 由织在复核里指出，我判成立。）',
    parameters: {
      action: { type: 'string', description: 'open（开争议）| claim（登记一侧主张）| judge（落判词）| list（列全部）' },
      artifactId: {
        type: 'string',
        description: '争议的 id = **被争议的那件东西**（如 `t-proto-audit-kan` / `hold-recheck-sho`）。'
          + '除 `list` 外必填 —— **不自动生成**：这个 id 正是「裁决可被下一次引用」的锚点，生成一个随机串就把它切断了',
      },
      subject: { type: 'string', description: 'open 必填：争议是关于什么的（一句话）' },
      rule: {
        type: 'string',
        description: 'open 必填（闭集）：`evidence` 按证据（函数能裁）| `role` 按角色（必须人落名）。'
          + '**开争议时定死**，后续 `claim`/`judge` 必须与之一致（不一致 ⇒ 拒）',
      },
      text: { type: 'string', description: 'claim 必填：**你这一侧的**主张（你自己的话，不许替对方写）' },
      refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'claim 可选：证据指针 `path:line`。**空是合法的**（「我这侧没给证据」是事实），'
          + '但在 `rule=evidence` 下空 = 把胜负交给对方 —— 届时结果会如实告诉你这一点',
      },
      reason: { type: 'string', description: 'judge + `rule=role` 必填：为什么这样判（`rule=evidence` 时判词由函数自己写）' },
      dispositions: {
        type: 'string',
        description: 'judge 必填（当有**非赢家侧**时）：**对另一侧每一条主张的逐条处置**，'
          + '每行一条 `<side> | <verdict> | <note>`。闭集：`adopted`（采纳）· `not-adopted`（**不采纳** —— ≠ 驳倒）· `unable`（无法裁）。'
          + '★ 为什么必须有：当事人哨的判据 ——「只要求留原话，判据量到的就是『有没有引文』，而不是『有没有并立』」。'
          + '**只写一句「你那半被并立」不算数**：非赢家侧必须逐条被处置，否则「并立」就退化成写判词那一方的措辞。'
          + '`rule=evidence` 时**不许**传（判词与处置都由函数给）。',
      },
      side: { type: 'string', description: 'judge + `rule=role` 必填：**判谁赢**（必须是已登记某一侧的 `by`，否则拒）' },
      verdictBy: { type: 'string', description: 'judge + `rule=role` 必填：谁裁的（`rule=evidence` 时**不许**传）' },
      headline: {
        type: 'string',
        description: 'judge + `rule=role` 必填：**判词的短结论句**（≤160 字符）—— **引用判词的唯一入口**。'
          + '「引判词 = 引这个字段」⇒ 转述时照抄它，不凭印象复述（这条字段的存在理由：2026-10-12 我在第一次裁决后'
          + '转述时说反了 —— 判词写「不是驳倒，是并立」，我口头说「你是输方」；当事人当场指出：'
          + '**只记成纪律就复现了这条争议本身的形状（结构上装不下 > 靠纪律）**）。`rule=evidence` 时**不许**传（判词由函数写）。',
      },
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      dryRun: { type: 'boolean', description: '只报将写什么，**不落盘**（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          artifactId: { type: 'string', required: true },
          path: { type: 'string', required: true },
          dryRun: { type: 'boolean', required: true },
          error: { type: 'string', required: true },
          total: { type: 'number', required: true },
          open: { type: 'number', required: true },
          decided: { type: 'number', required: true },
          escalated: { type: 'number', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: DisputeArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const action = str(args.action, '').trim().toLowerCase()
      const artifactId = str(args.artifactId, '').trim()
      const dir = artifactId === '' ? disputesRootOf(bus) : disputeDirOf(bus, artifactId)

      /** 计数**每次现算**（不缓存）⇒ 读数与盘上事实同体。 */
      const countsOf = () => {
        const { list } = loadDisputes(bus)
        let open = 0
        let decided = 0
        let escalated = 0
        for (const b of list) {
          if (b.verdict === null) open += 1
          else if (b.verdict.outcome === 'escalated') escalated += 1
          else decided += 1
        }
        return { total: list.length, open, decided, escalated }
      }
      const finish = (ok: boolean, rendered: string, error = '', path = dir, dryRun = false) => {
        const c = countsOf()
        return {
          ok, action, artifactId, path, dryRun, error,
          total: c.total, open: c.open, decided: c.decided, escalated: c.escalated,
          rendered,
        }
      }
      const bad = (m: string) => finish(false, '✖ ' + m, m)

      /* ── list ────────────────────────────────────────────────────── */
      if (action === 'list') {
        const { list, bad: badFiles } = loadDisputes(bus)
        const lines: string[] = ['争议台账（`' + disputesRootOf(bus) + '`）· 共 ' + String(list.length) + ' 条'
          + '（未裁 ' + String(countsOf().open) + ' · 已裁 ' + String(countsOf().decided)
          + ' · 升级待人裁 ' + String(countsOf().escalated) + '）']
        if (list.length === 0) lines.push('（空 —— **这不是「没有分歧」，只是「没有任何一条被登记过」**）')
        // ★ 痕迹对账（补观测面 · 见 `dispute.ts` 头注）：产物侧的主张 ⟷ trace 侧的写入记录。
        //   每轮**现读**（不缓存）⇒ 读数与盘上事实同体，而那正是本读数要看的时刻。
        const trace = loadDisputeTrace(bus)
        if (trace.missing) {
          lines.push('⚠ **痕迹面不可判**：`' + DISPUTE_TRACE_FILE + '` 不在'
            + '（留痕机制上线前 / 文件被删）⇒ 下面「没有 ⚠」**不代表**这些主张都有 trace。')
        }
        if (trace.broken > 0) {
          lines.push('⚠ 痕迹文件有 ' + String(trace.broken) + ' 行读不出来'
            + '（坏行**不抛** —— 一行坏不该带塌整份 trace —— 但它不进对账）')
        }
        for (const b of list) {
          const sides = b.claims.map((c) => c.by).join(' vs ')
          let state: string
          if (b.verdict === null) {
            state = '**未裁**（已登记 ' + String(b.claims.length) + ' 侧：' + (sides === '' ? '（还没有人写主张）' : sides) + '）'
          } else if (b.verdict.outcome === 'escalated') {
            // ★ 短结论句**先出**（它是引用入口）：照抄即可
            const hle = b.verdict.legacyNoHeadline
              ? '⚠ **这条判词早于「短结论句」字段**（schema 演进）⇒ **没有可照抄的短句**，'
                + '引用它时**必须照读下面的完整判词原文**（历史记录不被改写：写一次永不修改是这机制的第一条纪律）'
              : b.verdict.headline
            state = '⚠ **升级待人裁**：' + hle + '\n      （完整判词：' + b.verdict.reason + '）'
          } else {
            // ★ 短结论句是**引用判词的唯一入口** ⇒ 先出，且 legacy 必须显形（不假装它也有短句）
            const hl = b.verdict.legacyNoHeadline
              ? '⚠ **这条判词早于「短结论句」字段**（schema 演进）⇒ **没有可照抄的短句**，'
                + '引用它时**必须照读下面的完整判词原文**（历史记录不被改写：写一次永不修改是这机制的第一条纪律）'
              : '★ 短结论句（引用请照抄）：' + b.verdict.headline
            state = '**已裁**：`' + b.verdict.side + '` 赢（裁决人 ' + b.verdict.verdictBy + '）'
              + '\n      ' + hl
              // ★ 处置面**四种状态都显式说** —— 尤其「空」不能读成「无异议」
              //   （哨：缺格子的**默认读法**必须是「不可数」……**得由结构说，不是由注释说**）
              + (b.dispositionsState === 'complete' && b.verdict.dispositions.length > 0
                ? '\n' + renderDispositions(b.verdict.dispositions)
                : '')
              + (b.dispositionsState === 'legacy-unavailable'
                ? '\n      ⚠ **这条判词早于「处置」字段** ⇒ 它**没有逐条处置任何一侧的主张**'
                  + '（「并立」在当时只是一句措辞，**不可数**）'
                : '')
              + (b.dispositionsState === 'missing'
                ? '\n      ⚠⚠ **异常：这条 v3 判词没有处置清单，而两侧是有主张的** —— '
                  + '写侧本该拦下它（`validateDispositions`），但它多半是**绕过工具直接调 store** 写进去的。'
                  + '\n      ⇒ **不要把「空」读成「无异议」或「并立依旧成立」** —— '
                  + '空在这里的语义是「**这一格本该有东西而它不在**」。'
                : '')
              + '\n      （完整判词：' + b.verdict.reason + '）'
          }
          lines.push('  · `' + b.meta.artifactId + '` [' + b.meta.rule + '] ' + b.meta.subject + ' ⇒ ' + state)
          // ★ 痕迹读数**独立于裁决状态**渲染 —— 已裁争议原本不列 claims
          //   ⇒ 那一侧会**完全不可见**（实测：手搓的 claim 在 `list` 里「消失」，而它明明在盘上）。
          const auditLine = renderTraceAudit(auditClaimTraces(b.claims, trace.events, b.meta.artifactId))
          if (auditLine !== '') lines.push('      ' + auditLine)
          lines.push('    ' + disputeDirOf(bus, b.meta.artifactId))
        }
        if (badFiles.length > 0) {
          lines.push('⚠ **' + String(badFiles.length) + ' 个件读不出来**（原样保留，不覆盖不删）：')
          for (const x of badFiles) lines.push('  · ' + x)
        }
        lines.push('——')
        lines.push('**口径**：`未裁` = 已登记但没有任何判词；`升级待人裁` = 函数给过答案了（「我无权裁」，'
          + '理由在各自记录里）⇒ **这两个数不能合成一个**：前者等**当事人**，后者等**人**。')
        // ★ 口径的**主体**（两层判据各自的域）已**逐条渲染在读数处**（`renderTraceAudit`）——
        //   这里只留「怎么读这一行本身」，不把口径搬到末尾：放末尾一次会让**被摘走的那一块**
        //   失去自证能力，而「被摘走」正是这个读数最常被消费的形态。
        //   判据 = 织 §2.3 的切断测试 D1（我把两个读数贴进协议文档，见 `collab-protocol.md`）。
        lines.push('**痕迹口径**：每条下面那行是**产物 ⟷ trace 对账**（**名字** + **内容锚**两层，逐条自带口径）。'
          + '**没有那一行 = 这条争议还没有任何主张** —— 有主张就一定有一行：'
          + '对账行**无问题时也出**（否则读的人分不清「跑了、没发现问题」与「根本没跑」）。'
          + '`' + DISPUTE_TRACE_FILE + '` 不在 ⇒ 整份 trace 不可判（上面会显式说）。')
        return finish(true, lines.join('\n'), '', disputesRootOf(bus))
      }

      /* ── 其余三个动作都要求 artifactId ────────────────────────────── */
      if (artifactId === '') {
        return bad('artifactId 必填（除 `list` 外）—— 它**不自动生成**：'
          + '争议的 id 就是**被争议的那件东西**，那正是「裁决可被下一次引用」的锚点')
      }
      if (action !== 'open' && action !== 'claim' && action !== 'judge') {
        return bad('action 必须是 `open` / `claim` / `judge` / `list` 之一（收到 `' + action + '`）')
      }

      const { list, bad: badFiles } = loadDisputes(bus)
      const bundle = list.find((b) => b.meta.artifactId === artifactId)
      const refsRaw = Array.isArray(args.refs)
        ? args.refs.map((x) => String(x))
        : (str(args.refs, '').trim() === ''
          ? []
          : str(args.refs, '').split(',').map((x) => x.trim()).filter((x) => x !== ''))

      /* ── open ────────────────────────────────────────────────────── */
      if (action === 'open') {
        const subject = str(args.subject, '').trim()
        const ruleRaw = str(args.rule, '').trim()
        if (subject === '') return bad('subject 必填 —— 关于什么都不知道的争议不是争议')
        if (!isDisputeRule(ruleRaw)) {
          return bad('rule 必须是闭集里的一个：' + DISPUTE_RULES.join(' | ')
            + '（收到 `' + ruleRaw + '`）。释义：' + DISPUTE_RULES.map((r) => r + ' = ' + DISPUTE_RULE_LABEL[r]).join(' · '))
        }
        if (bundle !== undefined) {
          return bad('`' + artifactId + '` 已经开过了（`' + bundle.meta.rule + '`：' + bundle.meta.subject + '）'
            + ' —— no-clobber：覆盖会让「谁先开的、按哪条规则」消失。**要改规则就是另一条争议**')
        }
        const meta: DisputeMeta = { artifactId, subject, rule: ruleRaw, openedBy: cfg.selfId, atMs: Date.now() }
        const path = join(disputeDirOf(bus, artifactId), DISPUTE_META_FILE)
        if (args.dryRun === true) {
          return finish(true, '（dryRun）将写争议登记：' + path
            + '\n  关于：' + subject
            + '\n  规则：' + ruleRaw + '（' + DISPUTE_RULE_LABEL[ruleRaw] + '）'
            + '\n  开的人：' + cfg.selfId
            + '\n  ⇒ 下一步：**每一侧各自** `action=claim` 写自己那份（同侧只能写一次；要改就新开一条争议）',
            '', path, true)
        }
        const w = writeDisputeMeta(bus, meta)
        if (w !== '') return bad(w)
        // ★ 留痕（2026-10-12 · 由成员「织」的一条论点驱动）：修前这三处写入**完全不落任何 trace**
        //   ⇒ 「走正规路径」与「手搓 JSON」在盘上**没有任何可区分之处**。这正是她那句话的实测形态：
        //   「**「不许替对方写」只有在写入路径唯一时才是硬规矩**……其余修法的强度仍挂在『没人绕路』这个假设上」。
        //   ⇒ 这里补的不是防线（拦不住 —— 她有全权限，能写任何文件），是**观测面**：
        //     正规路径有痕、绕路没有 ⇒ 「产物里有主张而 trace 里没有」才成为一个**可看的缺口**。
        //   ⚠ 本节只做**留痕**这一步；**对账**（读这份 trace 并与产物比对）尚未施工 ——
        //     它要处理历史件（留痕之前写的主张全都没有 trace），判据不能把历史读成绕路。
        traceChange(bus, { op: 'dispute-open', artifactId, rule: ruleRaw, by: cfg.selfId }, 'manor-dispute.jsonl')
        return finish(true, '✔ 已开争议 `' + artifactId + '` · ' + ruleRaw + '（' + DISPUTE_RULE_LABEL[ruleRaw] + '）'
          + '\n  关于：' + subject
          + '\n  登记：' + path
          + '\n  ⇒ **每一侧各自** `manor_dispute action=claim`（**不许替对方写**）'
          + ' —— 双方的话都各自落盘，谁都没被吞掉'
          + '\n  ⚠ **但当事人那一侧未必有这把工具**（2026-10-12 由织当场指出）：成员档是**显式白名单**'
          + '（fail-closed），而你在 host 档看得见全部 ⇒ **「她能不能说话」这件事在你的读数里是零**。'
          + '实测代价：本工具落地当天，`manor_dispute` 只进了源、没进成员的可见面 ⇒ '
          + '派给成员的 claim 活 **200 秒后被杀**，而她在自己那侧读到的是 `unknown tool`。'
          + '\n      ⇒ 派活前用 `manor_dispatch`（它会为「正文提到的工具她看不见」就地报警）；'
          // ★ **现算，不写字面量**（2026-10-12 由织当场反问抓出）：
          //   第一版这里是一行硬编码的「成员档今天可见：`manor_claim` · `manor_release` · …」
          //   —— 那行**自己就会开始漂**：加一个成员工具它就过期，而**形状与我刚修的那个一模一样**
          //   （同一个决定两个落点），只是高了一层。她的原话：「若是后者，它自己就会开始漂
          //   —— 形状和我们刚合上的那个一模一样，只是高了一层。」
          + '成员档今天可见（**现算**）：'
          + toolsForRole('member', allTools.map((t) => t.name)).sort().join(' · ') + '。', '', path)
      }

      /* ── claim / judge 都要求争议已存在 ───────────────────────────── */
      if (bundle === undefined) {
        return bad('争议 `' + artifactId + '` 不存在（先 `action=open`）—— '
          + '**不许给一条没登记的争议写主张或判词**：那会让「这是谁的争议」无从回答')
      }
      const meta = bundle.meta

      /* ── claim ───────────────────────────────────────────────────── */
      if (action === 'claim') {
        const text = str(args.text, '').trim()
        if (text === '') return bad('text 必填 —— 空主张不是主张')
        if (bundle.claims.some((c) => c.by === cfg.selfId)) {
          return bad('`' + cfg.selfId + '` 这一侧已经写过主张了，**同一侧只能写一次**'
            + '（要改就是新开一条争议 —— 覆盖会让「当初怎么说的」消失）')
        }
        if (bundle.verdict !== null) {
          return bad('这条争议**已经有判词了**（' + bundle.verdict.outcome + '）⇒ 不再接受新主张：'
            + '判词之后补进来的话，读的人分不清「判词依据的」与「判词之后才说的」')
        }
        if (refsRaw.length > 0) {
          const rc = checkRefs(refsRaw, { exists: (p) => existsSync(p) })
          if (!rc.ok) return bad('refs 有问题：' + rc.bad.join('；'))
        }
        const claim: DisputeClaim = { by: cfg.selfId, atMs: Date.now(), text, refs: refsRaw }
        const path = join(disputeDirOf(bus, artifactId), claimFileNameOf(cfg.selfId))
        const sides = bundle.claims.map((c) => c.by).concat([cfg.selfId]).join(' vs ')
        const noRefWarn = refsRaw.length === 0 && meta.rule === 'evidence'
          ? '\n  ⚠ **你这侧没给 ref**，而规则是 `evidence`：对方若给了可解析的 ref，判词会判对方赢'
            + '（这不是「你说得不对」，是**规则就是数证据的有无**）。有就补，没有就如实留着。'
          : ''
        if (args.dryRun === true) {
          return finish(true, '（dryRun）将写主张：' + path
            + '\n  争议：`' + artifactId + '` [' + meta.rule + '] ' + meta.subject
            + '\n  主张（' + cfg.selfId + '）：' + text
            + '\n  证据：' + String(refsRaw.length) + ' 条' + noRefWarn, '', path, true)
        }
        const w = writeDisputeClaim(bus, artifactId, claim)
        if (w !== '') return bad(w)
        // ★ 留痕（见 open 分支那段）：`by` 是**调用者自己的身份**（`cfg.selfId`），不是参数 ——
        //   所以这行 trace 记的是「**谁**在什么时候写了主张」，而文件名里的 `by` 是产物侧的同一事实。
        //   两处**独立**记录同一件事 ⇒ 它们不一致时才有信息量（对账未施工，见上）。
        // ★ 锚（2026-10-12 · 成员织第三轮的判据，我核过后采纳）：
        //   · `textDigest` —— 唯一对「**事后改 `text`**」有效的锚（写读共用 `digestOf` ⇒ 不可能实现漂移）；
        //   · `refsCount` —— 它是**漏-字段检测器**：产物侧与 trace 侧这两个值来自**同一个变量** `refsRaw`
        //     ⇒ 售价 **×1.5 不是 ×2**，且它对 `text` 改动**零作用**。
        //     谁把这两层写成一句，谁就会把 `refsCount` 读成内容锚（见 `dispute.ts` 内容锚头注）。
        //   ⚠ 改名 `refs` → `refsCount`：`refs` 这个名字在工具 schema 里是**数组**（同名不同义）。
        traceChange(bus, {
          op: 'dispute-claim', artifactId, by: cfg.selfId,
          refsCount: refsRaw.length, textDigest: digestOf(text),
        }, 'manor-dispute.jsonl')
        return finish(true, '✔ 已登记主张（' + cfg.selfId + '）· 争议 `' + artifactId + '`'
          + '\n  现在两侧：' + sides
          + '\n  记录：' + path + noRefWarn
          + '\n  ⇒ 何时裁：`rule=evidence` 时**两侧都写完**才有意义（少于两侧 ⇒ 判词会告诉你那是单方主张）', '', path)
      }

      /* ── judge ───────────────────────────────────────────────────── */
      if (bundle.verdict !== null) {
        return bad('这条争议**已有判词**（' + bundle.verdict.outcome + '：' + bundle.verdict.reason + '）'
          + ' —— **终局唯一**：`verdict.json` 走 no-clobber，两个进程同时裁时后者被拒。'
          + '要重新裁 ⇒ 新开一条争议（保留「上一次是怎么判的」）')
      }
      const sideArg = str(args.side, '').trim()
      const byArg = str(args.verdictBy, '').trim()
      const reasonArg = str(args.reason, '').trim()
      const headlineArg = str(args.headline, '').trim()
      const dispArg = str(args.dispositions, '').trim()

      let verdict: DisputeVerdict
      if (meta.rule === 'evidence') {
        // ★「一个字段把选择钉住」的第一半：选了按证据，就**不许**手写裁决人与赢家。
        if (sideArg !== '' || byArg !== '' || headlineArg !== '' || dispArg !== '') {
          return bad('rule=evidence 的记录**不许**手写 `side` / `verdictBy` / `headline` / `dispositions`'
            + ' —— 「二者混用 = 没有规则」：选了按证据，裁决人、赢家、短结论句与处置**全都由函数给**。'
            + '要按人裁 ⇒ 那是 `rule=role` 的争议（新开一条）')
        }
        const jo = judgeDispute(meta, bundle.claims, {
          refResolvable: (r: string) => checkRefs([r], { exists: (p) => existsSync(p) }).ok,
        })
        const need = jo.kind === 'decided' ? 'decided' : 'escalated'
        const vErr = validateDispositions(need, jo.kind === 'decided' ? jo.side : '', bundle.claims, jo.dispositions)
        if (vErr !== '') return bad('（函数自己产的处置没通过校验 —— 这是本插件的缺陷，请报给爱丽丝）：' + vErr)
        if (jo.kind === 'decided') {
          verdict = {
            outcome: 'decided', headline: jo.headline, legacyNoHeadline: false,
            side: jo.side, verdictBy: jo.verdictBy, reason: jo.reason,
            refs: [], atMs: Date.now(),
            dispositions: jo.dispositions, legacyNoDispositions: false,
          }
        } else {
          verdict = {
            outcome: 'escalated', headline: jo.headline, legacyNoHeadline: false,
            side: '', verdictBy: '', reason: jo.reason,
            refs: [], atMs: Date.now(),
            dispositions: jo.dispositions, legacyNoDispositions: false,
          }
        }
      } else {
        // ★ 第二半：选了按角色，就**必须**人落名 + 指定赢家 + 说清为什么（函数不代裁）。
        if (byArg === '') {
          return bad('rule=role：**必须**给 `verdictBy`（谁裁的）—— 按角色的规则里，权威只能由具名人落名，函数不代裁')
        }
        if (sideArg === '') {
          return bad('rule=role：**必须**给 `side`（判谁赢）—— 「按人裁」是**人来指定赢家**，'
            + '不是「谁裁谁赢」（那会让「裁决人」与「赢家」变成一个东西，分歧就没被回答）')
        }
        if (!bundle.claims.some((c) => c.by === sideArg)) {
          return bad('`side=' + sideArg + '` 不是已登记的任何一侧（现有：'
            + (bundle.claims.length === 0 ? '（还没有人写主张）' : bundle.claims.map((c) => c.by).join(' / '))
            + '）—— **不许判一个不在场的赢家**')
        }
        if (reasonArg === '') {
          return bad('rule=role：**必须**给 `reason`（为什么这样判）—— 没写理由的判词，'
            + '下一次谁也引用不了它，那正是这条规则要消灭的状态')
        }
        // ★ 短结论句**必填且有上限**：它是「引判词的唯一入口」——
        //   我 2026-10-12 转述第一次裁决时说反了（判词「不是驳倒，是并立」→ 我口头「你是输方」），
        //   当事人的反驳是：**只记成纪律就复现了这条争议本身的形状**（结构上装不下 > 靠纪律）。
        if (headlineArg === '') {
          return bad('rule=role：**必须**给 `headline`（判词的**短结论句**，≤ ' + String(HEADLINE_MAX) + ' 字符）'
            + ' —— 它是**引用判词的唯一入口**：转述时照抄它，而不是凭印象复述。'
            + '（这条字段的存在理由见工具描述；缺了它，「留了原话」与「说对原话」之间就没有任何结构在挡。）')
        }
        if (headlineArg.length > HEADLINE_MAX) {
          return bad('`headline` 超长（' + String(headlineArg.length) + ' > ' + String(HEADLINE_MAX) + ' 字符）'
            + ' —— **长句就不再是「可照抄的一句」**，那它就退化成了第二个 `reason`')
        }
        // ★ **处置**：非赢家侧必须逐条被处置（「并立」可数化的落点）
        const parsed = parseDispositionsText(dispArg)
        if (parsed.bad.length > 0) {
          return bad('`dispositions` 有问题（**整批拒，不做部分接受** —— 部分接受会让「写了 3 条只落 2 条」静默发生）：'
            + '\n    ' + parsed.bad.join('\n    ')
            + '\n  格式：每行 `<side> | <verdict> | <note>`；处置词闭集：' + DISPOSITION_VERDICTS.join(' / '))
        }
        const vErr = validateDispositions('decided', sideArg, bundle.claims, parsed.list)
        if (vErr !== '') return bad(vErr)
        verdict = {
          outcome: 'decided', headline: headlineArg, legacyNoHeadline: false, side: sideArg, verdictBy: byArg,
          reason: '按角色裁定（由 ' + byArg + ' 落名）：' + reasonArg,
          refs: [], atMs: Date.now(),
          dispositions: parsed.list, legacyNoDispositions: false,
        }
      }

      // ★ 新写的判词**永远不是 legacy**（`legacyNoHeadline` 只用于读回 schema 演进之前的老记录）
      verdict.legacyNoHeadline = false
      const vPath = join(disputeDirOf(bus, artifactId), DISPUTE_VERDICT_FILE)
      const head = verdict.outcome === 'decided'
        ? '✔ 已裁 `' + artifactId + '`：**`' + verdict.side + '` 赢**（裁决人 ' + verdict.verdictBy + '）'
        : '⚠ `' + artifactId + '` **升级待人裁** —— 函数判不了，给出的是它能给的全部答案：「我无权裁」'
      const body = '\n  争议：[' + meta.rule + '] ' + meta.subject
        + '\n  两侧：' + (bundle.claims.length === 0
          ? '（**还没有人写主张** —— 判词是在零主张上作出的，这本身是个读数）'
          : bundle.claims.map((c) => c.by + '（' + String(c.refs.length) + ' 条 ref）').join(' vs '))
        + '\n  ★ **短结论句（引用判词请照抄这一行，不要凭印象复述）**：' + verdict.headline
        + '\n  判词：' + verdict.reason
        + (verdict.dispositions.length > 0 ? '\n' + renderDispositions(verdict.dispositions) : '')
        + '\n  记录：' + vPath
      if (args.dryRun === true) return finish(true, '（dryRun）' + head.replace('✔ 已裁', '将裁').replace('⚠', '将升级') + body, '', vPath, true)
      const w = writeDisputeVerdict(bus, artifactId, verdict)
      if (w !== '') return bad(w)
      // ★ 留痕（见 open 分支那段）：判词是**终局**（`verdict.json` 走 no-clobber）⇒
      //   trace 里这行是「谁在什么时候落了判词」的唯一时间线；产物只保留终局那一份。
      traceChange(bus, {
        op: 'dispute-judge', artifactId, outcome: verdict.outcome,
        side: verdict.side, verdictBy: verdict.verdictBy,
      }, 'manor-dispute.jsonl')
      return finish(true, head + body
        + '\n  ⇒ **下一次遇到同类分歧，引用它**：`manor_dispute action=list` 一条命令列得出来，'
        + '理由与裁决人都在记录里 —— 这就是「可被引用」与「活在散文里」的区别', '', vPath)
    },
  })

  interface TaskWatchArgs { busDir?: string; dryRun?: boolean }

  const taskWatchTool: ToolDefinition = defineTool({
    name: 'manor_task_watch',
    description:
      '**任务失败守望**（⑥ 治理的「追」半环）：只把**新增**的失败/静默失败推出去，不等人来查。'
      + '与 `manor_tasks` 的分工：后者答「现在什么状态」（**拉**），本工具做「新增了要喊一声」（**推**）——'
      + '两者共用同一份台账纯函数，读数不会分叉。'
      + '四条纪律：**W1 只报新增**（同一任务只通报一次，防重复告警淹掉通道）· '
      + '**W2 拒收不报故障**（拒收是防线在工作）· **W3 未完优先**（静默失败比失败更值得喊）· '
      + '**W4 首轮只建基线**（首次运行不报，否则启用瞬间会把全部历史失败一次性推出去）。'
      + '`dryRun=true` 只算计划：**不落状态、不发送**（先看清它会报什么）。',
    parameters: {
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      dryRun: { type: 'boolean', description: '只算计划（不落状态、不发送）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          busDir: { type: 'string', required: true },
          files: { type: 'number', required: true },
          seeded: { type: 'number', required: true },
          freshAlerts: { type: 'number', required: true },
          totalFailed: { type: 'number', required: true },
          totalUnfinished: { type: 'number', required: true },
          rejectedSeen: { type: 'number', required: true },
          notified: { type: 'boolean', required: true },
          freshTaskIds: { type: 'array', required: true, items: { type: 'string' } },
          error: { type: 'string', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: TaskWatchArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const dryRun = args.dryRun === true
      const r = runTaskWatchOnce(bus, !dryRun, !dryRun)
      const p = r.plan
      const lines: string[] = []
      lines.push(dryRun ? '（dryRun）任务守望计划：' : '任务守望已跑：')
      lines.push('  看过 ' + String(r.files) + ' 个日志文件 · 全局 失败 ' + String(p.totalFailed)
        + ' · 未完 ' + String(p.totalUnfinished) + ' · 拒收 ' + String(p.rejectedSeen) + '（拒收不报）')
      if (p.seeded > 0) {
        lines.push('  ⓘ 首轮建基线：登记 ' + String(p.seeded) + ' 条既有失败，**本轮不告警**（防启用瞬间刷屏）')
      }
      const text = renderTaskAlerts(p.alerts)
      if (text !== '') lines.push(text)
      else if (p.seeded === 0) lines.push('  ✔ 无新增失败（**要推给主人的那档**）')
      // ★ W6（2026-10-12）：**不推的那些也要在这里说清** —— 「不推」不等于「不记」。
      //   少了这一段，读工具的人会以为「内部失败没发生」（而它明明在台账里）。
      if (p.quietAlerts.length > 0) {
        const byNature = new Map<string, number>()
        for (const a of p.quietAlerts) byNature.set(a.nature, (byNature.get(a.nature) ?? 0) + 1)
        lines.push('  ⓘ 另有 ' + String(p.quietAlerts.length) + ' 条新增失败**按 `nature` 没推**：'
          + [...byNature.entries()].map(([k, v]) => k + ' ' + String(v)).join(' · ')
          + '\n     （`internal` / `probe` = 庄园内部试错 ⇒ 只进台账，**不打扰主人**；'
          + '明细看 `manor_tasks outcome=failed` —— **它们照样是失败，只是不推**）')
      }
      if (r.notified) lines.push('  ⇒ 告警已送出机器')
      else if (text !== '' && dryRun) lines.push('  （dryRun 未发送）')
      if (r.error !== '') lines.push('✖ ' + r.error)
      return {
        ok: r.ok,
        dryRun,
        busDir: bus,
        files: r.files,
        seeded: p.seeded,
        freshAlerts: p.alerts.length,
        totalFailed: p.totalFailed,
        totalUnfinished: p.totalUnfinished,
        rejectedSeen: p.rejectedSeen,
        notified: r.notified,
        freshTaskIds: p.alerts.map((a) => a.taskId),
        error: r.error,
        rendered: lines.join('\n'),
      }
    },
  })

  // 后台定时器：模块级单例（防热重载残留双定时器）。整个 tick 包在 try/catch 里——
  // 插件与宿主同进程，**逃逸异常会直接杀死 web**（AGENTS.md §5.24）。
  // 一轮 tick 做两件事（存活巡检 + 任务守望）：共用一个定时器，避免多定时器互相踩；
  // 但**各自独立 try/catch**——一件事炸了不该带着另一件一起停摆。
  // ★ 判据：**只有 host 档承载后台循环**（`roleCaps` 单一真源 · §5.19 单点所有权）。
  //   成员挂上本插件后若也起巡检 ⇒ N 个进程同时拉人、失败告警重复送给主人、巡检账并发写。
  if (roleCaps(config.role).backgroundLoops && config.patrolEnabled && patrolTimer === null) {
    patrolTimer = setInterval(() => {
      try {
        runPatrolOnce(cfg.busDir, true)
      } catch (e) {
        try {
          traceChange(cfg.busDir, { op: 'patrol-crashed', error: String(e) })
        } catch {
          /* 最后一层兜底：连留痕都失败时也不能让异常逃逸 */
        }
      }
      try {
        runTaskWatchOnce(cfg.busDir, true)
      } catch (e) {
        try {
          traceChange(cfg.busDir, { op: 'task-watch-crashed', error: String(e) }, 'manor-task-watch.jsonl')
        } catch {
          /* 同上 */
        }
      }
    }, Math.max(30000, config.patrolIntervalMs))
    if (typeof patrolTimer.unref === 'function') patrolTimer.unref()
    // ★★ 2026-10-14 **启动即补一轮**（§5.11 规则 5「定时机制防重启吞」）——
    //   现读抓出的**不对称**：`holdTimer` 早有这一条（见下方），**patrolTimer 没有**
    //   ⇒ 每轮 web 重启后巡检干等满一个周期（缺省 5 分钟），停机期间死掉的成员
    //   **多躺最多 5 分钟**。判据落在纯函数 `shouldRunOnBoot`（可离线测 + 尸体样本）。
    //   ⚠ 不是「启动就无条件跑」—— 那会让热重载/快速连重启变成紧转轮（同 §5.17 精神）。
    try {
      const bootState = loadPatrolState(cfg.busDir)
      const interval = Math.max(30000, config.patrolIntervalMs)
      const fired = shouldRunOnBoot(bootState.lastRunAtMs, Date.now(), interval)
      // ★★ **无论跑不跑都留痕**（2026-10-14 当场抓出的可观测缺口）：
      //   原版只在**触发**时留痕 ⇒ 不触发时**没有任何证据证明这段代码跑过**，
      //   于是「守卫正确拦住了」与「这段代码根本没接线」在盘上**同貌**。
      //   ⇒ 加 `fired` 字段：两种世界各有自己的读数（与 `natureDeclared` 同款纪律）。
      traceChange(cfg.busDir, {
        op: 'patrol-boot-catchup',
        fired,
        lastRunAtMs: bootState.lastRunAtMs,
        elapsedMs: Date.now() - bootState.lastRunAtMs,
        intervalMs: interval,
      }, 'manor-patrol.jsonl')
      if (fired) runPatrolOnce(cfg.busDir, true)
    } catch (e) {
      try {
        traceChange(cfg.busDir, { op: 'patrol-boot-catchup-failed', error: String(e) })
      } catch {
        /* 最后一层兜底：连留痕都失败时也不能让异常逃逸（§5.24） */
      }
    }
  }

  // ③ 依赖面的释放循环 —— **常驻方触发**（澄：释放由常驻方触发，不让被挂起的人自己爬出来）。
  // 独立定时器 + 独立 try/catch（`runHoldOnce` 自己吞异常）。
  if (roleCaps(config.role).backgroundLoops && config.holdEnabled && holdTimer === null) {
    // 启动即补一轮（§5.11 规则 5：定时机制防重启吞 —— 停机期间就绪的活不该再等一个周期）
    runHoldOnce(cfg.busDir)
    holdTimer = setInterval(() => { runHoldOnce(cfg.busDir) }, Math.max(30000, config.holdSweepIntervalMs))
    if (typeof holdTimer.unref === 'function') holdTimer.unref()
  }

  interface StrandedBusArgs {
    busDir?: string
    maxRows?: number
  }

  /**
   * **总线全域搁浅件**（`E14`）：`manor_find` 覆盖不到的那一半。
   *
   * 判据（**两层同时成立**）：「**有节点身份**（`nodes/` 里有它 ⇒ 有进程在轮询）**且**
   *   **取了会注入**（心跳自述 `harness` 是庄园适配器）」。
   * ⚠ 2026-10-12 由勘**当场纠正**过一版：我原先只判第一层（在不在 `nodes/` 里），
   *   而她的反例是「**在册、正心跳，信照样被 held**」（`autoInject=false` ⇒ 取了不注入）
   *   ⇒ **在册 ≠ 有消费者**。
   * ⚠ 这一格**不是价值判断**（织的分层：**可处置性是事实，重要性是价值**）。
   */
  const strandedBusTool: ToolDefinition = defineTool({
    name: 'manor_stranded',
    description:
      '看**总线全域**的搁浅件 —— `manor_find` 只看**成员信箱**，这是它覆盖不到的那一半。'
      + '按**可处置性**分两格：① **箱有消费者**（件会被搭车取走：投递即移出）'
      + '② **⚠ 箱没有消费者**（没有进程在读那个箱 ⇒ 件**不会被取**）。'
      + '★ 判据是「**心跳自述的 `harness` 是不是庄园适配器**」—— 两层同时成立才算有消费者：'
      + '**有节点身份**（有进程在轮询）**且取了会注入会话**。'
      + '⚠ 只判第一层是错的（2026-10-12 勘的反例：**在册、正心跳，信照样被 `held`** ⇒ **在册 ≠ 有消费者**）。'
      + '★ 那是**可算的事实，不是价值**（织的分层）。'
      + '★★ 2026-10-14 新增**第二条独立事实**（`G-strand` 机制化 · 勘给的升级方向落地）：'
      + '① **今天有没有消费者**（读 `nodes/` 心跳自述 `harness`）· '
      + '② **历史上入站通没通**（读 `state/<箱>.tasks.json` 的 `handled`）。'
      + '⚠ **两条不许合并** —— 勘的反例正是「今天有消费者 ∧ 入站从未通」。'
      + '投递面**四态**（互不掩盖：「读不到」不许读成「没有」）：'
      + '**无庄园适配器注册**（无 state 文件 —— ⚠ **≠「没人来过」**：别的消费者不写这个文件）· '
      + '**入站从未通**（有 state、`handled` 空）· '
      + '**入站通过**（`handled` >0）· **未知**（state 目录读不到 ⇒ 不作判）。'
      + '★ **两条判据分叉时必须显形**（真调抓出的形状）：state 面说无庄园适配器 ∧ `done/` 有归档 ⇒ '
      + '分叉**本身就是信息** —— 它证明「**那个消费者不是庄园适配器**」（state 面结构上看不见它）。'
      + '⚠ 它仍**答不了「件为什么没被取走」**（`held` / 报错 / 刚起还没轮到，三者同貌）。'
      + '★ **要先处置的是箱**，但 ⚠ **件不能跟着箱一起消失**：箱的决定（留/废）做完后，'
      + '件的落点**还要跟一次** —— 否则「箱没了」会把「件去哪」一起吞掉（另一种不可见面）。'
      + '★ 名册读不到时**不作判**（照报件数，但「哪些箱有消费者」标**未知**）。只读、零副作用。',
    parameters: {
      busDir: { type: 'string', description: '总线根（缺省用插件配置）' },
      maxRows: { type: 'number', description: '每格明细条数上限（缺省 8）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          busDir: { type: 'string', required: true },
          /** 名册读不到 ⇒ **不作判**（「未知」不是「都没有」） */
          unknownFace: { type: 'boolean', required: true },
          boxes: { type: 'number', required: true },
          total: { type: 'number', required: true },
          withConsumerItems: { type: 'number', required: true },
          noConsumerItems: { type: 'number', required: true },
          noConsumerBoxes: { type: 'number', required: true },
          /** ★ 2026-10-14：投递面四态计数（与 `noConsumer*` **是两条独立的事实**，不许合并） */
          noAdapterBoxes: { type: 'number', required: true },
          neverDeliveredBoxes: { type: 'number', required: true },
          deliveredBoxes: { type: 'number', required: true },
          unknownDeliveryBoxes: { type: 'number', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => [{ type: 'text', text: String((value as Record<string, unknown>)['rendered']) }],
    },
    async execute(args: StrandedBusArgs) {
      const rawBus = str(args.busDir, '').trim()
      const bus = rawBus !== '' ? resolve(rawBus) : cfg.busDir
      const maxRows = num(args.maxRows, 8)
      const nowMs = Date.now()
      const errors: string[] = []
      const boxes: BusBox[] = []
      let names: string[] = []
      try {
        names = readdirSync(join(bus, 'mailbox'), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      } catch (e) {
        errors.push('读不到 mailbox 目录：' + String(e))
      }
      for (const box of names) {
        const dir = join(bus, 'mailbox', box)
        let files: string[] = []
        try {
          files = readdirSync(dir).filter((n) => n.endsWith('.json'))
        } catch {
          continue
        }
        const items: BusItem[] = []
        for (const n of files) {
          let raw: Record<string, unknown> = {}
          try {
            raw = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>
          } catch {
            continue // 坏文件不阻断整轮（与 loadHolds 同纪律）
          }
          if (raw === null || typeof raw !== 'object') continue
          items.push({
            file: n,
            kind: typeof raw['kind'] === 'string' ? raw['kind'] : '(无 kind)',
            from: typeof raw['from'] === 'string' ? raw['from'] : '',
            createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : 0,
          })
        }
        if (items.length > 0) {
          // ★ `done/` 归档数 —— **旁证**（由织复核点名「声明了能力没接线」后补上）：
          //   `> 0` ⇒ 历史上确实有消费者在这个箱上工作过；`= 0` ⇒ **证明不了什么**
          //   （新箱也会是 0）⇒ 它**只作旁证，不作判据**（判据是「心跳自述 harness 是不是庄园适配器」）。
          let doneCount = 0
          try {
            doneCount = readdirSync(join(dir, 'done')).filter((n) => n.endsWith('.json')).length
          } catch {
            doneCount = 0 // 没有 done/ 目录 ⇒ 0（同上：旁证，不作判）
          }
          // ★ 2026-10-14 **第二条事实**（`G-strand` 机制化 · 勘给的升级方向落地）：
          //   `doneCount` 只是旁证；**直接证据**是 `state/<箱>.tasks.json`（`adapter.mjs:116`
          //   定死 `nodeId + '.tasks.json'`）—— 它由适配器每轮写（`adapter.mjs:695`）⇒
          //   文件在 = **适配器进程以这个 nodeId 活过**。`handled` 非空 = **入站真的通过**。
          //   ⚠ 三态**不可合并**：目录读不到 ⇒ `statePresent = undefined`（**不作判**），
          //     不许并进 `false`（那会把「我读不到」读成「它不存在」）。
          let statePresent: boolean | undefined
          let handledCount = 0
          try {
            const stRaw = readFileSync(join(bus, 'state', box + '.tasks.json'), 'utf8')
            const st = JSON.parse(stRaw) as Record<string, unknown>
            statePresent = true
            handledCount = Array.isArray(st['handled']) ? st['handled'].length : 0
          } catch (e) {
            // ★ 区分「文件不存在」与「目录读不到」——**这是本条纪律的全部要害**。
            const code = (e as { code?: string } | null)?.code
            statePresent = code === 'ENOENT' ? false : undefined
            if (statePresent === undefined) errors.push('state 面读不到（' + box + '）：' + String(e))
          }
          boxes.push({ box, items, doneCount, statePresent, handledCount })
        }
      }
      // ★ 判据的数据源：`nodes/` 的 id 集合（`onlineFace` 的键）。
      //   ⚠ 它答的是「**这个箱今天有没有身份**」，**不是**「历史上有没有人来过」——
      //     「不在 nodes/」可能由四种原因压出（织标的），所以措辞取「没有消费者」，不取「永不可处置」。
      const face = onlineFace(bus, nowMs)
      // ★ 判据被勘当场纠正（2026-10-12）：原先用「箱名在不在 `nodes/` 里」——
      //   反例：那一刻那个 id **在名册里、正心跳**，信照样烂在箱里（被 held，`autoInject=false`）
      //   ⇒ **在册 ≠ 有消费者**。换成「**心跳自述是庄园适配器**」的 id 集（= 有唤醒路径的箱子）。
      const knownIds = wakePathIds(face.harnesses)
      const result = classifyBoxes(boxes, knownIds)
      const rendered = renderStrandedBus(result, nowMs, {
        maxRows,
        unknownFace: !face.ok,
        faceError: face.error,
      })
      const wcItems = result.withConsumer.reduce((n, b) => n + b.items.length, 0)
      const ncItems = result.noConsumer.reduce((n, b) => n + b.items.length, 0)
      // ★ 投递面四态计数：**只数有件的箱**（空箱不占视野，与渲染层同口径）
      const ncWithItems = result.noConsumer.filter((b) => b.items.length > 0)
      const faceCount = (f: string): number => ncWithItems.filter((b) => b.delivery === f).length
      // 直接返回全字段对象（`dsh-tools` 按 schema **严格校验**，缺字段即拒）
      return {
        ok: true,
        busDir: bus,
        unknownFace: !face.ok,
        boxes: boxes.length,
        total: result.total,
        withConsumerItems: wcItems,
        noConsumerItems: ncItems,
        noConsumerBoxes: ncWithItems.length,
        noAdapterBoxes: faceCount('no-adapter'),
        neverDeliveredBoxes: faceCount('never-delivered'),
        deliveredBoxes: faceCount('delivered'),
        unknownDeliveryBoxes: faceCount('unknown'),
        errors,
        rendered: rendered === '' ? '✔ 全域无搁浅件（每个箱的顶层都空了）' : rendered,
      } as any
    },
  })

  // ★ 工具面分档（2026-10-12 · 由 E12 暴露出的真障碍）：成员跑在**独立数据面**里
  //   （`--dsHome E:\alice-nodes\maid-0N\.dsh`），而她们的 profile **没挂 `dsh-manor`**
  //   ⇒ 「不注册」对她们就等于「**这个工具不存在**」。
  //   分档表在 `toolsForRole`（单一真源，被测试钉住）；`member` 档是**白名单**
  //   ⇒ 新增工具**默认对成员不可见**（fail-closed：某天加一个管理工具，
  //   它不会静默出现在成员的工具面里）。
  const allTools = [
    findTool, dispatchTool, holdsTool, claimTool, releaseTool,
    wakeTool, membersTool, hireTool, retireTool, assignTool,
    patrolTool, tasksTool, reapTool, disputeTool, taskWatchTool, strandedBusTool,
  ]
  const keep = new Set(toolsForRole(cfg.role, allTools.map((t) => t.name)))
  for (const t of allTools) if (keep.has(t.name)) ctx.tools.register(t)
}
