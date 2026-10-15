/**
 * 独占领取（claim）纯函数测试 —— ③ 竞争面（E12）。
 *
 * 纪律（技能 acceptance-integrity）：**判据器必须先证明自己会拒** ——
 * 每个 decision 至少一具样本，坏记录一具（fail-closed），
 * 并有一条**同一条记录在不同 nowMs 下结论不同**的样本，钉住「年龄/剩余一律现算、不缓存」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAIM_VERSION,
  DEFAULT_CLAIM_TTL_MS,
  buildClaimRecord,
  claimFileNameOf,
  humanSpan,
  judgeClaim,
  parseClaim,
  serializeClaim,
} from '../src/claim.ts'

const T = 1_790_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()

const rec = (holder: string, atMs: number, ttlMs = DEFAULT_CLAIM_TTL_MS) =>
  buildClaimRecord('t-x', holder, atMs, ttlMs)

// ───────────────────────── 四态 ─────────────────────────

test('无记录 ⇒ granted（新建）', () => {
  const j = judgeClaim(undefined, 't-x', 'maid-01', T)
  assert.equal(j.decision, 'granted')
  assert.equal(j.holder, 'maid-01')
  assert.match(j.note, /领取成功/)
})

test('★ 同一持有人重领 ⇒ renewed（幂等 + 续期：我还在做，这一笔就是在续「我还在」）', () => {
  const j = judgeClaim(rec('maid-01', T - 60_000), 't-x', 'maid-01', T)
  assert.equal(j.decision, 'renewed')
  assert.match(j.note, /同一持有人重领 = 幂等续期/)
})

test('别人未过期 ⇒ denied，且必须报出**持有人与剩余**（否则她只能猜）', () => {
  const j = judgeClaim(rec('maid-03', T - 60_000, 600_000), 't-x', 'maid-01', T)
  assert.equal(j.decision, 'denied')
  assert.equal(j.holder, 'maid-03')
  assert.equal(j.remainMs, 540_000)
  assert.match(j.note, /已被 `maid-03` 持有/)
  assert.match(j.note, /剩余 9\.0 分钟/)
})

test('别人已过期 ⇒ takeover，且**旧记录随判定一并交出**（留痕由调用方 rename，不是删）', () => {
  const old = rec('maid-03', T - 20 * 60_000, 15 * 60_000)
  const j = judgeClaim(old, 't-x', 'maid-01', T)
  assert.equal(j.decision, 'takeover')
  assert.equal(j.stale?.holder, 'maid-03')
  assert.match(j.note, /已超时 5\.0 分钟/)
  assert.match(j.note, /留痕/)
})

test('★ 尸体：坏记录 ⇒ blocked（fail-closed，**不静默放行**）', () => {
  const j = judgeClaim(null, 't-x', 'maid-01', T)
  assert.equal(j.decision, 'blocked')
  assert.match(j.note, /读不到/)
  assert.match(j.note, /fail-closed/)
})

// ───────────── 年龄/剩余**现算**：同一条记录，换个 nowMs 就换结论 ─────────────

test('★ 同一条记录在不同 nowMs 下结论不同 —— 钉住「年龄/剩余一律现算，不缓存」', () => {
  const onDisk = rec('maid-03', T - 10 * 60_000, 15 * 60_000)
  assert.equal(judgeClaim(onDisk, 't-x', 'maid-01', T).decision, 'denied', '此刻未过期')
  const later = T + 10 * 60_000
  assert.equal(judgeClaim(onDisk, 't-x', 'maid-01', later).decision, 'takeover', '再过 10 分钟 ⇒ 过期可抢')
})

// ───────────────────────── 解析：坏 vs 缺 ─────────────────────────

test('parseClaim：**「坏」与「缺」必须分开** —— 坏内容返回 null（⇒ blocked），不返回「无记录」', () => {
  assert.equal(parseClaim(''), null)
  assert.equal(parseClaim('{'), null)
  assert.equal(parseClaim('null'), null)
  assert.equal(parseClaim('[]'), null)
  assert.equal(parseClaim('{"v":1}'), null, '缺字段')
  assert.equal(parseClaim('{"v":1,"taskId":"t","holder":"","at":"x","ttlMs":1}'), null, '空持有人')
  assert.equal(parseClaim('{"v":1,"taskId":"t","holder":"m","at":"不是时间","ttlMs":1}'), null, '时间不可解')
  assert.equal(parseClaim('{"v":1,"taskId":"t","holder":"m","at":"2026-01-01T00:00:00Z","ttlMs":0}'), null, 'ttl 非正')
})

test('parseClaim ↔ serializeClaim 往返（含 v 字段）', () => {
  const r = rec('maid-01', T)
  const back = parseClaim(serializeClaim(r))
  assert.deepEqual(back, r)
  assert.equal(back?.v, CLAIM_VERSION)
})

test('claimFileNameOf / humanSpan 的口径', () => {
  assert.equal(claimFileNameOf('t-x'), 't-x.json')
  assert.equal(humanSpan(45_000), '45.0 秒')
  assert.equal(humanSpan(90_000), '1.5 分钟')
  assert.equal(humanSpan(7_200_000), '2.0 小时')
  assert.equal(humanSpan(-5), '0.0 秒', '负数不得报成负时长')
  assert.equal(iso(T).length > 0, true)
})
