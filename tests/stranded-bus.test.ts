/**
 * 总线全域搁浅件（`stranded-bus.ts`）离线测试 —— `E14`。
 *
 * 核心尸体（缺一就是假绿）：
 *   ① **空 ⇒ 空串**（一个字都不加；与搁浅块同纪律）
 *   ② **名册读不到 ⇒ 不作判**（照报件数，但「哪些箱有消费者」标**未知** ——
 *      「读不到」不是「都没有」，这条今天已栽过一次）
 *   ③ **两格必须分开**：有消费者（会被搭车取走）/ 没有消费者（**要处置的是箱**）
 *   ④ ★ **第三格必须显形**（织按住的那格）：箱的决定做完后**件的落点还要跟一次** ——
 *      否则「箱没了」会把「件去哪」一起吞掉（**另一种不可见面**）
 *   ⑤ 排序是「**有没有内容**」不是「**重要性**」（重要性归人，本层不代填）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyBoxes,
  classifyDelivery,
  deliveryNote,
  divergenceNote,
  renderStrandedBus,
  DELIVERY_FACES,
  type BusBox,
  type DeliveryFace,
} from '../src/stranded-bus.ts'

const T0 = 1_790_000_000_000
const H = 3600_000

const box = (name: string, n: number, kind = 'result', ageH = 5): BusBox => ({
  box: name,
  items: Array.from({ length: n }, (_, i) => ({
    file: 'm-' + String(i) + '.json',
    kind,
    from: 'maid-01',
    createdAt: T0 - ageH * H,
  })),
})

test('① 分类：按 `knownIds` 分两格（判据只读箱名）', () => {
  const r = classifyBoxes(
    [box('maid-01', 2), box('sim-node-a', 1), box('primary', 3)],
    new Set(['maid-01', 'maid-02']),
  )
  assert.equal(r.total, 6)
  assert.deepEqual(r.withConsumer.map((b) => b.box), ['maid-01'])
  assert.deepEqual(r.noConsumer.map((b) => b.box).sort(), ['primary', 'sim-node-a'])
  assert.equal(r.withConsumer[0]!.hasConsumer, true)
  assert.equal(r.noConsumer[0]!.hasConsumer, false)
})

test('①b 排序是「**有没有内容**」：件多的箱在前（不是重要性）', () => {
  const r = classifyBoxes([box('a', 1), box('b', 5), box('c', 3)], new Set(['a', 'b', 'c']))
  assert.deepEqual(r.withConsumer.map((b) => b.box), ['b', 'c', 'a'])
})

test('② 空 ⇒ **空串**（一个字都不加）', () => {
  assert.equal(renderStrandedBus({ withConsumer: [], noConsumer: [], total: 0 }, T0), '')
})

test('②b 名册读不到 ⇒ **不作判**（照报件数，但那一格是未知）', () => {
  const r = classifyBoxes([box('x', 2)], new Set())
  const s = renderStrandedBus(r, T0, { unknownFace: true, faceError: '读不到节点目录' })
  assert.match(s, /未作判/)
  assert.match(s, /读不到节点目录/)
  assert.match(s, /2 件/, '★ 件数照报 —— 「未知」不是「都没有」')
  assert.ok(!/没有消费者/.test(s), '不作判时**不许**给出「没有消费者」的结论')
})

test('③ 两格必须分开，且各带「谁 / 多久 / 几件」', () => {
  const r = classifyBoxes([box('maid-01', 2, 'result', 3), box('sim-node-a', 1, 'event', 650)], new Set(['maid-01']))
  const s = renderStrandedBus(r, T0)
  assert.match(s, /全域搁浅/)
  assert.match(s, /箱有消费者/)
  assert.match(s, /箱没有消费者/)
  assert.match(s, /maid-01/)
  assert.match(s, /sim-node-a/)
  assert.match(s, /3\.0 小时/)
  assert.match(s, /27\.1 天/, '650 小时应渲染成天')
})

test('④ ★ 第三格必须显形 —— **且必须独立成行**（短语存在性判不出「被前一句吞掉」）', () => {
  // ⚠ 由织复核点名（2026-10-12）：我原来那三条 `assert.match` 是**短语存在性** ——
  //   缺口句若被**并进前一句**（同一行），它们照样全过 ⇒ **对「被前一句吞掉」这个形状零分辨力**。
  //   ⇒ 改成**按行**断言：缺口句所在的那一行**不得**同时含「先要处置的是箱」。
  const r = classifyBoxes([box('sim-node-a', 1)], new Set())
  const s = renderStrandedBus(r, T0)
  const lines = s.split('\n')
  assert.ok(lines.some((l) => /件.*不能跟着箱/.test(l)), '★ 必须点出「件不能跟着箱一起消失」')
  // ★ 2026-10-14 **翻断言**：原文断言 `/今天没有机制承载/` —— 那句**当时是真的**，
  //   现在投递面落地了 ⇒ 留着它 = 工具继续报一个**已不存在**的缺口（过期的真话）。
  //   ⇒ 换成新事实：**有判据了**，且**仍没有自动归档路径**（那部分确实还是缺口）。
  assert.ok(lines.some((l) => /这一格现在有判据了/.test(l)), '★ 必须显形为**已有判据**（旧句是过期的真话）')
  assert.ok(lines.some((l) => /仍没有「自动归档路径」/.test(l)), '★ 剩下的那半（自动归档）**必须如实标为缺口**')
  const gapLine = lines.find((l) => /件.*不能跟着箱/.test(l))!
  assert.ok(!/先要处置的是箱/.test(gapLine), '★ 缺口句必须**独立成行** —— 不许与前一句同处一行')
  const headLine = lines.find((l) => /先要处置的是箱/.test(l))!
  assert.notEqual(headLine, gapLine, '「先处置箱」与「件不能消失」必须是两行')
})

test('④b ★ 0 件时**整块不出现**（替不存在的件报缺口 = 另一种撒谎）', () => {
  // 由织复核抓出的反例（2026-10-12）：旧版会打印「② 箱没有消费者 —— 0 件，散在 0 个箱里」，
  //   然后照样断言「箱里这些件的落点还要跟一次」⇒ **替不存在的件报了缺口**。
  //   ⇒ 「空 ⇒ 一个字都不加」必须同样做在 ② 这一层（原来只做在 `total === 0` 那一层）。
  const r = classifyBoxes([box('maid-01', 1)], new Set(['maid-01']))
  assert.equal(r.total, 1)
  assert.equal(r.noConsumer.reduce((n, b) => n + b.items.length, 0), 0)
  const s = renderStrandedBus(r, T0)
  assert.ok(!/箱没有消费者/.test(s), '★ 无消费者件时，② 整块不得出现')
  assert.ok(!/不能跟着箱/.test(s), '★ 更不许替**不存在的件**报缺口')
  assert.ok(!/这一格现在有判据了/.test(s), '★ 同理：无件时也不许报「有判据了」（那条也是关于件的）')
  assert.match(s, /箱有消费者/, '① 那格照旧在')
})

test('④c ★★ **判据替换**（2026-10-14）：投递面四态取代 `doneCount` 那条被推翻的判据', () => {
  // ⚠ 本条**替换**了旧的 ④c。旧版断言的是：
  //   `doneCount > 0 ⇒ 「历史归档 N 件」` / `= 0 ⇒ 「从未归档过」+「没能证明」`。
  //   **那条判据已被勘当场推翻**（2026-10-14，`known-gaps.md` G-strand）：`done/` 只证明
  //   「**归档动作发生过**」，而 `state/<箱>.tasks.json` 证明 **适配器进程以该 nodeId 活过** ——
  //   后者才是「曾经有过消费者」的**直接证据**。
  //   ⇒ 新判据：**入站投递面四态**，且**四态两两不同**（这是它存在的全部意义）。
  const faces: DeliveryFace[] = ['no-adapter', 'never-delivered', 'delivered', 'unknown']
  const notes = faces.map((f) => deliveryNote({ delivery: f, handledCount: f === 'delivered' ? 5 : 0 }))
  assert.equal(new Set(notes).size, 4, '★ 四态必须渲染出**四个不同**的字符串（两两可辨）')
  assert.ok(DELIVERY_FACES.length === 4, '闭集必须与渲染一致（单一真源）')

  // ★ 四态的**决定性差别**：no-adapter 与 never-delivered **绝不许同貌** ——
  //   前者是「没有庄园适配器注册」，后者是「适配器跑过、一件都没取走」。
  const r = classifyBoxes(
    [
      { ...box('a', 1), statePresent: false },
      { ...box('b', 1), statePresent: true, handledCount: 0 },
      { ...box('c', 1), statePresent: true, handledCount: 9 },
      { ...box('d', 1), statePresent: undefined },
    ],
    new Set(),
  )
  const byBox = new Map(r.noConsumer.map((b) => [b.box, b]))
  assert.equal(byBox.get('a')!.delivery, 'no-adapter')
  assert.equal(byBox.get('b')!.delivery, 'never-delivered')
  assert.equal(byBox.get('c')!.delivery, 'delivered')
  assert.equal(byBox.get('d')!.delivery, 'unknown', '★ 读不到 ⇒ **不作判**，不许并进 no-adapter')
  const s = renderStrandedBus(r, T0)
  assert.match(s, /无庄园适配器注册/, '★ 措辞必须**收窄到「庄园适配器」**')
  assert.match(s, /这不等于从来没有人来过/, '★ 且必须同句写明「≠ 没人来过」（别的消费者不写这个文件）')
  assert.match(s, /入站从未通/)
  assert.match(s, /入站通过（已取走 9 件）/)
  assert.match(s, /投递面未知/)
  // ★★ 反向断言（真调当场抓出的形状）：旧的强措辞**不许**再出现 ——
  //   它字面对、语义会误导（读者读成「从来没有人来过」，而 `primary` 的 `done/` 里
  //   有 6 件 2026-09-15/09-26 的归档 ⇒ 那个消费者取走过，只是不写 state 文件）。
  assert.ok(!/建箱以来无适配器/.test(s), '★ 「建箱以来无适配器」太强 —— 不许再出现（语义误导）')
  // ★ `doneCount` 降级为**旁证**：仍在读数里并列，但**不再单独作判**
  const withDone = classifyBoxes([{ ...box('e', 1), statePresent: true, handledCount: 3, doneCount: 7 }], new Set())
  const s2 = renderStrandedBus(withDone, T0)
  assert.match(s2, /旁证：`done\/` 归档 7 件/, '★ 归档数保留为旁证（与判据并列，不合并）')
  assert.ok(!/从未归档过/.test(s2), '★ 被推翻的那句**不许**再出现（过期的真话）')
})

test('④c3 ★★ **两条判据分叉必须显形**（真调抓出的现场形状）', () => {
  // 现场（2026-10-14 · 真调）：`primary` 同时是「无庄园适配器注册」**且**「`done/` 归档 6 件」
  //   —— **两条判据方向相反**，而旧渲染**不告诉你它们分叉了** ⇒ 读者会拿其中一条当全部。
  //   ★ 分叉**本身就是信息**：它证明「**那个消费者不是庄园适配器**」（state 面看不见它）。
  const r = classifyBoxes(
    [
      { ...box('primary', 2), statePresent: false, handledCount: 0, doneCount: 6 },
      { ...box('plain', 1), statePresent: false, handledCount: 0, doneCount: 0 },
      { ...box('has-state', 1), statePresent: true, handledCount: 3, doneCount: 9 },
    ],
    new Set(),
  )
  const s = renderStrandedBus(r, T0)
  const lines = s.split('\n')
  const pri = lines.find((l) => /`primary`/.test(l))!
  assert.match(pri, /两条判据分叉/, '★ 分叉必须**在那一行上**显形（不是别处一句泛泛的话）')
  assert.match(pri, /不是庄园适配器/, '★ 必须说清分叉**意味着什么**（不是只报「不一致」）')
  const plain = lines.find((l) => /`plain`/.test(l))!
  assert.ok(!/分叉/.test(plain), '★ 不分叉时**一个字都不加**（`done=0` 不是分叉，是没证据）')
  const hs = lines.find((l) => /`has-state`/.test(l))!
  assert.ok(!/分叉/.test(hs), '★ `delivered` + 有归档**不是分叉**（两者同向）')
  // 纯函数层单独可测（渲染逻辑不许内联在 execute 里 —— `rowTag` 那条教训）
  assert.equal(divergenceNote({ delivery: 'no-adapter', doneCount: 6 }).length > 0, true)
  assert.equal(divergenceNote({ delivery: 'no-adapter', doneCount: 0 }), '')
  assert.equal(divergenceNote({ delivery: 'delivered', doneCount: 6 }), '')
  assert.equal(divergenceNote({ delivery: 'unknown', doneCount: 6 }), '', '★ 不作判时不许报分叉（未知不是分叉）')
})

test('④c2 ★ 四态的**判类函数**单独可测（渲染逻辑不许内联在 execute 里）', () => {
  // 教训来源（2026-10-14）：`rowTag` 曾内联在 `execute` 里 ⇒ **不受任何测试保护**，
  //   分档改了而它没跟上 ⇒ 同一节点被报两遍。⇒ 判类必须是**导出的纯函数**。
  assert.equal(classifyDelivery(undefined, 0), 'unknown', '★ 顺序：读不到**先于**不在判')
  assert.equal(classifyDelivery(false, 99), 'no-adapter', '★ 文件不在 ⇒ 计数**不参与**判类（不许被 99 带跑）')
  assert.equal(classifyDelivery(true, 0), 'never-delivered')
  assert.equal(classifyDelivery(true, 1), 'delivered')
  assert.equal(classifyDelivery(true, -3), 'never-delivered', '★ 负数/脏值不越界（夹到 0）')
  assert.equal(classifyDelivery(true, Number.NaN), 'never-delivered', '★ NaN 不越界')
})

test('④d 时距在「未来时间戳」下**不得输出负数**（两份实现对照时发现的真差异）', () => {
  // 对照 `stranded.mjs` 的同名函数时发现：那份**自带** `Math.max(0, ms)` 保护，
  //   我这份原来把保护**推给调用方** ⇒ `ms < 0` 时会输出**负分钟**。
  //   ⇒ 从**渲染入口**喂一个未来时间戳（比导出私有函数更接近真实调用面）。
  const future = {
    box: 'sim-node-a',
    items: [{ file: 'm-1.json', kind: 'result', from: 'x', createdAt: T0 + 3600000 }],
  }
  const s = renderStrandedBus(classifyBoxes([future], new Set()), T0)
  assert.match(s, /0 分钟/, '★ 负时差必须夹到 0，不许渲染成负数')
  // ★ 2026-10-12 收窄这条断言：原版是 `!/-\d/.test(s)`（**整个输出**）—— 它被**日期**击穿：
  //   我当日新加的口径文案里写着 `2026-10-12`，含 `-1` ⇒ 被判成「负数」而红。
  //   ⚠ 这是**今天第三次**同一形状（判据打在整段文本上、被无关文本击穿；
  //   前两次分别是 manor 的 `foldTasks(events)` 注释与 plugin-manager 的 `ready` 注释）。
  //   ⇒ 判据必须**限定到它自己的域**：只有「时距」那一族读数不许为负。
  const ages = [...s.matchAll(/(-?\d+(?:\.\d+)?)\s*(分钟|小时|天)/g)].map((m) => Number(m[1]))
  assert.ok(ages.length > 0, '一个时距都没抽到 —— 本判据在空跑（先修判据，别信它的绿）')
  for (const a of ages) assert.ok(a >= 0, '★ 时距不得为负，抽到 ' + String(a))
})

test('⑤ 口径必须自带：说清判据是什么、以及它答不了什么', () => {
  const r = classifyBoxes([box('sim-node-a', 1)], new Set())
  const s = renderStrandedBus(r, T0)
  assert.match(s, /nodes\//, '判据的数据源要写出来')
  // ★ 2026-10-14 **收窄**：原文断言 `/答不了「历史上有没有人来过」/` ——
  //   新增投递面之后「适配器来过吗」**已被答出** ⇒ 旧句与它并列成矛盾。
  //   ⇒ 断言换成**它仍然答不了的那两格**（成因 / 读过）。
  assert.match(s, /答不了「件为什么没被取走」/, '★ 局限必须与判据**同体**，且必须**收窄到仍然答不了的那几格**')
  assert.match(s, /取走 ≠ 读过/, '★ 「取走 ≠ 读过」必须显形（本文件反复栽的同一个形状）')
  assert.match(s, /重要性.*归人/, '价值判断的归属要写明（不代填）')
})

test('⑤b 新口径**不许**再出现被收窄掉的旧句（防两版并列成矛盾）', () => {
  // ⚠ 这条是**反向断言**：它存在的理由是「旧结论比缺口更容易被后人照抄」
  //   （本文件旁注那节的原话）。新增判据时最容易留下的，就是**上一版的局限句**。
  const r = classifyBoxes([box('sim-node-a', 1)], new Set())
  const s = renderStrandedBus(r, T0)
  assert.ok(!/答不了「历史上有没有人来过」/.test(s), '★ 旧局限句必须**已被收窄**，不许与新增投递面并列')
})
