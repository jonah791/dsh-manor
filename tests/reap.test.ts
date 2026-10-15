/**
 * 收尸裁决（`reap`）—— 把「没人管的未完」变成**有主的决定**（2026-10-12）。
 *
 * 真实触发：台账报出 `t-pwsh-probe-01`「未完 · 起于 115.6 小时前」，而**没有任何动作能处置它**。
 * 根因不是「发现不了」（`manor_tasks` 早报了），是**处置路径不存在**。
 *
 * ★ 本文件的判据设计要点：
 *   ① **零回归**：不传 `reaps` 时 `foldTasks` 行为与以前逐字一致（既有调用点不动）；
 *   ② **分型不被合流**：`dead` 与 `superseded` 分开计数（合成一个数＝替读的人决定要不要重做）；
 *   ③ **异常必须显形**：对已成事实的活裁决 ⇒ 不生效，但**计入 `orphanReaps` 报出来**（不静默吞）；
 *   ④ **空理由不是裁决**（写入口与读入口**都**拦 —— 只拦一侧等于没拦）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { foldTasks, parseActionLog, renderLedger, summarizeTasks } from '../src/task-ledger.ts'
import { depStateOf } from '../src/hold.ts'
import {
  REAP_LABEL, REAP_VERDICTS, buildReapRecord, parseReap, renderReapLine, serializeReap,
  type ReapRecord,
} from '../src/reap.ts'
import { loadReaps, reapDirOf, writeReap } from '../src/reap-store.ts'

/** 造一条真实的动作日志（JSONL 文本 —— 比手工造对象更贴近现场）。 */
function linesOf(taskId: string, withDone: boolean): string {
  const start = JSON.stringify({
    at: '2026-10-07T01:04:10.960Z', actionId: 'a-t1', stage: 'start', step: 0, total: 1,
    humanText: '收到任务 ' + taskId + '：测试样本',
    detail: { taskId, from: 'LAPTOP-BF4IAPLM-web-0', profile: 'maid-03', cwd: 'E:\\alice-nodes\\maid-03', acceptance: 'A' },
  })
  if (!withDone) return start + '\n'
  const done = JSON.stringify({
    at: '2026-10-07T01:05:00.000Z', actionId: 'a-t1', stage: 'done', step: 1, total: 1,
    humanText: '完成', detail: { taskId, ms: 50000 },
  })
  return start + '\n' + done + '\n'
}

function reapOf(taskId: string, verdict: 'dead' | 'superseded'): ReapRecord {
  return buildReapRecord({ taskId, verdict, reason: '凭据缺失导致会话未起；根因已修', atMs: 1791751400000, by: 'web-0' })
}

// ───────────────────────── 纯层：记录本身 ─────────────────────────

test('闭集：两档裁决词各有中文释义（**不分流**：它们对下一步动作不同）', () => {
  assert.deepEqual([...REAP_VERDICTS], ['dead', 'superseded'])
  for (const v of REAP_VERDICTS) assert.ok(REAP_LABEL[v].length > 0, v + ' 缺释义')
})

test('往返：serialize → parse 逐字段一致', () => {
  const r = reapOf('t-x', 'dead')
  const back = parseReap(serializeReap(r))
  assert.deepEqual(back, r)
})

test('尸体①：坏 JSON ⇒ null（**不抛**）', () => {
  assert.equal(parseReap('{ not json'), null)
})

test('尸体②：数组 / 标量 / null ⇒ null（结构不符不是「空」）', () => {
  assert.equal(parseReap('[]'), null)
  assert.equal(parseReap('42'), null)
  assert.equal(parseReap('null'), null)
})

test('尸体③：verdict 不在闭集 ⇒ null（闭在类型上，不许自由字符串）', () => {
  const bad = JSON.stringify({ taskId: 't-x', verdict: 'finished', reason: 'r', atMs: 1, by: 'w' })
  assert.equal(parseReap(bad), null)
})

test('★ 尸体④：**理由为空 ⇒ null** —— 空理由的裁决不是裁决（读侧也拦，不只写侧）', () => {
  for (const r of ['', '   ', '\n']) {
    const bad = JSON.stringify({ taskId: 't-x', verdict: 'dead', reason: r, atMs: 1, by: 'w' })
    assert.equal(parseReap(bad), null, '理由 ' + JSON.stringify(r) + ' 不该被当成合法裁决')
  }
})

test('尸体⑤：taskId 缺失或空 ⇒ null', () => {
  assert.equal(parseReap(JSON.stringify({ verdict: 'dead', reason: 'r', atMs: 1, by: 'w' })), null)
  assert.equal(parseReap(JSON.stringify({ taskId: '', verdict: 'dead', reason: 'r', atMs: 1, by: 'w' })), null)
})

test('渲染：一条都没有 ⇒ **空串**（不加噪音）；有 ⇒ 两档分开报数', () => {
  assert.equal(renderReapLine({ dead: 0, superseded: 0 }), '')
  const one = renderReapLine({ dead: 1, superseded: 0 })
  assert.match(one, /判死 1/)
  const both = renderReapLine({ dead: 2, superseded: 3 })
  assert.match(both, /判死 2/)
  assert.match(both, /已被取代 3/)
  assert.match(both, /不再计入「未完」/, '必须写明它从「未完」移走了（否则会被读成问题消失）')
})

// ───────────────────────── 折叠：裁决参与台账 ─────────────────────────

test('基线：未完（无裁决）⇒ 照旧计入 unfinished（零回归的对照）', () => {
  const tasks = foldTasks(parseActionLog(linesOf('t-x', false)))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.outcome, 'unfinished')
  assert.equal(tasks[0]!.reapVerdict, '', '没裁决就该是空串')
  assert.equal(summarizeTasks(tasks).unfinished, 1)
})

test('★ 零回归：**不传 reaps** ⇒ 行为与以前逐字一致（既有调用点不动）', () => {
  const a = foldTasks(parseActionLog(linesOf('t-x', false)))
  const b = foldTasks(parseActionLog(linesOf('t-x', false)), undefined)
  assert.deepEqual(a, b)
})

test('★ 未完 + 有裁决 ⇒ **不再计入 unfinished**，计入 reaped（分两档）', () => {
  const events = parseActionLog(linesOf('t-x', false) + linesOf('t-y', false))
  const reaps = new Map<string, ReapRecord>([['t-x', reapOf('t-x', 'dead')]])
  const s = summarizeTasks(foldTasks(events, reaps))
  assert.equal(s.unfinished, 1, '只有没裁决的那条算未完')
  assert.deepEqual(s.reaped, { dead: 1, superseded: 0 })
  assert.equal(s.orphanReaps, 0)
})

test('★★ 第五态：已裁决的未完，**`outcome` 本身就是 `reaped`**（不是 `unfinished`）', () => {
  // 这条钉的是 2026-10-12 活体验收当场抓到的分叉：**同一个概念、两个判据实现** ——
  // 最初「已裁决」只落在 `summarizeTasks` 的计数里，而 `outcome` 没变 ⇒
  // `manor_tasks`（读 summarize）说「未完 0」、`manor_task_watch`（**直接读 outcome**）说「未完 1」。
  // ⇒ 修法不是「让后者也读 summarize」，而是**让状态本身变**。
  const events = parseActionLog(linesOf('t-x', false))
  const reaps = new Map<string, ReapRecord>([['t-x', reapOf('t-x', 'dead')]])
  const t = foldTasks(events, reaps)[0]!
  assert.equal(t.outcome, 'reaped', '★ 状态本身必须变 —— 否则任何直接读 outcome 的地方都会把它当未完')
  assert.equal(t.reapVerdict, 'dead', '裁决词照样带着（渲染与追溯要用）')
})

test('★ 反向：无裁决的未完仍是 `unfinished`（第五态没有把真缺口吞掉）', () => {
  const t = foldTasks(parseActionLog(linesOf('t-x', false)))[0]!
  assert.equal(t.outcome, 'unfinished')
})

// ───────── 依赖面映射：第五态在**另一根轴**上的形态（tsc 逼出来的设计决定） ─────────

test('★★ `reaped` 映射到依赖面时**不对称**：superseded ⇒ done（放行）· dead ⇒ failed（升级）', () => {
  // 依赖一条「已被取代」的活 ⇒ 目的已由别的方式达成 ⇒ **依赖满足**；
  // 依赖一条「判死」的活 ⇒ 它没做成 ⇒ **依赖不可能** ⇒ 走出口二升级给人看，**绝不自动放行**。
  // ⇒ 这与 `reap.ts` 的「两档不合流」是同一件事在**另一根轴**上的形态：
  //   台账那根轴问「要不要重做」，依赖这根轴问「放行还是升级」。
  assert.equal(depStateOf({ outcome: 'reaped', reapVerdict: 'superseded' }), 'done')
  assert.equal(depStateOf({ outcome: 'reaped', reapVerdict: 'dead' }), 'failed')
})

test('★ 对照：未裁决的终态**恒等映射**（其余四态一字不变 ⇒ 零回归）', () => {
  assert.equal(depStateOf({ outcome: 'done', reapVerdict: '' }), 'done')
  assert.equal(depStateOf({ outcome: 'failed', reapVerdict: '' }), 'failed')
  assert.equal(depStateOf({ outcome: 'rejected', reapVerdict: '' }), 'rejected')
  assert.equal(depStateOf({ outcome: 'unfinished', reapVerdict: '' }), 'unfinished')
})

test('★ 分型不合流：dead 与 superseded 分别记账（合成一个数＝替读的人决定要不要重做）', () => {
  const events = parseActionLog(linesOf('t-a', false) + linesOf('t-b', false))
  const reaps = new Map<string, ReapRecord>([
    ['t-a', reapOf('t-a', 'dead')],
    ['t-b', reapOf('t-b', 'superseded')],
  ])
  const s = summarizeTasks(foldTasks(events, reaps))
  assert.deepEqual(s.reaped, { dead: 1, superseded: 1 })
  assert.equal(s.unfinished, 0)
  // 三数之和 = 全部「有 start 无终态」的条数（口径可核对）
  assert.equal(s.unfinished + s.reaped.dead + s.reaped.superseded, 2)
})

test('★★ 尸体：对**已完成**的活裁决 ⇒ 不生效，但**计入 orphanReaps 报出来**（异常不静默）', () => {
  const events = parseActionLog(linesOf('t-x', true))
  const reaps = new Map<string, ReapRecord>([['t-x', reapOf('t-x', 'dead')]])
  const s = summarizeTasks(foldTasks(events, reaps))
  assert.equal(s.done, 1, '完成就是完成 —— 收尸不该把它改成别的终态')
  assert.equal(s.unfinished, 0)
  assert.deepEqual(s.reaped, { dead: 0, superseded: 0 }, '它对「未完」才生效 ⇒ 不该进 reaped')
  assert.equal(s.orphanReaps, 1, '★ 无处生效的裁决必须被数出来 —— 静默吞掉它等于让改口不留痕')
})

test('渲染：有裁决时那行必须出现，**而未裁决的未完仍照常报**（不互相吞）', () => {
  const events = parseActionLog(linesOf('t-x', false) + linesOf('t-y', false))
  const reaps = new Map<string, ReapRecord>([['t-x', reapOf('t-x', 'superseded')]])
  const tasks = foldTasks(events, reaps)
  const text = renderLedger(summarizeTasks(tasks), tasks, 12, 1791751400000)
  assert.match(text, /已裁决 1 条/, '收尸必须显形 —— 否则读的人只看到「未完变小了」')
  assert.match(text, /未完 1 个/, '未裁决的那条仍要报（两种形态分开）')
})

test('渲染：orphanReaps > 0 ⇒ 显式报警（含「只对未完有意义」的解释）', () => {
  const events = parseActionLog(linesOf('t-x', true))
  const tasks = foldTasks(events, new Map<string, ReapRecord>([['t-x', reapOf('t-x', 'dead')]]))
  const text = renderLedger(summarizeTasks(tasks), tasks, 12, 1791751400000)
  assert.match(text, /裁决无处生效 1 条/)
  assert.match(text, /只对「未完」有意义/)
})

// ───────────────────────── IO 层：落盘 ─────────────────────────

function tmpBus(): string {
  return mkdtempSync(join(tmpdir(), 'manor-reap-'))
}

test('落盘往返：写 → 读，逐字段一致', () => {
  const bus = tmpBus()
  const r = reapOf('t-x', 'dead')
  assert.equal(writeReap(bus, r), '', '写应成功（返回空串）')
  const got = loadReaps(bus)
  assert.deepEqual(got.bad, [])
  assert.deepEqual(got.records.get('t-x'), r)
})

test('★ no-clobber：同一条活写两次 ⇒ **第二次被拒**（不覆盖 —— 覆盖会让「谁先判的」消失）', () => {
  const bus = tmpBus()
  assert.equal(writeReap(bus, reapOf('t-x', 'dead')), '')
  const second = writeReap(bus, reapOf('t-x', 'superseded'))
  assert.notEqual(second, '', '第二次必须失败')
  const got = loadReaps(bus)
  assert.equal(got.records.get('t-x')!.verdict, 'dead', '盘上仍是第一次的裁决')
})

test('尸体：坏记录进 `bad` 且**原文件保留**（fail-closed，不覆盖不删）', () => {
  const bus = tmpBus()
  const dir = reapDirOf(bus)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 't-broken.json')
  writeFileSync(p, '{ 这不是 JSON', 'utf8')
  const got = loadReaps(bus)
  assert.equal(got.records.size, 0)
  assert.equal(got.bad.length, 1)
  assert.equal(readFileSync(p, 'utf8'), '{ 这不是 JSON', '坏文件必须原样保留（它本身是证据）')
})

test('尸体：目录不存在 ⇒ **空**（首次使用的常态，不是「读不到」）', () => {
  const bus = tmpBus()
  const got = loadReaps(bus)
  assert.equal(got.records.size, 0)
  assert.deepEqual(got.bad, [])
})

// ───────────── 源码级：防「同一决定、多个落点」再漏（2026-10-12 当天引入当天抓出） ─────────────
// 形状（今天第三次）：工具面收窄了而**后台循环**照起 · 工具面收窄了而**指路文案**照旧 ·
// 裁决接进了两条读路而**第三条**没接。⇒ 三处都不是「写错了」，是**同一个决定有多个落点**。

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')

test('★ 源码级：不允许 `foldTasks(events)` 不传裁决（漏接 ⇒ 已裁决的未完在台账里复活）', () => {
  // ⚠ **必须先剥注释**：本条判据的解释文案里就写着那个字符串，不剥就自己把自己判红
  //   （2026-10-12 当场踩到 —— 「断言打在文本上、被解释文案击穿」的活体实例：
  //    越认真解释越容易红，而且红得**很合理**，因为源码里确实有那个串）。
  const codeLines = SRC.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  const offenders = codeLines.filter((l) => l.includes('foldTasks(events)'))
  assert.deepEqual(offenders, [],
    '发现 `foldTasks(events)` 没带第二个参数（注释已排除）—— 那条读路会把**已裁决的未完**算回「未完」：'
    + offenders.join(' | '))
})

test('★ 源码级：台账取数只有一条路（`readAllTasks` 不得自建读盘）', () => {
  const start = SRC.indexOf('const readAllTasks')
  assert.ok(start > 0, '找不到 `readAllTasks` —— 本判据已失效（先修判据，别信它的绿）')
  const block = SRC.slice(start, start + 1400)
  assert.ok(block.includes('collectActionEvents'), 'readAllTasks 必须走单一取数路径')
  assert.equal(block.includes('readdirSync'), false,
    'readAllTasks 又自建读盘了 —— 它当年就是这么与 manor_tasks 分叉的')
})
