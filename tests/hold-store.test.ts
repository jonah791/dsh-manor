/**
 * `hold` 的 **IO 层端到端**测试（`src/hold-store.ts`）—— 在**真磁盘状态**上跑。
 *
 * 为什么必须有这一层（勘的纪律：判据的输入源必须是**行为**不是**声明**）：
 *   纯函数测试（`hold.test.ts`）证明的是「解释器对」；它**证明不了**
 *   「落盘/读盘/释放/移出这条链在真文件上真的成立」。而 ③ 面最贵的失败形态
 *   （静默死锁、重复投递、挂在硬盘上没人看见）**全部只发生在这一层**。
 *
 * 用**临时总线**（真目录、真文件、真 rename/unlink），不 mock fs：
 *   mock 只能证明「我按我以为的方式调用了」，证明不了「文件系统真的变成了那样」。
 *
 * 运行：node --test tests/hold-store.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

import {
  buildWorldView,
  createHold,
  holdView,
  loadHolds,
  releaseHold,
  removeHold,
  sweepHolds,
} from '../src/hold-store.ts'
import { parseActionLog, foldTasks } from '../src/task-ledger.ts'
import { buildEnvelope } from '../src/envelope.ts'
import { DEFAULT_HOLD_TIMEOUT_MS, buildHoldRecord, renderHolds, type HoldRecord } from '../src/hold.ts'

const T0 = Date.parse('2026-10-12T02:00:00.000Z')
const MIN = 60_000

/** 造一个临时总线，测试结束自己删。 */
function makeBus(): { bus: string; close: () => void } {
  const bus = mkdtempSync(join(tmpdir(), 'manor-hold-'))
  mkdirSync(join(bus, 'logs', 'actions'), { recursive: true })
  mkdirSync(join(bus, 'mailbox', 'maid-03'), { recursive: true })
  mkdirSync(join(bus, 'nodes'), { recursive: true })
  mkdirSync(join(bus, 'hold'), { recursive: true })
  return { bus, close: () => { try { rmSync(bus, { recursive: true, force: true }) } catch { /* 清理失败不影响判据 */ } } }
}

/** 写一份动作日志：一条已完成的活（`stage:"done"` ⇒ 台账 outcome=done）。 */
function writeDoneAction(bus: string, taskId: string, owner: string, atIso: string): void {
  const lines = [
    { at: '2026-10-12T00:00:00.000Z', actionId: 'a-1', stage: 'start', humanText: '收到任务', detail: { taskId, profile: owner, from: 'LAPTOP-BF4IAPLM-web-0' } },
    { at: atIso, actionId: 'a-1', stage: 'done', humanText: '任务完成，产出 100 字符', detail: { taskId, profile: owner, ms: 60000, stdoutChars: 100 } },
  ]
  writeFileSync(join(bus, 'logs', 'actions', 'a-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

/** 写一份动作日志：一条**失败**的活（`humanText` 以失败前缀开头 ⇒ 台账 outcome=failed）。 */
function writeFailedAction(bus: string, taskId: string, owner: string, atIso: string): void {
  const lines = [
    { at: '2026-10-12T00:01:00.000Z', actionId: 'a-2', stage: 'start', humanText: '收到任务', detail: { taskId, profile: owner } },
    { at: atIso, actionId: 'a-2', stage: 'failed', humanText: '任务未完成（超时 1800s）', detail: { taskId, profile: owner, ms: 1800000 } },
  ]
  writeFileSync(join(bus, 'logs', 'actions', 'a-2.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

/** 写一份心跳（节点文件）。 */
function writeHeartbeat(bus: string, id: string, atMs: number): void {
  writeFileSync(join(bus, 'nodes', id + '.json'), JSON.stringify({ v: 1, nodeId: id, pid: 1234, atMs }) + '\n', 'utf8')
}

/**
 * 造一条 hold 记录 —— ★ **经生产写入器 `buildHoldRecord`**，不是手搓对象。
 *
 * 存在理由（2026-10-12 · 两位成员独立复核得出）：手搓夹具会让判据的**作用域被夹具形状限死**
 *   ——修前那条「记录里不含状态词」的判据就是这么被绕开的（夹具喂良性串、生产喂状态快照，
 *   而写入器住在 `index.ts` 的闭包里，测试碰不到）。⇒ **夹具必须与生产共用同一个写入函数**。
 */
function recOf(over: Partial<HoldRecord> = {}): HoldRecord {
  const base = buildHoldRecord({
    taskId: 't-B',
    to: 'maid-03',
    from: 'LAPTOP-BF4IAPLM-web-0',
    kind: 'task',
    text: '真正要她干的活',
    acceptance: '产出落盘',
    cwd: '.',
    priority: 'normal',
    dependsOn: ['t-A'],
    heldAtMs: T0 - 2 * MIN,
    heldBy: 'LAPTOP-BF4IAPLM-web-0',
    deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS,
    ttlMs: 86400000,
    // ★ 接力起点（2026-10-17 · 论文迁移）：走**生产写入器**（不是 `{...base, ...over}` 手搓）——
    //   本文件自己的纪律就是「夹具必须与生产共用同一个写入函数」，否则判据的作用域
    //   又被夹具形状限死（`best` 的归一住在 `buildHoldRecord` 里，手搓就绕过它）。
    ...(over.best === undefined ? {} : { best: over.best }),
  })
  const { best: _best, ...rest } = over
  return { ...base, ...rest }
}

/** 记一条 hold（落盘，模拟 `manor_dispatch` 挂起过的那条）。 */
function holdRec(bus: string, over: Partial<HoldRecord> = {}): HoldRecord {
  const rec = recOf(over)
  const w = createHold(bus, rec)
  assert.equal(w, '', '夹具自身必须能落盘：' + w)
  return rec
}

/** 从盘上现读账本（与插件里 `readAllTasks` 同一条路：同一个纯函数）。 */
function ledgerOf(bus: string): ReturnType<typeof foldTasks> {
  const dir = join(bus, 'logs', 'actions')
  const events = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => parseActionLog(readFileSync(join(dir, f), 'utf8')))
  return foldTasks(events)
}

const inputOf = (bus: string, nowMs: number, over: Record<string, unknown> = {}) => ({
  busDir: bus,
  tasks: ledgerOf(bus),
  heartbeatAgeMs: { 'maid-03': 3000 } as Record<string, number>,
  onlineFaceOk: true,
  nowMs,
  freshMs: 30_000,
  deadAfterMs: 300_000,
  ...over,
})

// ── 一 · 落盘 / 读盘 / 幂等 ─────────────────────────────────────────────

test('落盘→读盘往返：真文件上字段逐字一致（含中文正文）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    const { records, bad } = loadHolds(bus)
    assert.equal(bad.length, 0)
    assert.equal(records.length, 1)
    assert.equal(records[0]!.text, '真正要她干的活')
    assert.deepEqual(records[0]!.dependsOn, ['t-A'])
  } finally { close() }
})

test('★ no-clobber：同 taskId 再落一次必须**报错**，磁盘上仍是第一条', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus, { text: '第一条' })
    const w = createHold(bus, recOf({ text: '第二条' }))
    assert.match(w, /已有一条同 taskId/)
    assert.equal(loadHolds(bus).records[0]!.text, '第一条')
  } finally { close() }
})

test('坏记录：盘上存在但读不出来 ⇒ **报进 bad，不静默丢弃**（「读不到」≠「不在」）', () => {
  const { bus, close } = makeBus()
  try {
    writeFileSync(join(bus, 'hold', 't-broken.json'), '{ 这不是 json', 'utf8')
    writeFileSync(join(bus, 'hold', 't-nodeps.json'), JSON.stringify({ taskId: 't-nodeps', to: 'maid-03' }), 'utf8')
    holdRec(bus)
    const { records, bad } = loadHolds(bus)
    assert.equal(records.length, 1, '好的那条仍要读到')
    assert.equal(bad.length, 2)
    assert.ok(bad.some((b) => b.includes('t-broken')))
    assert.ok(bad.some((b) => b.includes('缺 dependsOn')))
  } finally { close() }
})

// ── 二 · ★ 判据核心：真磁盘上的「为什么还没跑」 ────────────────────────

test('★ 真磁盘：两个活的真实状态重跑解释器 ⇒ 逐字同一句话（哨的可证伪形式）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)                       // t-B 等 t-A
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    writeFileSync(join(bus, 'mailbox', 'maid-03', 'm-x.json'),
      JSON.stringify({ v: 1, id: 'm-x', kind: 'task', to: 'maid-03', meta: { taskId: 't-A' } }), 'utf8')
    const a = holdView(inputOf(bus, T0))
    const b = holdView(inputOf(bus, T0))
    assert.equal(a.entries.length, 1)
    assert.equal(a.entries[0]!.deps[0]!.state, 'pending')
    assert.match(a.entries[0]!.deps[0]!.source, /信箱 maid-03/)
    // 解释句在渲染里现出（渲染是它的唯一外显面）
    assert.equal(
      renderHolds([{ hold: a.entries[0]!.hold, deps: a.entries[0]!.deps, exit: a.entries[0]!.exit }], T0),
      renderHolds([{ hold: b.entries[0]!.hold, deps: b.entries[0]!.deps, exit: b.entries[0]!.exit }], T0),
    )
  } finally { close() }
})

test('★ 依赖**完成后**：sweep 释放 + 投递 + **溯源行在正文第一行** + hold 文件被移出', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    const s = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 3 })
    assert.deepEqual(s.released, ['t-B'])
    assert.equal(s.errors.length, 0)
    // ① 信封在盘上
    const envFile = join(bus, 'mailbox', 'maid-03', 'm-hold-t-B.json')
    const env = JSON.parse(readFileSync(envFile, 'utf8'))
    assert.equal(env.meta.taskId, 't-B')
    assert.equal(env.kind, 'task')
    assert.ok(String(env.text).startsWith('【出处】'), '溯源行必须是**正文第一行**（贴着的那张单子）')
    assert.ok(String(env.text).includes('真正要她干的活'))
    assert.match(String(env.text), /等了 2 分钟/)
    // ② hold 文件已移出（**投递即移出**，不留只增不减的墓碑）
    assert.equal(loadHolds(bus).records.length, 0)
  } finally { close() }
})

test('★ 幂等：同一条 hold 再释放一次 ⇒ 撞确定性 id，**不产生第二封信封**', () => {
  const { bus, close } = makeBus()
  try {
    const rec = holdRec(bus)
    const r1 = releaseHold(bus, rec, '', T0)
    assert.equal(r1.ok, true)
    assert.equal(r1.already, false)
    const r2 = releaseHold(bus, rec, '', T0)
    assert.equal(r2.ok, true)
    assert.equal(r2.already, true, '第二次必须自报「已投过」')
    const files = readdirSync(join(bus, 'mailbox', 'maid-03')).filter((n) => n.endsWith('.json'))
    assert.equal(files.length, 1, '盘上只能有一封')
  } finally { close() }
})

test('★ 收敛：释放后若移出失败，下一轮 sweep 靠确定性 id 收敛（不重复投递、不再报错）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    const w = removeHold(bus, 't-B')
    assert.equal(w, '', '夹具：先手工移出，模拟「释放成功但移出那一步没做」')
    // 把记录放回去（= 移出失败时盘上的样子）
    createHold(bus, holdRec(bus))
    const s = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 3 })
    assert.deepEqual(s.released, ['t-B'], '仍会被判为可释放')
    assert.equal(s.errors.length, 0, '撞 id 不算错误（那是幂等在收敛）')
    const files = readdirSync(join(bus, 'mailbox', 'maid-03')).filter((n) => n.endsWith('.json'))
    assert.equal(files.length, 1)
    assert.equal(loadHolds(bus).records.length, 0, '这一轮必须真的移出')
  } finally { close() }
})

// ── 三 · 出口三条（在真磁盘上各走一次）────────────────────────────────

test('★ 出口二：依赖**失败** ⇒ 升级落进记录（`escalated`），**绝不投递**', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeFailedAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    const s = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 3 })
    assert.equal(s.released.length, 0, '不可能完成的依赖**不能**放行')
    assert.equal(s.escalated.length, 1)
    assert.match(s.escalated[0]!, /dep-impossible/)
    assert.equal(loadHolds(bus).records[0]!.escalated, 'dep-impossible', '留痕必须落盘')
    const files = readdirSync(join(bus, 'mailbox', 'maid-03')).filter((n) => n.endsWith('.json'))
    assert.equal(files.length, 0, '**一封信封都不能有**')
  } finally { close() }
})

test('★ 出口三：超时 ⇒ 升级（不改投递）；且**同一原因不重复升级**（不刷屏）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus, { heldAtMs: T0 - 10 * 3600_000 })
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    writeFileSync(join(bus, 'mailbox', 'maid-03', 'm-y.json'),
      JSON.stringify({ v: 1, id: 'm-y', kind: 'task', meta: { taskId: 't-A' } }), 'utf8')
    const s1 = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 3 })
    assert.deepEqual(s1.escalated, ['t-B[timeout]'])
    const s2 = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 3 })
    assert.equal(s2.escalated.length, 0, '同一原因已经在记录里 ⇒ 不再重复升级（哨：恒定置顶会退化）')
    assert.equal(loadHolds(bus).records[0]!.escalated, 'timeout')
  } finally { close() }
})

test('★ 出口二附则：依赖**属主已不在线**且状态停在「进行中」⇒ dep-dead（防「在线撒谎」）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    // 起了会话但无终态 ⇒ 台账 outcome=unfinished
    writeFileSync(join(bus, 'logs', 'actions', 'a-3.jsonl'),
      JSON.stringify({ at: '2026-10-12T00:01:00.000Z', actionId: 'a-3', stage: 'start', humanText: '收到任务', detail: { taskId: 't-A', profile: 'maid-03' } }) + '\n', 'utf8')
    // 心跳**超判死线**（5min）⇒ maid-03 判死
    writeHeartbeat(bus, 'maid-03', T0 - 600_000)
    const s = sweepHolds({ ...inputOf(bus, T0, { heartbeatAgeMs: { 'maid-03': 600_000 } }), releaseBatch: 3 })
    assert.deepEqual(s.escalated, ['t-B[dep-dead]'])
  } finally { close() }
})

test('★ 心跳抖动**不得**升级为 dep-dead（2026-10-12 活体验收抓出的真缺陷，真磁盘版）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeFileSync(join(bus, 'logs', 'actions', 'a-3.jsonl'),
      JSON.stringify({ at: '2026-10-12T00:01:00.000Z', actionId: 'a-3', stage: 'start', humanText: '收到任务', detail: { taskId: 't-A', profile: 'maid-03' } }) + '\n', 'utf8')
    writeHeartbeat(bus, 'maid-03', T0 - 31_000)   // 陈旧 31 秒：超过新鲜阈值(30s)，但**远未**到判死线(5min)
    const s = sweepHolds({ ...inputOf(bus, T0, { heartbeatAgeMs: { 'maid-03': 31_000 } }), releaseBatch: 3 })
    assert.equal(s.escalated.length, 0, '抖动一次不得升级')
    assert.equal(s.depDead, 0, '反向扫描也不得报「依赖方已不活」')
    assert.equal(loadHolds(bus).records[0]!.escalated, '', '记录里不得留下升级标记')
  } finally { close() }
})

test('★ 升级**可撤销**：属主回来 ⇒ 清掉过期的 `escalated`（不清会让可见面永久虚高）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeFileSync(join(bus, 'logs', 'actions', 'a-3.jsonl'),
      JSON.stringify({ at: '2026-10-12T00:01:00.000Z', actionId: 'a-3', stage: 'start', humanText: '收到任务', detail: { taskId: 't-A', profile: 'maid-03' } }) + '\n', 'utf8')
    writeHeartbeat(bus, 'maid-03', T0 - 600_000)
    const s1 = sweepHolds({ ...inputOf(bus, T0, { heartbeatAgeMs: { 'maid-03': 600_000 } }), releaseBatch: 3 })
    assert.deepEqual(s1.escalated, ['t-B[dep-dead]'])
    assert.equal(loadHolds(bus).records[0]!.escalated, 'dep-dead')
    // 属主回来了
    const s2 = sweepHolds({ ...inputOf(bus, T0, { heartbeatAgeMs: { 'maid-03': 2000 } }), releaseBatch: 3 })
    assert.deepEqual(s2.cleared, ['t-B[dep-dead→已不成立]'])
    assert.equal(loadHolds(bus).records[0]!.escalated, '', '过期的升级必须被清掉（否则它与现读裁决自相矛盾）')
    // 反向：清掉之后**不得**再重复清（不刷屏）
    const s3 = sweepHolds({ ...inputOf(bus, T0, { heartbeatAgeMs: { 'maid-03': 2000 } }), releaseBatch: 3 })
    assert.equal(s3.cleared.length, 0)
  } finally { close() }
})

test('★ 在线面读不到 ⇒ **整轮不作判**（真磁盘：节点目录消失）——不释放、不升级', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')   // 依赖已完成 ⇒ 正常世界会释放
    const s = sweepHolds({ ...inputOf(bus, T0, { onlineFaceOk: false }), releaseBatch: 3 })
    assert.equal(s.judged, false, '必须自报「本轮未作判」')
    assert.equal(s.released.length, 0, '不得释放（「读不到」不是「都不在线」）')
    assert.equal(s.escalated.length, 0)
    assert.equal(loadHolds(bus).records.length, 1, '记录必须原样留着，等下一轮')
    assert.ok(s.errors.some((e) => e.includes('不作判')), '缺口必须出现在读数里，不能静默')
    // 对照组：在线面恢复 ⇒ 同一份世界立刻正确释放
    const s2 = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 3 })
    assert.equal(s2.judged, true)
    assert.deepEqual(s2.released, ['t-B'])
  } finally { close() }
})

// ── 四 · 反向扫描 / 可见面 ─────────────────────────────────────────────

test('★ 反向扫描（真磁盘）：依赖已满足却没跑 ⇒ 被点出；坏记录一并报出', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    writeFileSync(join(bus, 'hold', 't-bad.json'), '{坏', 'utf8')
    // 只读（不 sweep）⇒ 这条活「依赖已满足却仍在 hold 里」
    const v = holdView(inputOf(bus, T0))
    assert.equal(v.entries.length, 1)
    assert.equal(v.entries[0]!.exit.action, 'release')
    assert.equal(v.bad.length, 1)
    assert.match(v.bad[0]!, /t-bad/)
  } finally { close() }
})

test('★ 反向扫描**不得对本轮刚释放的**那条报异常（假异常是防线被忽略的起点）', () => {
  // 2026-10-12 活体验收当场看到：释放的同一轮就报了一条 `hold-ready-but-held`
  // （「依赖已全部完成，但这条活仍在 hold 里（应被释放）」）—— 而它**刚刚就是被本轮的释放器放的**。
  const { bus, close } = makeBus()
  try {
    holdRec(bus)
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    const s = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 3 })
    assert.deepEqual(s.released, ['t-B'])
    assert.equal(s.readyButHeld, 0, '刚释放的那条**不得**再进「就绪却没跑」——那会每轮放一条就报一条假异常')
    assert.equal(s.depDead, 0)
  } finally { close() }
})

test('★ 反向扫描仍必须抓住**真正**没被释放的（对照组：判据有分辨力，不是恒为 0）', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus, { taskId: 't-low', priority: 'low', heldAtMs: T0 - 10 * MIN })
    holdRec(bus, { taskId: 't-high', priority: 'high', heldAtMs: T0 - 1 * MIN })
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    const s = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 1 })   // 只放得下一条
    assert.deepEqual(s.released, ['t-high'])
    assert.equal(s.readyButHeld, 1, '被延后的那条**真的**还卡在 hold 里 ⇒ 必须被点出')
  } finally { close() }
})

test('★ 有界批次：就绪数超上限 ⇒ 只放高优先级的 N 条，其余**报出 deferred**（不假装都放了）', () => {
  const { bus, close } = makeBus()
  try {
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    holdRec(bus, { taskId: 't-low', priority: 'low', heldAtMs: T0 - 10 * MIN })
    holdRec(bus, { taskId: 't-high', priority: 'high', heldAtMs: T0 - 1 * MIN })
    const s = sweepHolds({ ...inputOf(bus, T0), releaseBatch: 1 })
    assert.deepEqual(s.released, ['t-high'], '高优先级先走（priority 的真实机制效果）')
    assert.equal(s.deferred, 1, '被延后的必须报出来，否则读者以为「就这些」')
    assert.deepEqual(loadHolds(bus).records.map((r) => r.taskId), ['t-low'])
  } finally { close() }
})

test('★ 世界解析的权威顺序（真磁盘）：账本 > 信箱 > hold > 找不到', () => {
  const { bus, close } = makeBus()
  try {
    holdRec(bus, { taskId: 't-B', dependsOn: ['t-A', 't-C', 't-D', 't-E'] })
    writeDoneAction(bus, 't-A', 'maid-03', '2026-10-12T00:05:00.000Z')   // 账本
    writeFileSync(join(bus, 'mailbox', 'maid-03', 'm-c.json'),
      JSON.stringify({ v: 1, id: 'm-c', kind: 'task', meta: { taskId: 't-C' } }), 'utf8')  // 信箱
    createHold(bus, holdRec(bus, { taskId: 't-D', dependsOn: ['t-Z'] }))                 // 另一条 hold
    writeHeartbeat(bus, 'maid-03', T0 - 3000)
    const w = buildWorldView(inputOf(bus, T0)).world
    assert.equal(w.ledger['t-A']!.state, 'done')
    assert.equal(w.queued['t-C']!.owner, 'maid-03')
    assert.equal(w.held['t-D']!.owner, 'maid-03')
    assert.equal(w.ledger['t-E'], undefined)
    assert.equal(w.queued['t-E'], undefined)
    assert.equal(w.held['t-E'], undefined)
  } finally { close() }
})

// ── 五 · 契约单一真源 ─────────────────────────────────────────────────

test('★ 信封契约单一真源：hold 释放的信封与 `buildEnvelope` 逐字同形（改一处必须两处同时改）', () => {
  const { bus, close } = makeBus()
  try {
    const rec = holdRec(bus)
    const r = releaseHold(bus, rec, '【出处】…', T0)
    const written = JSON.parse(readFileSync(join(bus, 'mailbox', 'maid-03', r.envelopeId + '.json'), 'utf8'))
    const expected = buildEnvelope({
      id: r.envelopeId, from: rec.from, to: rec.to, kind: rec.kind,
      text: '【出处】…\n\n' + rec.text, taskId: rec.taskId,
      acceptance: rec.acceptance, cwd: rec.cwd, createdAt: T0, ttlMs: rec.ttlMs,
      // ★ `via`（2026-10-15 · `G-provenance` Step B）：hold 释放这条路盖的章。
      //   本测试的原意是「两条路共用同一构造函数」—— 现在两条路的**唯一允许差异**就是这个字段
      //   （它答的正是「这条 taskId 是被哪条路造出来的」）。
      //   ⚠ 分辨力保留：若 `hold-store` 忘了传，`written` 会缺这一格而 `expected` 有 ⇒ 本测试仍红。
      via: 'hold-release',
      // ★ 接力起点（2026-10-17 · 论文迁移）：两条产出路的**唯一允许差异是 `via`**，其余逐字同形
      //   ⇒ 这里也带上（`rec.best` 为 `undefined` 时 `buildEnvelope` 不写该键，对称仍成立）。
      //   若 `hold-store` 忘了传，`written` 会缺这一格而 `expected` 有 ⇒ 本测试仍红。
      best: rec.best,
    })
    assert.deepEqual(written, expected)
  } finally { close() }
})

// ── 五之二 · 接力起点（论文迁移 arXiv:2610.20563 · 2026-10-17）────────────────
//
// 它答的问题：**「上一个做到哪了」**（未来的起点）。论文的 forgetting 之所以解锁平台期，
// 正因为重启时**只带最优解**、丢弃尝试史；而 hold 是信封的**第二条产出路**
// —— 不在记录里存下来，释放时那条活就丢了起点（同 `nature` / `timeout` 的教训）。
//
// 三条判据（缺一就是假绿）：**跟着走** · **空不写** · **归一 fail-closed**。

test('★ 接力起点跟着活走：hold 释放的信封带上 `meta.best`（第二条产出路不许丢它）', () => {
  const { bus, close } = makeBus()
  try {
    const rec = holdRec(bus, { best: { at: 'E:/alice/x.ts:12', judge: '3/3 测试绿' } })
    const r = releaseHold(bus, rec, '', T0)
    const written = JSON.parse(readFileSync(join(bus, 'mailbox', 'maid-03', r.envelopeId + '.json'), 'utf8'))
    assert.deepEqual(
      written.meta.best,
      { at: 'E:/alice/x.ts:12', judge: '3/3 测试绿' },
      '★ 删掉 `releaseHold` 的 `best: hold.best` ⇒ 本测试必红',
    )
  } finally { close() }
})

test('★ 没给起点 ⇒ 信封里没有这个键（空不写，不是写空对象）', () => {
  const { bus, close } = makeBus()
  try {
    const rec = holdRec(bus)
    const r = releaseHold(bus, rec, '', T0)
    const written = JSON.parse(readFileSync(join(bus, 'mailbox', 'maid-03', r.envelopeId + '.json'), 'utf8'))
    assert.equal('best' in written.meta, false, '★ 没给 ≠ 给了空')
  } finally { close() }
})

test('★ 归一在 `buildHoldRecord`：只有 judge 没有 at ⇒ 记录里不写 `best`（fail-closed）', () => {
  // ⚠ 故意绕类型（`as never`）：这条喂的正是**坏样本** —— 归一必须把它整条丢掉，
  //   而不是写一个只有分数的「装饰」。夹具走**生产写入器**（`recOf` 已改），判的是真实归一。
  const noAt = recOf({ best: { judge: 'j' } as never })
  assert.equal('best' in noAt, false, '没有「在哪」就没有起点 —— 不写半截')
  const withAt = recOf({ best: { at: 'a.ts:1' } as never })
  assert.deepEqual(withAt.best, { at: 'a.ts:1' })
})

test('★ 确定性 id 自证来源：hold 释放的信封名以 `m-hold-` 开头（文件名上说清它是谁放的）', () => {
  const { bus, close } = makeBus()
  try {
    const rec = holdRec(bus)
    const r = releaseHold(bus, rec, '', T0)
    assert.equal(r.envelopeId, 'm-hold-t-B')
  } finally { close() }
})

// ── 六 · 生产接线（**源码级**，诚实标注它的弱）────────────────────────
// 哨给的根因是「整个 tests/ 里没有任何用例执行写入路径 ⇒ 生产记录形状的每一条不变量，
//   都由人手搓的 HoldRecord 代守」。写入器住在 `apply` 闭包里（只能在真插件组合里跑），
//   所以**本文件测不到它**。剩下能做的两件事：① 把拼装抽成 `buildHoldRecord`（已做，且有 ★★ 用例）；
//   ② 钉住「闭包**必须委派**给那个函数，不许自己再拼一遍」—— 这条是**源码级**判据（弱），
//   它的作用只是「回头路被堵上时会红」，不证明运行时行为。运行时行为靠活体验收（§7 N17–N21）。

test('★ 生产写入器必须**委派**给 `buildHoldRecord`（源码级：防拼装被搬回闭包）', () => {
  const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  assert.match(src, /buildHoldRecord\(\{/, 'index.ts 必须调用 buildHoldRecord')
  assert.equal(/\breason:\s*why\b/.test(src), false, '不得再把散文 why 塞进记录（那是依赖状态快照）')
  assert.match(src, /reasonCode: rec\.reason, explainAtCreation: why/, '散文解释必须改走 trace（事件流是历史）')
})

test('★ 源码级：不得再有把 `stateLabel` 拼进落盘记录的写法', () => {
  const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  // `stateLabel` 仍可用于**回给调用方的现读文案**（那是「现在」，不是记录）——
  // 判据是它**不得出现在 buildHoldRecord 的入参里**。
  const call = /buildHoldRecord\(\{([\s\S]*?)\}\)/.exec(src)
  assert.notEqual(call, null, '找不到 buildHoldRecord 的调用点 ⇒ 本测试必须跟着改')
  assert.equal(call![1]!.includes('stateLabel'), false, 'buildHoldRecord 的入参里不得出现 stateLabel')
})

test('★ 生产调用点必须**行使**那个原因码（闭集不许只当声明）', () => {
  // 2026-10-12 当场抓出：`index.ts` 没传 `reason` ⇒ 缺省 `unknown` —— 而派活侧**明明知道**是
  //   「依赖未就绪」。织那句话当场应验：「**闭集此刻还是声明，还没被任何一个选择点行使过**」。
  //   ⇒ 缺省不能静默翻译（上一轮的教训），但**唯一知道真相的那一侧必须显式声明**。
  const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  const call = /buildHoldRecord\(\{([\s\S]*?)\}\)/.exec(src)
  assert.notEqual(call, null)
  assert.match(call![1]!, /reason:\s*'deps-pending'/, '依赖未就绪这条路径必须显式声明原因码')
  // 反向：`unknown` 不得成为生产路径的值（那是给「读旧记录/不知道」用的）
  assert.equal(/reason:\s*'unknown'/.test(src), false, "生产路径不得把原因写成 'unknown'")
})

test('★ E12 余件（源码级）：生产调用点必须把 `nature` 传进 `buildHoldRecord`', () => {
  // 与上一具同形。这里**类型层抓不住**「忘了传」——`HoldSpec.nature` 是**可选**的
  //   （因为「未声明」本来就是合法状态）⇒ 所以留一条源码级判据盯住**这一处调用点**。
  // ⚠ 强度边界：正则只看调用点文本，**不证明它真的流到了信封** —— 那一半由下面四具行为级测试负责。
  const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  const call = /buildHoldRecord\(\{([\s\S]*?)\}\)/.exec(src)
  assert.notEqual(call, null)
  assert.match(call![1]!, /nature:\s*natureRaw/, 'hold 是信封的**第二条产出路** —— 声明必须跟着活走')
})

/* ── `nature` 跟着 hold 走到信封（行为级 · 真磁盘）─────────────────────
 * 修前：`hold-store.ts` 里**一个 `nature` 都没有**（现读核实）⇒ 释放时 `buildEnvelope`
 * 不带它 ⇒ **那条路的活必然漏声明** ⇒ 取严按 `owner` 推给主人。
 * ★ 判据打在**盘上的信封**上 —— 它是这条链的最终产物，不是任何一层的返回值。
 * ★ 这是成员织那条推论的**第二个实例**：「某条路忘了传某字段」在取严缺省下**不会报错**，
 *   它只会静默地把那条路全算进兜底档。
 */

/** 一份 hold 规格（走生产同一个 `buildHoldRecord` ⇒ 形状不分叉）。 */
const specOf = (taskId: string, nature?: string) => {
  const spec: Parameters<typeof buildHoldRecord>[0] = {
    taskId, to: 'maid-03', from: 'LAPTOP-BF4IAPLM-web-0', kind: 'task',
    text: '做事', acceptance: '有产出', cwd: '.', priority: 'normal',
    dependsOn: ['t-dep'], heldAtMs: T0, heldBy: 'LAPTOP-BF4IAPLM-web-0',
    deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS, ttlMs: 86400000, reason: 'deps-pending',
  }
  if (nature !== undefined) spec.nature = nature
  return spec
}

/** 读 `maid-03` 信箱里**唯一**那封已投递的信封。 */
const envelopeOf = (bus: string): Record<string, unknown> => {
  const dir = join(bus, 'mailbox', 'maid-03')
  const files = readdirSync(dir).filter((x) => x.endsWith('.json'))
  assert.equal(files.length, 1, '本测试的 bus 是干净的 ⇒ 只该有一封')
  return JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Record<string, unknown>
}

test('★★★ 尸体·E12 余件：hold 声明的 `nature` 必须**走到信封里**', () => {
  const { bus, close } = makeBus()
  try {
    const rec = buildHoldRecord(specOf('t-nature-1', 'internal'))
    assert.equal(rec.nature, 'internal', '记录本身要存下这个声明')
    assert.equal(createHold(bus, rec), '')
    assert.equal(releaseHold(bus, rec, '', T0 + MIN).ok, true)
    const meta = envelopeOf(bus)['meta'] as Record<string, unknown>
    assert.equal(meta['nature'], 'internal',
      '★ 修前这里恒为 undefined ⇒ 那条路的活**必然漏声明**（内部建设的失败会推给主人）')
  } finally { close() }
})

test('★ 对照组：**未声明** ⇒ 信封里**没有**那个键（不写空串 —— 空串读起来像「他声明了空」）', () => {
  const { bus, close } = makeBus()
  try {
    const rec = buildHoldRecord(specOf('t-nature-2'))
    assert.equal(rec.nature, '', '未声明 ⇒ 空串')
    assert.equal(createHold(bus, rec), '')
    releaseHold(bus, rec, '', T0 + MIN)
    const meta = envelopeOf(bus)['meta'] as Record<string, unknown>
    assert.equal('nature' in meta, false, '★ 非空才写：缺这个键 = 派活方没声明（消费侧取严读 owner）')
  } finally { close() }
})

test('★ 往返：落盘再读回 `nature` 不丢（序列化不许吞字段）', () => {
  const { bus, close } = makeBus()
  try {
    assert.equal(createHold(bus, buildHoldRecord(specOf('t-nature-3', 'probe'))), '')
    const { records } = loadHolds(bus)
    assert.equal(records[0]?.nature, 'probe', '写盘 → 读回 必须一致')
  } finally { close() }
})

test('★ 空 `nature` **不落盘**：盘上那份 JSON 里没有那个键（同 `reasonLegacy` 的纪律）', () => {
  const { bus, close } = makeBus()
  try {
    assert.equal(createHold(bus, buildHoldRecord(specOf('t-nature-4'))), '')
    const files = readdirSync(join(bus, 'hold'))
    assert.equal(files.length, 1)
    const raw = readFileSync(join(bus, 'hold', files[0]!), 'utf8')
    assert.equal(raw.includes('"nature"'), false, '死键不入盘（读回缺字段 ⇒ 空串，往返仍一致）')
  } finally { close() }
})
