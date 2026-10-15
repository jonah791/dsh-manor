/**
 * 成员适配器新鲜度判据的测试（纯函数，零 I/O）。
 *
 * ## 这批测试要证明什么（不是「跑绿了」）
 *
 * 缺口的形状是**静默**：五名成员跑了 11 小时旧代码，而**没有任何读数会告诉你**。
 * ⇒ 判据的价值全在**它会出声**。所以每条测试都配尸体样本（§5.9 规则 2）：
 * 喂一个真实的「旧代码成员」，断言它**真的被拦下**——恒为空的输出不是证据。
 *
 * ## 真实读数（2026-10-14 11:13，域=庄园名册 6 名成员）
 *
 *   adapter.mjs mtime = 10-13 23:49:40
 *   maid-01..05 进程 start = 10-13 12:38:34  ⇒ 滞后 11 小时 11 分 6 秒
 *   maid-06     start = 10-13 23:57:07        ⇒ 含新代码
 *
 * 下面 `REAL_*` 常量就是这两个时刻（**取自现场，不是编的**）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  judgeAdapterFreshness,
  renderLag,
  summarizeStaleAdapters,
} from '../src/adapter-staleness.ts'

/** 现场读数：adapter.mjs mtime（2026-10-13 23:49:40 本地 = 15:49:40 UTC）。 */
const REAL_ADAPTER_MTIME = Date.UTC(2026, 9, 13, 15, 49, 40)
/** 现场读数：maid-01..05 进程启动（2026-10-13 12:38:34 本地 = 04:38:34 UTC）。 */
const REAL_STALE_START = Date.UTC(2026, 9, 13, 4, 38, 34)
/** 现场读数：maid-06 进程启动（2026-10-13 23:57:07 本地 = 15:57:07 UTC）。 */
const REAL_FRESH_START = Date.UTC(2026, 9, 13, 15, 57, 7)

// ───────────────────── 三态判定：stale / fresh / unknown ─────────────────────

test('判据：真实旧成员被拦下（尸体样本 = 现场那 5 个进程）', () => {
  const v = judgeAdapterFreshness(REAL_STALE_START, REAL_ADAPTER_MTIME)
  assert.equal(v.freshness, 'stale')
  // 滞后必须**算对**：11h11m06s = 40266000 ms
  assert.equal(v.lagMs, 40266000)
  assert.equal(renderLag(v.lagMs), '11 小时 11 分')
})

test('判据：重启后的成员判 fresh（负对照——判据不能一律报 stale）', () => {
  const v = judgeAdapterFreshness(REAL_FRESH_START, REAL_ADAPTER_MTIME)
  assert.equal(v.freshness, 'fresh')
  assert.equal(v.lagMs, 0)
  // ★ 负对照的关键断言：两者**必须不同**——否则判据没有区分力
  assert.notEqual(
    judgeAdapterFreshness(REAL_STALE_START, REAL_ADAPTER_MTIME).freshness,
    judgeAdapterFreshness(REAL_FRESH_START, REAL_ADAPTER_MTIME).freshness,
  )
})

test('判据：缺 startedAtMs ⇒ unknown，不许渲染成 fresh（静默即缺陷）', () => {
  // 老版本心跳 / 非适配器进程（如主脑 LAPTOP-BF4IAPLM-web-0 现读就没有这一格）
  assert.equal(judgeAdapterFreshness(0, REAL_ADAPTER_MTIME).freshness, 'unknown')
  assert.equal(judgeAdapterFreshness(NaN, REAL_ADAPTER_MTIME).freshness, 'unknown')
  assert.equal(judgeAdapterFreshness(-1, REAL_ADAPTER_MTIME).freshness, 'unknown')
  // ★ 这条是本判据的核心不变量：unknown ≠ fresh
  assert.notEqual(judgeAdapterFreshness(0, REAL_ADAPTER_MTIME).freshness, 'fresh')
})

test('判据：adapter mtime 读不到 ⇒ 全体 unknown（响亮降级，不猜）', () => {
  assert.equal(judgeAdapterFreshness(REAL_STALE_START, NaN).freshness, 'unknown')
  assert.equal(judgeAdapterFreshness(REAL_STALE_START, 0).freshness, 'unknown')
})

test('判据：相等算 fresh（零迟滞会误报「刚改完就重启」）', () => {
  assert.equal(judgeAdapterFreshness(REAL_ADAPTER_MTIME, REAL_ADAPTER_MTIME).freshness, 'fresh')
  assert.equal(judgeAdapterFreshness(REAL_ADAPTER_MTIME + 1, REAL_ADAPTER_MTIME).freshness, 'fresh')
})

// ───────────────────────── renderLag：滞后必须人读 ─────────────────────────

test('renderLag：分档正确且不产生「0 分」噪音', () => {
  assert.equal(renderLag(40266000), '11 小时 11 分')
  assert.equal(renderLag(90000), '1 分')
  assert.equal(renderLag(30000), '30 秒')
  assert.equal(renderLag(90000000), '1 天 1 小时')
  assert.equal(renderLag(0), '')
  assert.equal(renderLag(-5), '')
  assert.equal(renderLag(NaN), '')
})

// ───────────────────── summarize：一行读数，且全 fresh 时安静 ─────────────────────

test('汇总：现场 6 名成员 ⇒ 报 5 个 stale + 1 个 fresh（读数与手工核对一致）', () => {
  const s = summarizeStaleAdapters(
    [
      { id: 'maid-01', startedAtMs: REAL_STALE_START },
      { id: 'maid-02', startedAtMs: REAL_STALE_START },
      { id: 'maid-03', startedAtMs: REAL_STALE_START },
      { id: 'maid-04', startedAtMs: REAL_STALE_START },
      { id: 'maid-05', startedAtMs: REAL_STALE_START },
      { id: 'maid-06', startedAtMs: REAL_FRESH_START },
    ],
    REAL_ADAPTER_MTIME,
  )
  assert.equal(s.staleIds.length, 5)
  assert.equal(s.unknownIds.length, 0)
  assert.equal(s.maxLagMs, 40266000)
  assert.match(s.line, /跑旧代码 5 个/)
  assert.match(s.line, /maid-01\(11 小时 11 分\)/)
  // maid-06 不该出现在 stale 名单里
  assert.ok(!s.staleIds.includes('maid-06'))
})

test('汇总：全体 fresh ⇒ 空串（常读面只在有异常时出声）', () => {
  const s = summarizeStaleAdapters(
    [{ id: 'a', startedAtMs: REAL_FRESH_START }, { id: 'b', startedAtMs: REAL_FRESH_START }],
    REAL_ADAPTER_MTIME,
  )
  assert.equal(s.line, '')
  assert.equal(s.staleIds.length, 0)
})

test('汇总：unknown 必须出声（安静 ≠ 判不了）——负对照证明空分型不是万能挡箭牌', () => {
  const s = summarizeStaleAdapters(
    [{ id: 'a', startedAtMs: 0 }, { id: 'b', startedAtMs: REAL_FRESH_START }],
    REAL_ADAPTER_MTIME,
  )
  assert.equal(s.staleIds.length, 0)
  assert.deepEqual(s.unknownIds, ['a'])
  // ★ 「全 fresh 返回空串」这条优化**不许**把 unknown 一起吞掉
  assert.notEqual(s.line, '')
  assert.match(s.line, /判不了 1 个：a/)
})

test('汇总：超过 3 个时截断并报总数（一行读数的长度纪律）', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: 'm' + String(i), startedAtMs: REAL_STALE_START }))
  const s = summarizeStaleAdapters(many, REAL_ADAPTER_MTIME)
  assert.equal(s.staleIds.length, 7)
  assert.match(s.line, /等 7 个/)
})

test('汇总：stale 与 unknown 同时存在 ⇒ 两段都出（不许互相掩盖）', () => {
  const s = summarizeStaleAdapters(
    [
      { id: 'old', startedAtMs: REAL_STALE_START },
      { id: 'nokey', startedAtMs: 0 },
      { id: 'ok', startedAtMs: REAL_FRESH_START },
    ],
    REAL_ADAPTER_MTIME,
  )
  assert.match(s.line, /跑旧代码 1 个/)
  assert.match(s.line, /判不了 1 个/)
  assert.match(s.line, / · /) // 两段用 · 分隔
})
