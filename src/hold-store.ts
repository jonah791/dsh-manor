/**
 * `hold` 的 **IO 层** —— 落盘、读盘、释放、扫描（③ 依赖面）。
 *
 * 为什么单独成模块（不是塞在 `index.ts` 的 `apply` 闭包里）：
 *   闭包里的逻辑**只能在真插件组合里跑**，而这一层的每条判据都要能在**真磁盘状态**上重跑
 *   （哨的可证伪形式：「拿这条活与依赖活两个活的真实状态重跑一遍解释器，要得到同一句话」）。
 *   ⇒ 路径与读数全部**显式入参**，不读全局配置 ⇒ 可以在临时总线上做端到端验收
 *   （`tests/hold-store.test.ts` 就是这么干的）。
 *
 * 三条不可动的约束（各自都有测试钉着）：
 *   ① **记录只存指针**（`dependsOn` 的 taskId），**绝不缓存依赖的当前状态** ——
 *      否则「为什么还没跑」就变成「我怎么记的」，错了照着错译一遍且永远可复核（哨）。
 *   ② **释放由常驻方触发**（插件里的定时器），**不让被挂起的人自己爬出来**（澄）。
 *   ③ **投递即移出 + 确定性信封 id** ⇒ 释放是**幂等**的：重复释放撞 `wx` 即知已投过。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnvelope, holdEnvelopeId } from './envelope.ts'
import {
  HOLD_DIRNAME,
  buildTraceLine,
  depStateOf,
  judgeWorld,
  parseHoldFile,
  reverseScan,
  serializeHold,
  sortHolds,
  type ExitJudgement,
  type HoldRecord,
  type WorldView,
} from './hold.ts'
import type { TaskRecord } from './task-ledger.ts'

/** 读文件，读不到返回 null（**不抛**：单个坏文件不该带塌整轮扫描）。 */
const readTextSafe = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export const holdDirOf = (busDir: string): string => join(busDir, HOLD_DIRNAME)

/** 读全部 hold 记录。**坏记录 fail-loud 收集、不静默丢弃**（「读不到」≠「不在」）。 */
export function loadHolds(busDir: string): { records: HoldRecord[]; bad: string[] } {
  const dir = holdDirOf(busDir)
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return { records: [], bad: [] } // 目录不存在 = 没有任何挂起项（首次使用的常态）
  }
  const records: HoldRecord[] = []
  const bad: string[] = []
  for (const n of names) {
    const text = readTextSafe(join(dir, n))
    if (text === null) {
      bad.push(n + '：读不到')
      continue
    }
    const p = parseHoldFile(text)
    if (!p.ok || p.record === null) {
      bad.push(n + '：' + p.error)
      continue
    }
    records.push(p.record)
  }
  return { records, bad }
}

/** 落一条**新的** hold（`wx`：撞 id 即失败 —— 绝不静默覆盖一条已存在的挂起项）。 */
export function createHold(busDir: string, rec: HoldRecord): string {
  const dir = holdDirOf(busDir)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, rec.taskId + '.json'), serializeHold(rec), { encoding: 'utf8', flag: 'wx' })
    return ''
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'EEXIST') return '已有一条同 taskId 的挂起项（' + rec.taskId + '）——先处置它，或用别的 taskId'
    return '写 hold 失败：' + String(e)
  }
}

/** 改一条已有 hold（原子替换；只用于写 `escalated` 留痕）。 */
export function updateHold(busDir: string, rec: HoldRecord): string {
  const dest = join(holdDirOf(busDir), rec.taskId + '.json')
  try {
    writeFileSync(dest + '.tmp', serializeHold(rec), 'utf8')
    renameSync(dest + '.tmp', dest)
    return ''
  } catch (e) {
    return '改 hold 失败：' + String(e)
  }
}

/** 移出一条 hold（释放成功后调用）。**移出失败不致命**：下一轮靠确定性 id 收敛。 */
export function removeHold(busDir: string, taskId: string): string {
  try {
    unlinkSync(join(holdDirOf(busDir), taskId + '.json'))
    return ''
  } catch (e) {
    return '移出 hold 失败：' + String(e)
  }
}

/** `buildWorldView` 的入参：**全部显式**（不读全局配置 ⇒ 可在临时总线上重跑）。 */
export interface WorldInput {
  busDir: string
  /** 账本读数（调用方用 `parseActionLog` + `foldTasks` 折出来 —— 单一真源，本层不重做） */
  tasks: TaskRecord[]
  /**
   * 成员 → 心跳年龄（ms）；`-1` = 无记录。
   * ★ **带年龄而不是布尔**：判活取窄（`freshMs`）、判死取宽（`deadAfterMs`），中间地带**不作判**。
   */
  heartbeatAgeMs: Record<string, number>
  /**
   * ★ 这一轮**读到在线面了吗**。`false` ⇒ 整轮**不作判**（不释放、不升级）——
   * 「读不到」不是「都不在线」。**由调用方给**：读盘失败必须在那一侧就区分出来，不能吞成空集。
   */
  onlineFaceOk: boolean
  /**
   * 判定时刻。**必须显式给**——本层不做 `Date.now()`
   * （§「无隐式状态依赖」：取数路径不得依赖「现在几点」这种隐式状态，否则读数不可复现）。
   */
  nowMs: number
  /** 判活阈值（缺省 30s） */
  freshMs?: number
  /** 判死阈值（缺省 5min）—— **有意宽于 `freshMs`**，与 `manor_patrol` 同纪律 */
  deadAfterMs?: number
  /**
   * **释放宽限**：依赖完成后**至少**等过这么久才可能被 sweep 释放 ⇒ 反向扫描在宽限内**沉默**
   * （2026-10-12 真活实测：缺这一格，sweep 未到的那一轮会连报两次假异常）。
   * 调用侧按 `sweepIntervalMs` 算（`max(缺省, 2 × sweepIntervalMs)`）—— 本层只透传，缺省归纯判定层。
   */
  releaseGraceMs?: number
}

/**
 * 现读「可观测世界」（hold 判定与解释的**唯一输入**）。
 * 顺序即权威顺序：**账本（真发生过什么） > 信箱顶层（还没被取） > hold（本身在等）**。
 */
export function buildWorldView(i: WorldInput): { world: WorldView; notes: string[] } {
  const notes: string[] = []
  if (!i.onlineFaceOk) notes.push('在线面这一轮读不到（总线 nodes/）⇒ 依赖判定**不作判**')
  const world: WorldView = {
    ledger: {}, queued: {}, held: {},
    heartbeatAgeMs: i.heartbeatAgeMs,
    onlineFaceOk: i.onlineFaceOk,
  }
  for (const t of i.tasks) {
    world.ledger[t.taskId] = {
      // ★ 显式映射（不再靠「字段名相同」隐式等同）：`reaped` 分两档 ——
      //   `superseded` ⇒ done（依赖满足）· `dead` ⇒ failed（依赖不可能 ⇒ 升级，不放行）。
      state: depStateOf(t),
      owner: t.to,
      endedAtMs: t.endedAtMs,
      source: '账本 ' + t.actionId + '.jsonl',
    }
  }
  // 信箱顶层：还没被任何适配器取走的信封（按 `meta.taskId` 认领）
  let boxes: string[] = []
  try {
    boxes = readdirSync(join(i.busDir, 'mailbox'))
  } catch {
    notes.push('读不到信箱根 ' + join(i.busDir, 'mailbox'))
  }
  for (const box of boxes) {
    let files: string[] = []
    try {
      files = readdirSync(join(i.busDir, 'mailbox', box)).filter((n) => n.endsWith('.json'))
    } catch {
      continue
    }
    for (const n of files) {
      const t = readTextSafe(join(i.busDir, 'mailbox', box, n))
      if (t === null) continue
      try {
        const env = JSON.parse(t) as Record<string, unknown>
        const meta = env['meta']
        const taskId = meta !== null && typeof meta === 'object'
          ? String((meta as Record<string, unknown>)['taskId'] ?? '')
          : ''
        if (taskId !== '' && world.ledger[taskId] === undefined && world.queued[taskId] === undefined) {
          world.queued[taskId] = { owner: box }
        }
      } catch {
        /* 坏信封：已被 inbox 分类层计数，这里不重复报 */
      }
    }
  }
  const { records } = loadHolds(i.busDir)
  for (const h of records) world.held[h.taskId] = { owner: h.to }
  return { world, notes }
}

export interface HoldEntry {
  hold: HoldRecord
  deps: ReturnType<typeof judgeWorld>[number]['deps']
  exit: ExitJudgement
}

/** 一次算全：所有 hold 的依赖视图 + 出口裁决（三处调用共用 ⇒ 读数不分叉）。 */
export function holdView(i: WorldInput): { entries: HoldEntry[]; bad: string[]; notes: string[] } {
  const { world, notes } = buildWorldView(i)
  const { records, bad } = loadHolds(i.busDir)
  return {
    entries: judgeWorld(records, world, i.nowMs, { deadAfterMs: i.deadAfterMs, freshMs: i.freshMs }),
    bad,
    notes,
  }
}

/**
 * 释放一条 hold：写信封（**确定性 id** ⇒ 幂等）→ 调用方移出记录。
 * 溯源行（澄：**跟结果同一趟出来**，不是她问才给）拼在**正文第一行**。
 */
export function releaseHold(
  busDir: string,
  hold: HoldRecord,
  traceText: string,
  nowMs: number,
): { ok: boolean; envelopeId: string; already: boolean; error: string } {
  // ★ 确定性 id：同一条 hold 无论释放几次都撞同一个名字 ⇒ 第二次必 EEXIST ⇒ 收敛（不会重复投递）
  const envelopeId = holdEnvelopeId(hold.taskId)
  const env = buildEnvelope({
    id: envelopeId,
    from: hold.from,
    to: hold.to,
    kind: hold.kind,
    text: traceText === '' ? hold.text : traceText + '\n\n' + hold.text,
    taskId: hold.taskId,
    acceptance: hold.acceptance,
    cwd: hold.cwd,
    createdAt: nowMs,
    ttlMs: hold.ttlMs,
    // ★ `E12` 余件（2026-10-12）：修前这里**没传** ⇒ 释放出去的活**必然漏声明** ⇒
    //   消费侧按取严读作 `owner` ⇒ 内部建设的 hold 活失败**会推给主人**。
    //   空串 ⇒ `buildEnvelope` **不写**该字段（同 `refs` 纪律：非空才写）⇒ 台账读作「未声明」。
    nature: hold.nature,
    // ★ 超时预算（2026-10-14）——**同 `nature` 的教训**（2026-10-12）：hold 是信封的**第二条产出路**，
    //   不在这里带上，释放出去的活就丢了声明 ⇒ 那条活按**节点缺省**跑，
    //   而派活方以为「我声明了 2 小时」生效了（静默降级 = 最坏的一类）。
    timeout: hold.timeout,
    // ★ 接力起点（2026-10-17 · 论文迁移 arXiv:2610.20563）：**同 `nature` / `timeout` 的教训** ——
    //   hold 是信封的**第二条产出路**，不在这里带上，释放出去的活就丢了起点
    //   ⇒ 接力者**知道证据在哪、却不知道当前最好的是什么** ⇒ 从零试错一遍。
    //   `hold.best` 已是归一后的 `BestSpec`（`buildHoldRecord` 归一）⇒ 这里原样传回。
    best: hold.best,
    // ★ 来路盖章（2026-10-15 · `G-provenance` Step B）：本函数是**第二条**产出路
    //   （hold 释放）。与 `manor_dispatch` 直投**必须可区分** —— 缺口要答的正是
    //   「这条 taskId 是被哪条路造出来的」；不盖章则两条路在读数里同貌。
    //   分辨力由 `hold-store.test.ts` 的「信封契约单一真源」钉着（删这一行 ⇒ 那条必红，实测）。
    via: 'hold-release',
  })
  const dest = join(busDir, 'mailbox', hold.to, envelopeId + '.json')
  try {
    mkdirSync(join(busDir, 'mailbox', hold.to), { recursive: true })
    writeFileSync(dest, JSON.stringify(env, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'EEXIST') return { ok: true, envelopeId, already: true, error: '' }
    return { ok: false, envelopeId, already: false, error: '投递失败：' + String(e) }
  }
  return { ok: true, envelopeId, already: false, error: '' }
}

export interface SweepInput extends WorldInput {
  /** 每轮最多释放几条（有界：不一次把一堆成员同时叫醒） */
  releaseBatch: number
  /** 留痕回调。**吞错的职责在调用方**（本层直接调用，异常向上抛） */
  trace?: (obj: Record<string, unknown>) => void
}

export interface SweepResult {
  released: string[]
  escalated: string[]
  /** **撤销**的过期升级（现读裁决不再是 escalate ⇒ 清掉）—— 不清会让可见面永久虚高 */
  cleared: string[]
  /** 已就绪但本轮没放（超批次上限）—— **必须报出来**，否则读者以为「就这些」 */
  deferred: number
  readyButHeld: number
  depDead: number
  bad: string[]
  errors: string[]
  /** 本轮**有没有作判**（`false` = 在线面读不到 ⇒ 整轮跳过；不是「没有 hold」） */
  judged: boolean
}

/**
 * 一轮释放扫描（**常驻方触发**）。做五件事，各自留痕：
 *   ① 就绪 ⇒ 按优先级释放（有界批次，超出的**报出来**）
 *   ② 升级 ⇒ 写 `escalated` 留痕（**不自动放行**）
 *   ③ **撤销过期的升级**（现读裁决不再是 escalate ⇒ 清掉 —— 否则一次抖动会永久污染可见面）
 *   ④ **反向扫描** ⇒ 「已满足却没跑」「挂着但依赖方已不活」
 *   ⑤ 坏记录 ⇒ 报出来
 *
 * ⚠ **在线面读不到 ⇒ ①②③④ 全免**（`judged: false`）：那是「未知」，不是「都不在线」。
 */
export function sweepHolds(i: SweepInput): SweepResult {
  const trace = i.trace ?? (() => {})
  const { entries, bad, notes } = holdView(i)
  const errors = [...notes]
  const judged = i.onlineFaceOk
  if (!judged) {
    trace({ op: 'hold-not-judged', reason: '在线面读不到 ⇒ 本轮不作判（既不释放也不升级）', holds: entries.length })
    return { released: [], escalated: [], cleared: [], deferred: 0, readyButHeld: 0, depDead: 0, bad, errors, judged: false }
  }
  const byId = new Map(entries.map((e) => [e.hold.taskId, e]))
  const ready = sortHolds(entries.filter((e) => e.exit.action === 'release').map((e) => e.hold))
  const batch = ready.slice(0, Math.max(1, Math.trunc(i.releaseBatch)))
  const deferred = ready.length - batch.length
  const released: string[] = []
  for (const h of batch) {
    const e = byId.get(h.taskId)!
    const r = releaseHold(i.busDir, h, buildTraceLine(h, e.deps, i.nowMs), i.nowMs)
    if (!r.ok) {
      errors.push(h.taskId + '：' + r.error)
      continue
    }
    const rm = removeHold(i.busDir, h.taskId)
    if (rm !== '') errors.push(h.taskId + '：' + rm)
    released.push(h.taskId)
    trace({
      op: 'hold-released',
      taskId: h.taskId,
      to: h.to,
      envelopeId: r.envelopeId,
      alreadyDelivered: r.already,
      deps: h.dependsOn,
      waitedMs: i.nowMs - h.heldAtMs,
    })
  }
  // 升级：**只写留痕，不动投递**（哨：超时必须响，不是自动放行）
  const escalated: string[] = []
  // ★ 撤销：现读裁决不再是 escalate ⇒ 清掉旧标记。
  //   2026-10-12 活体验收抓出：`escalated` 一旦写入永不清除 ⇒ 一次心跳抖动写的 `dep-dead`
  //   **永久留在记录里**，渲染成 `⚠ 需裁决` 与同一份输出里的现读 `wait` **自相矛盾**，
  //   还会让 `manor_find` 的 `escalated` 计数长期虚高（狼来了）。
  //   这与「包是冻结点，它引用的世界不是」是同一条：**判定有寿命，标记必须能撤**。
  const cleared: string[] = []
  for (const e of entries) {
    if (e.exit.action !== 'escalate' && e.hold.escalated !== '') {
      const w = updateHold(i.busDir, { ...e.hold, escalated: '' })
      if (w !== '') {
        errors.push(e.hold.taskId + '：' + w)
        continue
      }
      cleared.push(e.hold.taskId + '[' + e.hold.escalated + '→已不成立]')
      trace({ op: 'hold-escalation-cleared', taskId: e.hold.taskId, was: e.hold.escalated, now: e.exit.code })
      continue
    }
    if (e.exit.action !== 'escalate') continue
    if (e.hold.escalated === e.exit.code) continue
    const w = updateHold(i.busDir, { ...e.hold, escalated: e.exit.code })
    if (w !== '') {
      errors.push(e.hold.taskId + '：' + w)
      continue
    }
    escalated.push(e.hold.taskId + '[' + e.exit.code + ']')
    trace({ op: 'hold-escalated', taskId: e.hold.taskId, code: e.exit.code, reason: e.exit.reason, deps: e.hold.dependsOn })
  }
  // ★ 本轮**已释放**的不进反向扫描：那条活刚刚被处理，报它「应被释放」是**假异常**
  //   （2026-10-12 活体验收当场看到：释放的同一轮就报了一条 `hold-ready-but-held`）。
  //   假异常是防线被忽略的起点 ⇒ 判据只对**仍未处理**的那些发问。
  // ★ **第二种假异常源**（同一天、真活）：依赖**刚满足**、sweep 还没到下一轮 ⇒ 也报「应被释放」。
  //   两道防线正交互补：这一行管「已处理的」，`releaseGraceMs` 管「还没来得及处理的」。
  const stillHeld = entries.filter((e) => !released.includes(e.hold.taskId))
  const rev = reverseScan(stillHeld, i.nowMs, i.deadAfterMs, i.releaseGraceMs)
  for (const x of rev.readyButHeld) trace({ op: 'hold-ready-but-held', taskId: x.taskId, reason: x.reason })
  for (const x of rev.depDead) trace({ op: 'hold-dep-dead', taskId: x.taskId, reason: x.reason })
  if (bad.length > 0) trace({ op: 'hold-bad-records', items: bad })
  return {
    released,
    escalated,
    cleared,
    deferred,
    readyButHeld: rev.readyButHeld.length,
    depDead: rev.depDead.length,
    bad,
    errors,
    judged: true,
  }
}
