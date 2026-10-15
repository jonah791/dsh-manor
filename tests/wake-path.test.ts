/**
 * 「有唤醒路径」判据（2026-10-12 · 由勘当场推翻我第一版判据后定型）。
 *
 * **背景**：我原先判「箱有没有消费者」用的是「**箱名在不在 `nodes/` 里**」。勘给了反例：
 *   那一刻 `LAPTOP-BF4IAPLM-maid-04-0` **在名册里、正心跳**（pid 33184），
 *   而那两条信是被 **`held`**（`autoInject=false`）—— **不是**「投给不存在的 id」。
 *   ⇒ 她那句是判据的最后形态：**「在册 ≠ 有消费者」**·
 *   「一个 `autoInject=false` 的箱子**在册也照样是死箱**，回信落在它上面等于没有落点。」
 *
 * ⇒ 真判据两层同时成立：**有节点身份**（有进程在轮询）**且取了会注入**（harness 是庄园适配器）。
 *
 * ★ 本文件把那次纠正**钉成判据**：第一具尸体就是她的真实反例（不是构造的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MANOR_ADAPTER_HARNESS, wakePathIds } from '../src/index.ts'
import { classifyBoxes, type BusBox } from '../src/stranded-bus.ts'

test('★ 只有庄园适配器算「有唤醒路径」（有身份 + 取了会注入）', () => {
  const ids = wakePathIds({
    'maid-01': MANOR_ADAPTER_HARNESS,
    'LAPTOP-BF4IAPLM-maid-04-0': 'dsh-agent-cluster',
  })
  assert.deepEqual([...ids], ['maid-01'])
})

test('★★ 尸体（勘的真实反例）：**在册、正心跳，但 harness 不是适配器 ⇒ 不算有消费者**', () => {
  const ids = wakePathIds({ 'LAPTOP-BF4IAPLM-maid-04-0': 'dsh-agent-cluster' })
  assert.equal(ids.has('LAPTOP-BF4IAPLM-maid-04-0'), false, '在册 ≠ 有消费者')
  assert.equal(ids.size, 0)
})

test('尸体：心跳没写 harness（空串）⇒ 也不算（未知不当作有）', () => {
  assert.equal(wakePathIds({ x: '' }).size, 0)
})

test('★ 接进分类：用这个 id 集 ⇒ 那个箱子落进「没有消费者」格', () => {
  const boxes: BusBox[] = [{
    box: 'LAPTOP-BF4IAPLM-maid-04-0',
    items: [{ file: 'a.json', kind: 'chat', from: 'maid-01', createdAt: 1 }],
    doneCount: 0,
  }]
  const r = classifyBoxes(boxes, wakePathIds({ 'LAPTOP-BF4IAPLM-maid-04-0': 'dsh-agent-cluster' }))
  assert.equal(r.noConsumer.length, 1, '取走也不注入 ⇒ 它就是「没有消费者」那一格')
  assert.equal(r.withConsumer.length, 0)
})

test('★ 对照组（判据不得恒判「无消费者」）：庄园适配器在 ⇒ 同一箱子落进「有消费者」格', () => {
  const boxes: BusBox[] = [{
    box: 'maid-01',
    items: [{ file: 'b.json', kind: 'chat', from: 'web-0', createdAt: 2 }],
    doneCount: 3,
  }]
  const r = classifyBoxes(boxes, wakePathIds({ 'maid-01': MANOR_ADAPTER_HARNESS }))
  assert.equal(r.withConsumer.length, 1)
  assert.equal(r.noConsumer.length, 0)
})
