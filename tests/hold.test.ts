/**
 * 暂不可发起（`src/hold.ts`）离线测试 —— ③ 任务与调度的依赖面。
 *
 * 纪律（§5.9 规则 2）：**每条「该放行」都要配一条「该升级」**，否则
 *   「一律升级」或「一律放行」这两种最蠢的实现都能全绿。
 * 另有三具必须存在的尸体：
 *   ① **指针 ≠ 状态** —— hold 记录里**不许出现依赖的当前状态**（易变状态不可落盘）。
 *      喂法：把一条 `waiting` 的 hold 序列化，改 world 让依赖变成 `failed`，
 *      断言**序列化结果一字未变**且重跑解释器**得到不同的话**。
 *      若哪天有人把 dep.state 缓存进记录，这条会红。
 *   ② **成环 fail-loud** —— 自依赖 / 两节点环 / 三节点环都必须被同一判据抓住。
 *   ③ **坏记录 fail-loud** —— 缺 taskId/to/dependsOn 的记录必须报错、不得静默丢弃。
 *
 * 运行：node --test tests/hold.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_HOLD_TIMEOUT_MS,
  HOLD_REASON_CODES,
  HOLD_REASON_UNKNOWN,
  HOLD_VERSION,
  buildHoldRecord,
  buildTraceLine,
  deadlineAfterMsOf,
  isHoldReasonCode,
  explainHold,
  findCycle,
  judgeExit,
  parseDependsOn,
  parseHoldFile,
  parsePriority,
  priorityRank,
  renderHoldLine,
  renderHolds,
  resolveDeps,
  judgeWorld,
  reverseScan,
  serializeHold,
  sortHolds,
  stateLabel,
  withTraceLine,
  type DepView,
  type HoldRecord,
  type WorldView,
} from '../src/hold.ts'

const T0 = 1_790_000_000_000
const H = 3600_000
const at = (h: number) => T0 - h * H

function dep(taskId: string, state: DepView['state'], over: Partial<DepView> = {}): DepView {
  return { taskId, state, owner: 'maid-03', ownerOnline: true, ownerAgeMs: 3000, source: 'logs/actions/a-1.jsonl', endedAtMs: 0, ...over }
}

function hold(over: Partial<HoldRecord> = {}): HoldRecord {
  return {
    v: HOLD_VERSION,
    taskId: 't-B',
    to: 'maid-03',
    from: 'web-0',
    kind: 'task',
    text: '干活',
    acceptance: '',
    // ★ `nature` 是后加的字段（`E12` 余件 · 2026-10-12）：**手搓 fixture 也必须给全** ——
    //   否则「序列化 → 解析 → 逐字段一致」那具往返判据会红（它正是这么红的，当场抓住我）。
    //   ⚠ 值得记的形状：`tests/` **不在 `tsconfig.json` 的 include 里** ⇒ 缺字段**不是编译错**，
    //     它只会在**运行时的逐字段判据**上露头。这就是那具 deepEqual 的价值所在
    //     （抽查式的断言会漏掉「多出一个键」这种漂移）。
    nature: '',
    cwd: '.',
    priority: 'normal',
    dependsOn: ['t-A'],
    heldAtMs: at(2),
    heldBy: 'web-0',
    reason: 'deps-pending',
    reasonLegacy: '',
    legacy: false,
    deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS,
    ttlMs: 86400000,
    escalated: '',
    ...over,
  }
}

// ── 一 · 解析层 ────────────────────────────────────────────────────────

test('优先级：已知值原样、未知值取 normal 并**给出错误文本**（不静默吞）', () => {
  assert.deepEqual(parsePriority('high'), { priority: 'high', error: '' })
  assert.deepEqual(parsePriority('HIGH'), { priority: 'high', error: '' })
  assert.deepEqual(parsePriority(undefined), { priority: 'normal', error: '' })
  const bad = parsePriority('urgent')
  assert.equal(bad.priority, 'normal')
  assert.match(bad.error, /未知优先级/)
})

test('依赖列表：接受 string / string[]、去重保序、**空项报错**、形态错报错', () => {
  assert.deepEqual(parseDependsOn('t-A').list, ['t-A'])
  assert.deepEqual(parseDependsOn(['t-A', 't-B', 't-A']).list, ['t-A', 't-B'])
  assert.deepEqual(parseDependsOn(undefined).list, [])
  const bad = parseDependsOn(['t-A', '  '])
  assert.deepEqual(bad.list, ['t-A'])
  assert.equal(bad.errors.length, 1, '空项必须报错——空依赖 = 永远等一个不存在的东西')
  assert.equal(parseDependsOn({ a: 1 }).errors.length, 1)
})

test('优先级权重与排序：先高优先级，同档**先等得久的**（priority 的真实机制效果）', () => {
  assert.ok(priorityRank('high') > priorityRank('normal'))
  assert.ok(priorityRank('normal') > priorityRank('low'))
  const a = hold({ taskId: 't-1', priority: 'low', heldAtMs: at(9) })
  const b = hold({ taskId: 't-2', priority: 'high', heldAtMs: at(1) })
  const c = hold({ taskId: 't-3', priority: 'normal', heldAtMs: at(5) })
  const d = hold({ taskId: 't-4', priority: 'high', heldAtMs: at(7) })
  assert.deepEqual(sortHolds([a, b, c, d]).map((x) => x.taskId), ['t-4', 't-2', 't-3', 't-1'])
})

// ── 二 · 成环 fail-loud（判据③）────────────────────────────────────────

test('★ 成环检测：自依赖 / 两节点 / 三节点 全都要被抓住（E11 判据③：必须 fail-loud）', () => {
  assert.equal(findCycle(new Map([['t-A', ['t-B']], ['t-B', []]])), null, '无环必须返回 null')
  const self = findCycle(new Map([['t-A', ['t-A']]]))
  assert.notEqual(self, null, '自依赖 = 长度 1 的环，必须被同一判据抓住')
  const two = findCycle(new Map([['t-A', ['t-B']], ['t-B', ['t-A']]]))
  assert.notEqual(two, null)
  assert.equal(two![0], two![two!.length - 1], '环路径首尾必须是同一点（可读性判据）')
  const three = findCycle(new Map([['t-A', ['t-B']], ['t-B', ['t-C']], ['t-C', ['t-A']]]))
  assert.notEqual(three, null)
  assert.equal(three!.length, 4, '三节点环路径 = 3 点 + 回首')
})

test('成环检测：长链（非环）**不得**误报 —— 深链不是环', () => {
  const edges = new Map<string, string[]>()
  for (let i = 0; i < 200; i++) edges.set('t-' + String(i), ['t-' + String(i + 1)])
  edges.set('t-200', [])
  assert.equal(findCycle(edges), null, '深链会被递归实现爆栈 —— 本实现用显式栈')
})

// ── 三 · 出口三条 ──────────────────────────────────────────────────────

test('出口一：依赖**全部完成** ⇒ release（这是唯一会自动投递的出口）', () => {
  const j = judgeExit(hold(), [dep('t-A', 'done', { endedAtMs: at(0.5) })], T0)
  assert.equal(j.action, 'release')
  assert.equal(j.code, 'deps-done')
})

test('出口二：依赖**失败/拒收** ⇒ escalate（dep-impossible），**绝不自动放行**', () => {
  const f = judgeExit(hold(), [dep('t-A', 'failed')], T0)
  assert.equal(f.action, 'escalate')
  assert.equal(f.code, 'dep-impossible')
  const r = judgeExit(hold(), [dep('t-A', 'rejected')], T0)
  assert.equal(r.code, 'dep-impossible')
})

test('出口二附则：依赖**在世界上不存在** ⇒ escalate（dep-missing），不是静默等', () => {
  const j = judgeExit(hold(), [dep('t-A', 'missing', { source: '账本/信箱/hold 三处皆无' })], T0)
  assert.equal(j.code, 'dep-missing')
  assert.match(j.reason, /不在世界上/)
})

test('★ 出口二附则二（哨⑥我漏的那一格）：依赖属主**心跳超判死线**且状态停在「进行中」⇒ escalate', () => {
  const alive = judgeExit(hold(), [dep('t-A', 'unfinished', { ownerOnline: true, ownerAgeMs: 3000 })], T0)
  assert.equal(alive.action, 'wait', '属主还在线 ⇒ 继续等（这是正常的）')
  const dead = judgeExit(hold(), [dep('t-A', 'unfinished', { ownerOnline: false, ownerAgeMs: DEAD })], T0)
  assert.equal(dead.action, 'escalate')
  assert.equal(dead.code, 'dep-dead')
  assert.match(dead.reason, /在线撒谎|不会自己走完/)
})

test('★ 判死必须**取宽**：心跳陈旧但未超判死线 ⇒ **不作判**，继续等（2026-10-12 活体验收抓出的缺陷）', () => {
  // 缺陷形状：只带布尔「在线/不在线」时，**心跳抖动一次**（陈旧 31s）就把活升成 `dep-dead`；
  //   而那次升级**永久留在记录里**，与同一份输出里的现读 `wait` 自相矛盾。
  //   正解：判活取窄（30s，用于呈现）、判死取宽（5min，用于升级），中间地带**不作判**。
  //   这与 `manor_patrol` 已有纪律同一条：「判死阈值有意宽于心跳新鲜阈值」。
  const jitter = judgeExit(hold(), [dep('t-A', 'unfinished', { ownerOnline: false, ownerAgeMs: 31_000 })], T0)
  assert.equal(jitter.action, 'wait', '抖动一次**不得**升级')
  assert.equal(jitter.code, 'waiting')
  const justUnder = judgeExit(hold(), [dep('t-A', 'unfinished', { ownerOnline: false, ownerAgeMs: 299_000 })], T0)
  assert.equal(justUnder.action, 'wait', '判死线以内一律不升级')
  const over = judgeExit(hold(), [dep('t-A', 'unfinished', { ownerOnline: false, ownerAgeMs: 301_000 })], T0)
  assert.equal(over.action, 'escalate', '越过判死线才升级')
  assert.match(over.reason, /判死线/)
})

test('★ 判死线可调（不写死）：deadAfterMs 一变，同一份世界裁决就变', () => {
  const d = [dep('t-A', 'unfinished', { ownerOnline: false, ownerAgeMs: 60_000 })]
  assert.equal(judgeExit(hold(), d, T0, 300_000).action, 'wait')
  assert.equal(judgeExit(hold(), d, T0, 30_000).action, 'escalate')
})

test('★ 在线面读不到 ⇒ **整轮不作判**（既不放行也不升级）——「读不到」不是「都不在线」', () => {
  // 2026-10-12 活体验收抓出的**根因**：旧版 `catch { return [] }` 把读盘失败吞成空集，
  //   下游据此判「所有属主都死了」⇒ 系统性误升级，且同一条 hold 被永久标上。
  const rec = hold({ taskId: 't-B', dependsOn: ['t-A'] })
  const blind: WorldView = { ledger: {}, queued: { 't-A': { owner: 'maid-03' } }, held: {}, heartbeatAgeMs: {}, onlineFaceOk: false }
  const j = judgeWorld([rec], blind, T0)
  assert.equal(j[0]!.exit.action, 'wait', '**不得**释放（那会误放）')
  assert.equal(j[0]!.exit.code, 'online-face-unreadable', '**不得**升级（那会误升级）')
  assert.match(j[0]!.exit.reason, /读不到.*不是.*都不在线/)
  // 对照组：同一份世界但**在线面读得到** ⇒ 会给出正常的 `waiting`
  const seeing = judgeWorld([rec], { ...blind, onlineFaceOk: true }, T0)
  assert.equal(seeing[0]!.exit.code, 'waiting')
})

test('出口三：**超时 ⇒ 升级，不自动放行**（哨：沉默的死锁比成环更危险）', () => {
  const old = hold({ heldAtMs: at(10), deadlineMs: DEFAULT_HOLD_TIMEOUT_MS })
  const j = judgeExit(old, [dep('t-A', 'pending')], T0)
  assert.equal(j.action, 'escalate')
  assert.equal(j.code, 'timeout')
  assert.match(j.reason, /不自动放行/)
})

test('出口判定优先级：全完成 > 不可能 > 属主死 > 超时（部分完成先升级，不放行）', () => {
  const mixed = judgeExit(hold(), [dep('t-A', 'done'), dep('t-C', 'failed')], T0)
  assert.equal(mixed.action, 'escalate', '一半完成一半失败 ⇒ 不能放行')
  assert.equal(mixed.code, 'dep-impossible')
})

test('无依赖的 hold 是缺陷 ⇒ 响亮报（不该静默等待）', () => {
  const j = judgeExit(hold({ dependsOn: [] }), [], T0)
  assert.equal(j.code, 'no-deps')
  assert.match(j.reason, /不该发生/)
})

// ── 四 · ★ 指针 ≠ 状态（本模块最核心的一具尸体）────────────────────────

test('★★ 判据必须作用在**生产写入器**上：`buildHoldRecord` 的产物不得含任何状态词', () => {
  // 存在理由（2026-10-12 · 两位成员独立复核得出，我照收）：
  //   修前这条判据喂的是**人手搓的良性串**（`reason: '依赖未完成'`），而生产写入器写的是
  //   `'依赖未完成：t-A（进行中（无终态） · 属主 maid-03）'` —— **逐字命中自己的禁止词表**。
  //   根因四个字：**夹具即世界**（拼装住在 index.ts 的 apply 闭包里，测试碰不到）。
  //   ⇒ 本用例的输入**必须**来自 `buildHoldRecord`（与生产同一个函数），而不是手搓对象。
  //   织的原话：「不是实现错了夹具对了，是**判据的作用域被夹具的形状限死了**。」
  const fromProduction = buildHoldRecord({
    taskId: 't-B', to: 'maid-03', from: 'web-0', kind: 'task', text: '干活',
    acceptance: '', cwd: '.', priority: 'normal', dependsOn: ['t-A'],
    heldAtMs: at(2), heldBy: 'web-0', deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS, ttlMs: 86400000,
  })
  const text = serializeHold(fromProduction)
  for (const w of ['"state"', '已完成', '已失败', '进行中', '被拒收', '在信箱里', 'ownerOnline', '属主 maid']) {
    assert.equal(text.includes(w), false, '生产形态记录里出现了状态词 "' + w + '" —— 判据必须打在写入器上')
  }
  // 反向对照：把「当时的解释」拼进 reason（= 修前的错误做法）⇒ 上表必然命中
  // ★ 喂法改过两次，两次都是被复核逼出来的，如实记：
  //   ① 第一版 `buildHoldRecord({ reason: '依赖未完成…' })` —— 类型闭集后编译不过；
  //   ② 第二版 `as unknown as HoldReasonCode` 绕过类型 ⇒ **运行期归一兜底把它 clamp 成 `unknown`**
  //      ⇒ 对照**不再命中**。★ 那本身是好消息（**兜底真的堵上了**），但对照因此失去分辨力。
  //   ⇒ 必须换成**「绕过写入器、手写记录」**的形状 —— 那才是这条词表真正要防的那一类输入
  //      （也正是 `source-of-truth-guards` 第四级的题：**写入器之外的入口才是真开口**）。
  const handWritten = JSON.stringify({
    v: 1, taskId: 't-B', to: 'maid-03', kind: 'task', text: '干活', dependsOn: ['t-A'],
    reason: '依赖未完成：t-A（' + stateLabel('unfinished') + ' · 属主 maid-03）',
  })
  assert.ok(handWritten.includes('进行中'), '对照组必须命中 ⇒ 证明上面的绿不是「词表恰好没人踩」')
})

test('★ 闭集**闭在类型上**（不只闭在「今天的调用点」）：非法码经**读盘侧**必须被拦并隔离', () => {
  // 织第二轮复核的原话：「`HoldSpec.reason?: string` —— 是 `string`，不是 `HoldReasonCode`。
  //   它能拒绝状态快照靠的不是函数，而是**今天那个唯一的生产调用点压根没传这个字段**。」
  //   ⇒ 两条修法：类型即闭集 + **读盘侧守门**（写的一侧收紧了不够，盘上的 v1 记录还在）。
  const snapshotProse = '依赖未完成：t-A（进行中（无终态） · 属主 maid-03）'
  const p = parseHoldFile(JSON.stringify({
    v: 1, taskId: 't-A', to: 'maid-03', dependsOn: ['t-X'], heldAtMs: at(1), reason: snapshotProse,
  }))
  assert.equal(p.ok, true, '**活不能丢** —— v1 记录仍要读得出来')
  assert.equal(p.record!.reason, 'unknown', '非法码 ⇒ 归一 unknown（**响亮标「不知道」**，不静默翻译成具体原因）')
  assert.equal(p.record!.reasonLegacy, snapshotProse, '原文进隔离区（可回溯，任何判定路径都不读它）')
  // 反向对照：合法码**不得**被隔离
  const okRec = parseHoldFile(JSON.stringify({
    v: 2, taskId: 't-A', to: 'maid-03', dependsOn: ['t-X'], heldAtMs: at(1), reason: 'manual',
  }))
  assert.equal(okRec.record!.reason, 'manual')
  assert.equal(okRec.record!.reasonLegacy, '', '合法码不得被当成遗留')
})

test('★ 缺字段**不得静默翻译**成某个具体原因（缺省 = unknown，不是 deps-pending）', () => {
  // 织指出：拿 `HOLD_REASON_CODES[0]` 当缺省值 = 把「没有原因」静默翻译成「依赖未就绪」
  //   ⇒ 缺字段变成了一条**关于依赖状态的断言**。
  const p = parseHoldFile(JSON.stringify({ v: 2, taskId: 't-A', to: 'maid-03', dependsOn: ['t-X'], heldAtMs: at(1) }))
  assert.equal(p.record!.reason, 'unknown')
  assert.notEqual(p.record!.reason, 'deps-pending', '缺字段不得断言「依赖未就绪」')
  const built = buildHoldRecord({
    taskId: 't-A', to: 'maid-03', from: 'web-0', kind: 'task', text: 'x',
    acceptance: '', cwd: '.', priority: 'normal', dependsOn: ['t-X'],
    heldAtMs: at(1), heldBy: 'web-0', deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS, ttlMs: 1,
  })
  assert.equal(built.reason, 'unknown')
})

test('★ 旧格式遗留必须在**可见面**上显形（不许隔离成悄悄话）', () => {
  const h = hold({ reason: 'unknown', reasonLegacy: '依赖未完成：t-A（进行中 · 属主 maid-03）' })
  const d = [dep('t-A', 'pending')]
  const s = renderHolds([{ hold: h, deps: d, exit: judgeExit(h, d, T0) }], T0)
  assert.match(s, /旧格式遗留/)
  assert.match(s, /只读诊断，不可当现状读/)
  assert.match(s, /进行中/, '原文可回溯（但被明确标记为隔离区）')
})

test('★ 记录里的 `reason` 是**原因码闭集**（闭在类型上），不是散文', () => {
  // ⚠ 织第二轮复核指出我上一版这里是**同源自证**：`assert.ok(HOLD_REASON_CODES.includes('deps-pending'))`
  //   —— 判据与对象读同一个常量，只证明常量等于它自己（`acceptance-integrity`：「期望值与被检对象同源 ⇒ 检查恒真」）。
  //   正解：**穷举闭集成员喂给写入器**（真检验「每个码都写得进去」）+ **对照**（非成员必被读盘侧拦下）。
  for (const code of HOLD_REASON_CODES) {
    const r = buildHoldRecord({
      taskId: 't-B', to: 'maid-03', from: 'web-0', kind: 'task', text: '干活',
      acceptance: '', cwd: '.', priority: 'normal', dependsOn: ['t-A'],
      heldAtMs: at(2), heldBy: 'web-0', deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS, ttlMs: 86400000,
      reason: code,
    })
    assert.equal(r.reason, code, '闭集成员 ' + code + ' 必须原样写入')
    assert.equal(isHoldReasonCode(code), true)
  }
  assert.equal(isHoldReasonCode('deps-pending '), false, '带空格不算成员（严格等值）')
  assert.equal(isHoldReasonCode(''), false)
  assert.equal(isHoldReasonCode(undefined), false)
  const rec = buildHoldRecord({
    taskId: 't-B', to: 'maid-03', from: 'web-0', kind: 'task', text: '干活',
    acceptance: '', cwd: '.', priority: 'normal', dependsOn: ['t-A'],
    heldAtMs: at(2), heldBy: 'web-0', deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS, ttlMs: 86400000,
  })
  assert.equal(rec.reason, HOLD_REASON_UNKNOWN, '**缺省是 unknown**，不是某个具体原因')
  assert.equal(rec.reasonLegacy, '', '新记录没有遗留区')
  assert.equal(rec.escalated, '', '新记录不得带升级标记')
  assert.equal(rec.v, HOLD_VERSION, '版本号要跟上')
})

test('★★ 复合判据（织第三轮复核给的）：`parse(serialize(parse(x)))` 必须与 `parse(x)` **全等**', () => {
  // 为什么单条判据抓不到：往返一致性那条喂的是**新 v2 记录**（`reasonLegacy` 本就是 `''`）⇒ **恒真**；
  //   唯一带原文的那条**只 parse、不 re-serialize**。两条性质各有判据，
  //   **而它们的复合 —— bug 唯一住的地方 —— 没有判据**。这就是「夹具的形状限死判据的作用域」的第三形态。
  // ★ 实测的 bug（织给出机制）：`parse` 把 v1 记录归一成 `reason:'unknown'`（**一个合法码**）⇒
  //   任何一次重写（升级留痕 / 清升级，走 `{ ...e.hold }`）把它连同 `reasonLegacy` 写回盘 ⇒
  //   下一次 `parse` 看到合法码 ⇒ 判定不是遗留 ⇒ **原文被它自己的载体字段清空**。
  const v1 = JSON.stringify({
    v: 1, taskId: 't-A', to: 'maid-03', kind: 'task', text: '干活', dependsOn: ['t-X'],
    heldAtMs: at(3), reason: '依赖未完成：t-X（进行中（无终态） · 属主 maid-03）',
  })
  const once = parseHoldFile(v1)
  assert.equal(once.ok, true)
  assert.equal(once.record!.reason, 'unknown', '非法码归一')
  assert.equal(once.record!.legacy, true, '时代标记必须被立起来')
  assert.match(once.record!.reasonLegacy, /进行中/, '原文必须进隔离区')
  // 复合：再序列化 → 再解析 ⇒ **必须全等**（尤其：原文不许蒸发）
  const twice = parseHoldFile(serializeHold(once.record!))
  assert.deepEqual(twice.record, once.record, '★ parse∘serialize∘parse 必须幂等 —— 不等的那一格，恰好是这个字段存在的全部理由')
  assert.match(twice.record!.reasonLegacy, /进行中/, '原文活到这条记录消失，**不随重写蒸发**')
  // 再走一轮也不许漂（幂等的幂等）
  const thrice = parseHoldFile(serializeHold(twice.record!))
  assert.deepEqual(thrice.record, once.record)
})

test('★ 时代标记**随记录持久化**，不由 `reason` 的值推断（这就是 bug 的根因）', () => {
  const rec = parseHoldFile(JSON.stringify({
    v: 1, taskId: 't-A', to: 'maid-03', dependsOn: ['t-X'], heldAtMs: at(1), reason: '依赖未完成：…',
  })).record!
  // 伪造「一次重写」：升级留痕走的是 `{ ...e.hold }`（hold-store 的既有路径）
  const rewritten = { ...rec, escalated: 'timeout' }
  const afterRewrite = parseHoldFile(serializeHold(rewritten)).record!
  assert.equal(afterRewrite.legacy, true, '重写之后**仍**必须判为遗留')
  assert.equal(afterRewrite.reasonLegacy, rec.reasonLegacy, '原文不许被重写清掉')
  // 反向对照：新记录（v2 + 合法码）**不得**被判成遗留
  const fresh = buildHoldRecord({
    taskId: 't-N', to: 'maid-03', from: 'web-0', kind: 'task', text: 'x', acceptance: '', cwd: '.',
    priority: 'normal', dependsOn: ['t-A'], heldAtMs: at(1), heldBy: 'web-0',
    deadlineAfterMs: DEFAULT_HOLD_TIMEOUT_MS, ttlMs: 1, reason: 'deps-pending',
  })
  const freshBack = parseHoldFile(serializeHold(fresh)).record!
  assert.equal(freshBack.legacy, false, '新记录不能被误判为遗留（否则隔离警告会在每条记录上刷）')
  assert.equal(freshBack.reasonLegacy, '')
  assert.equal(freshBack.reason, 'deps-pending')
})

test('★★ 时代标记只许说「怎么解读」，不许说「这个值读不出来」（织第四轮复核抓的真缺陷）', () => {
  // 她读源码给的形状：`legacy` 被当成了**全称量词**——「来自旧时代 ⇒ 这一代的话一律不可信」。
  //   可它的三个来源里只有 `!reasonOk` 在说**这个值**，另两个（`v < HOLD_VERSION` / `legacy===true`）在说**时代**。
  //   后果不是「读不出来」，是**把读得出来的扔掉**：合法码被降级成 `unknown`，
  //   而 `reasonLegacy` 那一格因 `reasonOk===true` 落成 `''` ⇒ **那个合法码哪都没留底**，
  //   且可见面（`hold.ts:589`）正好被这个三元组命中 ⇒ **反着点名「生产者没声明」，而它其实声明了**。
  //   ⇒ 两条判据分守两侧：时代标记管隔离警告，`isHoldReasonCode` 管值能不能读。
  const oldWithValidCode = JSON.stringify({
    v: 1, taskId: 't-A', to: 'maid-03', dependsOn: ['t-X'], heldAtMs: at(3),
    reason: 'deps-pending',
  })
  const rec = parseHoldFile(oldWithValidCode).record!
  assert.equal(rec.legacy, true, '旧时代记录该照旧立起时代标记')
  assert.equal(rec.reason, 'deps-pending',
    '★ 合法码必须保真 —— 降级成 unknown 等于把「它声明了」改写成「它没说」')
  const twice = parseHoldFile(serializeHold(rec)).record!
  assert.deepEqual(twice, rec, '重写不得把这个码抹掉（幂等）')

  // 第二来源：**已显式标 `legacy:true` 的当代记录**（重写路径会产生它）带合法码 —— 同一条病
  const marked = JSON.stringify({
    v: HOLD_VERSION, legacy: true, taskId: 't-B', to: 'maid-03', dependsOn: ['t-X'],
    heldAtMs: at(3), reason: 'manual', reasonLegacy: '',
  })
  const m = parseHoldFile(marked).record!
  assert.equal(m.legacy, true)
  assert.equal(m.reason, 'manual', '显式时代标记同样不许吃掉合法码')

  // ★ 尸体样本：**不合法**码才该归 `unknown` + 原文隔离 —— 证明上面的断言不是恒真
  const bad = parseHoldFile(JSON.stringify({
    v: 1, taskId: 't-C', to: 'maid-03', dependsOn: ['t-X'], heldAtMs: at(3),
    reason: '依赖未完成：t-X（进行中（无终态））',
  })).record!
  assert.equal(bad.reason, 'unknown', '非法码归 unknown（这一格必须仍然会拦）')
  assert.match(bad.reasonLegacy, /进行中/, '非法码的原文进隔离区')
  assert.notEqual(bad.reason, 'deps-pending', '反向：不许把非法码猜成某个具体原因')
})

test('★★ 预演「抬版本号」：整代落后时，**值仍按值本身判**（否则升版那天整代词一起丢底）', () => {
  // 织指出：`HOLD_VERSION` 2→3 那天，现网所有 v2 记录都满足 `v < HOLD_VERSION` ⇒ **整代判 legacy**
  //   ⇒ 旧实现会把整代的 reason 码一起降级、一起丢底，而每条上面都挂「生产者没声明」。
  //   这里用「显式写一个落后于当前的 v」来模拟那一刻（`HOLD_VERSION` 是常量，不真去改它）。
  const laggedV = JSON.stringify({
    v: HOLD_VERSION - 1, taskId: 't-E', to: 'maid-03', dependsOn: ['t-X'],
    heldAtMs: at(3), reason: 'capacity',
  })
  const r = parseHoldFile(laggedV).record!
  assert.equal(r.v, HOLD_VERSION - 1, '版本号照读，不许刷成当前（刷了下次就判不出时代）')
  assert.equal(r.legacy, true, '落后于当前的 v ⇒ 判为旧时代')
  assert.equal(r.reason, 'capacity', '★ 但它的合法码必须活下来 —— 升版不是焚书')
})

test('★ 可见面必须点名「机器面不知道原因」（哨第⑤问的运行期答案）', () => {
  // 她问：「第二个调用点忘了传 `reason`，除了那条只看 index.ts 的正则和『又有人去读 tail』之外，
  //   还有别的东西会响吗？」⇒ 答：类型层响（src 参与 tsc，必填）**+ 可见面响（本用例）**。
  const h = hold({ reason: 'unknown', reasonLegacy: '' })
  const d = [dep('t-A', 'pending')]
  const s = renderHolds([{ hold: h, deps: d, exit: judgeExit(h, d, T0) }], T0)
  assert.match(s, /机器面不知道原因/)
  assert.match(s, /生产者没声明/, '要说清这是「忘了声明」而不是「真的不知道」')
  // 反向：**归属（依赖非空）+ 合法码** ⇒ 不得刷这条警告
  const ok = hold({ reason: 'deps-pending' })
  const s2 = renderHolds([{ hold: ok, deps: d, exit: judgeExit(ok, d, T0) }], T0)
  assert.equal(s2.includes('机器面不知道原因'), false)
})

test('★ 旧字段名兼容：`deadlineMs` 时代的记录仍读得出来（且算作**时长**）', () => {
  const legacy = JSON.parse(serializeHold(buildHoldRecord({
    taskId: 't-B', to: 'maid-03', from: 'web-0', kind: 'task', text: '干活',
    acceptance: '', cwd: '.', priority: 'normal', dependsOn: ['t-A'],
    heldAtMs: at(2), heldBy: 'web-0', deadlineAfterMs: 7200000, ttlMs: 86400000,
  }))) as Record<string, unknown>
  delete legacy['deadlineAfterMs']
  legacy['deadlineMs'] = 7200000
  const p = parseHoldFile(JSON.stringify(legacy))
  assert.equal(p.ok, true)
  assert.equal(p.record!.deadlineAfterMs, 7200000)
  assert.equal(deadlineAfterMsOf(p.record!), 7200000)
})

test('★ 有意取舍钉死：依赖在**信箱里/本身在等** + 属主离线 ⇒ **只走超时，不升 dep-dead**', () => {
  // 由成员「织」提出（她标「倾向有意取舍，未被测试钉死」）—— 现按有意取舍**钉死**：
  //   `pending` = 信封还在信箱顶层（成员睡觉时它会等到她醒）；`held` = 它本身在合法地等。
  //   这两种都不是「写到一半」，故不该判「它不会自己走完」。只有 `unfinished` 才是。
  const dead = { ownerOnline: false, ownerAgeMs: DEAD }
  assert.equal(judgeExit(hold(), [dep('t-A', 'pending', dead)], T0).code, 'waiting')
  assert.equal(judgeExit(hold(), [dep('t-A', 'held', dead)], T0).code, 'waiting')
  assert.equal(judgeExit(hold(), [dep('t-A', 'unfinished', dead)], T0).code, 'dep-dead', '只有 unfinished 走 dep-dead')
})

test('★ 指针 ≠ 状态：依赖状态变化时，**记录一字未变**而解释句必须变', () => {
  const rec = hold()
  const before = serializeHold(rec)
  const waiting = explainHold(rec, [dep('t-A', 'unfinished', { ownerOnline: true, ownerAgeMs: 3000 })], T0)
  const nowDead = explainHold(rec, [dep('t-A', 'unfinished', { ownerOnline: false, ownerAgeMs: DEAD })], T0)
  const after = serializeHold(rec)
  assert.equal(before, after, '★ 记录里绝不能缓存依赖状态 —— 序列化必须一字未变')
  assert.notEqual(waiting, nowDead, '★ 同一份记录 + 不同世界 ⇒ 必须得到不同的话（否则解释是口供）')
  assert.match(waiting, /在线/)
  assert.match(nowDead, /心跳停 10 分钟/, '解释句里必须带**年龄**，不只带一个「不在线」')
})

test('★ 记录里不含任何依赖状态词 —— **输入取自生产写入器**（见上面那条 ★★ 的完整理由）', () => {
  const text = serializeHold(hold())
  for (const w of ['"state"', '已完成', '已失败', '进行中', 'ownerOnline']) {
    assert.equal(text.includes(w), false, '记录里出现了状态词 "' + w + '" —— 易变状态不可落盘')
  }
})

test('解释句是**纯函数**：同一份 world 重跑得逐字相同（哨的可证伪形式）', () => {
  const rec = hold()
  const deps = [dep('t-A', 'unfinished', { owner: 'maid-03', ownerOnline: true }), dep('t-C', 'pending')]
  assert.equal(explainHold(rec, deps, T0), explainHold(rec, deps, T0))
})

test('解释句带**来源定位符**与年龄（否则不可独立复核）', () => {
  const s = explainHold(hold(), [dep('t-A', 'unfinished', { source: 'mailbox/maid-03/m-x.json' })], T0)
  assert.match(s, /t-A/)
  assert.match(s, /来源 mailbox\/maid-03\/m-x\.json/)
  assert.match(s, /已等 2\.0 小时/)
})

// ── 五 · 反向扫描器（哨②：能把判定翻过来证伪的才算防线）──────────────

test('★ 反向扫描①：依赖**已满足却还在 hold 里** ⇒ 必须被点出（释放器没转）', () => {
  // ⚠ 口径演化（2026-10-12）：本条原先只喂「状态 = done」就够；现在「已完成」**不再足够** ——
  //   还要**超过释放宽限**才叫「释放器没转」（否则刚完成、sweep 未到的那一格会被误报）。
  //   这里补的是**夹具本来就该有的字段**（完成时刻），断言一个字没动。
  const e = { hold: hold({ taskId: 't-B' }), deps: [dep('t-A', 'done', { endedAtMs: T0 - 300_000 })] }
  const r = reverseScan([e], T0)
  assert.equal(r.readyButHeld.length, 1)
  assert.match(r.readyButHeld[0]!.reason, /应被释放/)
  assert.equal(r.depDead.length, 0)
})

test('★ 反向扫描②：依赖方**已不活（超判死线）/ 已不可能 / 找不到** ⇒ 必须被点出', () => {
  const a = reverseScan([{ hold: hold({ taskId: 't-1' }), deps: [dep('t-X', 'unfinished', { ownerOnline: false, ownerAgeMs: DEAD })] }], T0)
  assert.equal(a.depDead.length, 1)
  const b = reverseScan([{ hold: hold({ taskId: 't-2' }), deps: [dep('t-X', 'missing')] }], T0)
  assert.equal(b.depDead.length, 1)
  const c = reverseScan([{ hold: hold({ taskId: 't-3' }), deps: [dep('t-X', 'failed')] }], T0)
  assert.equal(c.depDead.length, 1)
  // ★ 与 judgeExit 同一条判死线：抖动**不得**被反向扫描报成「依赖方已不活」
  const jitter = reverseScan([{ hold: hold({ taskId: 't-4' }), deps: [dep('t-X', 'unfinished', { ownerOnline: false, ownerAgeMs: 31_000 })] }], T0)
  assert.equal(jitter.depDead.length, 0, '抖动一次不得进「已不活」清单（否则反向扫描自己成了噪音源）')
})

test('反向扫描：正常等待中的 hold **不得**被误报（对照组不失败 = 实验有结论）', () => {
  const r = reverseScan([{ hold: hold(), deps: [dep('t-A', 'unfinished', { ownerOnline: true })] }], T0)
  assert.equal(r.readyButHeld.length, 0)
  assert.equal(r.depDead.length, 0)
})

test('★★ 反向扫描的**窗口期**：依赖刚完成、sweep 还没到下一轮 ⇒ **不许报**（2026-10-12 真活实测连报两次假异常）', () => {
  // 实况（真活，不是构造）：18:15:38 勘投结果 ⇒ 18:15:54 与 18:16:24 反向扫描**两次**报
  //   「依赖已全部完成，但这条活仍在 hold 里（应被释放）」⇒ **18:16:32 sweep 真释放了**
  //   ⇒ 那两条报告**都是假的**。
  // 根因：sweep 是 60s 的独立周期，「刚满足（正常等待）」与「释放器没转（真故障）」
  //   在**只看状态**时不可分 —— 判据缺了**时间预算**。
  // 代价不对称：假阳性毁掉的是**整条防线的可信度**（读者学会忽略它 = 我今天刚写下的那句
  //   「假异常是防线被忽略的起点」），而漏报只是把真故障的发现推后一轮。
  //   ⇒ 两害相权取其宽。
  const GRACE = 120_000
  const justDone = reverseScan(
    [{ hold: hold({ taskId: 't-W1' }), deps: [dep('t-A', 'done', { endedAtMs: T0 - 54_000 })] }],
    T0, undefined, GRACE,
  )
  assert.equal(justDone.readyButHeld.length, 0, '54 秒前完成（< 宽限）⇒ 正常等待，必须沉默')

  const boundary = reverseScan(
    [{ hold: hold({ taskId: 't-W2' }), deps: [dep('t-A', 'done', { endedAtMs: T0 - GRACE })] }],
    T0, undefined, GRACE,
  )
  assert.equal(boundary.readyButHeld.length, 1, '正好等于宽限 ⇒ 取 `>=`（边界归入「该报了」）')

  const stale = reverseScan(
    [{ hold: hold({ taskId: 't-W3' }), deps: [dep('t-A', 'done', { endedAtMs: T0 - 300_000 })] }],
    T0, undefined, GRACE,
  )
  assert.equal(stale.readyButHeld.length, 1, '5 分钟前完成 ⇒ 真的该报了')
  assert.match(stale.readyButHeld[0]!.reason, /应被释放/)

  // ★ 尸体样本（证明上面不是恒真）：**完成时刻读不到**是另一回事 —— 它是数据缺口，
  //   不许静默（那正是「静默失败 = 死亡温床」），也不许冒充「超期」。
  const noTime = reverseScan(
    [{ hold: hold({ taskId: 't-W4' }), deps: [dep('t-A', 'done', { endedAtMs: 0 })] }],
    T0, undefined, GRACE,
  )
  assert.equal(noTime.readyButHeld.length, 1, '读不到时刻不许静默')
  assert.match(noTime.readyButHeld[0]!.reason, /完成时刻读不到/, '措辞必须指向**数据缺口**，不是「应被释放」')
})

// ── 六 · 溯源行（澄：跟结果同一趟出来，不是她问才给）──────────────────

test('溯源行：含**出处三件**（自何时起等 · 等谁 · 它何时完成），且拼在正文最前', () => {
  const line = buildTraceLine(hold(), [dep('t-A', 'done', { endedAtMs: at(0.5) })], T0)
  assert.match(line, /【出处】/)
  assert.match(line, /等 t-A/)
  assert.match(line, /已完成/)
  const merged = withTraceLine('真正要她干的活', line)
  assert.ok(merged.startsWith('【出处】'), '必须是**正文第一行**（流水线上贴着的那张单子）')
  assert.ok(merged.endsWith('真正要她干的活'))
})

test('溯源行：无追溯信息时**不硬拼**（空串 ⇒ 正文原样）', () => {
  assert.equal(withTraceLine('正文', ''), '正文')
})

// ── 七 · 可见面（哨四件：名字 · 异形 · 挂起者+依赖项 · 每轮都在）──────

test('★ 异形：0 条与 N 条长得**完全不一样**（「恒定置顶会退化」的防法）', () => {
  const zero = renderHolds([], T0)
  assert.match(zero, /0 条/)
  const one = renderHolds([{ hold: hold(), deps: [dep('t-A', 'unfinished', { ownerOnline: true })], exit: judgeExit(hold(), [dep('t-A', 'unfinished', { ownerOnline: true })], T0) }], T0)
  assert.match(one, /⏸/)
  assert.match(one, /暂不可发起/)
  assert.notEqual(zero, one)
})

test('★ 可见面必须含**挂起者 + 依赖项 + 出口裁决**（缺一 = 把「没人拿」升级成「没人看」）', () => {
  const h = hold({ heldBy: 'web-0', reason: 'deps-pending' })
  const d = [dep('t-A', 'unfinished', { ownerOnline: true })]
  const s = renderHolds([{ hold: h, deps: d, exit: judgeExit(h, d, T0) }], T0)
  assert.match(s, /挂起者 web-0/)
  assert.match(s, /挂起原因码：deps-pending/)
  assert.match(s, /t-A（进行中（无终态）/)
  assert.match(s, /出口裁决：wait/)
})

test('★ 记录层不含状态快照、现读层给出当下状态（2026-10-12 两位成员独立复核后定型）', () => {
  // 缺陷形状（活体验收抓出，随后由织与哨各自独立复核确认）：`reason` 曾是**挂起那一刻的状态快照**，
  //   渲染时与「现读」并列 ⇒ 读者会把冻结点读成现状。
  // 修法**不是**给渲染加标注（那只是免责声明），是**让记录层结构上装不下状态快照**
  //   （`reason` = 闭集原因码），而完整解释进 **trace 的事件流**（事件流是历史，记录是状态）。
  const h = hold({ heldAtMs: at(3), reason: 'deps-pending' })
  const d = [dep('t-A', 'done', { endedAtMs: at(1) })]   // 现在它已经完成了
  const s = renderHolds([{ hold: h, deps: d, exit: judgeExit(h, d, T0) }], T0)
  assert.match(s, /挂起原因码：deps-pending/, '记录层只出一个码')
  assert.match(s, /不含任何状态快照/, '必须说清为什么这里没有状态')
  assert.match(s, /hold-created/, '完整解释在哪要说清楚（否则读者以为解释丢了）')
  assert.match(s, /现在的状态（\*\*现读\*\*）：.*已完成/, '现读的那一层必须给出当下的状态')
  // 反向：两行必须**都在**，且冻结层必须带生成时刻（否则读者分不清哪个是现在）
  const lines = s.split('\n').filter((l) => l.includes('挂起原因码') || l.includes('现在的状态'))
  assert.equal(lines.length, 2, '两层缺一 ⇒ 读者分不清哪个是现在')
  assert.match(lines[0]!, /20\d\d-\d\d-\d\dT/, '挂起层必须带时刻')
})

test('已升级的 hold 在渲染里**必须显形**（⚠ 需裁决），且可只列升级项', () => {
  const h = hold({ escalated: 'timeout' })
  const d = [dep('t-A', 'pending')]
  const all = renderHolds([{ hold: h, deps: d, exit: judgeExit(h, d, T0) }], T0)
  assert.match(all, /⚠ 需裁决\[timeout\]/)
  const only = renderHolds([{ hold: hold(), deps: [dep('t-A', 'pending')], exit: judgeExit(hold(), [dep('t-A', 'pending')], T0) }], T0, { escalatedOnly: true })
  assert.match(only, /没有已升级的挂起项/)
})

test('常读面那一行：0 条时**一个字都不加**、需裁决时必须报数', () => {
  assert.equal(renderHoldLine(0, 0), '', '无挂起项时不能加噪音 —— 否则它会退化成每次都有的段')
  assert.match(renderHoldLine(2, 0), /暂不可发起 2 条/)
  assert.match(renderHoldLine(2, 1), /1 条需裁决/)
})

test('渲染口径行必须写明「状态现读、记录只存指针」（可独立复核）', () => {
  const h = hold()
  const d = [dep('t-A', 'pending')]
  const s = renderHolds([{ hold: h, deps: d, exit: judgeExit(h, d, T0) }], T0)
  assert.match(s, /指针/)
  assert.match(s, /易变状态不可落盘/)
  assert.match(s, /不自动放行/)
})

// ── 八 · 坏记录 fail-loud（尸体③）─────────────────────────────────────

test('★ 坏记录必须报错，**不得静默丢弃**（「读不到」≠「不在」）', () => {
  assert.equal(parseHoldFile('{ 坏 json').ok, false)
  assert.equal(parseHoldFile('[]').ok, false)
  assert.equal(parseHoldFile('{}').ok, false)
  const noTo = parseHoldFile(JSON.stringify({ taskId: 't-A', dependsOn: ['t-B'] }))
  assert.equal(noTo.ok, false)
  assert.match(noTo.error, /缺 to/)
  const noDeps = parseHoldFile(JSON.stringify({ taskId: 't-A', to: 'maid-03' }))
  assert.equal(noDeps.ok, false)
  assert.match(noDeps.error, /缺 dependsOn/)
})

test('好记录往返：序列化 → 解析 → 逐字段一致', () => {
  const rec = hold({ priority: 'high', dependsOn: ['t-A', 't-C'], escalated: '' })
  const r = parseHoldFile(serializeHold(rec))
  assert.equal(r.ok, true)
  assert.deepEqual(r.record, rec)
})

test('未知优先级在解析层**降级但不丢**（normal + 错误由派活侧回给调用方）', () => {
  const r = parseHoldFile(JSON.stringify({ taskId: 't-A', to: 'maid-03', dependsOn: ['t-B'], priority: 'urgent' }))
  assert.equal(r.ok, true)
  assert.equal(r.record!.priority, 'normal')
  assert.equal(parsePriority('urgent').error !== '', true, '错误文本必须由派活侧回出去')
})

// ── 九 · 世界解析 + 端到端解释器（哨的可证伪形式）──────────────────────

/** 一份「一切正常」的世界：maid-03 心跳 3 秒前，在线面读得到。 */
function world(over: Partial<WorldView> = {}): WorldView {
  return { ledger: {}, queued: {}, held: {}, heartbeatAgeMs: { 'maid-03': 3000 }, onlineFaceOk: true, ...over }
}

const DEAD = 600_000   // 超判死线（缺省 300_000）

test('世界解析顺序：账本 > 信箱 > hold > **找不到**（找不到必须自报三处皆无）', () => {
  const w = world({
    ledger: { 't-A': { state: 'done', owner: 'maid-03', endedAtMs: at(1), source: '账本 a-1.jsonl' } },
    queued: { 't-B': { owner: 'maid-03' } },
    held: { 't-C': { owner: 'maid-02' } },
    heartbeatAgeMs: { 'maid-03': 3000 },
  })
  const r = resolveDeps(['t-A', 't-B', 't-C', 't-D'], w)
  assert.equal(r[0]!.state, 'done')
  assert.equal(r[0]!.endedAtMs, at(1))
  assert.equal(r[1]!.state, 'pending')
  assert.equal(r[1]!.ownerOnline, true)
  assert.equal(r[2]!.state, 'held')
  assert.equal(r[2]!.ownerOnline, false, 'maid-02 不在 online 里 ⇒ 不在线（不猜）')
  assert.equal(r[3]!.state, 'missing')
  assert.match(r[3]!.source, /三处皆无/)
})

test('★ 独立可核：两个**活的**真实状态重跑解释器 ⇒ 逐字同一句话；换世界 ⇒ 必换一句话', () => {
  const rec = hold({ taskId: 't-B', dependsOn: ['t-A'] })
  const live = world({
    ledger: { 't-A': { state: 'unfinished', owner: 'maid-03', endedAtMs: 0, source: '账本 a-9.jsonl' } },
    heartbeatAgeMs: { 'maid-03': 3000 },
  })
  const s1 = judgeWorld([rec], live, T0)
  const s2 = judgeWorld([rec], live, T0)
  assert.equal(explainHold(s1[0]!.hold, s1[0]!.deps, T0), explainHold(s2[0]!.hold, s2[0]!.deps, T0))
  assert.equal(s1[0]!.exit.action, 'wait')

  const dead = world({ ...live, heartbeatAgeMs: { 'maid-03': 600000 } })
  const s3 = judgeWorld([rec], dead, T0)
  assert.notEqual(explainHold(s3[0]!.hold, s3[0]!.deps, T0), explainHold(s1[0]!.hold, s1[0]!.deps, T0), '世界变了，话必须变')
  assert.equal(s3[0]!.exit.code, 'dep-dead')
})

test('端到端：一条 hold 从「等」到「放」到「升级」三种世界各判一次（三种出口都有尸体）', () => {
  const rec = hold({ taskId: 't-B', dependsOn: ['t-A'] })
  const waiting = judgeWorld([rec], world({ queued: { 't-A': { owner: 'maid-03' } }, heartbeatAgeMs: { 'maid-03': 3000 } }), T0)
  assert.equal(waiting[0]!.exit.action, 'wait')
  const ready = judgeWorld([rec], world({ ledger: { 't-A': { state: 'done', owner: 'maid-03', endedAtMs: at(1), source: 'x' } }, heartbeatAgeMs: { 'maid-03': 3000 } }), T0)
  assert.equal(ready[0]!.exit.action, 'release')
  const esc = judgeWorld([rec], world({}), T0)
  assert.equal(esc[0]!.exit.action, 'escalate')
  assert.equal(esc[0]!.exit.code, 'dep-missing')
})

test('★ 端到端不可复核性防线：解释句里的每个事实都能在 world 里找到出处', () => {
  const rec = hold({ taskId: 't-B', dependsOn: ['t-A', 't-C'] })
  const w = world({
    ledger: { 't-A': { state: 'done', owner: 'maid-03', endedAtMs: at(1), source: '账本 a-1.jsonl' } },
    queued: { 't-C': { owner: 'maid-02' } },
    heartbeatAgeMs: { 'maid-02': 3000 },
  })
  const j = judgeWorld([rec], w, T0)
  const s = explainHold(j[0]!.hold, j[0]!.deps, T0)
  assert.match(s, /来源 账本 a-1\.jsonl/)
  assert.match(s, /来源 信箱 maid-02（顶层，未被取走）/)
  assert.equal(j[0]!.exit.action, 'wait', '一条完成、一条在信箱 ⇒ 还得等')
})

