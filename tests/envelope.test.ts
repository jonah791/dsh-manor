/**
 * 信封契约（`envelope.ts`）测试 —— 重点测 `R17'` 新增的 `refs`（证据指针）。
 *
 * 核心尸体（缺一就是假绿）：
 *   ① **空 refs ⇒ `meta` 里根本没有这个键** —— 不是空数组。
 *      空数组读起来像「他给了，但什么都没给」；**不写**的语义才是干净的「派活方没给指针」。
 *   ② **`parseRef` 的边界**：非串 / 无冒号 / 冒号在首 / 冒号在尾 / line 非数字 / line 为 0。
 *   ③ **`checkRefs` 把「空」与「写坏」分开报**（空白是个会撒谎的读数 ⇒ 空必须分型）。
 *   ④ **存在性由调用方注入**（`exists`）⇒ 本层不读盘，可离线测。
 *   ⑤ ⚠ **诚实边界**（澄标的）：`checkRefs` 只能到「给了能解析开的 ref」，
 *      **到不了「ref 指向的内容真的支持那句结论」** —— 后者要人读。这条不该被测试写成「已验证」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildEnvelope, checkRefs, parseRef, KNOWN_ENVELOPE_VIAS, viaKindOf, VIA_MAX_LEN } from '../src/envelope.ts'

const base = {
  id: 'm-1', from: 'web-0', to: 'maid-01', kind: 'task', text: '干活',
  taskId: 't-1', acceptance: '落盘', cwd: '.', createdAt: 1791740000000, ttlMs: 86400000,
}

test('① 无 refs ⇒ meta 里没有这个键（**不写**，不是写空数组）', () => {
  const env = buildEnvelope(base)
  const meta = env.meta as Record<string, unknown>
  assert.equal('refs' in meta, false, '★ 空不得写成空数组 —— 那读起来像「给了但什么都没给」')
  assert.deepEqual(Object.keys(meta).sort(), ['acceptance', 'cwd', 'taskId'])
})

test('①b 空数组同样不写；非空才写、且原样保留', () => {
  assert.equal('refs' in (buildEnvelope({ ...base, refs: [] }).meta as object), false)
  const env = buildEnvelope({ ...base, refs: ['a/b.ts:12', 'c/d.md:3'] })
  assert.deepEqual((env.meta as Record<string, unknown>).refs, ['a/b.ts:12', 'c/d.md:3'])
})

test('② parseRef 的边界（每一条都是一具尸体）', () => {
  assert.deepEqual(parseRef('src/hold.ts:661'), { path: 'src/hold.ts', line: 661 })
  assert.deepEqual(parseRef('  C:\\a\\b.mjs:7  '), { path: 'C:\\a\\b.mjs', line: 7 }, '两端空白要吃掉')
  assert.deepEqual(parseRef('a/b.ts:1'), { path: 'a/b.ts', line: 1 })
  assert.equal(parseRef('没有冒号'), null)
  assert.equal(parseRef(':12'), null, '冒号在首 ⇒ path 为空')
  assert.equal(parseRef('a/b.ts:'), null, '冒号在尾 ⇒ 没有行号')
  assert.equal(parseRef('a/b.ts:abc'), null, '行号必须是数字')
  assert.equal(parseRef('a/b.ts:0'), null, '★ 行号从 1 起（0 不是合法行号）')
  assert.equal(parseRef('a/b.ts:-3'), null)
  assert.equal(parseRef(123), null, '非串一律 null（不猜）')
  assert.equal(parseRef(null), null)
})

test('③ checkRefs：空与写坏**分开报**（空必须分型）', () => {
  const exists = (p: string) => p === 'ok.ts'
  const empty = checkRefs([], { exists })
  assert.equal(empty.ok, false)
  assert.match(empty.bad[0]!, /空/, '★ 空要走「空」那一支，不许混进「写坏」')

  const bad = checkRefs(['没冒号', 'ok.ts:3', 'gone.ts:1'], { exists })
  assert.equal(bad.ok, false)
  assert.equal(bad.bad.length, 2, '两具尸体都要被点出来')
  assert.equal(bad.parsed.length, 1, '合法的那条仍然解析出来（不因为同伴坏就丢）')
  assert.match(bad.bad[0]!, /形态/)
  assert.match(bad.bad[1]!, /不存在/)

  const good = checkRefs(['ok.ts:3'], { exists })
  assert.equal(good.ok, true)
  assert.deepEqual(good.parsed, [{ path: 'ok.ts', line: 3 }])
})

test('③b 非数组一律当空（信封字段可能是字符串/null）', () => {
  const r = checkRefs('a.ts:1', { exists: () => true })
  assert.equal(r.ok, false)
  assert.match(r.bad[0]!, /空/)
})

// ── `via`（`G-provenance` Step B · 2026-10-15）────────────────────────────────
//
// 这个字段要答的问题：**「这条 taskId 是被哪条调用点造出来的」**。
// 缺口（`docs/known-gaps.md` G-provenance）的三种病在盘上同貌 ⇒ 本字段让来路**直接读出**。
//
// 本组尸体（缺一就是假绿）：
//   · **不传 / 传空 ⇒ `meta` 里根本没有这个键**（同 `refs` 纪律：空不写）；
//   · **`unknown` 与 `none` 不可合并** —— 前者是「我不认识的那条路」（**枚举漏格的信号**），
//     后者是「还没盖章」。并成一态，则「有我没见过的路在造活」静默消失；
//   · **超长必须截断**（不许把整段文本塞进 `meta`）。

test('④ 无 via ⇒ meta 里没有这个键（空不写，同 refs 纪律）', () => {
  const meta = buildEnvelope(base).meta as Record<string, unknown>
  assert.equal('via' in meta, false, '★ 没盖章 ≠ 盖了一个空章')
  assert.deepEqual(Object.keys(meta).sort(), ['acceptance', 'cwd', 'taskId'])
})

test('④b 传了才写，且原样保留', () => {
  const env = buildEnvelope({ ...base, via: 'manor_dispatch' })
  assert.equal((env.meta as Record<string, unknown>).via, 'manor_dispatch')
})

test('④c 尸体：空串 / 纯空白 / 非字符串 ⇒ 一律不写（空必须分型）', () => {
  for (const bad of ['', '   ', '\t\n', 123, null, undefined, {}, []]) {
    assert.equal(
      'via' in (buildEnvelope({ ...base, via: bad as unknown }).meta as object),
      false,
      '坏输入不得写出一个像「声明了」的字段：' + JSON.stringify(bad),
    )
  }
})

test('④d 归一：两端空白吃掉、超长截断（防把整段文本塞进 meta）', () => {
  assert.equal(
    (buildEnvelope({ ...base, via: '  member-send  ' }).meta as Record<string, unknown>).via,
    'member-send',
  )
  const got = (buildEnvelope({ ...base, via: 'x'.repeat(200) }).meta as Record<string, unknown>).via as string
  assert.equal(got.length, VIA_MAX_LEN, '★ 超长必须截断，不许原样落盘')
})

test('④e viaKindOf 三态不可合并（unknown ≠ none）', () => {
  for (const k of KNOWN_ENVELOPE_VIAS) assert.equal(viaKindOf(k), 'known', k + ' 应在清单里')
  // ★ 本字段最该出声的一态：**我不认识的那条路 = 枚举漏格的信号**
  assert.equal(viaKindOf('someone-new'), 'unknown')
  assert.equal(viaKindOf(''), 'none')
  assert.equal(viaKindOf(undefined), 'none')
  assert.equal(viaKindOf(null), 'none')
})

test('④f 清单是枚举的机器可读副本（四条产出路）', () => {
  // 用途：`KNOWN_ENVELOPE_VIAS` 是「有几条路在写信封」的唯一非散文落点。
  // 2026-10-12 我在散文里数出「五条」，2026-10-15 现读只有四条（代码演进合并了调用点）
  // ⇒ 新增/合并产出路时，这条测试是**必须一起改**的那一处（改了才可能绿）。
  assert.deepEqual(
    [...KNOWN_ENVELOPE_VIAS].sort(),
    ['hold-release', 'manor_dispatch', 'member-adapter', 'member-send'],
  )
})

test('④g 接线（**源码级**，弱判据）：两条产出路各盖各的章', () => {
  // ⚠ 诚实标注它的弱：读源码文本只能证明「那一行在」，**不能**证明运行时走到。
  //   两侧的证据强度**不对称**，如实分开：
  //   · hold 释放那侧 —— **运行时**（`hold-store.test.ts` 的单一真源测试真跑 `releaseHold`
  //     并读回信封）⇒ 强，且删章必红（实测）；
  //   · 直投那侧 —— 只有源码级（`manor_dispatch` 住在工具壳层，起它要完整 ctx）⇒ 弱。
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /via: 'manor_dispatch'/, '直投路的盖章不见了')
  assert.equal(
    src.includes("via: 'hold-release'"),
    false,
    'hold 那侧的章不该出现在 index.ts —— 两条路各盖各的，章的位置本身就是证据',
  )
})
