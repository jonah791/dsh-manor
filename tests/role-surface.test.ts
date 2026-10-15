/**
 * 工具面分档（`role: host | member`）—— 由 E12 暴露出的真障碍（2026-10-12）。
 *
 * 背景：成员跑在**独立数据面**（`--dsHome E:\alice-nodes\maid-0N\.dsh`），profile **没挂 `dsh-manor`**
 * ⇒ 「不注册」对她们等于「**工具不存在**」；而 E12 的「独占型必须先举手」举手的正是她们。
 *
 * ★ 本文件的判据设计要点：**工具名从 `src/index.ts` 源码现算**（正则提取 `name: 'manor_xxx'`），
 *   而不是手写一份清单 —— 手写清单会漂移，而漂移的后果是**某个管理工具静默出现在成员面前**，
 *   或者某个成员工具**永远不可见**（一个错字就够）。「现算」让这条判据跟着源码走。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HOST_ONLY_TOOLS, MEMBER_TOOLS, guideLine, roleCaps, toolsForRole } from '../src/index.ts'
import { invisibleToolMentions } from '../src/envelope.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')

/** 从源码里现算全部工具名（`defineTool({ name: 'manor_xxx'`）。 */
function allToolNames(): string[] {
  const out: string[] = []
  for (const m of SRC.matchAll(/name:\s*'(manor_[a-z_]+)'/g)) {
    const n = m[1]!
    if (!out.includes(n)) out.push(n)
  }
  return out
}

test('★ 源码里真能现算出工具名（否则本文件的其余判据全在空跑）', () => {
  const names = allToolNames()
  assert.ok(names.length >= 10, '现算出 ' + String(names.length) + ' 个 —— 太少，正则应已失效')
  assert.ok(names.includes('manor_claim'), '连 manor_claim 都没现算出来')
})

test('host 档 ⇒ 全部（现有行为零回归）', () => {
  const all = allToolNames()
  assert.deepEqual(toolsForRole('host', all), all)
})

test('member 档 ⇒ 恰好是白名单里的那几个，且**每个名字都真实存在**', () => {
  const all = allToolNames()
  const got = toolsForRole('member', all)
  // ★ 判**集合**不判顺序：返回顺序由 `toolsForRole` 过滤 `all` 得来（= 源码里的定义序），
  //   那是**实现的**，不是**行为**。断言顺序 = 把实现写进判据（同一天在
  //   `scripts/readme-claim-verify.mjs` 的 selftest 上刚踩过同一个坑）。
  assert.deepEqual([...got].sort(), [...MEMBER_TOOLS].sort())
  for (const n of MEMBER_TOOLS) {
    assert.ok(all.includes(n), '★ `MEMBER_TOOLS` 里的 `' + n + '` 在源码里不存在 —— 一个错字就让它永远不可见')
  }
})

test('★ 管理动作**一律不得进 member 档**（成员能踢人 = 权限越界）', () => {
  const all = allToolNames()
  const got = new Set(toolsForRole('member', all))
  for (const banned of ['manor_hire', 'manor_retire', 'manor_assign', 'manor_wake', 'manor_patrol']) {
    assert.equal(got.has(banned), false, banned + ' 不该出现在成员工具面里')
  }
})

test('★ 白名单是 fail-closed：**新工具**（不在表里）对成员默认不可见', () => {
  const all = [...allToolNames(), 'manor_some_future_admin_tool']
  const got = toolsForRole('member', all)
  assert.equal(got.includes('manor_some_future_admin_tool'), false, '新增工具默认对成员不可见')
  assert.equal(toolsForRole('host', all).includes('manor_some_future_admin_tool'), true, 'host 档照常给')
})

test('★ E12 的本体必须在成员面上（否则这一轮的工具等于没做）', () => {
  const got = toolsForRole('member', allToolNames())
  assert.ok(got.includes('manor_claim'), '成员必须能举手')
  assert.ok(got.includes('manor_release'), '成员必须能放下')
})

// ────────── 后台循环的角色分档（2026-10-12 · 挂载成员**之前**发现的第二层） ──────────
// 由来：工具面收窄了，**定时器照起** —— 成员挂上本插件后每个进程都会跑存活巡检（每 5 分钟）
// 与依赖释放（每 60 秒）。⇒ N 个 owner。这正是 §5.19 的违规形状，且**症状是外部的**：
// 一个成员可能被拉起两次、失败告警重复送给主人、`patrolState` 被并发写导致退避计数失真。

test('★ 后台循环只有 host 承载（§5.19 单点所有权）', () => {
  assert.equal(roleCaps('member').backgroundLoops, false, '成员**不得**承载后台循环')
  assert.equal(roleCaps('host').backgroundLoops, true, 'host 是后台循环的 owner')
})

test('★ 工具面与后台循环**同一个判据**（改一处两处都动）', () => {
  // 工具的来源必须就是 `roleCaps` 里那一份（同一引用）——不是另抄一份清单。
  assert.equal(roleCaps('member').tools, MEMBER_TOOLS, '成员工具面必须直接引用 MEMBER_TOOLS，不许另抄')
  assert.equal(roleCaps('host').tools, null, 'host = 全部（null 表示不设白名单）')
})

test('★ 源码级：每个 setInterval 的守卫都要带 backgroundLoops（新定时器忘门控 = 静默多 owner）', () => {
  const hits = [...SRC.matchAll(/setInterval\(/g)].map((m) => m.index!)
  assert.ok(hits.length >= 2, '只现算出 ' + String(hits.length) + ' 处 setInterval —— 正则失效或定时器被删')

  for (const i of hits) {
    const start = SRC.lastIndexOf('if (', i)
    const span = i - start
    // ★ 不判「定位失败」就断言，会让判据在窗口滑走时**静默变松**（取到很远的旧守卫也照样含关键字）。
    assert.ok(span > 0 && span <= 600,
      '第 ' + String(i) + ' 处 setInterval 的守卫定位失败（区间 ' + String(span) + ' 字节）—— 先修本判据，别信它的绿')

    const guard = SRC.slice(start, i)
    assert.match(guard, /backgroundLoops/,
      '第 ' + String(i) + ' 字节处的 setInterval 守卫里没有 backgroundLoops —— '
      + '成员挂上后会成为第二个 owner（N 个进程同时拉人 + 重复告警）。守卫原文：' + guard.slice(0, 140))
  }
})

// ────────── 指路文案的角色分档（2026-10-12 · 织在试点验收里实测抓出） ──────────
// 缺陷形状：工具面收窄了、**文案照旧** —— `manor_find` 尾部推荐 `manor_dispatch` / `manor_wake`，
// 而这两个工具成员根本调不到。它**不产生任何异常**：测试全绿、工具全部正常、心跳照跳，
// 只有**当事人读到**才会发现。⇒ 「分档」的宾语集 = 工具面 + 后台循环 + **给当事人看的文案**。

test('★ 成员档指路文案不得推荐她调不到的工具', () => {
  // `manor_roster` 是**显式例外**：它来自 `dsh-agent-nodeforge`（不在本插件的工具面里）。
  const allowed = new Set<string>(['manor_roster', ...MEMBER_TOOLS])
  const names = [...guideLine('member').matchAll(/manor_[a-z_]+/g)].map((m) => m[0])
  assert.ok(names.length >= 1, '文案里一个工具名都没抽到 —— 正则失效，本判据在空跑')
  for (const n of names) {
    assert.ok(allowed.has(n), '成员档文案推荐了 `' + n + '`，而她的工具面里没有它')
  }
})

test('★ host 档指路文案照旧（零回归），且推荐的都是本插件真有的工具', () => {
  const line = guideLine('host')
  assert.match(line, /manor_dispatch/, 'host 档必须保留「派活用 manor_dispatch」')
  assert.match(line, /manor_wake/, 'host 档必须保留「起成员用 manor_wake」')
  const all = new Set(allToolNames())
  for (const m of line.matchAll(/manor_[a-z_]+/g)) {
    const n = m[0]
    if (n === 'manor_roster') continue // nodeforge 的，同上
    assert.ok(all.has(n), 'host 档文案里的 `' + n + '` 在本插件里不存在（错字会让她白找一遍）')
  }
})

// ────────── 工具归类完备性（2026-10-12 · **由一次真实失败驱动**）──────────
// 缺陷形状：`MEMBER_TOOLS` 是**白名单**（fail-closed）⇒ 新工具**默认对成员不可见**。
// 这个默认**是对的**，但它有**一半缺口**：**「默认不可见」与「有人确认过这是有意的」是两件事**。
// 实测代价：`manor_dispute` 落地后没同步白名单 ⇒ 派给 maid-05 的活 **200 秒后被杀**
// （台账 `failed/timeout`），而**没有任何机制报过警**（工具注册正常、心跳正常、当时测试全绿）。
// ⇒ 补法不是「记得改白名单」，而是让**「没归类」变成一个测试失败**。

test('★★ 每个工具都必须被显式归类（member 可见 / host 专属）—— 并集=全部，且两清单不相交', () => {
  const all = allToolNames()
  const member = new Set(MEMBER_TOOLS)
  const hostOnly = new Set(HOST_ONLY_TOOLS)
  // ① 不相交（同一个决定不许有两个落点）
  for (const n of member) {
    assert.equal(hostOnly.has(n), false, '`' + n + '` 同时出现在两个清单里 —— 同一个决定两个落点')
  }
  // ② 并集 = 全部（**这条才是抓「新工具没归类」的那一条**）
  const classified = new Set<string>([...member, ...hostOnly])
  const unclassified = all.filter((n) => !classified.has(n))
  assert.deepEqual(unclassified, [],
    '★ 这些工具**没被归类**：' + unclassified.join(' · ')
    + ' ⇒ 请显式决定它对成员可见还是 host 专属。**「默认不可见」不是一个答案，是一个静默的决定**'
    + ' —— 它已经害过一次：`manor_dispute` 落地后没归类，派给 maid-05 的活 200 秒后被杀。')
  // ③ 反向：清单里的名字必须真实存在（错字 ⇒ 那个工具永远不可见）
  for (const n of [...member, ...hostOnly]) {
    assert.ok(all.includes(n), '清单里的 `' + n + '` 在源码里不存在（错字 ⇒ 它永远不可见）')
  }
})

test('★ 本轮根因的回填：`manor_dispute` 必须在 member 档（否则当事人写不了主张）', () => {
  const got = toolsForRole('member', allToolNames())
  assert.ok(got.includes('manor_dispute'),
    '争议机制的核心就是「**每一侧自己写自己那份**」 —— 成员看不见它，整套机制对当事人等于不存在')
})

// ────────── 派活侧：她看不看得见我让她用的工具（同一次失败的另一半）──────────

test('★★ 派活正文提到的工具若成员看不见 ⇒ 必须报出来（`invisibleToolMentions`）', () => {
  const visible = new Set(toolsForRole('member', allToolNames()))
  // 反例（本轮实测形状）：让她调一个 host 专属工具
  assert.deepEqual(invisibleToolMentions('请执行 `manor_dispatch ...` 派一条活', visible), ['manor_dispatch'])
  // 正例：她自己有的工具，不报
  assert.deepEqual(invisibleToolMentions('请执行 `manor_dispute action=claim ...`', visible), [])
  // 去重保序
  assert.deepEqual(invisibleToolMentions('`manor_wake` 与 `manor_wake` 与 `manor_patrol`', visible), ['manor_wake', 'manor_patrol'])
  // 取宽：没提任何工具 ⇒ 空（不许把没提到的也算进来）
  assert.deepEqual(invisibleToolMentions('请把结果写进 done/ 目录', visible), [])
  // 判据不许恒空：至少证明它**真的会报**
  assert.ok(invisibleToolMentions('`manor_wake`', visible).length > 0, '这条判据恒为空 = 没有分辨力')
})

// ────────── 判据的作用域：必须钉**跑着的那份**（2026-10-12 · 由织当场指出）──────────
// 她的原话（逐字）：
//   「插件自己的判据 `tests/role-surface.test.ts` 是**从 src 正则现算**再断言白名单 ⊆ 源码名
//    —— **它只钉源，不钉构建产物**。lib 落后于源时，套件照样全绿。
//     这一格是「判据的作用域」问题，跟 10-11 那次 `reason` 判据是**同一个形状**
//     （判据的输入不是生产的那个对象）。」
// 实测代价：`src` 已含 `manor_dispute` 而 `lib/index.js` 还是 3 项 ⇒ 成员侧调不到
// ⇒ 派给她的活 **200 秒后被杀**，而**套件全绿**（其余断言测的是源，生产跑的是 lib）。

/** 从构建产物里抽出成员白名单（纯函数 ⇒ 可喂尸体样本）。`null` = 找不到（正则失效或产物形态变了）。 */
export function memberToolsInBundle(text: string): string[] | null {
  const m = /export const MEMBER_TOOLS = \[([^\]]*)\]/.exec(text)
  if (m === null) return null
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

test('★ 尸体：产物抽取器在「落后一版」的样本上必须抽出**不同的**结果（证明它有分辨力）', () => {
  const srcSide = "export const MEMBER_TOOLS = ['manor_claim', 'manor_release', 'manor_find', 'manor_dispute'];"
  const stale = "export const MEMBER_TOOLS = ['manor_claim', 'manor_release', 'manor_find'];"
  assert.deepEqual(memberToolsInBundle(srcSide), MEMBER_TOOLS)
  const got = memberToolsInBundle(stale)
  assert.notDeepEqual(got, MEMBER_TOOLS, '★ 这条抽取器若在落后样本上也返回同一个结果，它就是恒真的（没有分辨力）')
  assert.equal(memberToolsInBundle('var nothing = 1'), null, '找不到时必须返回 null，不许假装抽出空表')
})

test('★★ 生产那一份（lib/index.js）的成员白名单必须与源一致 —— 判据的输入必须是**生产的对象**', () => {
  const libPath = join(HERE, '..', 'lib', 'index.js')
  assert.ok(existsSync(libPath), 'lib/index.js 不存在 ⇒ 先 `npm run build`（本判据的前提是产物存在）')
  const got = memberToolsInBundle(readFileSync(libPath, 'utf8'))
  assert.notEqual(got, null, '在 lib/index.js 里找不到 MEMBER_TOOLS 的导出 —— 正则失效或产物形态变了')
  assert.deepEqual([...got!].sort(), [...MEMBER_TOOLS].sort(),
    '★ **产物落后于源**：lib 里的成员白名单与 src 不一致 ⇒ 改了源码但**没重新 build**（或 build 失败被忽略）。'
    + '**症状**：host 侧一切正常、其余测试全绿，而**成员侧调不到那个新工具** —— '
    + '实测代价是派给 maid-05 的活 200 秒后被杀。'
    + '\n  lib=[' + got!.join(', ') + ']  src=[' + MEMBER_TOOLS.join(', ') + ']')
})

test('★★ 源码里不得硬编码「成员档可见清单」（必须现算 —— 织 2026-10-12 反问抓出）', () => {
  // 缺陷形状：`manor_dispute action=open` 的渲染里曾写死一行
  //   「成员档今天可见：`manor_claim` · `manor_release` · `manor_find` · `manor_dispute`」
  // ⇒ 加一个成员工具它就过期 —— **形状与「同一个决定两个落点」一模一样，只是高了一层**。
  //   她的原话：「若是后者，它自己就会开始漂 —— 形状和我们刚合上的那个一模一样，只是高了一层。」
  // ★ **先剥注释再扫**（2026-10-12 · 本判据**第一次运行就误报**）：我在同一个改动里写了注释
  //   解释「第一版曾硬编码」，而注释里**逐字引用了那个坏形状** ⇒ 判据被自己的解释文案击穿。
  //   **同形状当日第五次**；修法固定是「收窄输入域」——这里 = 剥掉注释，只扫代码。
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  // 证明剥注释**真的生效** —— 否则上面那条判据仍被注释击穿，只是这次恰好没匹配到。
  assert.equal(/第一版这里是一行硬编码/.test(CODE), false, '剥注释没生效：注释内容仍在输入域里')
  const bad = /可见[：:][^\n]{0,20}`manor_/.exec(CODE)
  assert.equal(bad, null,
    '源码里出现了硬编码的「可见清单」（匹配：' + String(bad === null ? '' : bad[0]) + '）—— '
    + '它会长漂：加一个成员工具就过期。**要用 `toolsForRole(...)` 现算**。')
  // ★ 反向对照：现算的写法必须真的存在 —— 否则这条判据可能只是「恰好没人写死」，
  //   而不是「该现算的地方在现算」。**一条只会不响的判据没有分辨力。**
  assert.match(SRC, /toolsForRole\('member', allTools\.map/,
    '现算的调用点不见了 —— 确认改动没把现算那行一起删掉（那样上面那条会因为「没写死」而误绿）')
})
