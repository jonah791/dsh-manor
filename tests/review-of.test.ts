/**
 * 复核对账（`verifyOf`）—— 2026-11-12。
 *
 * 存在理由：庄园的回执面只答「有没有交回证据」，**答不了「谁复核过它」** ——
 *   工具自己在那一行写着「收到回执 ≠ 交的东西满足了判据」，需要「另一份**不是作者写的**重建」。
 *   而 `refs` 补不上这一格：它不折进台账（`grep refs task-ledger.ts` 为空）⇒
 *   台账里**根本看不到复核关系**。
 *
 * 判据链（本套件就是这三条，每条都有**必须先会拒**的尸体样本）：
 *   ① **派了 ≠ 复核过**：复核任务失败 / 拒收 / 未完 ⇒ 目标仍算「无人复核」；
 *   ② **自己验自己不算复核**（AGENTS.md §1.2 硬线）；
 *   ③ **判不了 ≠ 判过**：收件人为空时**单独报数**，不许混进「已复核」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildEnvelope, normalizeVerifyOf } from '../src/envelope.ts'
import {
  applyReviewIndex,
  foldTasks,
  summarizeTasks,
  type ActionEvent,
  type TaskRecord,
} from '../src/task-ledger.ts'

/** 造一条最小 TaskRecord（缺省给全，不用 any —— 让 TS 盯住漏字段）。 */
function task(over: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    actionId: 'a-' + over.taskId,
    to: 'maid-01',
    from: 'web-0',
    acceptance: '判据',
    nature: 'internal',
    natureDeclared: true,
    via: '',
    verifyOf: '',
    reviewedBy: '',
    selfReview: false,
    startedAtMs: 1,
    envelopeCreatedAtMs: 0,
    endedAtMs: 2,
    outcome: 'done',
    failureKind: 'none',
    rejectKind: 'none',
    warning: '',
    ms: 1,
    stdoutChars: 0,
    stderrChars: 0,
    tail: '',
    reapVerdict: '',
    reapReason: '',
    reapAtMs: 0,
    ...over,
  }
}

const baseEnv = {
  id: 'm-1', from: 'web-0', to: 'maid-03', kind: 'task', text: '干活',
  taskId: 't-a', acceptance: '判据', cwd: '.', createdAt: 1, ttlMs: 2,
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 归一：不像 taskId 的指针**不救也不猜**
// ═══════════════════════════════════════════════════════════════════════════

test('R1 normalizeVerifyOf：空 / 非字符串 ⇒ null（**不写字段**，不是写了空串）', () => {
  assert.equal(normalizeVerifyOf(''), null)
  assert.equal(normalizeVerifyOf('   '), null)
  assert.equal(normalizeVerifyOf(undefined), null)
  assert.equal(normalizeVerifyOf(null), null)
  assert.equal(normalizeVerifyOf(42), null)
  assert.equal(normalizeVerifyOf({}), null)
})

test('R2 normalizeVerifyOf：**非 `t-` 前缀 ⇒ null**（成员 id / 信封 id 都不是 taskId）', () => {
  assert.equal(normalizeVerifyOf('maid-01'), null, '成员 id 不是 taskId')
  assert.equal(normalizeVerifyOf('m-abc123'), null, '信封 id 前缀是 m-')
  assert.equal(normalizeVerifyOf('t-a'), 't-a', '正常 taskId 放行')
})

test('R3 尸体·残缺前缀 `t-` ⇒ null（放行它会让孤儿检测**永远不响**）', () => {
  assert.equal(normalizeVerifyOf('t-'), null, '光有前缀没有体 = 残缺，不是指针')
})

test('R4 超长 ⇒ 截到 VERIFY_OF_MAX_LEN（防整段文本塞进 meta）', () => {
  const long = 't-' + 'x'.repeat(200)
  const got = normalizeVerifyOf(long)
  assert.ok(got !== null)
  assert.equal(got!.length, 64)
  assert.ok(got!.startsWith('t-'))
})

// ═══════════════════════════════════════════════════════════════════════════
// ② 信封：**空不写** —— 旧信封必须逐字不变
// ═══════════════════════════════════════════════════════════════════════════

test('R5 buildEnvelope：给了 ⇒ 写进 meta.verifyOf', () => {
  const env = buildEnvelope({ ...baseEnv, verifyOf: 't-a' })
  const meta = env['meta'] as Record<string, unknown>
  assert.equal(meta['verifyOf'], 't-a')
})

test('R6 尸体·没给 ⇒ **meta 里没有该键**（不是写了 undefined / 空串）', () => {
  const env = buildEnvelope({ ...baseEnv })
  const meta = env['meta'] as Record<string, unknown>
  assert.equal('verifyOf' in meta, false, '空不写 —— 旧信封结构必须逐字一致')
})

test('R7 坏形状（成员 id / 残缺）⇒ 同样不写（归一在单一真源里，调用点不判）', () => {
  for (const bad of ['maid-01', 't-', '']) {
    const env = buildEnvelope({ ...baseEnv, verifyOf: bad })
    const meta = env['meta'] as Record<string, unknown>
    assert.equal('verifyOf' in meta, false, `坏形状 ${JSON.stringify(bad)} 不该落盘`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// ③ 源码级接线：**两条产出路都不得漏**（照 timeout / best 的 G3/G4/G5 传统）
//
// 为什么这条必须是测试而不是注释：`nature` 的教训（2026-10-12）——hold 是信封的第二条
//   产出路，那条路忘了传字段 ⇒ 释放出去的活必然丢声明，而**没有任何东西会响**。
//   ⇒ 判据只能钉在源码上（删那一行 ⇒ 这条必红）。
// ═══════════════════════════════════════════════════════════════════════════

test('R8 源码级接线：hold 释放路必须把 hold.verifyOf 传回 buildEnvelope', () => {
  const src = readFileSync(new URL('../src/hold-store.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('verifyOf: hold.verifyOf'), 'releaseHold 漏传 ⇒ 复核关系在释放时静默丢失')
})

test('R9 源码级接线：manor_dispatch 直投与挂 hold 两处都必须带上 verifyOfRaw', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const hits = src.split('verifyOf: verifyOfRaw').length - 1
  assert.equal(hits, 2, '直投 + hold 各一处；少一处 = 那条路的活丢了「复核谁」')
})

// ═══════════════════════════════════════════════════════════════════════════
// ④ 反向索引：判据的**分辨力**（三条尸体样本）
// ═══════════════════════════════════════════════════════════════════════════

test('R10 正向：复核任务 done ⇒ 目标 reviewedBy 被填', () => {
  const ts = [
    task({ taskId: 't-a', to: 'maid-03' }),
    task({ taskId: 't-r', to: 'maid-06', verifyOf: 't-a' }),
  ]
  applyReviewIndex(ts)
  assert.equal(ts[0]!.reviewedBy, 't-r')
  assert.equal(ts[1]!.selfReview, false)
})

test('R11 尸体①·**派了 ≠ 复核过**：复核任务 failed ⇒ 目标仍「无人复核」', () => {
  const ts = [
    task({ taskId: 't-a', to: 'maid-03' }),
    task({ taskId: 't-r', to: 'maid-06', verifyOf: 't-a', outcome: 'failed' }),
  ]
  applyReviewIndex(ts)
  assert.equal(ts[0]!.reviewedBy, '', '复核失败 ≠ 复核过 —— 这是整格存在的理由')
})

test('R12 尸体②·**自己验自己不算复核**：to 相同 ⇒ selfReview 且 reviewedBy 仍空', () => {
  const ts = [
    task({ taskId: 't-a', to: 'maid-03' }),
    task({ taskId: 't-r', to: 'maid-03', verifyOf: 't-a' }),
  ]
  applyReviewIndex(ts)
  assert.equal(ts[1]!.selfReview, true, '必须显形（不静默丢弃）')
  assert.equal(ts[0]!.reviewedBy, '', 'AGENTS.md §1.2：验收不自己验自己')
})

test('R13 尸体③·**判不了 ≠ 判过**：收件人为空 ⇒ 取宽算复核，但单独报数', () => {
  const ts = [
    task({ taskId: 't-a', to: '' }), // 早期日志没记成员
    task({ taskId: 't-r', to: 'maid-06', verifyOf: 't-a' }),
  ]
  applyReviewIndex(ts)
  assert.equal(ts[0]!.reviewedBy, 't-r', '判不了 ⇒ 取宽（代价较低的一侧）')
  const s = summarizeTasks(ts)
  assert.equal(s.review.unknownReviewer, 1, '但**必须**报出来 —— 否则盲区在读数里消失')
})

test('R14 孤儿：verifyOf 指向不存在的任务 ⇒ 不计入已复核，且在汇总里单独报', () => {
  const ts = [task({ taskId: 't-r', to: 'maid-06', verifyOf: 't-nope' })]
  applyReviewIndex(ts)
  const s = summarizeTasks(ts)
  assert.equal(s.review.orphanReviews, 1)
  assert.equal(s.review.eligible, 0, '孤儿复核任务自己也不进分母')
})

test('R15 分母规则：**复核任务自身不进分母**（否则无限递归：复核者的复核者永远没有）', () => {
  const ts = [
    task({ taskId: 't-a', to: 'maid-03' }),
    task({ taskId: 't-r', to: 'maid-06', verifyOf: 't-a' }),
  ]
  applyReviewIndex(ts)
  const s = summarizeTasks(ts)
  assert.equal(s.review.eligible, 1, '只有 t-a 该被复核')
  assert.equal(s.review.reviewed, 1)
  assert.equal(s.review.unreviewed, 0)
})

test('R16 汇总三分：unreviewed 是**要盯的那个数**，且 selfReviews 与之分开', () => {
  const ts = [
    task({ taskId: 't-a', to: 'maid-03' }), // 已复核
    task({ taskId: 't-b', to: 'maid-03' }), // 无人复核
    task({ taskId: 't-c', to: 'maid-03' }), // 只有自我复核
    task({ taskId: 't-r1', to: 'maid-06', verifyOf: 't-a' }),
    task({ taskId: 't-r2', to: 'maid-03', verifyOf: 't-c' }), // 自己验自己
  ]
  applyReviewIndex(ts)
  const s = summarizeTasks(ts)
  assert.equal(s.review.eligible, 3)
  assert.equal(s.review.reviewed, 1)
  assert.equal(s.review.unreviewed, 2, 't-b 无人复核 + t-c 只有自我复核')
  assert.equal(s.review.selfReviews, 1, '自我复核单独一档，不许算进 reviewed')
})

test('R17 同一目标被多次复核 ⇒ 取 taskId 字典序最小的（可复现，不取 Map 迭代序）', () => {
  const ts = [
    task({ taskId: 't-a', to: 'maid-03' }),
    task({ taskId: 't-rz', to: 'maid-06', verifyOf: 't-a' }),
    task({ taskId: 't-ra', to: 'maid-05', verifyOf: 't-a' }),
  ]
  applyReviewIndex(ts)
  assert.equal(ts[0]!.reviewedBy, 't-ra', '字典序 t-ra < t-rz')
})

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 折叠：字段从动作日志进台账（含空值语义）
// ═══════════════════════════════════════════════════════════════════════════

function ev(stage: string, detail: Record<string, unknown>, humanText = ''): ActionEvent {
  return { at: '2026-11-12T00:00:00Z', actionId: 'a1', stage, humanText, detail }
}

test('R18 foldTasks：detail.verifyOf 折进记录；同一任务多行时**非空才覆盖**', () => {
  const tasks = foldTasks([
    ev('start', { taskId: 't-r', profile: 'maid-06', acceptance: '判据' }),
    ev('stage', { taskId: 't-r', verifyOf: 't-a' }),
    ev('done', { taskId: 't-r', profile: 'maid-06' }),
  ])
  assert.equal(tasks[0]!.verifyOf, 't-a')
})

test('R19 尸体·日志里没有 verifyOf ⇒ 空串（**不是**「复核了空」，也不参与复核关系）', () => {
  const tasks = foldTasks([ev('done', { taskId: 't-a', profile: 'maid-03' })])
  assert.equal(tasks[0]!.verifyOf, '')
  assert.equal(tasks[0]!.reviewedBy, '')
  const s = summarizeTasks(tasks)
  assert.equal(s.review.eligible, 1)
  assert.equal(s.review.unreviewed, 1)
  assert.equal(s.review.orphanReviews, 0, '空串不是孤儿')
})
