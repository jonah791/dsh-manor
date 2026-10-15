/**
 * 多播（`to` 逗号分隔）—— ③ 竞争面 E12 的真前置（2026-10-12）。
 *
 * 为什么先有它才有 claim：成员「澄」的判据「独立型 ⇒ 各做各的 / 独占型 ⇒ 先举手」
 * **两者都要求「一件活能被多人看见」**；而此前 `to` 只能一个成员 ⇒ 活天然独占 ⇒
 * `claim` 没有对象可领。⇒ 顺序是「先有多播，竞争才成为真问题」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRecipients } from '../src/envelope.ts'

test('★ 零回归：单收件人解析成单元素（既有调用一字不改）', () => {
  assert.deepEqual(parseRecipients('maid-01'), ['maid-01'])
})

test('逗号分隔 ⇒ 拆开', () => {
  assert.deepEqual(parseRecipients('maid-01,maid-03'), ['maid-01', 'maid-03'])
})

test('带空格 / 空段 / 尾逗号 ⇒ trim 且丢空段（不把空串当收件人）', () => {
  assert.deepEqual(parseRecipients(' maid-01 , , maid-03 ,'), ['maid-01', 'maid-03'])
  assert.deepEqual(parseRecipients('maid-01,,,'), ['maid-01'])
})

test('★ 重复 ⇒ 去重且**保序**（第一个仍是第一个 —— 顺序有意义：主收件人）', () => {
  assert.deepEqual(parseRecipients('maid-03,maid-01,maid-03'), ['maid-03', 'maid-01'])
})

test('全空 ⇒ 空数组（调用方据此 fail-loud，而不是投给一个叫空串的箱子）', () => {
  assert.deepEqual(parseRecipients(''), [])
  assert.deepEqual(parseRecipients('  ,  , '), [])
})

test('不做成员存在性校验 —— 这是刻意的（那是 manor_find 的知识面）', () => {
  // 投给不存在的箱子会留一条**搁浅件**：那本身可观测，比一次硬拒更诚实
  // （硬拒把「这封信没人取」藏进一次调用失败里）。
  assert.deepEqual(parseRecipients('不存在的人'), ['不存在的人'])
})
