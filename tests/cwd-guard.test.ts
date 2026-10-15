/**
 * 派活侧的 cwd 校验（2026-10-12 · 四封回执共同报出的缺口）。
 *
 * 由来：多播派活时我给了一个 cwd（`E:/alice-nodes`），而四个成员的工作根是各自的
 * `E:\alice-nodes\maid-0N` ⇒ **同一个 cwd 发给 N 个不同工作根的人，必然对每个人越界**。
 * 适配器**正确地**拒了并降级（按本节点工作根执行）—— 但**四个人各自在自己的回执里抱怨一次，
 * 派活侧却一无所知**。⇒ 诊断前移到**唯一握有全局**的那一侧。
 *
 * ★ 本文件全部是**纯函数**判据（零 IO）—— 壳层只负责把名册里的 workdir 喂进来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoTaskId, cwdInsideWorkdir } from '../src/index.ts'

test('单播常态：cwd 就是她自己的工作根 ⇒ 通过（且分隔符混写也算通过）', () => {
  assert.equal(cwdInsideWorkdir('E:/alice-nodes/maid-01', 'E:\\alice-nodes\\maid-01'), true)
})

test('工作根的子目录 ⇒ 通过（在根内）', () => {
  assert.equal(cwdInsideWorkdir('E:/alice-nodes/maid-01/src', 'E:/alice-nodes/maid-01'), true)
})

test('★ 真触发：多播给的 `E:/alice-nodes` 对五个成员**全部越界**', () => {
  for (const n of ['maid-01', 'maid-02', 'maid-03', 'maid-04', 'maid-05']) {
    assert.equal(cwdInsideWorkdir('E:/alice-nodes', 'E:/alice-nodes/' + n), false,
      '`E:/alice-nodes` 不落在 ' + n + ' 的工作根内 —— 这正是 2026-10-12 四封回执共同报出的那条')
  }
})

test('尸体①：相对路径（空 / `.`）⇒ 一律通过（它随各人工作根，不是越界）', () => {
  assert.equal(cwdInsideWorkdir('', 'E:/alice-nodes/maid-01'), true)
  assert.equal(cwdInsideWorkdir('.', 'E:/alice-nodes/maid-01'), true)
})

test('尸体②：工作根未知（读不到名册记录）⇒ **不作判**（不替她断言越界）', () => {
  assert.equal(cwdInsideWorkdir('E:/somewhere/else', ''), true)
})

test('★ 前缀不得误判：`alice-nodes-x` 与 `alice-nodes` 互不包含（裸 startsWith 的经典错）', () => {
  assert.equal(cwdInsideWorkdir('E:/alice-nodes-x', 'E:/alice-nodes'), false)
  assert.equal(cwdInsideWorkdir('E:/alice-nodes', 'E:/alice-nodes-x'), false)
})

test('归一：大小写与尾斜杠都不影响判决（Windows 实测会混写）', () => {
  assert.equal(cwdInsideWorkdir('e:\\Alice-Nodes\\MAID-01\\', 'E:/alice-nodes/maid-01'), true)
})

// ────── taskId 不得含**分隔符字符**（2026-10-12 多播活体验收当场发现） ──────
// 多播时 `to` 是 `maid-02,maid-03`，缺省 id 直接拼 `to` ⇒ `t-maid-02,maid-03-mv4a94oa`。
// 而**逗号在依赖面是分隔符**（`hold.dependsOn` 用 `join(',')` 存多值）
// ⇒ 同一个字符既是标识符的一部分又是分隔符。

test('★ 多播自动生成的 taskId **不含逗号**（含了就会被依赖面拆成两个不存在的 id）', () => {
  const id = autoTaskId('maid-02,maid-03', 1791750949354)
  assert.equal(id.includes(','), false, '生成的 id 含逗号 —— 它被当依赖时会被拆坏')
  assert.match(id, /^t-maid-02\+maid-03-/, '应把逗号换成 `+`，并保留「投给了谁」的信息')
})

test('单播自动生成照旧（零回归）', () => {
  assert.match(autoTaskId('maid-01', 1000), /^t-maid-01-/)
})
