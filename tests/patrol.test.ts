/**
 * 存活巡检决策层的测试。
 *
 * 三条纪律各有一组用例，且**每条都有尸体样本**：
 *   - 退避：必须证明「退避期内不重试」与「退避期外才重试」两侧都成立（否则退避是死代码）
 *   - 上限：必须证明「到上限后不再 toWake」——只告警不重试，两者不能同时为真
 *   - 恢复即清零：必须证明成员活回来后重试账被清（否则下次故障会继承旧账）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyRoster, hire, retire, type NodeObservation, type RosterFile } from '../src/roster-registry.ts'
import {
  emptyPatrolState,
  normalizePatrolState,
  planPatrol,
  renderPatrol,
  shouldRunOnBoot,
  updatePatrolState,
  type PatrolState,
} from '../src/patrol.ts'

const T0 = 1_790_000_000_000
const DEAD = 300_000
const BACKOFF = [300_000, 900_000, 1_800_000]

const obs = (id: string, atMs: number, pid = 1): NodeObservation => ({ id, harness: 'alice-manor-adapter', atMs, pid })

function rosterOf(ids: string[]): RosterFile {
  let r = emptyRoster(T0)
  for (const id of ids) r = hire(r, { id, name: id.toUpperCase(), duty: '活' }, T0).roster
  return r
}

const plan = (r: RosterFile, o: NodeObservation[], s: PatrolState, nowMs: number, maxAttempts = 3) =>
  planPatrol({ roster: r, observations: o, state: s, nowMs, deadAfterMs: DEAD, maxAttempts, backoffMs: BACKOFF })

// ───────────────────────── 基本判定 ─────────────────────────

test('健康成员 ⇒ ok，不进 toWake', () => {
  const r = rosterOf(['maid-01'])
  const p = plan(r, [obs('maid-01', T0)], emptyPatrolState(T0), T0 + 1000)
  assert.deepEqual(p.toWake, [])
  assert.deepEqual(p.healthy, ['maid-01'])
  assert.equal(p.decisions[0]!.action, 'ok')
})

test('心跳过期超阈值 ⇒ 拉起（这就是「死了会被发现」）', () => {
  const r = rosterOf(['maid-01'])
  const p = plan(r, [obs('maid-01', T0)], emptyPatrolState(T0), T0 + DEAD + 1)
  assert.deepEqual(p.toWake, ['maid-01'])
  assert.equal(p.decisions[0]!.action, 'wake')
  assert.match(p.decisions[0]!.reason, /心跳过期/)
})

test('恰在阈值上不算死（判据是 age >= deadAfterMs）', () => {
  const r = rosterOf(['maid-01'])
  const p = plan(r, [obs('maid-01', T0)], emptyPatrolState(T0), T0 + DEAD - 1)
  assert.deepEqual(p.toWake, [])
})

test('从未上线（无观测）⇒ 也拉起（「聘了没起过」正是要拉起的场景）', () => {
  const r = rosterOf(['maid-04', 'maid-05'])
  const p = plan(r, [], emptyPatrolState(T0), T0)
  assert.deepEqual(p.toWake, ['maid-04', 'maid-05'])
  assert.match(p.decisions[0]!.reason, /从未上线/)
})

test('心跳时间在未来 ⇒ 算死（时钟异常不当成健康）', () => {
  const r = rosterOf(['maid-01'])
  const p = plan(r, [obs('maid-01', T0 + 99_999)], emptyPatrolState(T0), T0)
  assert.deepEqual(p.toWake, ['maid-01'])
  assert.match(p.decisions[0]!.reason, /时间异常/)
})

test('尸体①：退役成员**不巡检**——退役就是「不再管她的身体」', () => {
  let r = rosterOf(['maid-01', 'maid-02'])
  r = retire(r, 'maid-02', '职责合并', T0).roster
  const p = plan(r, [], emptyPatrolState(T0), T0)
  assert.deepEqual(p.toWake, ['maid-01'], '已退役的 maid-02 不该被拉起')
  assert.equal(p.decisions.length, 1)
})

// ───────────────────────── 纪律一：有界退避 ─────────────────────────

test('退避期内 ⇒ skip-backoff（不重试）', () => {
  const r = rosterOf(['maid-01'])
  let s = emptyPatrolState(T0)
  s = updatePatrolState(s, plan(r, [], s, T0), [{ id: 'maid-01', ok: true }], T0)
  assert.equal(s.attempts['maid-01']!.count, 1)
  // 立刻再巡一次（退避 300s 未到）
  const p2 = plan(r, [], s, T0 + 60_000)
  assert.deepEqual(p2.toWake, [], '退避期内不得重试')
  assert.equal(p2.decisions[0]!.action, 'skip-backoff')
  assert.match(p2.decisions[0]!.reason, /退避中/)
})

test('退避期外 ⇒ 再拉起（退避是「推远」不是「放弃」）', () => {
  const r = rosterOf(['maid-01'])
  let s = emptyPatrolState(T0)
  s = updatePatrolState(s, plan(r, [], s, T0), [{ id: 'maid-01', ok: true }], T0)
  const p2 = plan(r, [], s, T0 + 300_000)
  assert.deepEqual(p2.toWake, ['maid-01'])
  assert.match(p2.decisions[0]!.reason, /第 2 次拉起/)
})

test('退避窗口随次数变长（不是固定间隔）', () => {
  const r = rosterOf(['maid-01'])
  let s = emptyPatrolState(T0)
  s = updatePatrolState(s, plan(r, [], s, T0), [{ id: 'maid-01', ok: true }], T0)
  // 第 2 次尝试后，退避应为 BACKOFF[1] = 900_000
  const p2 = plan(r, [], s, T0 + 300_000)
  s = updatePatrolState(s, p2, [{ id: 'maid-01', ok: true }], T0 + 300_000)
  const p3 = plan(r, [], s, T0 + 300_000 + 899_999)
  assert.deepEqual(p3.toWake, [], '第二个退避窗口应为 900s')
  const p4 = plan(r, [], s, T0 + 300_000 + 900_000)
  assert.deepEqual(p4.toWake, ['maid-01'])
})

// ───────────────────────── 纪律二：上限告警 ─────────────────────────

test('尸体②：到上限后**只告警、不再重试**（两者不得同时为真）', () => {
  const r = rosterOf(['maid-01'])
  let s = emptyPatrolState(T0)
  let now = T0
  for (let i = 0; i < 3; i++) {
    const p = plan(r, [], s, now)
    s = updatePatrolState(s, p, [{ id: 'maid-01', ok: true }], now)
    now += 2_000_000
  }
  assert.equal(s.attempts['maid-01']!.count, 3)
  const p = plan(r, [], s, now)
  assert.deepEqual(p.toAlert, ['maid-01'])
  assert.deepEqual(p.toWake, [], '到上限绝不能再拉起——否则上限形同虚设')
  assert.match(p.decisions[0]!.reason, /停止重试/)
})

test('拉起**失败也计数**（否则永远起不来的成员会被无限重试）', () => {
  const r = rosterOf(['maid-01'])
  let s = emptyPatrolState(T0)
  const p = plan(r, [], s, T0)
  s = updatePatrolState(s, p, [{ id: 'maid-01', ok: false }], T0)
  assert.equal(s.attempts['maid-01']!.count, 1)
  assert.equal(s.attempts['maid-01']!.lastReason, '拉起失败')
})

// ───────────────────────── 纪律三：恢复即清零 ─────────────────────────

test('尸体③：成员活回来后重试账被清（否则下次故障继承旧账）', () => {
  const r = rosterOf(['maid-01'])
  let s = emptyPatrolState(T0)
  s = updatePatrolState(s, plan(r, [], s, T0), [{ id: 'maid-01', ok: true }], T0)
  assert.equal(s.attempts['maid-01']!.count, 1)
  // 她活回来了
  const p2 = plan(r, [obs('maid-01', T0 + 400_000)], s, T0 + 400_001)
  assert.deepEqual(p2.recovered, ['maid-01'])
  s = updatePatrolState(s, p2, [], T0 + 400_001)
  assert.equal(s.attempts['maid-01'], undefined, '重试账必须被清掉')
  // 再死一次 ⇒ 又是「首次拉起」，不退避
  const p3 = plan(r, [obs('maid-01', T0 + 400_000)], s, T0 + 400_001 + DEAD + 1)
  assert.deepEqual(p3.toWake, ['maid-01'])
  assert.match(p3.decisions[0]!.reason, /首次拉起/)
})

// ───────────────────────── 状态归一（坏状态不该让巡检停摆） ─────────────────────────

test('尸体④：坏巡检状态 ⇒ normalize 补默认值、不抛', () => {
  assert.deepEqual(normalizePatrolState(null, T0).attempts, {})
  assert.deepEqual(normalizePatrolState('garbage', T0).attempts, {})
  assert.deepEqual(normalizePatrolState({ attempts: [] }, T0).attempts, {})
  const s = normalizePatrolState({ attempts: { 'maid-01': { count: 'x', lastAtMs: null } } }, T0)
  assert.equal(s.attempts['maid-01']!.count, 0)
  assert.equal(s.attempts['maid-01']!.lastAtMs, 0)
  assert.equal(s.lastRunAtMs, T0)
})

// ───────────────────────── 渲染与计数 ─────────────────────────

test('renderPatrol：计数与实际决策一致，且输出含每个人的理由', () => {
  const r = rosterOf(['maid-01', 'maid-02', 'maid-03'])
  const now = T0 + DEAD + 1
  // maid-01 的心跳必须是**新鲜的**（= now）：用 T0 的旧心跳会被正确判成「死」——
  // 第一版这里就写错了，失败信息反而证明判据有分辨力。
  const p = plan(r, [obs('maid-01', now)], emptyPatrolState(T0), now)
  const rep = renderPatrol(p, 3, now)
  assert.equal(rep.activeCount, 3)
  assert.equal(rep.healthyCount, 1)
  assert.equal(rep.wokeCount, 2)
  assert.equal(rep.alertCount, 0)
  assert.match(rep.lines.join('\n'), /maid-02/)
  assert.match(rep.lines.join('\n'), /maid-03/)
})

// ───────────────────────── 启动即补一轮（§5.11 规则 5） ─────────────────────────

test('★ 启动即补：距上次跑满一个周期 ⇒ 立刻补（宿主重启不再干等）', () => {
  // ★ 存在理由（2026-10-14 现读抓出的**不对称**）：`holdTimer` 有启动即补，
  //   而 `patrolTimer` 没有 ⇒ 每轮 web 重启后巡检干等满一个周期（缺省 5 分钟），
  //   停机期间死掉的成员**多躺最多 5 分钟**。
  const I = 300_000
  assert.equal(shouldRunOnBoot(T0 - I, T0, I), true, '正好满一个周期 ⇒ 补（边界取闭）')
  assert.equal(shouldRunOnBoot(T0 - I - 1, T0, I), true, '超过一个周期 ⇒ 补')
  assert.equal(shouldRunOnBoot(T0 - I + 1, T0, I), false, '★ 未满一个周期 ⇒ **不补**（防热重载/快速连重启变紧转轮）')
  assert.equal(shouldRunOnBoot(T0, T0, I), false, '★ 刚跑过 ⇒ 不补（这条防的是「启动就无条件跑」）')
})

test('★ 启动即补：脏值一律**取严补跑**（宁可多跑一轮，不因坏数字干等）', () => {
  const I = 300_000
  assert.equal(shouldRunOnBoot(Number.NaN, T0, I), true, 'NaN ⇒ 取严')
  assert.equal(shouldRunOnBoot(0, T0, I), true, '0（空账初值外的脏值）⇒ 取严')
  assert.equal(shouldRunOnBoot(T0 + 60_000, T0, I), true, '★ 未来时刻（时钟回拨/账被改）⇒ 取严补跑')
  assert.equal(shouldRunOnBoot(T0 - I, T0, 0), true, '周期非法 ⇒ 取严')
  assert.equal(shouldRunOnBoot(Number.NaN, Number.NaN, I), true, '双脏 ⇒ 取严')
})
