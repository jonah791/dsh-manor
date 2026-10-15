/**
 * `claim` IO 层测试 —— 在**真临时总线**（真目录/真文件/真 rename）上跑（③ 竞争面 · E12）。
 *
 * ⚠ **本文件覆盖的是顺序语义**（两笔依次调用）。**真并发**（两个进程同时领同一件活）
 *   无法在纯单测里证 —— 那属**活体验收**。
 *   但「`wx` 是原子的」这一条**可以直接测**：同一路径连写两次，第二次必抛 `EEXIST`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimDirOf,
  claimPathOf,
  expiredDirOf,
  loadClaims,
  readClaim,
  releaseClaim,
  tryClaim,
} from '../src/claim-store.ts'
import { DEFAULT_CLAIM_TTL_MS } from '../src/claim.ts'

const T = 1_790_000_000_000
const fresh = (): string => mkdtempSync(join(tmpdir(), 'claim-store-'))

test('首领 ⇒ granted，且**盘上真有记录**（不是只在返回值里成功）', () => {
  const bus = fresh()
  const r = tryClaim(bus, 't-x', 'maid-01', T)
  assert.equal(r.decision, 'granted')
  const on = readClaim(bus, 't-x')
  assert.equal(on?.holder, 'maid-01')
  assert.equal(on?.taskId, 't-x')
})

test('★ 原子性（顺序形态）：第二笔是别人且未过期 ⇒ denied，且**盘上记录一字未动**', () => {
  const bus = fresh()
  tryClaim(bus, 't-x', 'maid-01', T)
  const before = readFileSync(claimPathOf(bus, 't-x'), 'utf8')
  const r = tryClaim(bus, 't-x', 'maid-03', T + 1000)
  assert.equal(r.decision, 'denied')
  assert.equal(r.holder, 'maid-01')
  assert.equal(readFileSync(claimPathOf(bus, 't-x'), 'utf8'), before, '★ 未取得者不得改动记录')
})

test('★ `wx` 真会拦：同一路径连写两次，第二次必抛 EEXIST（这是本模块原子性的地基）', () => {
  const bus = fresh()
  mkdirSync(claimDirOf(bus), { recursive: true })
  const p = claimPathOf(bus, 't-wx')
  writeFileSync(p, '{"a":1}', { flag: 'wx' })
  assert.throws(() => writeFileSync(p, '{"a":2}', { flag: 'wx' }), (e: unknown) =>
    (e as { code?: string }).code === 'EEXIST')
})

test('同一持有人重领 ⇒ renewed，且 `at` 刷新（续期在盘上可见）', () => {
  const bus = fresh()
  tryClaim(bus, 't-x', 'maid-01', T)
  const atBefore = readClaim(bus, 't-x')?.at
  const r = tryClaim(bus, 't-x', 'maid-01', T + 60_000)
  assert.equal(r.decision, 'renewed')
  const atAfter = readClaim(bus, 't-x')?.at
  assert.notEqual(atAfter, atBefore, '★ 续期必须落盘（否则「我还在」只是个返回值）')
})

test('★ 过期 ⇒ takeover：新记录是新人，且**旧记录进 expired/ 留痕**（不是删掉）', () => {
  const bus = fresh()
  tryClaim(bus, 't-x', 'maid-03', T, 60_000)
  const r = tryClaim(bus, 't-x', 'maid-01', T + 120_000, 60_000)
  assert.equal(r.decision, 'takeover')
  assert.notEqual(r.expiredPath, '')
  assert.equal(existsSync(r.expiredPath), true, '★ 抢占必留痕')
  assert.match(readFileSync(r.expiredPath, 'utf8'), /maid-03/, '留痕里是**旧**持有人')
  assert.equal(readClaim(bus, 't-x')?.holder, 'maid-01')
})

test('★ 尸体：坏记录 ⇒ blocked，且**坏文件原样保留**（fail-closed，不覆盖不删）', () => {
  const bus = fresh()
  mkdirSync(claimDirOf(bus), { recursive: true })
  const p = claimPathOf(bus, 't-bad')
  writeFileSync(p, '{ 这不是 JSON')
  const r = tryClaim(bus, 't-bad', 'maid-01', T)
  assert.equal(r.decision, 'blocked')
  assert.equal(readFileSync(p, 'utf8'), '{ 这不是 JSON', '★ 坏记录是证据，不许动它')
})

test('release：持有人自己 ⇒ ok；**别人 ⇒ 拒绝**（替别人释放就是夺权）', () => {
  const bus = fresh()
  tryClaim(bus, 't-x', 'maid-01', T)
  const other = releaseClaim(bus, 't-x', 'maid-03')
  assert.equal(other.ok, false)
  assert.match(other.note, /拒绝释放/)
  assert.match(other.note, /夺权/)
  assert.equal(readClaim(bus, 't-x')?.holder, 'maid-01', '拒绝后记录仍在')
  const mine = releaseClaim(bus, 't-x', 'maid-01')
  assert.equal(mine.ok, true)
  assert.equal(readClaim(bus, 't-x'), undefined)
})

test('release 之后可再领 ⇒ granted（且不留痕：留痕只给抢占）', () => {
  const bus = fresh()
  tryClaim(bus, 't-x', 'maid-01', T)
  releaseClaim(bus, 't-x', 'maid-01')
  const r = tryClaim(bus, 't-x', 'maid-03', T + 1000)
  assert.equal(r.decision, 'granted')
  assert.equal(existsSync(expiredDirOf(bus)), false, '自愿释放不产生 expired/ 目录')
})

test('loadClaims：正常记录进 records，**坏记录进 bad 且不静默丢**', () => {
  const bus = fresh()
  tryClaim(bus, 't-ok', 'maid-01', T)
  mkdirSync(claimDirOf(bus), { recursive: true })
  writeFileSync(join(claimDirOf(bus), 't-bad.json'), 'not json')
  const { records, bad } = loadClaims(bus)
  assert.equal(records.length, 1)
  assert.equal(bad.length, 1)
  assert.match(bad[0]!, /结构不符/)
})

test('目录不存在时：readClaim ⇒ undefined（确认不在），loadClaims ⇒ 空（首次使用的常态）', () => {
  const bus = fresh()
  assert.equal(readClaim(bus, 't-none'), undefined)
  assert.deepEqual(loadClaims(bus), { records: [], bad: [] })
  assert.equal(readdirSync(bus).length, 0, '读操作不得在盘上留下东西')
})

test('默认 TTL 是 15 分钟（取值依据：台账实测中位 3.7 分钟 / 最长 30.0 分钟）', () => {
  assert.equal(DEFAULT_CLAIM_TTL_MS, 15 * 60 * 1000)
})
