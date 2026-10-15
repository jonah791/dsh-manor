/**
 * 收件箱分类（`src/inbox.ts`）离线测试。
 *
 * 纪律（与 §5.9 规则 2 同一课）：**每条「该判可处理」都要配一条「该判无人认领」**，
 *   否则「全部算无人认领」这种最蠢的实现也能全绿。另有两具尸体：
 *   ① **契约同源**——读适配器的 `dispatch.mjs` 与本地 `CLAIMABLE_KINDS` 逐字对账；
 *   ② **fail-closed**——坏 kind 必须算无人认领（不声称能处理）。
 *
 * 运行：node --test tests/inbox.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  CLAIMABLE_KINDS,
  DEFAULT_STALE_AFTER_MS,
  hoursOf,
  renderInbox,
  summarizeInbox,
} from '../src/inbox.ts'

const here = dirname(fileURLToPath(import.meta.url))
const T0 = 1_790_000_000_000
const H = 3600_000
const at = (h: number) => T0 - h * H

// ── 一 · 契约同源（★ 最重要的一例）──────────────────────────────────────
// MANOR_KINDS 的真源在适配器（.mjs）。跨语言不能 import ⇒ 复制一份，
// 由这条测试把它绑住：改一边不改另一边 ⇒ 红。

test('★ 契约同源：CLAIMABLE_KINDS 必须与适配器 dispatch.mjs 的 MANOR_KINDS 逐字一致', () => {
  const p = join(here, '..', '..', '..', 'projects', 'self', 'alice-manor', 'dispatch.mjs')
  const src = readFileSync(p, 'utf8')
  const m = /export const MANOR_KINDS = \[([^\]]*)\]/.exec(src)
  assert.notEqual(m, null, '适配器里找不到 MANOR_KINDS —— 它改名/搬走了，本测试必须跟着改')
  const adapterKinds = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s !== '')
  assert.deepEqual(
    [...CLAIMABLE_KINDS].sort(),
    [...adapterKinds].sort(),
    '适配器认领的 kind 与插件侧不一致 —— 读数会比现实乐观或悲观',
  )
})

// ── 二 · 分类：两侧都测 ────────────────────────────────────────────────

test('task / chat ⇒ 可处理（下一轮轮询会取走，不需要人管）', () => {
  const s = summarizeInbox([{ kind: 'task', createdAt: at(1) }, { kind: 'chat', createdAt: at(1) }], T0, DEFAULT_STALE_AFTER_MS)
  assert.equal(s.pending, 2)
  assert.equal(s.claimable, 2)
  assert.equal(s.unclaimed, 0)
  assert.equal(s.stale, false)
})

test('★ 尸体：result / event / alert ⇒ 无人认领（这是真实积压的那一族）', () => {
  const s = summarizeInbox(
    [
      { kind: 'result', createdAt: at(31) },
      { kind: 'result', createdAt: at(30) },
      { kind: 'event', createdAt: at(2) },
      { kind: 'alert', createdAt: at(2) },
    ],
    T0,
    DEFAULT_STALE_AFTER_MS,
  )
  assert.equal(s.pending, 4)
  assert.equal(s.claimable, 0)
  assert.equal(s.unclaimed, 4)
  assert.equal(s.unclaimedKinds['result'], 2)
  assert.equal(s.oldestUnclaimedAgeMs, 31 * H)
})

test('★ 尸体 · fail-closed：坏 kind（空串 / 非字符串 / 大小写不同）一律算无人认领', () => {
  const s = summarizeInbox(
    [{ kind: '', createdAt: at(1) }, { kind: 42, createdAt: at(1) }, { kind: 'CHAT', createdAt: at(1) }, { kind: null, createdAt: at(1) }],
    T0,
    DEFAULT_STALE_AFTER_MS,
  )
  assert.equal(s.claimable, 0, '「不知道能不能处理」时不得声称能处理')
  assert.equal(s.unclaimed, 4)
  assert.equal(s.unclaimedKinds['(无 kind)'], 3)
  assert.equal(s.unclaimedKinds['CHAT'], 1)
})

// ── 三 · 年龄与搁浅 ────────────────────────────────────────────────────

test('空箱 ⇒ 全 0、不 stale（不是「读不到」——那是调用方的事）', () => {
  const s = summarizeInbox([], T0, DEFAULT_STALE_AFTER_MS)
  assert.deepEqual(
    { p: s.pending, c: s.claimable, u: s.unclaimed, o: s.oldestAgeMs, ou: s.oldestUnclaimedAgeMs, st: s.stale },
    { p: 0, c: 0, u: 0, o: 0, ou: 0, st: false },
  )
})

test('★ 关键区分：可处理件再旧也**不算搁浅**（它下一轮就会被取走）', () => {
  const s = summarizeInbox([{ kind: 'chat', createdAt: at(100) }], T0, DEFAULT_STALE_AFTER_MS)
  assert.equal(s.oldestAgeMs, 100 * H)
  assert.equal(s.oldestUnclaimedAgeMs, 0)
  assert.equal(s.stale, false, '把「可处理但还没轮到」报成搁浅 ⇒ 狼来了')
})

test('无人认领件超阈值 ⇒ stale；未超 ⇒ 不 stale（阈值两侧都测）', () => {
  const over = summarizeInbox([{ kind: 'result', createdAt: at(7) }], T0, DEFAULT_STALE_AFTER_MS)
  const under = summarizeInbox([{ kind: 'result', createdAt: at(5) }], T0, DEFAULT_STALE_AFTER_MS)
  assert.equal(over.stale, true)
  assert.equal(under.stale, false)
})

test('非法 createdAt **不计龄**（不猜），但仍计入 pending', () => {
  const s = summarizeInbox([{ kind: 'result', createdAt: 'yesterday' }, { kind: 'result', createdAt: 0 }], T0, DEFAULT_STALE_AFTER_MS)
  assert.equal(s.pending, 2)
  assert.equal(s.unclaimed, 2)
  assert.equal(s.oldestUnclaimedAgeMs, 0)
  assert.equal(s.stale, false)
})

test('createdAt 在未来（时钟偏斜）⇒ 年龄夹到 0，不出负数', () => {
  const s = summarizeInbox([{ kind: 'result', createdAt: T0 + 5 * H }], T0, DEFAULT_STALE_AFTER_MS)
  assert.equal(s.oldestUnclaimedAgeMs, 0)
})

// ── 四 · 渲染（读数形状）────────────────────────────────────────────────

test('渲染：没有无人认领件 ⇒ **保持旧形状**（正常态不被噪音淹没）', () => {
  const s = summarizeInbox([{ kind: 'chat', createdAt: at(1) }], T0, DEFAULT_STALE_AFTER_MS)
  assert.equal(renderInbox(s, 0), '收件箱 待 1 死 0')
})

test('渲染：有无人认领件 ⇒ 展开括注（可处理 / 无人认领 / kind 分布 / 最旧多久）', () => {
  const s = summarizeInbox(
    [{ kind: 'chat', createdAt: at(0.1) }, { kind: 'result', createdAt: at(31) }, { kind: 'result', createdAt: at(30) }],
    T0,
    DEFAULT_STALE_AFTER_MS,
  )
  const out = renderInbox(s, 0)
  assert.match(out, /待 3 死 0/)
  assert.match(out, /可处理 1/)
  assert.match(out, /无人认领 2/)
  assert.match(out, /result×2/)
  assert.match(out, /最旧 31\.0h/)
  assert.match(out, /⚠/, '超阈值必须显形——静默的搁浅正是本条要治的病')
})

test('渲染：未超阈值时不挂警告（阈值两侧都测）', () => {
  const s = summarizeInbox([{ kind: 'result', createdAt: at(1) }], T0, DEFAULT_STALE_AFTER_MS)
  assert.equal(/⚠/.test(renderInbox(s, 0)), false)
})

test('hoursOf：一位小数、不出负数', () => {
  assert.equal(hoursOf(0), '0.0')
  assert.equal(hoursOf(90 * 60 * 1000), '1.5')
  assert.equal(hoursOf(-5), '0.0')
})
