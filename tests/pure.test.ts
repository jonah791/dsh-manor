/**
 * manor 门面的纯函数测试。
 *
 * 存在理由：2026-10-11 清账时发现 README 声称有 `tests/pure.test.mjs`（10/10），
 * 而**该文件在仓库里从未存在过** —— 「声明与实现不符」的典型形态（技能 acceptance-integrity §4）。
 * 处置不是删声明，是**把声明变成真的**：这些纯函数确实值得测，尤其 `keyNamesFor`
 * （2026-10-09 两次真实失败都源于「启动键名靠人抄文档」）。
 *
 * 尸体样本逐条注明：它们证明回退分支**真的会走**，而不是没被执行过的死代码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEnvelope, judgeFresh, keyNamesFor, newMsgId, parseIdentity } from '../src/index.ts'

/** 形如真实 profile 的片段：provider 段 + 其 apiKeyEnv。 */
function patchOf(provider: string, keyEnv: string): string {
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: ' + provider,
    '    model: some-model',
    '',
    provider + ':',
    '  apiKeyEnv: ' + keyEnv,
  ].join('\n')
}

// ───────────────────────── keyNamesFor：启动键名不许硬编码 ─────────────────────────

test('keyNamesFor：判据随 profile 走——provider 是 command 就取 COMMAND_API_KEY', () => {
  const r = keyNamesFor(patchOf('command', 'COMMAND_API_KEY'))
  assert.equal(r.provider, 'command')
  assert.deepEqual(r.keyNames, ['COMMAND_API_KEY'])
  assert.match(r.source, /provider "command" 段内的 apiKeyEnv/)
})

test('keyNamesFor：同一样本换 provider ⇒ 键名必须跟着变（这条正是本插件存在的理由）', () => {
  const r = keyNamesFor(patchOf('opemcoder', 'OPEMCODER_API_KEY'))
  assert.equal(r.provider, 'opemcoder')
  assert.deepEqual(r.keyNames, ['OPEMCODER_API_KEY'])
})

test('尸体①：空 profile ⇒ 回退硬编码缺省，且 source 说明是回退（不是伪装成推导成功）', () => {
  const r = keyNamesFor('')
  assert.equal(r.provider, '')
  assert.deepEqual(r.keyNames, ['COMMAND_API_KEY'])
  assert.match(r.source, /硬编码缺省/)
})

test('尸体②：有 provider 但该段没有 apiKeyEnv ⇒ 回退到文件里第一个 apiKeyEnv', () => {
  const text = [
    '- id: agent-default-model',
    '  config:',
    '    provider: ghost',
    '',
    'other-provider:',
    '  apiKeyEnv: FALLBACK_KEY',
  ].join('\n')
  const r = keyNamesFor(text)
  assert.equal(r.provider, 'ghost')
  assert.deepEqual(r.keyNames, ['FALLBACK_KEY'])
  assert.match(r.source, /回退/)
})

test('尸体③：完全没有 apiKeyEnv ⇒ 回退缺省（不是空字符串——空键名会让成员 2 秒 exit=1）', () => {
  const r = keyNamesFor('- id: agent-default-model\n  config:\n    provider: x\n')
  assert.deepEqual(r.keyNames, ['COMMAND_API_KEY'])
  assert.notEqual(r.keyNames[0], '')
})

// ───────────────────────── parseIdentity：从 AGENTS.md 抽身份 ─────────────────────────

test('parseIdentity：标准标题行 ⇒ 取到名字', () => {
  const md = '# 织（Ori）— 爱丽丝庄园成员\n\n负责**工程实现**：把东西做出来\n'
  const r = parseIdentity(md)
  assert.equal(r.name, '织（Ori）')
  assert.equal(r.duty, '工程实现')
})

test('尸体④：无标题行 ⇒ name 为空串（身份缺失不是错误，只是没读到——不许编）', () => {
  const r = parseIdentity('<meta>只有许可块，没有身份标题</meta>')
  assert.equal(r.name, '')
})

test('parseIdentity：回退分支能识别「# 名字（全名）」形态', () => {
  const r = parseIdentity('# 绘琉（Eru）\n\n负责**出图**\n')
  assert.equal(r.name, '绘琉')
})

test('尸体⑤：有标题但无「负责」句 ⇒ duty 为空串', () => {
  const r = parseIdentity('# 澄（Sumi）— 爱丽丝庄园成员\n\n无职责句\n')
  assert.equal(r.name, '澄（Sumi）')
  assert.equal(r.duty, '')
})

// ───────────────────────── judgeFresh：单一判据的新鲜度 ─────────────────────────

test('judgeFresh：age 小于阈值 ⇒ 在线', () => {
  assert.deepEqual(judgeFresh(1000, 1000 + 29_999, 30_000), { online: true, ageMs: 29_999 })
})

test('judgeFresh：age 恰好等于阈值 ⇒ 离线（判据是 < 而非 ≤）', () => {
  assert.deepEqual(judgeFresh(1000, 1000 + 30_000, 30_000), { online: false, ageMs: 30_000 })
})

test('尸体⑥：atMs 为 0 / 非有限 / 未来 ⇒ 一律离线且 ageMs=-1（时钟异常不当成在线）', () => {
  assert.deepEqual(judgeFresh(0, 1000, 30_000), { online: false, ageMs: -1 })
  assert.deepEqual(judgeFresh(Number.NaN, 1000, 30_000), { online: false, ageMs: -1 })
  assert.deepEqual(judgeFresh(2000, 1000, 30_000), { online: false, ageMs: -1 })
})

// ───────────────────────── buildEnvelope：庄园专属信封契约 ─────────────────────────

test('buildEnvelope：meta 三件套齐备（缺 taskId 会被成员正确拒收）', () => {
  const e = buildEnvelope({
    id: 'm-1', from: 'web-0', to: 'maid-01', kind: 'task', text: 'do it',
    taskId: 't-1', acceptance: 'exit 0', cwd: '.', createdAt: 123, ttlMs: 456,
  })
  assert.equal(e['v'], 1)
  assert.deepEqual(e['meta'], { taskId: 't-1', acceptance: 'exit 0', cwd: '.' })
  assert.equal(e['kind'], 'task')
})

test('尸体⑦：acceptance 留空也**照样出现在 meta 里**（缺键与空值是两件事——适配器只查键存在）', () => {
  const e = buildEnvelope({
    id: 'm-2', from: 'a', to: 'b', kind: 'task', text: 'x',
    taskId: 't-2', acceptance: '', cwd: '.', createdAt: 1, ttlMs: 2,
  })
  const meta = e['meta'] as Record<string, unknown>
  assert.equal(Object.prototype.hasOwnProperty.call(meta, 'acceptance'), true)
  assert.equal(meta['acceptance'], '')
})

test('newMsgId：形如 m-<base36>-<rand>', () => {
  const id = newMsgId(1_790_000_000_000, 'abcd1234')
  assert.match(id, /^m-[0-9a-z]+-abcd1234$/)
})
