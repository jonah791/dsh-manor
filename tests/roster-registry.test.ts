/**
 * 庄园成员册（登记层）纯函数测试。
 *
 * 纪律（技能 acceptance-integrity）：**判据器必须先证明自己会拒** ——
 * 前四个用例是**尸体样本**（坏 JSON / 结构不符 / 重复 id），它们证明 `parseRoster` 有分辨力，
 * 而不是「恰好这几次没出错」。
 *
 * 两条不变量各有一组用例：N1 身份不靠心跳 · N2 退役只移不删。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyRoster,
  firstDuplicateId,
  findMember,
  hire,
  mergeStatus,
  normalizeRecord,
  parseRoster,
  retire,
  assign,
  rowTag,
  type NodeObservation,
  type RosterFile,
} from '../src/roster-registry.ts'

const T0 = 1_790_000_000_000
const FRESH = 30_000

const obs = (id: string, atMs: number, pid = 100, harness = 'alice-manor-adapter'): NodeObservation =>
  ({ id, harness, atMs, pid })

/** 造一个「织 + 澄」的登记册（两成员，均在册）。 */
function rosterTwo(): RosterFile {
  let r = emptyRoster(T0)
  r = hire(r, { id: 'maid-01', name: '织', alias: '月见织', duty: '检索与核对' }, T0).roster
  r = hire(r, { id: 'maid-02', name: '澄', alias: '月见澄', duty: '出图' }, T0).roster
  return r
}

// ───────────────────────── 尸体样本：判据器必须会拒 ─────────────────────────

test('尸体①：坏 JSON ⇒ ok=false 且带原因（不静默返回空册）', () => {
  const r = parseRoster('{ not json', T0)
  assert.equal(r.ok, false)
  assert.match(r.error, /JSON 解析失败/)
  assert.equal(r.roster.members.length, 0)
})

test('尸体②：根节点是数组 ⇒ 拒（结构不符不是「空册」）', () => {
  const r = parseRoster('[]', T0)
  assert.equal(r.ok, false)
  assert.match(r.error, /根节点不是对象/)
})

test('尸体③：缺 members 数组 ⇒ 拒', () => {
  const r = parseRoster('{"v":1}', T0)
  assert.equal(r.ok, false)
  assert.match(r.error, /缺 members/)
})

test('尸体④：重复 id ⇒ 拒（读坏了，不是可修的小毛病）', () => {
  const text = JSON.stringify({ v: 1, members: [{ id: 'a' }, { id: 'a' }] })
  const r = parseRoster(text, T0)
  assert.equal(r.ok, false)
  assert.match(r.error, /重复 id：a/)
})

test('尸体④补：空 id 也算读坏（firstDuplicateId 直接可测）', () => {
  assert.equal(firstDuplicateId([normalizeRecord({ id: 'x' }, T0)]), '')
  assert.equal(firstDuplicateId([normalizeRecord({ id: '' }, T0)]), '(空 id)')
})

// ───────────────────────── 不变量 N1：身份不靠心跳 ─────────────────────────

test('N1：全体离线时，仍列出全部在职成员及其职责', () => {
  const r = rosterTwo()
  // 观测为空 = 没有任何心跳（成员全死了）
  const m = mergeStatus(r, [], T0, FRESH)
  assert.equal(m.activeCount, 2)
  assert.equal(m.onlineCount, 0)
  const ids = m.rows.map((x) => x.id)
  assert.deepEqual(ids, ['maid-01', 'maid-02'])
  assert.equal(m.rows[0]!.duty, '检索与核对')
  assert.equal(m.rows[1]!.duty, '出图')
  // 登记在职但从未见过心跳 ⇒ 双向分歧里的 neverSeen
  assert.deepEqual(m.neverSeen, ['maid-01', 'maid-02'])
})

// ───────────────────────── 不变量 N2：退役只移不删 ─────────────────────────

test('N2：退役只改状态，条目保留（可回退）', () => {
  const r = rosterTwo()
  const res = retire(r, 'maid-01', '主人指令：职责合并', T0 + 1000)
  assert.equal(res.ok, true)
  assert.equal(res.roster.members.length, 2, '条目不得被删除')
  const m = findMember(res.roster, 'maid-01')
  assert.equal(m!.status, 'retired')
  assert.equal(m!.retiredAtMs, T0 + 1000)
  assert.equal(m!.retireReason, '主人指令：职责合并')
  assert.equal(findMember(res.roster, 'maid-02')!.status, 'active', '不得牵连他人')
})

test('N2 补：复职把 retired 改回 active 并清退役时间', () => {
  const r = rosterTwo()
  const r2 = retire(r, 'maid-01', 'x', T0 + 1000).roster
  const r3 = assign(r2, 'maid-01', { reactivate: true }, T0 + 2000).roster
  const m = findMember(r3, 'maid-01')!
  assert.equal(m.status, 'active')
  assert.equal(m.retiredAtMs, 0)
  assert.equal(m.retireReason, '')
})

// ───────────────────────── 管理动作的拒绝语义 ─────────────────────────

test('hire：已存在即拒绝（不静默覆盖）', () => {
  const r = rosterTwo()
  const res = hire(r, { id: 'maid-01', duty: '别的东西' }, T0 + 5)
  assert.equal(res.ok, false)
  assert.match(res.error, /已在册/)
  assert.equal(findMember(res.roster, 'maid-01')!.duty, '检索与核对', '拒绝时不得改动原记录')
})

test('hire：空 id 拒绝', () => {
  const res = hire(emptyRoster(T0), { id: '   ' }, T0)
  assert.equal(res.ok, false)
  assert.match(res.error, /id 必填/)
})

test('retire：不存在的 id ⇒ 报错（不静默成功）', () => {
  const res = retire(rosterTwo(), 'maid-99', 'x', T0)
  assert.equal(res.ok, false)
  assert.match(res.error, /没有 maid-99/)
})

test('retire：重复退役 ⇒ 报错（状态机不静默）', () => {
  const r = retire(rosterTwo(), 'maid-01', 'x', T0 + 1).roster
  const again = retire(r, 'maid-01', 'y', T0 + 2)
  assert.equal(again.ok, false)
  assert.match(again.error, /已是退役状态/)
})

test('assign：字段级合并（只改给到的字段）', () => {
  const r = rosterTwo()
  const res = assign(r, 'maid-01', { duty: '审计' }, T0 + 10)
  assert.equal(res.ok, true)
  const m = findMember(res.roster, 'maid-01')!
  assert.equal(m.duty, '审计')
  assert.equal(m.name, '织', '未给到的字段必须保留')
  assert.equal(m.alias, '月见织')
  assert.equal(m.hiredAtMs, T0, '聘用时间不得被改动')
})

test('assign：不存在的 id ⇒ 报错', () => {
  const res = assign(rosterTwo(), 'maid-99', { duty: 'x' }, T0)
  assert.equal(res.ok, false)
})

// ───────────────────────── 双向分歧显式报出 ─────────────────────────

test('分歧：总线上有心跳但未登记 ⇒ unregistered（野生节点不隐藏）', () => {
  const r = rosterTwo()
  const m = mergeStatus(r, [obs('maid-01', T0, 111), obs('worker-x', T0, 222)], T0, FRESH)
  assert.deepEqual(m.unregistered, ['worker-x'])
  const wild = m.rows.find((x) => x.id === 'worker-x')!
  assert.equal(wild.registered, false)
  assert.equal(wild.online, true)
  assert.equal(wild.duty, '', '未登记 ⇒ 没有职责可报（不编造）')
})

test('分歧：登记在职但从未上线 ⇒ neverSeen（不静默当成「一切正常」）', () => {
  const r = rosterTwo()
  const m = mergeStatus(r, [obs('maid-01', T0, 111)], T0, FRESH)
  assert.deepEqual(m.neverSeen, ['maid-02'])
})

// ── ★ 2026-10-14 分档：`unregistered` 拆出 `outsideRoster` ──────────────────
//
// 修前两种语义**完全不同**的东西共用一个读数：
//   ① 主脑的总线身份（`LAPTOP-…-web-0`，harness 空，**它本来就不该进成员册**）
//   ② 未登记的成员（**该**被登记）
// 混报的后果是**永久噪音**：每次读名册都报一句永远为真、永远不需要动作的话
//   ⇒ 读者学会忽略整条读数（假阳性毁的是整条防线的可信度）。

test('★ 分档：自述是庄园适配器但未登记 ⇒ 进 unregistered（该进册）', () => {
  const m = mergeStatus(rosterTwo(), [obs('worker-x', T0, 222)], T0, FRESH)
  assert.deepEqual(m.unregistered, ['worker-x'])
  assert.deepEqual(m.outsideRoster, [], '适配器节点不该落进册外档')
})

test('★ 分档：harness 空（主脑的 cluster 身份）⇒ 进 outsideRoster（不该进册）', () => {
  const m = mergeStatus(rosterTwo(), [obs('LAPTOP-X-web-0', T0, 333, 100, '')], T0, FRESH)
  assert.deepEqual(m.outsideRoster, ['LAPTOP-X-web-0'])
  assert.deepEqual(m.unregistered, [], '★ 它**不许**落进「待登记」档——那正是修前造出永久噪音的读法')
})

test('★ 分档：别的 harness 的节点 ⇒ 也进 outsideRoster（判据不是「id 长得像谁」）', () => {
  const m = mergeStatus(rosterTwo(), [obs('LAPTOP-X-maid-04-0', T0, 444, 100, 'dsh-agent-cluster')], T0, FRESH)
  assert.deepEqual(m.outsideRoster, ['LAPTOP-X-maid-04-0'])
  assert.deepEqual(m.unregistered, [], '派生身份**不是**待登记成员（它没有适配器在轮询）')
})

test('★ 分档：两档同现时各归各位（不是「要么这档要么那档」）', () => {
  const m = mergeStatus(rosterTwo(), [
    obs('worker-x', T0, 222),
    obs('LAPTOP-X-web-0', T0, 333, 100, ''),
  ], T0, FRESH)
  assert.deepEqual(m.unregistered, ['worker-x'])
  assert.deepEqual(m.outsideRoster, ['LAPTOP-X-web-0'])
})

// ── ★★ 分档暴露出的第二处同型病：`onlineCount` 被册外节点污染 ──────────────
//
// 现读症状（2026-10-14 重启后真调）：名册「在职 6」而报「此刻在线 7」——
//   多出来的那个 1 是**主脑的总线身份**。修前 `onlineCount = rows.filter(r => r.online)`，
//   而 `rows` 含册外节点 ⇒ 两个**语义不同**的东西（成员 / 册外事实）共用一个计数。
// ⚠ 这一处是**被第一处暴露的**：分档之后那个多出来的 1 才看得见（修前它混在「未登记」里）。

test('★ onlineCount 的分母是名册，不是 rows：册外节点在线**不许**进这个计数', () => {
  const m = mergeStatus(rosterTwo(), [
    obs('maid-01', T0, 111),
    obs('LAPTOP-X-web-0', T0, 333, 100, ''),
  ], T0, FRESH)
  assert.equal(m.onlineCount, 1, '只有 maid-01 是**成员且在线**；主脑身份在线但它不是成员')
})

test('★ onlineCount 与 activeCount 的关系：在线 ≤ 在职（修前会出现「在线 > 在职」）', () => {
  const m = mergeStatus(rosterTwo(), [
    obs('maid-01', T0, 111),
    obs('maid-02', T0, 222),
    obs('LAPTOP-X-web-0', T0, 333, 100, ''),
    obs('ghost-y', T0, 444, 100, 'something-else'),
  ], T0, FRESH)
  assert.equal(m.onlineCount, 2)
  assert.equal(m.activeCount, 2)
  assert.ok(m.onlineCount <= m.activeCount, '★ 「在线 > 在职」是自相矛盾的读数，不许再出现')
})

test('★ 对照：册外节点**离线**时 onlineCount 不变（证明判据盯的是「是不是成员」而非「有没有观测」）', () => {
  const online = mergeStatus(rosterTwo(), [obs('maid-01', T0, 111), obs('LAPTOP-X-web-0', T0, 333, 100, '')], T0, FRESH)
  const offline = mergeStatus(rosterTwo(), [obs('maid-01', T0, 111), obs('LAPTOP-X-web-0', T0 - FRESH * 10, 333, 100, '')], T0, FRESH)
  assert.equal(online.onlineCount, offline.onlineCount, '册外节点在线与否都不该动成员在线数')
  assert.equal(offline.outsideRoster.length, 1, '但它仍在册外档里被报出（事实不隐藏）')
})

test('★ 分档：两档的并集等于全部未登记观测（**没有东西掉在地上**）', () => {
  const m = mergeStatus(rosterTwo(), [
    obs('worker-x', T0, 222),
    obs('LAPTOP-X-web-0', T0, 333, 100, ''),
    obs('ghost-y', T0, 555, 100, 'something-else'),
  ], T0, FRESH)
  const all = [...m.unregistered, ...m.outsideRoster].sort()
  assert.deepEqual(all, ['LAPTOP-X-web-0', 'ghost-y', 'worker-x'])
})

// ───────────────────────── 排序（名册的第一读者是人） ─────────────────────────

test('排序：在册成员排在野生节点前面（不混排）', () => {
  const m = mergeStatus(rosterTwo(), [
    obs('aaa-wild', T0, 1), // 野生节点，字母序反而在前
    obs('maid-01', T0, 2),
    obs('maid-02', T0, 3),
  ], T0, FRESH)
  assert.deepEqual(m.rows.map((x) => x.id), ['maid-01', 'maid-02', 'aaa-wild'])
})

// ── ★★ 行内标签 `rowTag`（2026-10-14 从 execute 内联逻辑抽成纯函数）───────────
//
// 为什么抽出来：修前它内联在工具 `execute` 里 ⇒ **测不到** ⇒ 它没跟上同一批的分档改动，
//   于是同一个册外节点被**报两遍**、且行内那遍贴的是 `⚠ 未登记`（喊人去做一件不该做的事）。
// ⇒ 这些样本就是那条「同一决定多个落点、只改一处」的判据。

test('★ rowTag：在册成员的四种状态各归其位', () => {
  const m = mergeStatus(rosterTwo(), [obs('maid-01', T0, 1)], T0, FRESH)
  const online = m.rows.find((r) => r.id === 'maid-01')!
  const offline = m.rows.find((r) => r.id === 'maid-02')!
  assert.equal(rowTag(online), '✓ 在线')
  assert.equal(rowTag(offline), '· 离线')
})

test('★ rowTag：册外节点（harness 非适配器）⇒ `ℹ 册外`，**不是** `⚠ 未登记`', () => {
  const m = mergeStatus(rosterTwo(), [obs('LAPTOP-X-web-0', T0, 1, 100, '')], T0, FRESH)
  const outside = m.rows.find((r) => r.id === 'LAPTOP-X-web-0')!
  assert.equal(rowTag(outside), 'ℹ 册外', '★ 修前这里返回 ⚠ 未登记 —— 那正是「报两遍且语气错」的根因')
})

test('★ rowTag：自述是适配器但未登记 ⇒ `⚠ 未登记`（该进册，需要动作）', () => {
  const m = mergeStatus(rosterTwo(), [obs('worker-x', T0, 1)], T0, FRESH)
  const pending = m.rows.find((r) => r.id === 'worker-x')!
  assert.equal(rowTag(pending), '⚠ 未登记')
})

test('★★ rowTag 与汇总分档**同判据**：同一行不许在两处落进不同档', () => {
  const m = mergeStatus(rosterTwo(), [
    obs('worker-x', T0, 1),
    obs('LAPTOP-X-web-0', T0, 2, 100, ''),
  ], T0, FRESH)
  const pending = m.rows.find((r) => r.id === 'worker-x')!
  const outside = m.rows.find((r) => r.id === 'LAPTOP-X-web-0')!
  // 行内 tag 说「待登记」⇔ 汇总 unregistered 含它；行内说「册外」⇔ 汇总 outsideRoster 含它。
  assert.equal(rowTag(pending) === '⚠ 未登记', m.unregistered.includes('worker-x'))
  assert.equal(rowTag(outside) === 'ℹ 册外', m.outsideRoster.includes('LAPTOP-X-web-0'))
})

test('排序：在册成员内部，在线优先，其次按 id', () => {
  let r = emptyRoster(T0)
  r = hire(r, { id: 'maid-b' }, T0).roster
  r = hire(r, { id: 'maid-a' }, T0).roster
  const m = mergeStatus(r, [obs('maid-b', T0, 1)], T0, FRESH)
  assert.deepEqual(m.rows.map((x) => x.id), ['maid-b', 'maid-a'])
})

// ───────────────────────── 在线判定边界 ─────────────────────────

test('在线判定：age 恰好等于 freshMs ⇒ 离线（判据是 age < freshMs）', () => {
  const m = mergeStatus(rosterTwo(), [obs('maid-01', T0, 1)], T0 + FRESH, FRESH)
  assert.equal(m.rows.find((x) => x.id === 'maid-01')!.online, false)
})

test('在线判定：age 小于 freshMs ⇒ 在线', () => {
  const m = mergeStatus(rosterTwo(), [obs('maid-01', T0, 1)], T0 + FRESH - 1, FRESH)
  assert.equal(m.rows.find((x) => x.id === 'maid-01')!.online, true)
})

test('在线判定：心跳时间在未来（负 age）⇒ 离线且 age=-1（时钟异常不当成在线）', () => {
  const m = mergeStatus(rosterTwo(), [obs('maid-01', T0 + 9999, 1)], T0, FRESH)
  const row = m.rows.find((x) => x.id === 'maid-01')!
  assert.equal(row.online, false)
  assert.equal(row.heartbeatAgeMs, -1)
})

// ───────────────────────── 视图过滤与计数 ─────────────────────────

test('视图：onlyActive 过滤退役成员，但计数仍如实给出', () => {
  const r = retire(rosterTwo(), 'maid-01', 'x', T0 + 1).roster
  const m = mergeStatus(r, [], T0, FRESH, { onlyActive: true })
  assert.deepEqual(m.rows.map((x) => x.id), ['maid-02'])
  assert.equal(m.activeCount, 1)
  assert.equal(m.retiredCount, 1, '被过滤掉不等于不存在——计数必须如实')
})

test('parseRoster：正常册往返一致（含 normalize 的缺省填充）', () => {
  const r = rosterTwo()
  const text = JSON.stringify(r)
  const back = parseRoster(text, T0)
  assert.equal(back.ok, true)
  assert.deepEqual(back.roster.members, r.members)
})
