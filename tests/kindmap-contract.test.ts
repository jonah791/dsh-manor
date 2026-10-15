/**
 * 行为面 kind 契约（2026-10-12 · 成员「勘」要求的那一条）
 *
 * 与 `tests/inbox.test.ts` 的「契约同源」分工（**两条互补，缺一条就有盲区**）：
 *   - 那条读适配器的**声明行**（`export const MANOR_KINDS = [...]`）⇒ 抓得住「**声明改了、副本没改**」，
 *     **抓不住「声明还在、实现已经不用它了」**（把 `classifyIncoming` 改硬编码、`MANOR_KINDS` 留作死代码，
 *     那条测试照样全绿——而「写的侧知道」拿到的就是死代码）。
 *   - 本条读适配器**真的调用 `classifyIncoming`** 之后落下的产物（`state/adapter-kindmap-<id>.json`）
 *     ⇒ 它对的是**行为**，不是**意图**。
 *
 * ⚠ **这是集成检查，不是单元测试**：它需要盘上真的存在产物（成员跑过适配器）。
 *   **没有产物时显式 SKIP**——「恒为空」不是证据，也不是通过（§5.9 规则 2）。
 *   总线目录取 `MANOR_BUS_DIR`，缺省 `C:\Users\tr\.dsh-cluster`。
 *
 * 运行：node --test tests/kindmap-contract.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { CLAIMABLE_KINDS } from '../src/inbox.ts'

const BUS = process.env['MANOR_BUS_DIR'] ?? 'C:\\Users\\tr\\.dsh-cluster'
const STATE = join(BUS, 'state')

/** 盘上现有的行为面产物（一个成员一份）。 */
function kindMaps(): Array<{ file: string; nodeId: string; observed: Record<string, string> }> {
  if (!existsSync(STATE)) return []
  const out: Array<{ file: string; nodeId: string; observed: Record<string, string> }> = []
  for (const n of readdirSync(STATE)) {
    if (!n.startsWith('adapter-kindmap-') || !n.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(STATE, n), 'utf8')) as Record<string, unknown>
      const obs = j['observed']
      if (obs === null || typeof obs !== 'object') continue
      out.push({ file: n, nodeId: String(j['nodeId'] ?? '?'), observed: obs as Record<string, string> })
    } catch {
      // 坏文件：不当作「没有产物」——但也无法断言，交给下面那条去报告
      out.push({ file: n, nodeId: '?', observed: {} })
    }
  }
  return out
}

const maps = kindMaps()
const any = maps.length > 0

test('产物存在（否则本检查无从谈起——显式 SKIP，不静默通过）', { skip: !any ? '盘上没有 adapter-kindmap-*.json：成员还没在新版适配器上重启过一次' : false }, () => {
  assert.equal(any, true)
})

test('★ 声明与**行为**一致：认领的 kind 真的被判为它，其余真的被判 skip', { skip: !any ? '同上' : false }, () => {
  for (const m of maps) {
    for (const [kind, verdict] of Object.entries(m.observed)) {
      if (CLAIMABLE_KINDS.includes(kind)) {
        assert.equal(verdict, kind, `${m.nodeId}：声明认领 \`${kind}\`，而实际判成了 \`${verdict}\` ⇒ 声明与实现分叉`)
      } else {
        assert.equal(verdict, 'skip', `${m.nodeId}：声明不认领 \`${kind}\`，而实际判成了 \`${verdict}\` ⇒ 声明与实现分叉`)
      }
    }
  }
})

test('★ 探针必须真的覆盖到每个声明认领的 kind（否则产物证明不了它们）', { skip: !any ? '同上' : false }, () => {
  for (const m of maps) {
    for (const k of CLAIMABLE_KINDS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(m.observed, k),
        true,
        `${m.nodeId}：产物里没有 \`${k}\` 的探测结果 ⇒ 这份产物对 \`${k}\` 零信息量`,
      )
    }
  }
})

test('★ 反向守卫：产物里必须**有**被判 skip 的 kind（否则「全部认领」也能过）', { skip: !any ? '同上' : false }, () => {
  for (const m of maps) {
    const skipped = Object.values(m.observed).filter((v) => v === 'skip').length
    assert.ok(skipped > 0, `${m.nodeId}：产物里没有任何 skip ⇒ 这份产物没有分辨力（恒为「认领」）`)
  }
})
