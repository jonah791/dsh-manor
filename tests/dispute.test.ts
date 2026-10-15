/**
 * 争议登记与裁决（`dispute`）—— 让「两个成员意见相左」有一个**可被下一次引用**的落点（2026-10-12）。
 *
 * 真实触发已经发生过一次：织判「不变量破了」、哨判「宣称 + 判据缺陷」，两人都明写分歧、都不吞，
 * 最后由 web-0 读两份后裁决 —— 而那个裁决**只活在散文里** ⇒ **下一次没人能引用上一次**。
 *
 * ★ 本文件的判据设计要点：
 *   ① **「都有证据」不裁胜负**（函数只数得出「有没有」，读不出「支不支持」）⇒ 必须 `escalate`；
 *   ② **`escalate` 是终态**，与「未裁」分开报数（合成一个数＝替读的人决定要不要管）；
 *   ③ **标识符与分隔符要分开**（尸体样本：`by='../..'` 不许穿出目录）；
 *   ④ **终局唯一**（并发两方同时裁，后者被 `wx` 拒）—— 不靠锁，靠 `O_EXCL`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DISPOSITION_VERDICTS, DISPUTE_RULE_LABEL, HEADLINE_MAX, auditClaimTraces, claimFileNameOf, digestOf, judgeDispute,
  parseDispositionsText, parseDisputeClaim, parseDisputeMeta,
  parseDisputeVerdict, renderDispositions, renderDisputeLine, renderTraceAudit, safeSeg,
  serializeDisputeClaim, serializeDisputeMeta,
  serializeDisputeVerdict, validateDispositions, type DisputeClaim, type DisputeMeta,
} from '../src/dispute.ts'
import {
  DISPUTE_TRACE_FILE, disputeDirOf, disputesRootOf, dispositionsStateOf, loadDisputeTrace, loadDisputes,
  writeDisputeClaim, writeDisputeMeta, writeDisputeVerdict,
} from '../src/dispute-store.ts'

const T0 = 1770000000000

const meta = (rule: 'evidence' | 'role', artifactId = 'a1'): DisputeMeta => ({
  artifactId, subject: '不变量是否被破坏', rule, openedBy: 'web-0', atMs: T0,
})

const claim = (by: string, refs: string[]): DisputeClaim => ({ by, atMs: T0, text: by + ' 的说法', refs })

/** 只有这两个路径算「可解析」（注入谓词 ⇒ 纯层不碰盘）。 */
const resolvable = (r: string): boolean => r === 'src/a.ts:1' || r === 'src/b.ts:2'

const tmpBus = (): string => mkdtempSync(join(tmpdir(), 'manor-dispute-'))

/* ── A · judgeDispute（判据真能执行的那部分）────────────────────────── */

test('A1 恰好一方有可解析 ref ⇒ 判那一方赢，裁决人是 `rule:evidence`（不是人）', () => {
  const jo = judgeDispute(meta('evidence'), [claim('zhi', ['src/a.ts:1']), claim('shao', [])], {
    refResolvable: resolvable,
  })
  assert.equal(jo.kind, 'decided')
  if (jo.kind !== 'decided') return
  assert.equal(jo.side, 'zhi')
  assert.equal(jo.verdictBy, 'rule:evidence')
  // ★ 判词必须自曝边界：只声称「只有一方给了能解析开的证据」，不声称那一方对
  assert.match(jo.reason, /不声称那一方的结论是对的/)
})

test('★ A2 两侧都有可解析 ref ⇒ **escalate**（「都有证据」不裁胜负）', () => {
  const jo = judgeDispute(meta('evidence'), [claim('zhi', ['src/a.ts:1']), claim('shao', ['src/b.ts:2'])], {
    refResolvable: resolvable,
  })
  assert.equal(jo.kind, 'escalate')
  if (jo.kind !== 'escalate') return
  assert.match(jo.reason, /不裁胜负/)
})

test('A3 两侧都没有可解析 ref ⇒ escalate（无判据可用）', () => {
  const jo = judgeDispute(meta('evidence'), [claim('zhi', []), claim('shao', [])], { refResolvable: resolvable })
  assert.equal(jo.kind, 'escalate')
})

test('★ A4 只有一方登记 ⇒ escalate（**单方主张不是争议**）', () => {
  const jo = judgeDispute(meta('evidence'), [claim('zhi', ['src/a.ts:1'])], { refResolvable: resolvable })
  assert.equal(jo.kind, 'escalate')
  if (jo.kind !== 'escalate') return
  assert.match(jo.reason, /单方主张/)
})

test('A5 零主张 ⇒ escalate（不许在零主张上裁出赢家）', () => {
  const jo = judgeDispute(meta('evidence'), [], { refResolvable: resolvable })
  assert.equal(jo.kind, 'escalate')
})

test('★ A6 rule=role ⇒ 函数**不代裁**（一律 escalate，交人落名）', () => {
  const jo = judgeDispute(meta('role'), [claim('zhi', ['src/a.ts:1']), claim('shao', [])], {
    refResolvable: resolvable,
  })
  assert.equal(jo.kind, 'escalate')
  if (jo.kind !== 'escalate') return
  assert.match(jo.reason, /verdictBy/)
})

test('A7 注入谓词抛异常 ⇒ 当作「不可解析」，**不把异常变成判词**', () => {
  const jo = judgeDispute(meta('evidence'), [claim('zhi', ['boom']), claim('shao', [])], {
    refResolvable: () => {
      throw new Error('盘读不了')
    },
  })
  assert.equal(jo.kind, 'escalate') // 两侧都不可解析 ⇒ 无判据
})

test('A8 同名 `by` 重复出现 ⇒ 按**一侧**算（不是两方）', () => {
  const jo = judgeDispute(meta('evidence'), [claim('zhi', []), claim('zhi', [])], { refResolvable: resolvable })
  assert.equal(jo.kind, 'escalate')
  if (jo.kind !== 'escalate') return
  assert.match(jo.reason, /单方主张/)
})

/* ── B · safeSeg（★ 尸体样本：标识符与分隔符必须分开）───────────────── */

test('★★ B1 尸体样本：`by` 里的路径分隔符必须被净化（不许穿出目录）', () => {
  const evil = '../../etc/passwd'
  const seg = safeSeg(evil)
  assert.ok(!seg.includes('/'), '净化后不许再含 `/`：' + seg)
  assert.ok(!seg.includes('\\'), '净化后不许含 `\\`：' + seg)
  const fn = claimFileNameOf(evil)
  assert.equal(fn.includes('/'), false)
  assert.match(fn, /^claim-[\w.-]+\.json$/)
})

test('B2 `..` / `.` / 空串 ⇒ 一律退成一个安全段（不许是「上一级」）', () => {
  assert.equal(safeSeg('..'), '_')
  assert.equal(safeSeg('.'), '_')
  assert.equal(safeSeg(''), '_')
  assert.equal(claimFileNameOf('..'), 'claim-_.json')
})

test('B3 正常名字不被改动（净化不是改名器）', () => {
  assert.equal(safeSeg('maid-01'), 'maid-01')
  assert.equal(claimFileNameOf('LAPTOP-BF4IAPLM-web-0'), 'claim-LAPTOP-BF4IAPLM-web-0.json')
})

test('B4 超长名字被截断（不许用名字撑爆路径）', () => {
  assert.ok(safeSeg('x'.repeat(500)).length <= 64)
})

/* ── C · 解析（「坏」与「缺」必须分开）─────────────────────────────── */

test('C1 坏 JSON / 缺字段 / 不在闭集的 rule ⇒ null（不是「没有争议」）', () => {
  assert.equal(parseDisputeMeta('{bad'), null)
  assert.equal(parseDisputeMeta('[]'), null)
  assert.equal(parseDisputeMeta(JSON.stringify({ artifactId: 'a', rule: 'evidence' })), null) // 缺 subject
  assert.equal(parseDisputeMeta(JSON.stringify({ artifactId: 'a', subject: 's', rule: 'majority' })), null)
})

test('C2 好记录能往返（序列化 → 解析 恒等）', () => {
  const m = meta('role')
  assert.deepEqual(parseDisputeMeta(serializeDisputeMeta(m)), m)
  const c = claim('zhi', ['src/a.ts:1'])
  assert.deepEqual(parseDisputeClaim(serializeDisputeClaim(c)), c)
})

test('★ C3 判词：`decided` 却没说谁赢 ⇒ null；没写理由 ⇒ null；**没有短结论句 ⇒ null**', () => {
  const base = {
    v: 2, outcome: 'decided', headline: 'zhi 赢（按证据）', side: 'zhi', verdictBy: 'web-0',
    reason: 'r', refs: [], atMs: T0,
  }
  assert.notEqual(parseDisputeVerdict(JSON.stringify(base)), null)
  assert.equal(parseDisputeVerdict(JSON.stringify({ ...base, side: '' })), null)
  assert.equal(parseDisputeVerdict(JSON.stringify({ ...base, reason: '' })), null)
  assert.equal(parseDisputeVerdict(JSON.stringify({ ...base, outcome: 'maybe' })), null)
  // ★ 短结论句是「引判词的唯一入口」⇒ **v2 起**缺了它就等于判词没有可照抄的形式（必须拦）
  assert.equal(parseDisputeVerdict(JSON.stringify({ ...base, headline: '' })), null)
  assert.equal(parseDisputeVerdict(JSON.stringify({ ...base, headline: '   ' })), null)
  // ★ 超长的「短结论句」不再是可照抄的一句 ⇒ 也拦
  assert.equal(parseDisputeVerdict(JSON.stringify({ ...base, headline: 'x'.repeat(HEADLINE_MAX + 1) })), null)
  assert.notEqual(parseDisputeVerdict(JSON.stringify({ ...base, headline: 'x'.repeat(HEADLINE_MAX) })), null)
  // escalated 不需要 side（本来就没赢家），但**必须有理由**；短结论句的要求**按 schema 版本分**：
  //   v2 起必填；v1 及更早（**连 `v` 字段都没有**）没有这个字段 ⇒ 允许缺，但会被标成 legacy。
  assert.notEqual(parseDisputeVerdict(JSON.stringify({ v: 2, outcome: 'escalated', headline: '我无权裁', side: '', reason: '我无权裁' })), null)
  assert.equal(parseDisputeVerdict(JSON.stringify({ v: 2, outcome: 'escalated', side: '', reason: '我无权裁' })), null,
    '★ v2 起没有短结论句 ⇒ 非法（**不能用「字段缺失」判 legacy** —— 那会把忘了写的新记录也放过）')
  assert.notEqual(parseDisputeVerdict(JSON.stringify({ outcome: 'escalated', side: '', reason: '我无权裁' })), null,
    'v1 老记录（无 `v` 字段）⇒ 允许缺短结论句，但标 legacy')
})

// ────────── 短结论句（2026-10-12 · 由哨在第一次闭环后指出）──────────
// 现场：我裁决后**转述时说反了** —— 判词明写「不是驳倒，是并立」，我口头说「你是输方」。
// 我当时的修法是「记成纪律：引用自己的裁决时要照读记录」。她的反驳是：
//   **这条争议的原始主题恰恰是「结构上装不下 > 靠纪律」** —— 只落一句「下次小心」，
//   那个「同一个决定、两个落点」的形状就**还在原地**，只是换了个当事人（这次是我）。
// ⇒ 能装下它的结构是**一个不可改写的短结论句字段**：「引判词 = 引这个字段」。

test('★★ 函数给出的判词必须自带短结论句（两种终局都要有，且可照抄）', () => {
  const d = judgeDispute(meta('evidence'), [claim('zhi', ['src/a.ts:1']), claim('shao', [])], { refResolvable: resolvable })
  assert.equal(d.kind, 'decided')
  assert.ok(d.headline.length > 0, 'decided 必须有短结论句')
  assert.ok(d.headline.length <= HEADLINE_MAX, '短结论句不许超上限（否则它就不是「可照抄的一句」）')
  assert.match(d.headline, /zhi/, '短结论句要点名赢家')

  const e = judgeDispute(meta('evidence'), [claim('zhi', []), claim('shao', [])], { refResolvable: resolvable })
  assert.equal(e.kind, 'escalate')
  assert.ok(e.headline.length > 0, 'escalate 也必须有短结论句（「我无权裁」本身是一个答案）')
  assert.match(e.headline, /无权裁/, 'escalate 的短结论句要说清是「无权裁」而不是「还没裁」')
})

test('★ 短结论句不许超上限、不许为空（写侧与读侧都要拦 —— 只拦一侧等于没拦）', () => {
  const ok = {
    outcome: 'decided', headline: 'a 赢', side: 'a', verdictBy: 'rule:evidence',
    reason: 'r', refs: [], atMs: T0, dispositions: [], legacyNoDispositions: false,
  }
  assert.notEqual(parseDisputeVerdict(serializeDisputeVerdict(ok)), null)
  assert.throws(() => serializeDisputeVerdict({ ...ok, headline: '' }), /./, '空短结论句不该能序列化出去')
  // ★ 处置清单也一样：**写侧**不能把一个「字段缺失」的判词写出去
  //   （`dispositions` 缺失 ⇒ `.map` 直接抛 ⇒ 由 `writeDisputeVerdict` 接住并转成错误字符串）
  assert.throws(
    () => serializeDisputeVerdict({ ...ok, dispositions: undefined as unknown as never }),
    /./,
    '缺 dispositions 的判词不该能序列化出去 —— v3 起它是判词的一部分',
  )
})

test('★★ schema 演进的代价：**老判词照样读得回**，但显式标成 legacy（不改历史记录）', () => {
  // 现场：短结论句字段上线时，盘上已经躺着一条半小时前写的判词（`hold-recheck-sho`）。
  // 处置纪律：**不改它** —— `verdict.json` 走 `wx`、「写一次永不修改」是这个机制的第一条纪律；
  //   为了一个新字段去改一条已落的判词，等于把「谁先判的、为什么」这条保证破掉。
  // ⇒ 读侧显式标记 + 渲染时响亮提示「没有可照抄的短句，必须照读原文」。
  const legacy = { outcome: 'decided', side: 'zhi', verdictBy: 'web-0', reason: 'r', refs: [], atMs: T0 }
  const parsed = parseDisputeVerdict(JSON.stringify(legacy))
  assert.notEqual(parsed, null, '老判词必须读得回来 —— 否则一条合法判词会变成「读不出」')
  assert.equal(parsed!.legacyNoHeadline, true)
  assert.equal(parsed!.headline, '', '★ 不许替它编造一个短句 —— 那是伪造（把没有的东西写成有）')
  // 反向对照：**v2** 判词必须 **不是** legacy（否则这个标记就没有信息量）
  const fresh = parseDisputeVerdict(JSON.stringify({ ...legacy, v: 2, headline: 'zhi 赢' }))
  assert.equal(fresh!.legacyNoHeadline, false)
  // 且 v2 判词的 headline 为空时仍要拒（legacy 例外只对 **v1**，不对「v2 给了空串」）
  assert.equal(parseDisputeVerdict(JSON.stringify({ ...legacy, v: 2, headline: '' })), null)
})

/* ── D · 存储（真实盘 · 终局唯一不靠锁，靠 O_EXCL）──────────────────── */

test('D1 同一 artifactId 开两次 ⇒ 第二次被拒（no-clobber，不覆盖）', () => {
  const bus = tmpBus()
  assert.equal(writeDisputeMeta(bus, meta('evidence')), '')
  const second = writeDisputeMeta(bus, { ...meta('evidence'), subject: '换了个说法' })
  assert.notEqual(second, '', '重复开必须被拒')
  // 原记录**没被覆盖**（「谁先开的、按哪条规则」还在）
  const { list } = loadDisputes(bus)
  assert.equal(list[0].meta.subject, '不变量是否被破坏')
})

test('D2 同一侧主张写两次 ⇒ 第二次被拒（要改就新开一条争议）', () => {
  const bus = tmpBus()
  writeDisputeMeta(bus, meta('evidence'))
  assert.equal(writeDisputeClaim(bus, 'a1', claim('zhi', [])), '')
  assert.notEqual(writeDisputeClaim(bus, 'a1', claim('zhi', ['src/a.ts:1'])), '')
})

test('★★ D3 终局唯一：判词写两次 ⇒ 第二次被拒（并发两方同时裁，后者 EEXIST）', () => {
  const bus = tmpBus()
  writeDisputeMeta(bus, meta('evidence'))
  const v = {
    outcome: 'decided' as const, headline: 'zhi 赢（按证据）', side: 'zhi', verdictBy: 'rule:evidence',
    reason: '按证据判', refs: [], atMs: T0,
    dispositions: [{ side: 'shao', verdict: 'unable' as const, note: '本侧 0 条可解析 ref' }],
    legacyNoDispositions: false,
  }
  assert.equal(writeDisputeVerdict(bus, 'a1', v), '')
  const again = writeDisputeVerdict(bus, 'a1', { ...v, side: 'shao' })
  assert.notEqual(again, '', '终局只能有一个')
  const { list } = loadDisputes(bus)
  assert.equal(list[0].verdict?.side, 'zhi') // 第一次的判词还在
})

test('D4 `dispute/` 不存在 ⇒ **空表且无 bad**（「空」不是错误）', () => {
  const bus = tmpBus()
  const { list, bad } = loadDisputes(bus)
  assert.equal(list.length, 0)
  assert.equal(bad.length, 0)
  assert.equal(existsSync(disputesRootOf(bus)), false)
})

test('D5 全貌读回：meta + 两侧主张 + 判词（主张按时间排序）', () => {
  const bus = tmpBus()
  writeDisputeMeta(bus, meta('evidence'))
  writeDisputeClaim(bus, 'a1', { by: 'shao', atMs: T0 + 10, text: 'b', refs: [] })
  writeDisputeClaim(bus, 'a1', { by: 'zhi', atMs: T0 + 5, text: 'a', refs: [] })
  writeDisputeVerdict(bus, 'a1', {
    outcome: 'escalated', headline: '我无权裁：两侧都无证据', side: '', verdictBy: '', reason: '两侧都无证据', refs: [], atMs: T0 + 20,
    dispositions: [
      { side: 'zhi', verdict: 'unable', note: '无判据可用' },
      { side: 'shao', verdict: 'unable', note: '无判据可用' },
    ],
    legacyNoDispositions: false,
  })
  const { list, bad } = loadDisputes(bus)
  assert.equal(bad.length, 0)
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].claims.map((c) => c.by), ['zhi', 'shao'])
  assert.equal(list[0].verdict?.outcome, 'escalated')
})

test('★★ D6 坏记录**不静默丢**：进 bad，且原文件原样留着（它本身是证据）', () => {
  const bus = tmpBus()
  writeDisputeMeta(bus, meta('evidence'))
  const p = join(disputeDirOf(bus, 'a1'), 'claim-broken.json')
  writeFileSync(p, '{这不是合法 JSON', 'utf8')
  const { bad } = loadDisputes(bus)
  assert.ok(bad.some((b) => b.includes('claim-broken.json')), '坏件必须报出来：' + JSON.stringify(bad))
  assert.equal(readFileSync(p, 'utf8'), '{这不是合法 JSON') // 原样保留
})

test('★★ D7 有主张没登记 ⇒ 进 bad（形态不全要报，不许假装它不存在）', () => {
  const bus = tmpBus()
  mkdirSync(join(disputesRootOf(bus), 'a9'), { recursive: true })
  writeFileSync(join(disputesRootOf(bus), 'a9', 'claim-zhi.json'), serializeDisputeClaim(claim('zhi', [])), 'utf8')
  const { list, bad } = loadDisputes(bus)
  assert.equal(list.length, 0)
  assert.ok(bad.some((b) => b.includes('没有合法 `meta.json`')), JSON.stringify(bad))
})

test('D8 不认识的文件名也要报（不静默跳过）', () => {
  const bus = tmpBus()
  writeDisputeMeta(bus, meta('evidence'))
  writeFileSync(join(disputeDirOf(bus, 'a1'), 'stray.json'), '{}', 'utf8')
  const { bad } = loadDisputes(bus)
  assert.ok(bad.some((b) => b.includes('不认识的文件名')), JSON.stringify(bad))
})

/* ── E · 渲染（两个数不合流）─────────────────────────────────────── */

test('E1 两个数都是 0 ⇒ 空串（一个字都不加）', () => {
  assert.equal(renderDisputeLine({ open: 0, escalated: 0 }), '')
})

test('★★ E2 「未裁」与「升级待人裁」**分开报**（合成一个数＝替读的人决定要不要管）', () => {
  const both = renderDisputeLine({ open: 2, escalated: 1 })
  const ls = both.split('\n')
  assert.equal(ls.length, 2)
  assert.match(ls[0], /未裁争议 2 条/)
  assert.match(ls[1], /升级待人裁 1 条/)
  // 只有一类时**不许**出现另一类的字眼（否则读数会撒谎）
  assert.equal(renderDisputeLine({ open: 1, escalated: 0 }).includes('升级'), false)
  assert.equal(renderDisputeLine({ open: 0, escalated: 1 }).includes('未裁'), false)
})

test('E3 规则的释义与闭集同名（渲染指路不许指到一个不存在的档）', () => {
  assert.equal(Object.keys(DISPUTE_RULE_LABEL).sort().join(','), 'evidence,role')
})

/* ── F · 处置清单（2026-10-12 · 由哨指出：「留了」≠「算了」）────────────── */
// 她的原话（逐字）：「判词把对方原话贴进去，不等于对它做了处置。只要求留，
//   判据量到的就是**『有没有引文』**，而不是**『有没有并立』**。」
// ⇒ 绑一条：**非赢家侧必须逐条被处置**（采纳 / 不采纳 / 无法裁）。

test('★★ decided：**每一侧**都必须被逐条处置（赢家侧也不例外 —— 哨问出来的那一格）', () => {
  const claims = [claim('zhi', []), claim('shao', [])]
  const e1 = validateDispositions('decided', 'zhi', claims, [])
  assert.notEqual(e1, '', '有主张却没处置时必须拒')
  assert.match(e1, /shao/, '拒的时候要点名缺的是哪一侧（否则读的人还得自己找）')
  assert.match(e1, /zhi/, '赢家侧也要被点名 —— 它同样需要一格')
  // ★ 只处置非赢家侧 ⇒ **仍要拒**：不写赢家侧，读的人会默认「赢家说的都成立」
  const e2 = validateDispositions('decided', 'zhi', claims, [{ side: 'shao', verdict: 'unable', note: 'r' }])
  assert.notEqual(e2, '', '只处置非赢家侧不够 —— **赢家侧的主张也得有处置**')
  assert.match(e2, /赢家/, '拒的时候要点明「缺的这一侧就是赢家」（否则当事人不知道该怎么补）')
  // 两侧都处置 ⇒ 通过
  assert.equal(validateDispositions('decided', 'zhi', claims, [
    { side: 'zhi', verdict: 'adopted', note: '这一侧的主张被采纳' },
    { side: 'shao', verdict: 'unable', note: '函数读不出对错' },
  ]), '')
  // 零主张 ⇒ 空清单合法（**没有东西可处置**，不是「漏了」）
  assert.equal(validateDispositions('decided', '', [], []), '')
})

test('★★ escalated：**每一侧**都要被处置（没人是赢家 ⇒ 没有豁免）', () => {
  const claims = [claim('zhi', []), claim('shao', [])]
  assert.notEqual(validateDispositions('escalated', '', claims, [{ side: 'zhi', verdict: 'unable', note: 'r' }]), '')
  assert.equal(validateDispositions('escalated', '', claims, [
    { side: 'zhi', verdict: 'unable', note: 'r' },
    { side: 'shao', verdict: 'unable', note: 'r' },
  ]), '')
})

test('★ 处置的三条硬规矩：不在场 / 空理由 / 重复', () => {
  const claims = [claim('zhi', []), claim('shao', [])]
  assert.match(validateDispositions('decided', 'zhi', claims, [{ side: 'nobody', verdict: 'unable', note: 'r' }]), /不是已登记/)
  assert.match(validateDispositions('decided', 'zhi', claims, [{ side: 'shao', verdict: 'unable', note: '  ' }]), /空理由/)
  assert.match(validateDispositions('decided', 'zhi', claims, [
    { side: 'shao', verdict: 'unable', note: 'r' }, { side: 'shao', verdict: 'adopted', note: 'r' },
  ]), /两次/)
})

test('★★ 闭集里**没有** `rejected`（驳倒）—— 「不采纳」与「驳倒」是两件事', () => {
  assert.deepEqual([...DISPOSITION_VERDICTS], ['adopted', 'not-adopted', 'unable'])
  assert.equal((DISPOSITION_VERDICTS as readonly string[]).includes('rejected'), false,
    '不许把「驳倒」塞进来 —— 当事人说的是「不采纳」，那是更弱的语义（同一形状：别把两个东西装进一个词）')
})

test('★★ 多行文本解析：任一行坏 ⇒ **整批拒**（不做部分接受）', () => {
  const good = parseDispositionsText('shao | unable | 无判据可用\nzhi | adopted | 采纳')
  assert.equal(good.bad.length, 0)
  assert.equal(good.list.length, 2)
  assert.equal(good.list[0]!.verdict, 'unable')
  // 坏行：只有两段
  assert.equal(parseDispositionsText('shao | unable').bad.length, 1)
  // 坏行：处置词不在闭集（`rejected` 正是那个**不该被接受**的词）
  assert.match(parseDispositionsText('shao | rejected | r').bad[0]!, /不在闭集/)
  // 坏行：空理由
  assert.match(parseDispositionsText('shao | unable |').bad[0]!, /缺理由/)
  // note 里允许竖线（只按前两个竖线切）
  const l = parseDispositionsText('shao | unable | a | b')
  assert.equal(l.bad.length, 0)
  assert.equal(l.list[0]!.note, 'a | b')
  // 空文本 ⇒ 空清单且无坏行（**这是「没给」，不是「坏了」**）
  assert.deepEqual(parseDispositionsText(''), { list: [], bad: [] })
  assert.deepEqual(parseDispositionsText(undefined), { list: [], bad: [] })
})

test('★ 渲染：空清单 ⇒ 空串；有清单 ⇒ 每一侧都出现（且 `not-adopted` 标注 ≠ 驳倒）', () => {
  assert.equal(renderDispositions([]), '')
  const s = renderDispositions([
    { side: 'shao', verdict: 'not-adopted', note: 'n1' },
    { side: 'zhi', verdict: 'adopted', note: 'n2' },
  ])
  assert.match(s, /shao/)
  assert.match(s, /zhi/)
  assert.match(s, /不采纳/)
  assert.match(s, /驳倒/, '`not-adopted` 的释义必须显式写明「≠ 驳倒」—— 否则它会被读成「你错了」')
})

test('★★ 函数产的判词必须自带完整处置（否则 rule=evidence 的判词永远过不了自己的校验）', () => {
  const claims = [claim('zhi', ['src/a.ts:1']), claim('shao', [])]
  const d = judgeDispute(meta('evidence'), claims, { refResolvable: resolvable })
  assert.equal(d.kind, 'decided')
  assert.equal(
    validateDispositions('decided', d.kind === 'decided' ? d.side : '', claims, d.dispositions), '',
    '函数自己产的处置必须通过它自己的校验 —— 否则它连一条合法判词都写不出来',
  )
  const esc = judgeDispute(meta('evidence'), [claim('zhi', []), claim('shao', [])], { refResolvable: resolvable })
  assert.equal(esc.kind, 'escalate')
  assert.equal(validateDispositions('escalated', '', claims, esc.dispositions), '')
  // ★ 函数产的两侧处置**分别**是 `adopted`（赢家侧）/ `unable`（其余侧）：
  //   给输的那侧 `not-adopted` 会是对它主张的**否定评价**，而函数根本没读过它的内容。
  const bySide: Record<string, string> = {}
  for (const dd of d.dispositions) bySide[dd.side] = dd.verdict
  assert.equal(bySide['zhi'], 'adopted', '★ 赢家侧也要有一格，且是 `adopted`（「这一侧的主张被采纳」）')
  assert.equal(bySide['shao'], 'unable', '★ 其余侧是 `unable` —— 函数只数证据的有无，读不出对错')
  // ★ 且赢家侧那格的 note 必须**自己说清** `adopted` 不等于「每句都对」
  const winnerNote = d.dispositions.find((x) => x.side === 'zhi')!.note
  assert.match(winnerNote, /采不采/, '赢家侧的 note 要写明 `adopted` 评价的是「采不采」，不是「对不对」')
})

/* ── G · 处置面的状态（2026-10-12 · 哨：缺格子的默认读法必须是「不可数」）── */
// 她的原话：「缺格子的**默认读法**必须是『**不可数**』，不能是『并立依旧成立』，
//   也不能是『无异议』……**空格的默认语义如果落在「没意见」，那条老判词就又被当成有内容的了**：
//   『并立』当时只是一句措辞这件事，**得由结构说，不是由注释说**。」

const verdictOf = (
  dispositions: Array<{ side: string; verdict: 'adopted' | 'not-adopted' | 'unable'; note: string }>,
  legacyNoDispositions: boolean,
) => ({
  outcome: 'decided' as const, headline: 'h', legacyNoHeadline: false, side: 'a', verdictBy: 'x',
  reason: 'r', refs: [], atMs: T0, dispositions, legacyNoDispositions,
})

test('★★★ 空 dispositions 的默认读法必须是「不可数」，**不是**「无异议」', () => {
  // ① 无判词 ⇒ `none`（**别读成**「无异议」）
  assert.equal(dispositionsStateOf(null, 2), 'none')
  // ② 老判词 ⇒ `legacy-unavailable`（如实：不可数）
  assert.equal(dispositionsStateOf(verdictOf([], true), 2), 'legacy-unavailable')
  // ③ ★ **尸体样本**：v3 判词 + 有主张 + 处置为空 ⇒ `missing`
  //    写侧本该拦（`validateDispositions`），但**直接调 store 能绕过工具**（成员织用过这条路径）
  assert.equal(dispositionsStateOf(verdictOf([], false), 2), 'missing',
    '★ 有主张却没有处置清单 ⇒ 必须读作「这一格本该有东西而它不在」，不许读成「无异议」')
  // ④ 有清单 ⇒ `complete`
  assert.equal(dispositionsStateOf(verdictOf([{ side: 'a', verdict: 'adopted', note: 'n' }], false), 2), 'complete')
  // ⑤ 零主张 ⇒ 空清单**合法**（没有东西可处置）—— 但**仍然不能**读成 `missing`
  assert.equal(dispositionsStateOf(verdictOf([], false), 0), 'complete', '零主张时没有东西可处置，空是正常的')
})

test('★★ 四种状态互不相同（否则「显式分型」就退化成同一个值 —— 那等于没分）', () => {
  const s = new Set<string>([
    dispositionsStateOf(null, 0),
    dispositionsStateOf(verdictOf([], true), 1),
    dispositionsStateOf(verdictOf([], false), 1),
    dispositionsStateOf(verdictOf([{ side: 'a', verdict: 'unable', note: 'n' }], false), 1),
  ])
  assert.equal(s.size, 4, '实际得到：' + [...s].join(' / '))
})

/* ── H. 痕迹对账（产物 ⟷ trace）──────────────────────────────────────
 * 由成员织的论点驱动：「『不许替对方写』只有在**写入路径唯一**时才是硬规矩」。
 * 现读核实：三处写入修前不落任何 trace ⇒ 「走正规路径」与「手搓 JSON」在盘上不可区分。
 * ⇒ 留痕 + 对账补的是**观测面**（拦不住人，只让「绕了路」有地方可看）。
 * ⚠ 本组最要紧的不是「能查出绕路」，而是**不许把两件不同的事说成同一件**：
 *   「无 trace」≠「有人在伪造」（还有 trace 写失败这一种解释）；
 *   「早于留痕」≠「无 trace」（前者是**不可判**，后者是**有读数**）。
 */

/**
 * trace 事件。★ 锚字段的**默认值是「没落锚」**（`-1` / `''`）——
 * ⚠ 这不是图方便：默认取「有锚」会让每一条**旧断言静默变成**在测锚；
 *   取「没落锚」恰好是**旧行的真实形态**，而要用锚的测试必须显式给（见 `evA`）。
 */
const ev = (op: string, artifactId: string, by: string, atMs: number) =>
  ({ op, artifactId, by, atMs, refsCount: -1, textDigest: '' })

/** 带锚的 trace 事件（**显式**给两层锚：`refs` 条数 + `text` 摘要）。 */
const evA = (
  op: string, artifactId: string, by: string, atMs: number, refsCount: number, textDigest: string,
) => ({ op, artifactId, by, atMs, refsCount, textDigest })

/**
 * 产物侧的一条主张。★ 锚要比 `text` 与 `refs` ⇒ 两者都是它的**一等字段**（不是可选装饰）：
 * 缺了它们，锚判定就只剩「问不出来」—— 那正是 `no-anchor`。
 */
const cl = (by: string, atMs: number, text = '主张', refs: string[] = []) => ({ by, atMs, text, refs })

/** trace 侧一行「名实相符」的 claim（锚由**被测的那份文本**算出 ⇒ 改它就必然 mismatch）。 */
const anchorEv = (artifactId: string, by: string, atMs: number, text: string, refs: string[]) =>
  evA('dispute-claim', artifactId, by, atMs, refs.length, digestOf(text))

/**
 * 「这条争议有 `open` 痕迹」的最小事件集 —— 新判据的**分档依据**。
 * ⚠ 它不是装饰：`openedWithTrace=false` 时**整条争议**都判 `unjudgeable`（分档单位是争议，不是单侧）。
 */
const opened = (artifactId: string) => [ev('dispute-open', artifactId, 'web-0', T0 - 1000)]

test('H1 有 open 且该侧有 claim 事件 ⇒ traced', () => {
  const a = auditClaimTraces(
    [cl('织', T0 + 100)],
    [...opened('a1'), ev('dispute-claim', 'a1', '织', T0 + 50)],
    'a1',
  )
  assert.equal(a.traced, 1)
  assert.equal(a.untraced, 0)
  assert.equal(a.unjudgeable, 0)
  assert.equal(a.openedWithTrace, true)
})

test('H2 ★ 有 open、该侧无 claim 事件 ⇒ untraced（**只报事实**）', () => {
  const a = auditClaimTraces(
    [cl('绕路者', T0 + 100)],
    [...opened('a1'), ev('dispute-claim', 'a1', '织', T0 + 50)],
    'a1',
  )
  assert.equal(a.untraced, 1)
  assert.equal(a.traced, 0)
})

test('H3 事件属于**别的争议** ⇒ 连「有 open」都不许借（不许跨 artifactId 认领）', () => {
  const a = auditClaimTraces(
    [cl('织', T0 + 100)],
    [ev('dispute-open', 'a2', 'web-0', T0 - 1000), ev('dispute-claim', 'a2', '织', T0 + 50)],
    'a1',
  )
  assert.equal(a.untraced, 0, '别的争议的 open 不能给这一条背书')
  assert.equal(a.unjudgeable, 1, '本争议没有 open ⇒ 整条不可判')
})

test('H4 非 claim 事件（只有 open/judge）⇒ 不算 claim 的痕迹', () => {
  const a = auditClaimTraces(
    [cl('织', T0 + 100)],
    [...opened('a1'), ev('dispute-judge', 'a1', '织', T0 + 150)],
    'a1',
  )
  assert.equal(a.untraced, 1)
})

test('H5 ★★ 没有任何 trace 事件 ⇒ **全部 unjudgeable**，不是 untraced', () => {
  const a = auditClaimTraces([cl('织', T0 + 100)], [], 'a1')
  assert.equal(a.unjudgeable, 1)
  assert.equal(a.untraced, 0, '★ 「读不到 trace」绝不能被读成「有人绕路」')
  assert.equal(a.openedWithTrace, false)
})

test('H6 ★★ 历史件：本争议**没有 open 痕迹** ⇒ 整条 unjudgeable（**不许把历史读成绕路**）', () => {
  // 真总线那条 `hold-recheck-sho` 正是这个形态：它留痕上线之前就开了。
  const a = auditClaimTraces(
    [cl('织', T0 - 5000), cl('哨', T0 - 4000)],
    [ev('dispute-claim', 'a1', 'web-0', T0)],
    'a1',
  )
  assert.equal(a.unjudgeable, 2)
  assert.equal(a.untraced, 0, '留痕上线前开的争议 ⇒ 它的主张按定义没有 trace ⇒ 不可判')
})

test('H7 ★ 对照组：有 open ⇒ 整条可判、无事件的那侧 untraced（证明 H6 不是「一律不可判」的恒真判据）', () => {
  const a = auditClaimTraces(
    [cl('织', T0 - 5000), cl('绕路者', T0 + 500)],
    [...opened('a1'), ev('dispute-claim', 'a1', 'web-0', T0)],
    'a1',
  )
  assert.equal(a.unjudgeable, 0, '有 open ⇒ 整条可判（时间早也不行 —— 时间不参与判据）')
  assert.equal(a.untraced, 2, '两侧都没有自己的 claim 事件')
  assert.equal(a.traced, 0)
})

test('★★★ 尸体（织复核 §2.2 的回归）：把 claim 的 `atMs` **伪造成很早** ⇒ 仍须 untraced', () => {
  // 旧实现用 `claim.atMs`（产物自报时间）分档 ⇒ 「今天手搓、再写成去年」的件自动获得历史件豁免。
  // 那**比不做分档更坏**：它把缺口**洗成了豁免**。新判据只看「有没有 open」，与任何时间无关。
  const faked = cl('绕路者', T0 - 99999999)
  const a = auditClaimTraces([faked], [...opened('a1'), ev('dispute-claim', 'a1', '织', T0 + 50)], 'a1')
  assert.equal(a.untraced, 1, '★ 时间可伪造 ⇒ 判据不许看时间')
  assert.equal(a.unjudgeable, 0, '伪造得再早也不许变成「历史件」')
})

test('H8 ★ 渲染：**有主张就一定有一行**（口径落读数处 · 织 §2.3 的落位判据）', () => {
  // ⚠ **行为变更（2026-10-12）**：原实现是「全 traced ⇒ 空串」。现在**有主张时始终出**——
  //   计数行 + 口径行。理由是可跑的（织 §2.3 的**切断测试 D1**）：一条读数被单独摘走时，
  //   块内必须能自证它的域 —— 而「被摘走」正是这个读数最常被消费的形态（贴进裁决/文档/信）。
  //   ⚠ 旧行为（空串）会让人分不清「跑了、没发现问题」与「根本没跑」—— 这两种状态对
  //     下一步的动作完全不同（同 `renderDisputeLine` 的纪律）。
  // ★ 这里用**带锚的**事件（`anchorEv`）而不是裸 `ev`：裸 `ev` 是「没落锚」，
  //   那本身就是一个要显式说出来的状态。本具测的才是**真·一切正常** ⇒ 断言里不许有 ⚠。
  const a = auditClaimTraces([cl('织', T0 + 100, '原话', [])],
    [...opened('a1'), anchorEv('a1', '织', T0 + 50, '原话', [])], 'a1')
  const s = renderTraceAudit(a)
  assert.match(s, /痕迹对账/, '对过账就要报结果，哪怕结果是「没问题」')
  assert.match(s, /口径/, '★ 口径必须与读数同体（切断后那块要能自证域）')
  assert.equal(s.includes('⚠'), false, '没问题时不许用 ⚠（否则它会退化成一段每次都被跳过的噪音）')
})

test('H9 渲染：零主张 ⇒ 空串（没有东西可对账，不是「对完没问题」）', () => {
  assert.equal(renderTraceAudit(auditClaimTraces([], [], 'a1')), '')
})

test('H10 ★★ 渲染 untraced ⇒ 必须同时说出「两种解释、不可区分、不指控」', () => {
  const a = auditClaimTraces([cl('绕路者', T0 + 100)], [...opened('a1'), ev('dispute-claim', 'a1', '织', T0 + 50)], 'a1')
  const s = renderTraceAudit(a)
  assert.match(s, /无 trace/)
  assert.match(s, /绕路者/, '必须点名是哪一侧（否则读数落不到人）')
  assert.match(s, /不可区分/, '★ 判据只报事实：手搓与 trace 写失败在这里分不开')
  assert.match(s, /不指控/)
})

test('★★★ H10b（织 §2.1 · **随锚上线改过一次**）：渲染必须写明「只声称存在性」+「内容级那一半由锚管」', () => {
  // ★ 这具断言改过的**理由本身就是证据**：旧文案写「要抓内容改动，trace 里得落内容锚 ——
  //   这一版**没有**」；加锚之后那句话**变成了假话** ⇒ 文案与实现必须同一次改，
  //   否则读的人会按旧文案判断能力（与「仪器更新了、文案没跟上」同一形状）。
  const a = auditClaimTraces([cl('绕路者', T0 + 100)], [...opened('a1'), ev('dispute-claim', 'a1', '织', T0 + 50)], 'a1')
  const s = renderTraceAudit(a)
  assert.match(s, /只声称「存在性」/, '★ 不写这句，读的人会把存在性对账读成内容对账')
  assert.match(s, /锚/, '内容级那一半由锚管 —— 要如实说它现在**有**（不是「这一版没有」）')
  assert.match(s, /三个都是名字/, '对账的键全是名字这件事要说出来（不然「为什么抓不到内容」无从理解）')
})

test('H11 渲染 unjudgeable **不**带 ⚠（它是固有属性，不是告警）', () => {
  const a = auditClaimTraces([cl('织', T0 - 100)], [ev('dispute-claim', 'a1', 'web-0', T0)], 'a1')
  const s = renderTraceAudit(a)
  assert.match(s, /留痕之前/)
  assert.match(s, /问不出来/, '措辞要说清「不可判」不是「没问题」')
  assert.equal(s.includes('⚠'), false, '历史件不是故障 —— 用 ⚠ 会把它读成告警')
})

test('H12 三种 verdict 各自可达（闭集完整性）', () => {
  // ⚠ 三种**不能在同一条争议里同时出现**：分档是整条争议级的（有 open 就全都可判）。
  const claims = [cl('a', T0 + 100)]
  const vTraced = auditClaimTraces(claims, [...opened('a1'), ev('dispute-claim', 'a1', 'a', T0)], 'a1').rows[0]?.verdict
  const vUntraced = auditClaimTraces(claims, [...opened('a1'), ev('dispute-claim', 'a1', '别人', T0)], 'a1').rows[0]?.verdict
  const vUnjudgeable = auditClaimTraces(claims, [], 'a1').rows[0]?.verdict
  assert.deepEqual([vTraced, vUntraced, vUnjudgeable], ['traced', 'untraced', 'unjudgeable'])
})

/* ── I. trace 读取（IO）────────────────────────────────────────────── */

test('I1 ★ 文件不存在 ⇒ missing=true（**与「文件在但空」分开**）', () => {
  const bus = tmpBus()
  const t = loadDisputeTrace(bus)
  assert.equal(t.missing, true)
  assert.deepEqual(t.events, [])
})

test('I2 空文件 ⇒ missing=false 且零事件（上线了、还没人写过）', () => {
  const bus = tmpBus()
  writeFileSync(join(bus, DISPUTE_TRACE_FILE), '', 'utf8')
  const t = loadDisputeTrace(bus)
  assert.equal(t.missing, false)
  assert.equal(t.events.length, 0)
})

test('I3 正常读取：三行三个 op 都认', () => {
  const bus = tmpBus()
  writeFileSync(join(bus, DISPUTE_TRACE_FILE), [
    JSON.stringify({ atMs: T0, by: 'web-0', op: 'dispute-open', artifactId: 'a1', rule: 'role' }),
    JSON.stringify({ atMs: T0 + 1, by: '织', op: 'dispute-claim', artifactId: 'a1', refs: 2 }),
    JSON.stringify({ atMs: T0 + 2, by: 'web-0', op: 'dispute-judge', artifactId: 'a1', outcome: 'decided' }),
  ].join('\n') + '\n', 'utf8')
  const t = loadDisputeTrace(bus)
  assert.equal(t.events.length, 3)
  assert.equal(t.broken, 0)
  assert.deepEqual(t.events.map((e) => e.op), ['dispute-open', 'dispute-claim', 'dispute-judge'])
})

test('I4 ★ 坏行进 broken 而**不抛**（一行坏不该带塌整份 trace）', () => {
  const bus = tmpBus()
  writeFileSync(join(bus, DISPUTE_TRACE_FILE), [
    '{ 这不是 JSON',
    JSON.stringify({ atMs: T0, by: 'web-0', op: 'dispute-open', artifactId: 'a1' }),
    JSON.stringify({ atMs: T0, by: 'web-0', op: 'dispute-open' }), // 缺 artifactId ⇒ 不可对账
    '[]',
  ].join('\n'), 'utf8')
  const t = loadDisputeTrace(bus)
  assert.equal(t.events.length, 1)
  assert.equal(t.broken, 3, '坏 JSON / 缺字段 / 数组，三个都该进 broken')
})

test('I5 ★ 端到端：写一条 claim ⇒ 它能被对账认出来（写侧与读侧同一份事实）', () => {
  const bus = tmpBus()
  writeDisputeMeta(bus, meta('role', 'a1'))
  const c = { by: '织', atMs: Date.now(), text: '主张', refs: [] }
  writeDisputeClaim(bus, 'a1', c)
  // trace 由**工具层**写（本测试直接调 store ⇒ 它不会写 trace）⇒ 这正是「绕路」的形态
  const t = loadDisputeTrace(bus)
  const a = auditClaimTraces([c], t.events, 'a1')
  assert.equal(a.unjudgeable, 1, '没有 trace 文件 ⇒ 不可判（而**不是** untraced）')
  // 补两行 trace（**必须先有 open** —— 分档依据）⇒ 同一份产物立刻变成 traced
  writeFileSync(join(bus, DISPUTE_TRACE_FILE), [
    JSON.stringify({ atMs: c.atMs - 100, by: 'web-0', op: 'dispute-open', artifactId: 'a1' }),
    JSON.stringify({ atMs: c.atMs - 1, by: '织', op: 'dispute-claim', artifactId: 'a1' }),
  ].join('\n') + '\n', 'utf8')
  const t2 = loadDisputeTrace(bus)
  const a2 = auditClaimTraces([c], t2.events, 'a1')
  assert.equal(a2.traced, 1)
  assert.equal(a2.openedWithTrace, true)
  // ★ 反向：只有 claim 行、**没有 open** ⇒ 仍不可判（证明分档真的看 open，不是「有事件就算」）
  writeFileSync(join(bus, DISPUTE_TRACE_FILE),
    JSON.stringify({ atMs: c.atMs - 1, by: '织', op: 'dispute-claim', artifactId: 'a1' }) + '\n', 'utf8')
  const t3 = loadDisputeTrace(bus)
  assert.equal(auditClaimTraces([c], t3.events, 'a1').unjudgeable, 1,
    '没有 open ⇒ 整条争议不可判（它可能是留痕前开的）')
})

/* ── J. 内容锚（产物自 trace 落笔以来有没有被改）──────────────────────
 * 由成员织第三轮答复驱动（`_review/trace-anchor-sumi.md`，我逐条核过后采纳）。
 * 名字级对账有两个敞口：
 *   ① **事前伪造** —— 手搓者照自己的产物算好摘要再一起写 ⇒ 锚**拦不住**（她的边界①）；
 *   ② **事后篡改** —— 走正规路径写好之后**再改产物** ⇒ 名字级**完全看不见**。
 * 本组测的是 ②。
 * ★★ 两具尸体的**分工必须分开**（否则各自的栏就是恒不亮的装饰）：
 *   · 只改 `text` ⇒ **只有** `textDigest` 亮（`refsCount` 恒静默）
 *   · 只改 `refs` 条数 ⇒ **只有** `refsCount` 亮（`textDigest` 不亮）
 *   —— 后者是 `refsCount` 的**准入条件**（织 §3.5（一））；顺序也不能换。
 */

test('J1 名实相符 ⇒ anchored（两层锚都一致）', () => {
  const c = cl('织', T0 + 100, '原话', ['a.md:1', 'b.md:2'])
  const a = auditClaimTraces([c], [...opened('a1'), anchorEv('a1', '织', T0 + 50, '原话', ['a.md:1', 'b.md:2'])], 'a1')
  assert.equal(a.anchored, 1)
  assert.equal(a.mismatch, 0)
  assert.deepEqual(a.rows[0]?.anchorFields, [])
})

test('★★★ J2 第二具尸体（改 `text`、不动 `by`、不动条数）⇒ **必须** mismatch，且只有 `textDigest` 亮', () => {
  // ★ 这具是织 §2.3 指定的那具 —— 它是 `textDigest` **唯一**的区分力来源：
  //   缺了它，「锚能抓内容改动」这句话就没有任何读数在支撑。
  const c = cl('织', T0 + 100, '改过的话', []) // ← 产物侧已被改
  const a = auditClaimTraces([c], [...opened('a1'), anchorEv('a1', '织', T0 + 50, '原话', [])], 'a1')
  assert.equal(a.mismatch, 1, '★ 说好的「改 text 会亮」必须真的亮')
  assert.deepEqual(a.rows[0]?.anchorFields, ['textDigest'], '且必须是 textDigest 那一栏')
  assert.equal(a.rows[0]?.verdict, 'traced', '名字仍对得上 —— 名字级**永远看不见**这次改动')
})

test('★★★ J3 `refsCount` 的**准入条件**：只改条数、`text` 一字不动 ⇒ 只有 `refsCount` 亮', () => {
  // ★ 不写这具，`refsCount` 就是一个**恒不亮的字段**（织 §3.5（一）：按「恒为空的输出
  //   不是证据」，它就不该进产物）。顺序也不能换 —— `textDigest` 先亮，
  //   `refsCount` 才看得到自己那一格 ⇒ 这里 `text` 必须**逐字相同**。
  const same = '原话一字不动'
  const c = cl('织', T0 + 100, same, ['a.md:1']) // 产物 1 条
  const a = auditClaimTraces([c], [...opened('a1'), anchorEv('a1', '织', T0 + 50, same, ['a.md:1', 'b.md:2'])], 'a1')
  assert.equal(a.mismatch, 1)
  assert.deepEqual(a.rows[0]?.anchorFields, ['refsCount'], '★ 必须**只有** refsCount（证明 textDigest 没在替它亮）')
})

test('J4 ★ 缺锚字段 ⇒ `no-anchor`（**不是** anchored）—— 「缺字段就是缺，不许有默认值」', () => {
  // 这正是**旧行**的形态：`ev()` 的默认锚值就是 `-1` / `''`。
  const c = cl('织', T0 + 100, '原话', ['a.md:1'])
  const a = auditClaimTraces([c], [...opened('a1'), ev('dispute-claim', 'a1', '织', T0 + 50)], 'a1')
  assert.equal(a.noAnchor, 1)
  assert.equal(a.anchored, 0, '★ 「读不到」绝不能被洗成「一致」')
  assert.equal(a.mismatch, 0, '★ 也不是「不一致」—— 是这个问题在这里问不出来')
  assert.equal(a.rows[0]?.verdict, 'traced', '名字对得上（锚是**另一层**判据）')
})

test('J5 ★ 没有 trace 行 ⇒ 锚一并是 no-anchor（连锚的来源都没有），但**不进 `noAnchor` 计数**', () => {
  const a = auditClaimTraces([cl('绕路者', T0 + 100, 'x', [])], [...opened('a1'), ev('dispute-claim', 'a1', '织', T0 + 50)], 'a1')
  assert.equal(a.rows[0]?.verdict, 'untraced')
  assert.equal(a.rows[0]?.anchor, 'no-anchor')
  assert.equal(a.noAnchor, 0, '⚠ 口径：`noAnchor` 只数「名字对上了、但那行没落锚」—— 否则这个数会虚高')
})

test('J6 ★ 渲染 mismatch ⇒ 必须说清「哪一栏」+「不指控是哪一侧被改」', () => {
  const c = cl('织', T0 + 100, '改过', [])
  const a = auditClaimTraces([c], [...opened('a1'), anchorEv('a1', '织', T0 + 50, '原话', [])], 'a1')
  const s = renderTraceAudit(a)
  assert.match(s, /锚对不上/)
  assert.match(s, /textDigest/, '要说清是哪一栏（否则读的人只能猜是哪一半被动过）')
  assert.match(s, /不指控/, '★ 同「无 trace」：改产物会 mismatch，改/伪造 trace 行**也会**')
})

test('J7 ★ 域：`open`/`judge` 行**不进**锚栏（它们本来就不带锚，不是「缺锚」）', () => {
  // 直答织 §1.2 的顾虑：她担心 `judge` 行恒出 `no-anchor` 被读成「有东西没锚上」。
  // 按本实现，锚判定**只对 `dispute-claim` 行发生**（`ANCHOR_SCOPE_OP`）⇒ 那两行不进这一栏。
  const c = cl('织', T0 + 100, '原话', [])
  const a = auditClaimTraces([c], [
    ...opened('a1'), ev('dispute-judge', 'a1', 'web-0', T0 + 900), anchorEv('a1', '织', T0 + 50, '原话', []),
  ], 'a1')
  assert.equal(a.noAnchor, 0, '★ judge 行不带锚 ⇒ 不许被读成「缺锚」')
  assert.equal(a.anchored, 1)
})

test('J8 ★★ KNOWN_GAP（B2 · 断言的是**当下事实**）：手搓者追一行**带自算摘要**的 trace ⇒ 锚也救不了', () => {
  // ★ 这是**缺口登记**，不是「实现正确」的断言 —— 它断言的是**现状**。
  //   ⇒ 将来真把它修好时**这条会红**，而那时的正确动作是**把它改成断言 `mismatch`**
  //     （红就是「该来更新台账了」，不是「构建被卡住」）。
  //   为什么必须写成断言而不是注释（织 §5.3，我认）：**缺口登记要能被复查** ——
  //     写在注释里的缺口，3 个月后与「没人发现过」不可区分；写成断言则每次构建都读到它。
  //   根因（她的边界①）：手搓者**一开始**就照自己的产物算好摘要再写进 trace
  //     ⇒ 两侧天然自洽 —— **锚只防事后改动，不防事前伪造**。
  const forged = '手搓的主张'
  const a = auditClaimTraces([cl('绕路者', T0 + 100, forged, [])], [
    ...opened('a1'),
    anchorEv('a1', '绕路者', T0 + 50, forged, []), // ← 伪造者**自己**算的摘要
  ], 'a1')
  assert.equal(a.traced, 1, '缺口①：追一行自写记录 ⇒ 名字对账被洗白')
  assert.equal(a.anchored, 1, '缺口②：那行带自算摘要 ⇒ **锚也一致**')
  assert.equal(a.mismatch, 0)
})
