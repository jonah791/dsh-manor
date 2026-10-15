/**
 * `timeout.ts` 的判据测试 —— 「硬顶参数化」的**派活侧**。
 *
 * 纪律（SOUL §5.9 规则 2）：**新防线必带尸体测试**；并且必须有**金标准**
 * （合法输入 ⇒ 精确生效、零 error/warning）—— 否则「恒亮的判据不是证据」。
 *
 * ★ 本文件里最要紧的一组是 **H（跨实现契约对账）**：`manor`（TS 插件）与
 *   `alice-manor`（独立适配器 .mjs）之间**没有共享模块机制**，唯一的共享面是
 *   总线上的信封 JSON ⇒ **常量只能靠测试对账**（改一处忘另一处 = 静默分叉：
 *   派活侧说「合法」而执行侧照 clamp，或反过来）。
 *   ⚠ 该用例**要求两个包在同一个工作区里**（本仓即此形态）。若 manor 被复制到别处独立开发，
 *     这条会红 —— 那是**刻意的**：那时必须显式决定契约由谁拥有。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  validateTimeoutSpec,
  normalizeTimeoutSpec,
  renderTimeoutSpec,
  MIN_TASK_TIMEOUT_MS,
  DEFAULT_MAX_TASK_IDLE_MS,
  DEFAULT_MAX_TASK_HARD_CAP_MS,
} from '../src/timeout.ts'
import { buildEnvelope } from '../src/envelope.ts'
import { buildHoldRecord } from '../src/hold.ts'

/** 一具合法的 hold 规格（只用于喂 `buildHoldRecord`；字段值本身不参与本组断言）。 */
const holdSpec = (over = {}) => ({
  taskId: 't-timeout-1', to: 'maid-01', from: 'web-0', kind: 'task', text: 'x',
  acceptance: '', cwd: '.', priority: 'normal' as const, dependsOn: [],
  heldAtMs: 1791740000000, heldBy: 'web-0', deadlineAfterMs: 21600000,
  ttlMs: 86400000, reason: 'deps-pending' as const,
  ...over,
})

/* ── A 金标准：合法声明必须**精确生效**（判据不恒亮）──────────────────────── */

test('A1 合法 spec ⇒ 精确生效、零 error、零 warning', () => {
  const r = validateTimeoutSpec({ idleMs: 600000, hardCapMs: 5400000 })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.spec, { idleMs: 600000, hardCapMs: 5400000 })
})

test('A2 未声明 ⇒ 空 spec、零 error、零 warning（不声明是合法状态）', () => {
  const r = validateTimeoutSpec({})
  assert.deepEqual(r.spec, {})
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
})

test('A3 只给一个字段 ⇒ 只收那个字段（不替派活方补另一个）', () => {
  const r = validateTimeoutSpec({ hardCapMs: 3600000 })
  assert.deepEqual(r.spec, { hardCapMs: 3600000 })
  assert.equal(r.errors.length, 0)
})

/* ── B 拒发尸体：低于下限 / 类型错（fail-loud，不放行必然被杀的预算）────────── */

test('B1 尸体·低于下限 ⇒ error，且文案点明「必然被杀」与「把秒当毫秒」', () => {
  const r = validateTimeoutSpec({ hardCapMs: 60 })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0]!, /低于下限/)
  assert.match(r.errors[0]!, /必然被杀/, '要说清代价，否则派活方不知道为什么被拦')
  assert.match(r.errors[0]!, /把秒当毫秒/, '要给出最常见的笔误形状')
  assert.equal(r.spec.hardCapMs, undefined, '被拒的字段不得进 spec')
})

test('B2 尸体·非有限正数（负数/0/NaN/Infinity/字符串）⇒ 一律 error', () => {
  for (const bad of [-1, 0, NaN, Infinity, 'abc', {}, []]) {
    const r = validateTimeoutSpec({ hardCapMs: bad })
    assert.equal(r.errors.length, 1, 'bad=' + JSON.stringify(bad) + ' 应被拒')
    assert.match(r.errors[0]!, /有限正数/)
    assert.match(r.errors[0]!, /单位是\*\*毫秒\*\*/, '要提醒单位 —— 写错单位是最贵的笔误')
  }
})

test('B3 idleMs 与 hardCapMs 用同一套判据（不因字段不同而松紧不一）', () => {
  assert.equal(validateTimeoutSpec({ idleMs: 60 }).errors.length, 1)
  assert.equal(validateTimeoutSpec({ idleMs: 600000 }).errors.length, 0)
})

/* ── C 警告而非拒发：超上界（判据见 timeout.ts 头注「拒发 vs 警告」）────────── */

test('C1 尸体·超上界 ⇒ **零 error** + 一条 warning（活照跑，只是会被 clamp）', () => {
  const r = validateTimeoutSpec({ hardCapMs: 99999999 })
  assert.deepEqual(r.errors, [], '超上界不是错误 —— 拒发是「劳动全丢」的最强动作，代价不对称时取轻的那侧')
  assert.equal(r.warnings.length, 1)
  assert.equal(r.spec.hardCapMs, 99999999, '仍要收下原值（执行侧 clamp 时 requested 才有据可查）')
})

test('C2 警告必须**可操作**：点名 clamp 与要抬的那个开关', () => {
  const r = validateTimeoutSpec({ hardCapMs: 99999999 })
  assert.match(r.warnings[0]!, /clamp/)
  assert.match(r.warnings[0]!, /--maxHardCapMs/, '不说清抬哪个开关，警告就只是噪音')
})

/* ── D 可诊断性：硬顶 ≤ idle ⇒ idle 判据永远不会先触发 ───────────────────── */

test('D1 尸体·hardCapMs ≤ idleMs ⇒ 出 warning（不改值，只让人看得见）', () => {
  const r = validateTimeoutSpec({ idleMs: 600000, hardCapMs: 300000 })
  assert.equal(r.errors.length, 0)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0]!, /永远不会先触发/)
  assert.deepEqual(r.spec, { idleMs: 600000, hardCapMs: 300000 }, '提示不得改值')
})

test('D2 正常预算（硬顶 > idle）⇒ 无 warning（提示不恒亮）', () => {
  assert.equal(validateTimeoutSpec({ idleMs: 60000, hardCapMs: 600000 }).warnings.length, 0)
})

test('D3 只给一个字段时不出 shadowed（无从比较 ⇒ 不许猜）', () => {
  assert.equal(validateTimeoutSpec({ hardCapMs: 300000 }).warnings.length, 0)
})

/* ── E 归一（写入侧共用：envelope 与 hold 记录）───────────────────────────── */

test('E1 normalizeTimeoutSpec：非对象/数组/null ⇒ null', () => {
  for (const v of [null, undefined, 'x', 123, [], true]) {
    assert.equal(normalizeTimeoutSpec(v), null, 'v=' + JSON.stringify(v))
  }
})

test('E2 normalizeTimeoutSpec：全空 ⇒ null（**不写字段** —— 比写了空对象干净）', () => {
  assert.equal(normalizeTimeoutSpec({}), null)
  assert.equal(normalizeTimeoutSpec({ idleMs: 'x' }), null, '坏值丢完后为空 ⇒ 也是 null')
})

test('E3 normalizeTimeoutSpec：部分有效 ⇒ 只留有效字段（部分可用 > 全废）', () => {
  assert.deepEqual(normalizeTimeoutSpec({ idleMs: 'x', hardCapMs: 3600000 }), { hardCapMs: 3600000 })
})

test('E4 normalizeTimeoutSpec：**不做范围校验**（那是 validate 的职责，分工不许混）', () => {
  // 超上界与低于下限都**照收** —— 归一管形状，范围管语义（两处混了就会出现「谁说了算」的分叉）
  assert.deepEqual(normalizeTimeoutSpec({ hardCapMs: 99999999 }), { hardCapMs: 99999999 })
  assert.deepEqual(normalizeTimeoutSpec({ hardCapMs: 60 }), { hardCapMs: 60 })
})

/* ── F 信封接线（直投那条产出路）─────────────────────────────────────────── */

const envOf = (timeout: unknown) => buildEnvelope({
  id: 'm-1', from: 'web-0', to: 'maid-01', kind: 'task', text: 'x',
  taskId: 't-1', acceptance: '', cwd: '.', createdAt: 1, ttlMs: 2, timeout,
})

test('F1 buildEnvelope：给了 spec ⇒ 写进 meta.timeout（形状与声明一致）', () => {
  const meta = envOf({ idleMs: 600000, hardCapMs: 5400000 })['meta'] as Record<string, unknown>
  assert.deepEqual(meta['timeout'], { idleMs: 600000, hardCapMs: 5400000 })
})

test('F2 尸体·未声明 / 坏形状 ⇒ **不写** meta.timeout（不加噪音键）', () => {
  for (const v of [undefined, null, {}, 'oops', { hardCapMs: 'x' }]) {
    const meta = envOf(v)['meta'] as Record<string, unknown>
    assert.equal('timeout' in meta, false, 'v=' + JSON.stringify(v) + ' 不该写出该键')
  }
})

test('F3 旧信封兼容：不带 timeout 的信封结构与改动前逐字一致', () => {
  const meta = envOf(undefined)['meta'] as Record<string, unknown>
  assert.deepEqual(Object.keys(meta).sort(), ['acceptance', 'cwd', 'taskId'],
    '未声明时 meta 的键集合必须与改动前一致（向后兼容是硬要求）')
})

/* ── G ★ hold 第二条产出路（nature 教训的第二个实例）──────────────────────── */

test('G1 buildHoldRecord：给了 spec ⇒ 记录带上它（释放时才有的可传）', () => {
  const rec = buildHoldRecord(holdSpec({ timeout: { hardCapMs: 3600000 } }))
  assert.deepEqual(rec.timeout, { hardCapMs: 3600000 })
})

test('G2 buildHoldRecord：未声明 ⇒ **记录里没有该键**（不是写了 undefined）', () => {
  const rec = buildHoldRecord(holdSpec())
  assert.equal('timeout' in rec, false, '记录不该带一个死键（同 nature 空串纪律）')
})

test('G3 源码级接线：releaseHold 必须把 hold.timeout 传回 buildEnvelope', () => {
  // ★ 这条防的正是 2026-10-12 那个教训的形状：**「某条路忘了传某字段」不报错、只静默降级**。
  //   行为级测试碰不到 releaseHold（它写盘 + 依赖总线），故用源码级断言守接线。
  const src = readFileSync(new URL('../src/hold-store.ts', import.meta.url), 'utf8')
  assert.match(src, /timeout:\s*hold\.timeout/, 'releaseHold 里必须带上 timeout（否则释放出去的活丢声明）')
})

test('G4 源码级接线：manor_dispatch 挂 hold 时必须把 timeoutSpec 传给 buildHoldRecord', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /timeout:\s*timeoutSpec/, '挂 hold 的调用点必须带 timeout（与 nature 同一条路）')
})

test('G5 源码级接线：两条产出路都不得漏（直投也必须有）', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  // 直投那条：buildEnvelope 的调用里也要有 timeout
  const direct = /const env = buildEnvelope\(\{[\s\S]*?\}\)/.exec(src)
  assert.ok(direct !== null, '找不到直投的 buildEnvelope 调用点（结构变了 ⇒ 本断言需同步）')
  assert.match(direct[0]!, /timeout:\s*timeoutSpec/, '直投那条产出路漏了 timeout')
})

/* ── H ★ 跨实现契约对账（无共享机制 ⇒ 测试是唯一手段）────────────────────── */

test('H1 跨实现常量对账：MIN / MAX 与 adapter 侧 timeouts.mjs 逐字一致', () => {
  const mjs = readFileSync(new URL('../../../projects/self/alice-manor/timeouts.mjs', import.meta.url), 'utf8')
  const numOf = (name: string): number => {
    const m = new RegExp('export const ' + name + ' = (\\d+)').exec(mjs)
    assert.ok(m !== null, 'timeouts.mjs 里找不到常量 ' + name + '（契约漂移：那一侧改名/删了？）')
    return Number(m[1])
  }
  // 下限：派活侧拒发 / 执行侧 clamp 到同一条线 —— 不一致会出现「派活侧说合法、执行侧照抬」
  assert.equal(MIN_TASK_TIMEOUT_MS, numOf('MIN_IDLE_MS'), 'MIN_TASK_TIMEOUT_MS ≠ timeouts.mjs 的 MIN_IDLE_MS')
  assert.equal(MIN_TASK_TIMEOUT_MS, numOf('MIN_HARD_CAP_MS'), 'MIN_TASK_TIMEOUT_MS ≠ timeouts.mjs 的 MIN_HARD_CAP_MS')
  // 上界：派活侧的「警告线」必须与执行侧的「clamp 线」同值，否则警告是错的
  assert.equal(DEFAULT_MAX_TASK_IDLE_MS, numOf('DEFAULT_MAX_IDLE_MS'), 'idle 上界两侧不一致')
  assert.equal(DEFAULT_MAX_TASK_HARD_CAP_MS, numOf('DEFAULT_MAX_HARD_CAP_MS'), '硬顶上界两侧不一致')
})

/* ── I 渲染（派活方要看见自己的声明）────────────────────────────────────── */

test('I1 renderTimeoutSpec：null ⇒ 空串（未声明不加噪音）', () => {
  assert.equal(renderTimeoutSpec(null), '')
})

test('I2 renderTimeoutSpec：完整 ⇒ 两个字段、秒为单位（人读）', () => {
  assert.equal(renderTimeoutSpec({ idleMs: 180000, hardCapMs: 3600000 }), 'idle 180s / 硬顶 3600s')
})

test('I3 renderTimeoutSpec：部分 ⇒ 只渲染给了的那项（不补默认值 —— 那是执行侧的活）', () => {
  assert.equal(renderTimeoutSpec({ hardCapMs: 3600000 }), '硬顶 3600s')
  assert.equal(renderTimeoutSpec({ idleMs: 60000 }), 'idle 60s')
})
