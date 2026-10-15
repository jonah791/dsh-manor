/**
 * 名册并发写保护（roster-lock）测试。
 *
 * 纪律（acceptance-integrity）：**判据器必须先证明自己有分辨力**。
 * 第一组用例是「**无锁会丢更新**」的对照实验——它证明丢更新真的会发生（不是理论担忧）；
 * 第二组是同一实验加锁后**两笔都必须留下**。两组读数相反，才说明这道防线在工作。
 *
 * 第三组起是锁原语本身：坏锁放行（四具尸体）· TTL 与时钟偏移 · 有界等待超时 ·
 * 释放不夺权 · 进程内保序 · 临界区抛错仍释放锁。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireLock,
  judgeLock,
  lockPathOf,
  parseLock,
  releaseLock,
  renderLockInfo,
  serializePerTarget,
  withTargetLock,
  type LockInfo,
} from '../src/roster-lock.ts'
import { emptyRoster, hire, parseRoster, rosterFingerprint, type RosterFile } from '../src/roster-registry.ts'

const T0 = 1_790_000_000_000

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'manor-lock-'))

const writeRosterFile = (p: string, r: RosterFile): void => {
  writeFileSync(p, JSON.stringify(r, null, 2) + '\n', 'utf8')
}

const readRosterFile = (p: string): RosterFile => {
  const parsed = parseRoster(readFileSync(p, 'utf8'), T0)
  assert.equal(parsed.ok, true)
  return parsed.roster
}

/** 读 → 改 → 写（**不加锁**）。在中间留一个 await 交错点，模拟两个动作撞在一起。 */
const unlockedHire = async (p: string, id: string, nowMs: number): Promise<void> => {
  const before = existsSync(p) ? readRosterFile(p) : emptyRoster(nowMs)
  await new Promise((resolve) => setImmediate(resolve))
  const res = hire(before, { id }, nowMs)
  assert.equal(res.ok, true)
  writeRosterFile(p, res.roster)
}

/** 同一段「读-改-写」，供加锁版复用（临界区内容与上面逐字相同，只差有没有锁）。 */
const criticalHire = (p: string, id: string, nowMs: number): void => {
  const before = existsSync(p) ? readRosterFile(p) : emptyRoster(nowMs)
  const res = hire(before, { id }, nowMs)
  assert.equal(res.ok, true)
  writeRosterFile(p, res.roster)
}

// ── 一 · 对照：不加锁 ⇒ 丢更新（证明问题真实） ──────────────────────────────

test('对照·无锁并发：两笔「读-改-写」相撞 ⇒ 后写覆盖前写，先写的那笔消失', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  await Promise.all([unlockedHire(p, 'maid-a', T0), unlockedHire(p, 'maid-b', T0 + 1)])
  const roster = readRosterFile(p)
  const ids = roster.members.map((m) => m.id)
  assert.equal(roster.members.length, 1, '无锁并发下必然只留下一笔（这就是丢更新的现场）')
  assert.equal(ids.includes('maid-a') && ids.includes('maid-b'), false, '两人不可能同时留下')
})

// ── 二 · 修复：加锁后同一实验，两笔都必须在 ────────────────────────────────

test('修复·加锁并发：同一实验两笔并发 ⇒ 两笔都留下（不丢更新）', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  const [ra, rb] = await Promise.all([
    withTargetLock(p, { owner: 't1' }, () => criticalHire(p, 'maid-a', T0)),
    withTargetLock(p, { owner: 't2' }, () => criticalHire(p, 'maid-b', T0 + 1)),
  ])
  assert.equal(ra.ok, true)
  assert.equal(rb.ok, true)
  const ids = readRosterFile(p).members.map((m) => m.id).sort()
  assert.deepEqual(ids, ['maid-a', 'maid-b'], '两笔都必须留下——丢一笔即修复失败')
})

test('修复·加锁并发（三笔）：三人全在，且锁文件最终被释放', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  const out = await Promise.all(['a', 'b', 'c'].map((id, i) =>
    withTargetLock(p, { owner: 'w' + id }, () => criticalHire(p, 'm-' + id, T0 + i))))
  assert.equal(out.every((o) => o.ok), true)
  assert.deepEqual(readRosterFile(p).members.map((m) => m.id).sort(), ['m-a', 'm-b', 'm-c'])
  assert.equal(existsSync(lockPathOf(p)), false, '临界区完成后锁必须被释放')
})

test('修复·临界区抛错 ⇒ 错误如实上报，且锁被释放（可再取）', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  const bad = await withTargetLock(p, { owner: 'oops' }, () => {
    throw new Error('临界区故意失败')
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /临界区故意失败/)
  assert.equal(existsSync(lockPathOf(p)), false, '抛错也必须释放锁（否则整本名册被锁死）')
  const again = await withTargetLock(p, { owner: 'next' }, () => criticalHire(p, 'm-x', T0))
  assert.equal(again.ok, true)
})

// ── 三 · 指纹：CAS 复核的判据 ──────────────────────────────────────────────

test('指纹：成员任一字段变化 ⇒ 指纹必变', () => {
  const base = hire(emptyRoster(T0), { id: 'a', name: '织', duty: '织造' }, T0).roster
  const renamed = hire(emptyRoster(T0), { id: 'a', name: '织造', duty: '织造' }, T0).roster
  const otherDuty = hire(emptyRoster(T0), { id: 'a', name: '织', duty: '别的' }, T0).roster
  const laterTime = hire(emptyRoster(T0), { id: 'a', name: '织', duty: '织造' }, T0 + 1).roster
  assert.notEqual(rosterFingerprint(base), rosterFingerprint(renamed))
  assert.notEqual(rosterFingerprint(base), rosterFingerprint(otherDuty))
  assert.notEqual(rosterFingerprint(base), rosterFingerprint(laterTime))
})

test('指纹：同一内容重新构造 ⇒ 指纹不变（否则 CAS 永远误报冲突）', () => {
  const a = hire(emptyRoster(T0), { id: 'a', name: '织' }, T0).roster
  const b = hire(emptyRoster(T0), { id: 'a', name: '织' }, T0).roster
  assert.equal(rosterFingerprint(a), rosterFingerprint(b))
})

test('指纹：成员顺序不影响结果（列表顺序不是语义）', () => {
  const two = hire(hire(emptyRoster(T0), { id: 'a' }, T0).roster, { id: 'b' }, T0 + 1).roster
  const flipped: RosterFile = { ...two, members: [...two.members].reverse() }
  assert.equal(rosterFingerprint(two), rosterFingerprint(flipped))
})

test('指纹：增删成员必变（这是它最要紧的用途）', () => {
  const one = hire(emptyRoster(T0), { id: 'a' }, T0).roster
  const two = hire(one, { id: 'b' }, T0 + 1).roster
  assert.notEqual(rosterFingerprint(one), rosterFingerprint(two))
  assert.notEqual(rosterFingerprint(two), rosterFingerprint(emptyRoster(T0)))
})

// ── 四 · 坏锁放行（四具尸体） ─────────────────────────────────────────────

test('尸体①：锁文件是坏 JSON ⇒ 放行，且 issue 说明原因（不静默）', () => {
  const r = parseLock('{ 这不是 json')
  assert.equal(r.info, null)
  assert.match(r.issue, /不是合法 JSON/)
  assert.equal(judgeLock(r.info, r.issue, T0, 'me').verdict, 'free')
})

test('尸体②：锁文件为空 ⇒ 放行 + issue', () => {
  const r = parseLock('   \n')
  assert.equal(r.info, null)
  assert.match(r.issue, /为空/)
})

test('尸体③：锁文件是数组/标量（shape 非法）⇒ 放行 + issue', () => {
  assert.match(parseLock('[]').issue, /shape 非法/)
  assert.match(parseLock('42').issue, /shape 非法/)
})

test('尸体④：缺字段或非正数（owner 空 / ttl 0 / atMs 0）⇒ 放行 + issue', () => {
  assert.match(parseLock('{"owner":"","atMs":1,"ttlMs":1}').issue, /缺字段/)
  assert.match(parseLock('{"owner":"x","atMs":1,"ttlMs":0}').issue, /缺字段/)
  assert.match(parseLock('{"owner":"x","atMs":0,"ttlMs":1}').issue, /缺字段/)
})

test('坏锁在场时仍能取到锁（不至于因坏数据停在半路）', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  writeFileSync(lockPathOf(p), 'not json at all', 'utf8')
  const got = await acquireLock(p, { owner: 'me', waitMs: 50, pollMs: 10 })
  assert.equal(got.ok, true)
  assert.equal(got.trace.some((t) => t.includes('坏锁放行')), true, '放行必须留痕')
})

// ── 五 · 裁决表：TTL / 时钟偏移 / 自持 ────────────────────────────────────

test('裁决：他人新鲜持有 ⇒ held；过期 ⇒ expired；自持 ⇒ self', () => {
  const info: LockInfo = { owner: 'other', atMs: T0, ttlMs: 1000, note: '' }
  assert.equal(judgeLock(info, '', T0 + 500, 'me').verdict, 'held')
  assert.equal(judgeLock(info, '', T0 + 1000, 'me').verdict, 'expired', '恰好等于 TTL 即过期（不拖一秒）')
  assert.equal(judgeLock({ ...info, owner: 'me' }, '', T0 + 500, 'me').verdict, 'self')
})

test('裁决：时钟偏移（atMs 在未来）⇒ held（不因时钟问题去抢别人的锁）', () => {
  const info: LockInfo = { owner: 'other', atMs: T0 + 60_000, ttlMs: 1000, note: '' }
  const v = judgeLock(info, '', T0, 'me')
  assert.equal(v.verdict, 'held')
  assert.equal(v.ageMs < 0, true)
})

test('可取锁后，锁文件内容可被 parseLock 读回（自己写的自己认）', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  const got = await acquireLock(p, { owner: 'me', note: '调试' })
  assert.equal(got.ok, true)
  const back = parseLock(readFileSync(lockPathOf(p), 'utf8'))
  assert.equal(back.info === null, false)
  assert.equal(back.info === null ? '' : back.info.owner, 'me')
  assert.equal(back.info === null ? '' : back.info.note, '调试')
})

// ── 六 · 有界等待与不夺权 ───────────────────────────────────────────────

test('有界等待：他人持锁且 waitMs 内不释放 ⇒ 失败，错误里带持有者与等待时长', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  // ⚠ 必须用**真实当前时间**写这把锁：`acquireLock` 走真实时钟，用固定 T0 会让锁在出生时就已过期 13 天
  writeFileSync(lockPathOf(p), renderLockInfo('holder-x', 60_000, '', Date.now()), 'utf8')
  // ⚠ 且不可注入固定时钟：那会让 waitedMs 恒为 0，超时判据永不成立 ⇒ 死循环
  const got = await acquireLock(p, { owner: 'me', waitMs: 80, pollMs: 20 })
  assert.equal(got.ok, false)
  assert.match(got.error, /holder-x/)
  assert.match(got.error, /超时/)
})

test('不夺权：releaseLock 不动别人持有的锁', () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  writeFileSync(lockPathOf(p), renderLockInfo('holder-x', 60_000, '', T0), 'utf8')
  assert.equal(releaseLock(p, 'me'), '', '释放他人锁不报错，但也不该动它')
  assert.equal(existsSync(lockPathOf(p)), true)
  const back = parseLock(readFileSync(lockPathOf(p), 'utf8'))
  assert.equal(back.info === null ? '' : back.info.owner, 'holder-x')
})

test('自持重入：同一 owner 再取 ⇒ 可取（self 视为可取）', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  const a = await acquireLock(p, { owner: 'me', ttlMs: 60_000 })
  assert.equal(a.ok, true)
  const b = await acquireLock(p, { owner: 'me', ttlMs: 60_000, waitMs: 20 })
  assert.equal(b.ok, true)
})

// ── 七 · 进程内保序 ────────────────────────────────────────────────────

test('进程内队列：同一目标的调用按提交顺序执行（不交错）', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  const order: string[] = []
  const mk = (tag: string, delay: number) => serializePerTarget(p, async () => {
    order.push(tag + '-start')
    await new Promise((resolve) => setTimeout(resolve, delay))
    order.push(tag + '-end')
  })
  await Promise.all([mk('first', 20), mk('second', 1)])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
})

test('进程内队列：前一笔失败不污染后一笔', async () => {
  const dir = freshDir()
  const p = join(dir, 'roster.json')
  await assert.rejects(() => serializePerTarget(p, async () => {
    throw new Error('第一笔失败')
  }))
  const second = await serializePerTarget(p, async () => 'ok')
  assert.equal(second, 'ok')
})
