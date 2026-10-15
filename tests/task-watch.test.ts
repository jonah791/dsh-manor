/**
 * 任务失败守望（⑥「追」半环）纯函数测试。
 *
 * 四条纪律各配**尸体样本**（证明判据会拒，而不是「恰好没出错」）：
 *   W1 只报新增 · W2 拒收不报故障 · W3 未完优先 · W4 首轮只建基线
 * 夹具仍取自**真实日志原文**（经 task-ledger 折成 TaskRecord），不是编造的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  foldTasks, parseActionLog, renderAsOf, renderLedger, summarizeTasks, type TaskRecord,
} from '../src/task-ledger.ts'

const here = dirname(fileURLToPath(import.meta.url))
import {
  emptyTaskWatchState,
  normalizeTaskWatchState,
  planTaskWatch,
  renderTaskAlerts,
  type TaskWatchState,
} from '../src/task-watch.ts'

const T0 = 1_790_000_000_000

/** 已过首轮（基线已建）的状态 —— 测「增量告警」语义时必须用它。 */
const seededState = (t: number = T0): TaskWatchState => ({ ...emptyTaskWatchState(t), baselineAtMs: t })

/** 真样本：超时失败。
 *  ⚠ 每个数组元素必须是**完整的一行 JSON**——`parseActionLog` 逐行解析，
 *  把一行拆成两个元素会让两半都不是合法 JSON（2026-10-11 实测踩过）。 */
const FAIL_JSON = [
  '{"at":"2026-10-10T15:13:14.760Z","actionId":"a-1","stage":"start","step":0,"total":1,"humanText":"收到任务 t-f1：做点事","detail":{"taskId":"t-f1","from":"web-0","profile":"maid-03"}}',
  '{"at":"2026-10-10T15:30:06.351Z","actionId":"a-1","stage":"failed","step":1,"total":1,"humanText":"任务未完成：超时","detail":{"taskId":"t-f1","ok":false,"ms":1011593}}',
].join('\n')

/** 真样本：静默失败（有 start 无终态）。 */
const SILENT_JSON =
  '{"at":"2026-10-11T00:00:00.000Z","actionId":"a-2","stage":"start","humanText":"收到任务 t-s1：x",'
  + '"detail":{"taskId":"t-s1","profile":"maid-02"}}'

/** 真样本：拒收（正文为空）。 */
const REJECT_JSON =
  '{"at":"2026-10-11T13:49:22.251Z","actionId":"a-3","stage":"failed","humanText":"任务正文为空",'
  + '"detail":{"taskId":"t-r1"}}'

/** 真样本：完成。 */
const DONE_JSON = [
  '{"at":"2026-10-11T13:49:22.336Z","actionId":"a-4","stage":"start","step":0,"total":1,"humanText":"收到任务 t-d1：x","detail":{"taskId":"t-d1","profile":"maid-05"}}',
  '{"at":"2026-10-11T13:49:28.866Z","actionId":"a-4","stage":"done","step":1,"total":1,"humanText":"任务完成，1 条证据","detail":{"taskId":"t-d1","ok":true,"ms":6539}}',
].join('\n')

const tasksOf = (...parts: string[]): TaskRecord[] => foldTasks(parseActionLog(parts.join('\n')))

// ═══════════════ 尸体样本：四条纪律 ═══════════════

test('尸体·W4：首轮**只建基线、不告警**（否则启用瞬间 18 条历史失败全推出去 = 狼来了最坏形态）', () => {
  const tasks = tasksOf(FAIL_JSON, SILENT_JSON)
  const r = planTaskWatch(tasks, emptyTaskWatchState(T0), T0)
  assert.equal(r.alerts.length, 0, '首轮一条都不报')
  assert.equal(r.seeded, 2, '但要全部登记进基线')
  assert.notEqual(r.nextState.baselineAtMs, 0, '基线时刻已落')
  assert.equal(r.totalFailed, 1, '总数读数仍然如实（首轮不报 ≠ 没有失败）')
})

test('尸体·W4 反向：建完基线后，新失败必须报（否则上面那条只是恒不报）', () => {
  const r1 = planTaskWatch(tasksOf(FAIL_JSON), emptyTaskWatchState(T0), T0)
  const r2 = planTaskWatch(tasksOf(FAIL_JSON, SILENT_JSON), r1.nextState, T0 + 1000)
  assert.equal(r2.alerts.length, 1)
  assert.equal(r2.alerts[0]!.taskId, 't-s1')
})

test('尸体·W1：同一批任务跑两轮 ⇒ 第二轮**零新增**（防重复告警淹掉通道）', () => {
  const tasks = tasksOf(FAIL_JSON, SILENT_JSON)
  const r1 = planTaskWatch(tasks, seededState(), T0 + 60_000)
  assert.equal(r1.alerts.length, 2, '已建基线后，两条都该报')
  const r2 = planTaskWatch(tasks, r1.nextState, T0 + 120_000)
  assert.equal(r2.alerts.length, 0, '第二轮零新增')
  assert.equal(r2.totalFailed, 1, '但总数读数仍在（不是「没有失败」）')
  assert.equal(r2.totalUnfinished, 1)
})

test('尸体·W2：拒收**不进**故障告警（它是防线在工作，不是故障）', () => {
  const r = planTaskWatch(tasksOf(REJECT_JSON, FAIL_JSON), seededState(), T0)
  assert.equal(r.rejectedSeen, 1)
  assert.equal(r.alerts.length, 1, '只有那条真失败进告警')
  assert.equal(r.alerts[0]!.taskId, 't-f1')
  assert.equal(r.alerts.some((a) => a.taskId === 't-r1'), false, '拒收不得出现在告警里')
})

test('尸体·W3：未完排在 failed 之前（静默失败更值得先喊）', () => {
  const r = planTaskWatch(tasksOf(FAIL_JSON, SILENT_JSON), seededState(), T0)
  assert.equal(r.alerts.length, 2)
  assert.equal(r.alerts[0]!.outcome, 'unfinished', '静默失败在最前')
  assert.equal(r.alerts[0]!.reason, 'silent')
  assert.equal(r.alerts[1]!.outcome, 'failed')
  assert.equal(r.alerts[1]!.reason, 'timeout')
})

test('完成与拒收都不进告警', () => {
  const r = planTaskWatch(tasksOf(DONE_JSON, REJECT_JSON), seededState(), T0)
  assert.equal(r.alerts.length, 0)
  assert.equal(r.rejectedSeen, 1)
  assert.equal(r.totalFailed, 0)
})

// ═══════════════ 状态归一（坏状态不许带塌） ═══════════════

test('归一：坏状态补默认，不抛', () => {
  const s1 = normalizeTaskWatchState(null, T0)
  assert.deepEqual(s1.seen, {})
  assert.equal(s1.reportedTotal, 0)
  assert.equal(s1.baselineAtMs, 0, '坏状态 = 未建基线（首轮语义），不会误告警')
  const s2 = normalizeTaskWatchState({ seen: { a: 'x', b: 5 }, reportedTotal: 'nope' }, T0)
  assert.deepEqual(s2.seen, { b: 5 }, '只收数字值，脏键丢弃')
  assert.equal(s2.reportedTotal, 0)
  const s3 = normalizeTaskWatchState([], T0)
  assert.equal(s3.v, 1)
})

test('归一 往返：planTaskWatch 产出的状态能被自己读回（落盘再读仍不重报）', () => {
  const r1 = planTaskWatch(tasksOf(FAIL_JSON), seededState(), T0)
  assert.equal(r1.alerts.length, 1)
  const round = normalizeTaskWatchState(JSON.parse(JSON.stringify(r1.nextState)), T0)
  const r2 = planTaskWatch(tasksOf(FAIL_JSON), round, T0 + 1000)
  assert.equal(r2.alerts.length, 0, '落盘再读回仍不重报')
})

// ═══════════════ 渲染 ═══════════════

test('渲染：空数组返回空串（调用方据此决定不发——不发空消息）', () => {
  assert.equal(renderTaskAlerts([]), '')
})

test('渲染：含未完时显式点名「静默失败 · 最该追的一类」', () => {
  const r = planTaskWatch(tasksOf(FAIL_JSON, SILENT_JSON), seededState(), T0)
  const text = renderTaskAlerts(r.alerts)
  assert.match(text, /新增 2 条/)
  assert.match(text, /静默失败/)
  assert.match(text, /t-f1/)
  assert.match(text, /timeout/)
  assert.match(text, /maid-03/)
})

// ═══════════ W5：未完的静默期（2026-10-12 主人问「怎么发了一堆任务失败」时查出）═══════════

/** `SILENT_JSON` 里那条 start 的**真实**时刻（UTC）——静默期必须拿真实时间算。 */
const SILENT_START_MS = Date.parse('2026-10-11T00:00:00.000Z')

test('★ 尸体·W5：**年轻的未完不报** —— 修前它会立刻被报成「⛔ 静默失败」', () => {
  // 这正是那天的误报：我 09:57 派的活，10:01 被报（**4 分钟**），而它其实还在跑。
  const r = planTaskWatch(tasksOf(SILENT_JSON), seededState(SILENT_START_MS), SILENT_START_MS + 4 * 60 * 1000)
  assert.equal(r.alerts.length, 0, '年轻的未完不许报')
  assert.equal(r.young, 1, '★ 它必须**可见** —— 否则「没报」与「没有未完」会被读成同一件事')
})

test('★ W5 反向：超过静默期 ⇒ 必须报（否则上面那条只是恒不报）', () => {
  const r = planTaskWatch(tasksOf(SILENT_JSON), seededState(SILENT_START_MS), SILENT_START_MS + 26 * 60 * 1000)
  assert.equal(r.alerts.length, 1)
  assert.equal(r.alerts[0]?.outcome, 'unfinished')
  assert.equal(r.young, 0)
})

test('★★ W5 不许漏报：年轻那轮**不写进 seen** ⇒ 到期后仍然会报', () => {
  const tasks = tasksOf(SILENT_JSON)
  const r1 = planTaskWatch(tasks, seededState(SILENT_START_MS), SILENT_START_MS + 60 * 1000)
  assert.equal(r1.alerts.length, 0)
  assert.equal(r1.nextState.seen['t-s1'], undefined,
    '★ 写进 seen ⇒ 它下次超时永远不再报（**漏报比误报更坏**）')
  const r2 = planTaskWatch(tasks, r1.nextState, SILENT_START_MS + 30 * 60 * 1000)
  assert.equal(r2.alerts.length, 1, '到期必须报出来')
})

test('★ W5 只管未完：`failed` 有终态 ⇒ **立即报**，不等静默期', () => {
  const failMs = Date.parse('2026-10-10T15:30:06.351Z')
  const r = planTaskWatch(tasksOf(FAIL_JSON), seededState(failMs), failMs + 60 * 1000)
  assert.equal(r.alerts.length, 1, '有终态的失败不需要等静默期（等到期只会拖慢真故障的通报）')
  assert.equal(r.young, 0)
})

test('★★ 尸体·W5「负数 ≠ 年轻」：时间算不出来时**取严报出**', () => {
  // `now` 早于 start（时钟倒挂 / 夹具用了假 now）⇒ age < 0。
  // 若把负数当「年轻」，**所有**未完都会被静默掉 —— 而本判据上线时 5 条既有测试正是这样红的。
  const r = planTaskWatch(tasksOf(SILENT_JSON), seededState(T0), T0)
  assert.equal(r.young, 0, '★ 「算不出来」不是「很年轻」')
  assert.equal(r.alerts.length, 1, '算不出来时取严：报（漏报比误报坏）')
})

test('★ W5 静默期可配：传 0 ⇒ 任何未完立即报（回到修前的时效，排障时用）', () => {
  const r = planTaskWatch(tasksOf(SILENT_JSON), seededState(SILENT_START_MS), SILENT_START_MS + 1000, 0)
  assert.equal(r.alerts.length, 1)
})

// ═══════════ W6：按 `nature` 分流（2026-10-12 · 主人问「怎么发了一堆任务失败」）═══════════
//
// 分流的依据是**派活侧声明的 `nature`**，不是消费侧猜「哪条像主人的活」（那是编造）。
// ⚠ 本组最要紧的一条：**`quietAlerts` 不是垃圾桶** —— 「不推」≠「不记」。

/** 真样本：带 `nature` 声明的失败（`nature` 落在 start 行的 `detail` 里，与 adapter 实际写法一致）。 */
const failWithNature = (taskId: string, nature: string): string => [
  '{"at":"2026-10-10T15:13:14.760Z","actionId":"a-' + taskId + '","stage":"start","step":0,"total":1,'
  + '"humanText":"收到任务 ' + taskId + '：做点事","detail":{"taskId":"' + taskId + '","from":"web-0",'
  + '"profile":"maid-03","nature":"' + nature + '"}}',
  '{"at":"2026-10-10T15:30:06.351Z","actionId":"a-' + taskId + '","stage":"failed","step":1,"total":1,'
  + '"humanText":"任务未完成：超时","detail":{"taskId":"' + taskId + '","ok":false,"ms":1011593}}',
].join('\n')

const atFail = Date.parse('2026-10-10T15:31:00.000Z')

test('★★ W6 尸体：`internal` 档的新增失败**不推给主人**（修前它和主人的活一起推）', () => {
  const r = planTaskWatch(tasksOf(failWithNature('t-int1', 'internal')), seededState(atFail), atFail)
  assert.equal(r.alerts.length, 0, '内部试错不推')
  assert.equal(r.quietAlerts.length, 1, '★ 但**要记** —— 丢进垃圾桶就是把「内部失败的可见性」一起削掉')
  assert.equal(r.quietAlerts[0]?.nature, 'internal')
  assert.equal(r.quietAlerts[0]?.taskId, 't-int1')
})

test('★ W6 对照：`owner` 档 ⇒ 进 alerts（证明分流不是「一律不推」）', () => {
  const r = planTaskWatch(tasksOf(failWithNature('t-own1', 'owner')), seededState(atFail), atFail)
  assert.equal(r.alerts.length, 1)
  assert.equal(r.quietAlerts.length, 0)
})

test('★★ W6 取严尸体：**没声明** `nature` ⇒ 按 `owner` 推（漏报主人的活比多报噪音更坏）', () => {
  // FAIL_JSON 里**没有** nature 字段 —— 这正是全量历史日志的形态。
  const r = planTaskWatch(tasksOf(FAIL_JSON), seededState(atFail), atFail)
  assert.equal(r.alerts.length, 1, '★ 未声明必须取严推给主人')
  assert.equal(r.alerts[0]?.nature, 'owner')
})

test('★ W6：`probe` 档同样不推（探针/仪器验收不是主人的活）', () => {
  const r = planTaskWatch(tasksOf(failWithNature('t-prb1', 'probe')), seededState(atFail), atFail)
  assert.equal(r.alerts.length, 0)
  assert.equal(r.quietAlerts[0]?.nature, 'probe')
})

test('★★ W6 不许丢：新增失败的总数 = alerts + quietAlerts（两格都要产出）', () => {
  const r = planTaskWatch(
    tasksOf(failWithNature('t-a', 'owner'), failWithNature('t-b', 'internal'), failWithNature('t-c', 'probe')),
    seededState(atFail),
    atFail,
  )
  assert.equal(r.alerts.length + r.quietAlerts.length, 3, '★ 三条新增失败，一格都不能少')
  assert.equal(r.alerts.length, 1)
  assert.equal(r.quietAlerts.length, 2)
})

test('★ W6 与 W5 正交：静默期只作用于 unfinished，`nature` 只作用于分流（互不干扰）', () => {
  const r = planTaskWatch(tasksOf(failWithNature('t-x', 'internal'), SILENT_JSON), seededState(SILENT_START_MS), SILENT_START_MS + 4 * 60 * 1000)
  assert.equal(r.quietAlerts.length, 1, 'internal 的 failed ⇒ quiet')
  assert.equal(r.young, 1, '年轻的 unfinished ⇒ 静默期拦下（两条判据各自生效）')
  assert.equal(r.alerts.length, 0)
})

/* ═══════════ W7：取严缺省的**审计把手**（成员织 · 2026-10-12 · 我认）═══════════
 * 她的反驳逐字（我全认）：
 *   > `DEFAULT_TASK_NATURE` 的**点火率 ≡ 声明漏写率**（构造决定）。声明覆盖完整时，
 *   > 缺省几乎不点火；声明有洞时，缺省取 `owner` 不是加一条噪音，是**把这个字段当初
 *   > 要拦的洪水原样放回来** —— 而洪水经由疲劳造成的漏报，恰恰就是「漏报主人的活」。
 *   > **取严的缺省会亲手造出它要防的那件事。**
 * ⇒ 所以「缺省取 owner 不是缺陷」只差一个从句：**+ 缺省率可测**。
 *   测不到点火率时，「取严」与「取宽」在读数上**不可区分**（两侧都表现为「推了」）。
 */

/** 真样本：派活时**显式声明**了 nature（日志里真有那个字段）。 */
const DECLARED_OWNER = [
  '{"at":"2026-10-12T01:00:00.000Z","actionId":"a-7","stage":"start","humanText":"收到任务 t-n1：x","detail":{"taskId":"t-n1","profile":"maid-01","nature":"owner"}}',
  '{"at":"2026-10-12T01:00:05.000Z","actionId":"a-7","stage":"done","humanText":"任务完成","detail":{"taskId":"t-n1","ok":true,"ms":5000}}',
].join('\n')

/** 真样本：**未声明** nature（日志里没有那个字段）。 */
const UNDECLARED = [
  '{"at":"2026-10-12T01:01:00.000Z","actionId":"a-8","stage":"start","humanText":"收到任务 t-n2：x","detail":{"taskId":"t-n2","profile":"maid-01"}}',
  '{"at":"2026-10-12T01:01:05.000Z","actionId":"a-8","stage":"done","humanText":"任务完成","detail":{"taskId":"t-n2","ok":true,"ms":5000}}',
].join('\n')

/** 真样本：显式声明 `internal`。 */
const DECLARED_INTERNAL = [
  '{"at":"2026-10-12T01:02:00.000Z","actionId":"a-9","stage":"start","humanText":"收到任务 t-n3：x","detail":{"taskId":"t-n3","profile":"maid-01","nature":"internal"}}',
  '{"at":"2026-10-12T01:02:05.000Z","actionId":"a-9","stage":"done","humanText":"任务完成","detail":{"taskId":"t-n3","ok":true,"ms":5000}}',
].join('\n')

test('★★★ W7 审计把手：**声明 `owner`** 与**未声明**必须读出不同（否则「取严」无法检验）', () => {
  // ★ 缺了这具，取严缺省的点火率就**数不出来**，而它非 0 的含义是「洪水原样放回」。
  //   这两条活的**结果完全相同**（都成功、都读作 `owner`）—— **只有 `natureDeclared` 分得开**。
  const declared = tasksOf(DECLARED_OWNER)
  const undeclared = tasksOf(UNDECLARED)
  assert.equal(declared[0]?.nature, 'owner')
  assert.equal(undeclared[0]?.nature, 'owner', '归一之后两者**同貌** —— 这正是问题所在')
  assert.equal(declared[0]?.natureDeclared, true, '★ 声明的必须读得出「是声明的」')
  assert.equal(undeclared[0]?.natureDeclared, false, '★ 兜底的必须读得出「是兜底的」')
})

test('★★ W7 点火率：`natureUndeclared` 只数**缺省兜底**的，不数声明过的', () => {
  const tasks = tasksOf(DECLARED_OWNER, UNDECLARED, DECLARED_INTERNAL)
  const s = summarizeTasks(tasks)
  assert.equal(s.total, 3)
  assert.equal(s.natureUndeclared, 1, '三条里只有一条是兜底 ⇒ 点火率 1/3')
  // ★ 对照（否则判据可能被写成「数所有 owner」而恒偏大）：声明过 owner 的那条**不许**被算成兜底。
  assert.notEqual(s.natureUndeclared, 2, '★ 显式声明 `owner` 的不许被算成兜底')
})

test('★★ W7 渲染：声明面**始终出**，且 0 与非 0 是**相反的两句话**', () => {
  const allDeclared = tasksOf(DECLARED_OWNER, DECLARED_INTERNAL)
  const out0 = renderLedger(summarizeTasks(allDeclared), allDeclared, 10)
  assert.match(out0, /nature/, '★ 0 也要出：不报这个数，「取严」就只是一句无法检验的主张')
  assert.match(out0, /没点火/, '0 的含义是「声明覆盖完整」，必须说出来（它与非 0 是相反的两件事）')

  const mixed = tasksOf(DECLARED_OWNER, UNDECLARED)
  const out1 = renderLedger(summarizeTasks(mixed), mixed, 10)
  assert.match(out1, /未声明 1 \/ 2 条/, '分子与分母一起报（同 `failureRate` 的纪律）')
  assert.match(out1, /推给主人/, '★ 兜底的真实后果要说出来 —— 那正是它会点火的那一档')
})

test('★ W7 闭集外的值 ⇒ 与「没写」同档（**都不是有效声明**）', () => {
  // 判据：`natureDeclaredOf` = `isTaskNature` ⇒ 写错的值同样落兜底档。
  // ⚠ 若把它算作「声明过」，点火率会被**低报**（而低报的后果正是这条审计把手要防的）。
  const bad = '{"at":"2026-10-12T01:03:00.000Z","actionId":"a-a","stage":"start",'
    + '"humanText":"收到任务 t-n4：x","detail":{"taskId":"t-n4","profile":"maid-01","nature":"OWNER"}}'
  const t = tasksOf(bad)[0]!
  assert.equal(t.nature, 'owner', '取严：写错了也读作 owner')
  assert.equal(t.natureDeclared, false, '★ 但它**不是一次有效声明** ⇒ 必须算兜底')
})

/* ═══════════ W8/W9：时刻是**抬头**，不是正文第一行 ═══════════
 * W8（织第 4 条）：把「读数要带时刻」从**纪律**改成**字段 / 结构**。
 * W9（织第 5 条 · 她用**行号**抓出我的缺陷）：时刻行**只长在一个出口上**时，
 *   绕过正文的路径（`s.total===0` 的前置返回 / 过滤后为空那条 —— 它的**签名里没有 `nowMs`**）
 *   会静默丢掉它，**而结构化字段照常返回** ⇒ 盘上长成「字段说 11:17 查的、正文一个字没说」。
 *   她的结构判断：**让时刻行在所有分支之前生成、当抬头叠加** —— 让分支消失，比让两处同步便宜。
 */

test('★★ W8 抬头：给了 `nowMs` ⇒ 有「截至 <ISO>」，且写出那个时刻本身', () => {
  const out = renderAsOf(T0)
  assert.match(out, /本读数\*\*截至\*\*/, '★ 时刻必须出现在抬头里（否则「这是哪一刻的」只能靠读者猜）')
  const iso = new Date(T0).toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(out, new RegExp(iso), '要写出**那个时刻本身**，不是「最近」这类含糊词')
})

test('★★ W8 未给 `nowMs` ⇒ **响亮说「问不出来」**，绝不假造时刻', () => {
  const out = renderAsOf(0)
  assert.match(out, /没有时刻/, '★ 同「空必须分型」：不知道就说不知道')
  assert.match(out, /问不出来/, '不是「没问题」——是这个问题在这里没有答案')
  assert.equal(out.includes(String(new Date().getFullYear()) + '-'), false,
    '★ 对照：不许悄悄用「现在」冒充读数的时刻（那会让「我查得到」退化回「我以为」）')
})

test('★★★ W9 抬头**恰好一次**：整份读数的两个出口各只带一个抬头', () => {
  // 修前抬头长在正文渲染器的正文第一行 ⇒ 两个出口丢了它；中间一版改成「调用方叠」
  //   ⇒ 又出现「正文若也带就变成两次」的风险。现在**整份读数只有一个生产者** ⇒ 恒为 1 次。
  // ⚠ 这具同时覆盖两个出口：`s.total===0` 的前置返回 + 正常出口。
  const count = (t: string): number => t.split('截至').length - 1
  const empty = renderLedger(summarizeTasks([]), [], 10, T0)
  assert.equal(count(empty), 1, '空台账的出口也必须**恰好一个**抬头（且不许两处各写一遍）')
  const tasks = tasksOf(DONE_JSON)
  const normal = renderLedger(summarizeTasks(tasks), tasks, 10, T0)
  assert.equal(count(normal), 1, '正常出口同样**恰好一个**')
})

test('★★★ W9 「让第二个生产者不存在」（源码级 · 装不下而非枚举）', () => {
  // ★ 这具的形状是成员织 2026-10-12 指出的：
  //   > 「原来那条枚举式守卫，枚举的是『**当时有几个生产者**』。若正文渲染器仍可被外部调用，
  //   >   或将来多一条产出 `rendered` 的路径 ⇒ 它只看那一条拼接语句，**照样绿**。」
  //   ⇒ 治法不是再加一条守卫，是**让第二个生产者不存在** ⇒ 于是判据也从「枚举」变成「装不下」：
  //     ① 正文渲染器**不在导出面**上（外部拿不到它 ⇒ 没法拿它当整份读数用）；
  //     ② 抬头只能经唯一生产者给 ⇒ `index.ts` 里**不该再出现**直接调抬头的地方。
  const ledger = readFileSync(join(here, '..', 'src', 'task-ledger.ts'), 'utf8')
  assert.match(ledger, /\nfunction renderBody\(/, '正文渲染器必须是**私有**的（`function`，不带 `export`）')
  assert.equal(/export function renderBody\(/.test(ledger), false,
    '★ 它一旦被导出，「新路径忘了抬头」就又在导出面上装得下了')
  assert.match(ledger, /export function renderLedger\(/, '整份读数的唯一产出者')
  const idx = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  assert.equal(/renderAsOf\(/.test(idx), false,
    '★ 工具层**不许**自己拼抬头 —— 抬头只能经 `renderLedger` 给（否则又出现两个生产者）')
  assert.match(idx, /const asOfMs = Date\.now\(\)/,
    '时刻取一次、抬头与结构化字段共用（两处各调一次 Date.now() 是同族缺陷）')
})
