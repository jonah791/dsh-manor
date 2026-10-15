/**
 * **总线全域**的搁浅件（`E14` · 2026-10-12）。
 *
 * 为什么需要它（勘的全域扫描 + 织的洞）：
 *   `manor_find` 的域是**庄园成员的信箱**（`inbox.ts` 头注自承「必要不充分」），
 *   而**总线全域**（`mailbox/*` 全部箱子）另有一批：实测 **16 个箱里只有 4 个有消费者**，
 *   其余 12 个（`sim-node-a` / `LAPTOP-BF4IAPLM-maid-04-0` / `node-a-3090` / `primary` …）
 *   **不在任何名册上** ⇒ 落进它们的件
 *   **不会被认领**（没人取）、**也不会被判搁浅**（kind 在认领名单里）
 *   ⇒ **既不在通道里，也不在账上**（织的原话）。
 *
 * ★ 判据（**可算的事实，不是价值** —— 织给的分层）：
 *   **箱名是否在 `nodes/` 里**（`nodes/*.json` 的 id 集合）⇒ 决定「**可处置性**」。
 *   ⚠ 它答的是「**这个箱今天有没有身份**」，**不是**「历史上有没有人来过」——
 *     所以才用「没有消费者」这个措辞，不用「永不可处置」。
 *
 * ⚠ **局限（织标的四理由，我照录）**：`done=0` 或「不在名册」都**可能**由四种原因压出 ——
 *   ① 裸 id 但没有适配器在跑 · ② 没有消费者 · ③ 箱子太新 · ④ 消费者从不取件。
 *   ⇒ 本层报的是「**这个箱今天没有身份**」，**不是**「历史上从没有人来过」。
 *   ⇒ 措辞取「**没有消费者**」，不用「永不可处置」，且**必须带读数域**。
 *
 * ★ **重要性/排序归人**（价值取舍）：本层只**分类与计数**，
 *   **不替当事人决定先处理哪个**（与「判断不可代填」同纪律）。
 */

/**
 * **入站投递面** —— 回答「**历史上**有没有适配器认领过这个箱、有没有真的取走过件」。
 *
 * ★ 存在理由（2026-10-14 · `G-strand` 的机制化落点）：
 *   `classifyBoxes` 那条判据答的是「**今天**有没有消费者」（读 `nodes/` 的心跳自述），
 *   而**它答不了「入站通没通」** —— 勘 2026-10-14 当场把这一格推翻：
 *   「**在册、正心跳，信照样被 `held`**」⇒ 三种成因（没有消费者 / 有消费者但按配置拒绝取 /
 *   消费者在别处）**外观完全相同**。⇒ **需要第二条事实**，且**不能与前一条合并**
 *   （合并 = 又一次「把两个不同的东西装进一个读数」）。
 *
 * ★ 数据源：`state/<box>.tasks.json`（`adapter.mjs:116` 定死 `nodeId + '.tasks.json'`）。
 *   **它比 `done/` 强**：`done/` 只证明「归档动作发生过」，而 state 文件证明
 *   **适配器进程以这个 nodeId 活过**（`adapter.mjs:695` 每轮写它）——
 *   后者才是「曾经有过消费者」的**直接证据**。
 *
 * ★ 四态（**互不掩盖** —— 「读不到」不许读成「没有」）：
 *   - `no-adapter`      state 文件不存在 ⇒ **建箱以来没有适配器以它注册过**
 *   - `never-delivered` 有 state 文件但 `handled` 为空 ⇒ **适配器跑过、从未取走任何件**
 *   - `delivered`       有 state 文件且 `handled` 非空 ⇒ **入站真的通过**
 *   - `unknown`         state 目录读不到 ⇒ **不作判**（与 `unknownFace` 同纪律）
 *
 * ⚠ **它仍然答不了「件为什么没被取走」**：`never-delivered` 至少有三条成因
 *   （按配置 `held` / 消费侧报错 / 刚起还没轮到）—— 本层只报**有没有发生过**，不报原因。
 */
export type DeliveryFace = 'no-adapter' | 'never-delivered' | 'delivered' | 'unknown'

/** 四态的**闭集**（渲染与测试共用单一真源，防两处各自枚举而漂移）。 */
export const DELIVERY_FACES: readonly DeliveryFace[] = ['no-adapter', 'never-delivered', 'delivered', 'unknown']

/**
 * 按「state 文件在不在 + 取走计数」判四态。**纯函数** ⇒ 可离线测。
 * @param statePresent `true`=文件在 · `false`=文件不在 · `undefined`=**目录读不到**（不作判）
 * @param handledCount 该箱 `handled` 数组的长度（`statePresent !== true` 时忽略）
 */
export function classifyDelivery(statePresent: boolean | undefined, handledCount: number): DeliveryFace {
  // ★ 顺序即纪律：`undefined`（读不到）**必须**先于 `false`（不在）判 ——
  //   反过来会把「我读不到」读成「它不存在」，那是本条要防的那个错本身。
  if (statePresent === undefined) return 'unknown'
  if (statePresent !== true) return 'no-adapter'
  const n = Number.isFinite(handledCount) && handledCount > 0 ? Math.trunc(handledCount) : 0
  return n > 0 ? 'delivered' : 'never-delivered'
}

/** 一个箱里的一件（只留渲染与判类需要的字段）。 */
export interface BusItem {
  file: string
  kind: string
  from: string
  createdAt: number
}

/** 扫描结果里的一个箱。 */
export interface BusBox {
  box: string
  items: BusItem[]
  /**
   * 该箱 `done/` 里的归档数（**由 IO 层填**）。
   * ⚠ 由成员织复核抓出（2026-10-12）：这个字段**原先声明了却恒为 0、且无人读** ——
   *   「**声明了一个能力但没接线**」，容易被误读成「已经有」。
   *   ⇒ 她给的二选一是「量化填上 / 从类型删掉」，**选量化**：
   *   `doneCount > 0` 是「**历史上确实有消费者工作过**」的旁证 ——
   *   它正是她列的四理由里「**消费者从不取件**」那一格的反面。
   */
  doneCount?: number
  /**
   * state 文件在不在（**由 IO 层填**）：`true`=在 · `false`=不在 · `undefined`=目录读不到。
   * ⚠ 三态**不可合并**：`undefined` 必须留作「不作判」，不许并进 `false`。
   */
  statePresent?: boolean
  /** 该箱 `handled` 里的取走计数（**由 IO 层填**）。 */
  handledCount?: number
}

/** 分类后的一个箱（`hasConsumer` 由调用方按名册判定）。 */
export interface BoxView extends BusBox {
  hasConsumer: boolean
  /** 该箱 `done/` 里的归档数（**旁证**：>0 说明历史上确实有消费者工作过）。 */
  doneCount: number
  /**
   * **入站投递面**（2026-10-14 新增）—— 与 `hasConsumer` **是两条独立的事实**：
   *   前者答「**今天**有没有消费者」，本条答「**历史上**入站通没通」。
   *   ⚠ **不许把它们合并**（勘的反例正是「今天有消费者 ∧ 入站从未通」）。
   */
  delivery: DeliveryFace
  /** 取走计数（`delivery === 'delivered'` 时 >0）。 */
  handledCount: number
}

export interface BusScanResult {
  /** 有消费者：件会被搭车取走（投递即移出）⇒ 这里报的是「**还没轮到的**」 */
  withConsumer: BoxView[]
  /** 无消费者：件**不会被取** ⇒ **要处置的是箱，不是件** */
  noConsumer: BoxView[]
  /** 总件数（两格之和，便于对账） */
  total: number
}

/**
 * 按「箱有没有消费者」分类。**纯函数**（名册由调用方给）⇒ 可离线测。
 * @param boxes 扫描到的箱（含件）
 * @param knownIds **「今天有消费者」的 id 集合** —— 实现里**只**由 `nodes/*.json` 的
 *   **心跳自述 `harness`** 派生（只有庄园适配器取走才会注入会话）。
 *
 * ★ 这条判据被两位当事人**各推进一步**（两次都是「事实 vs 声明」这条线上的一步）：
 *   ① **织**（2026-10-12 复核里点名）：**不要改成「庄园名册 ∪ `nodes/`」** ——
 *      名册是**登记册的声明**，`nodes/` 是**心跳的事实**；把名册并进来会让这一格
 *      从「今天有没有进程在轮询它」滑向「登记册上有没有这个名字」。
 *      她还**预言了分叉条件**：「将来出现『**在册但从未唤醒**』的成员时，两者就会分叉。」
 *   ② **勘**（同日）**给出了那个实例，并再推一步**：那一刻 `LAPTOP-BF4IAPLM-maid-04-0`
 *      **在 `nodes/` 里有心跳** —— 按①的判据它算「有身份」；可它的那两封信是被
 *      **`held`**（`autoInject=false`）⇒ **取走也不注入会话** ⇒ 那个箱子**照样没有落点**。
 *      她那句是判据的最后形态：「**在册 ≠ 有消费者**」·
 *      「一个 `autoInject=false` 的箱子**在册也照样是死箱**，回信落在它上面等于没有落点。」
 *   ⇒ 判据要**两层同时成立**：**有节点身份**（有进程在轮询）**且**取了会注入
 *     （`harness === MANOR_ADAPTER_HARNESS`）。`knownIds` 由调用方按这两层构造。
 */
export function classifyBoxes(boxes: BusBox[], knownIds: Set<string>): BusScanResult {
  const withConsumer: BoxView[] = []
  const noConsumer: BoxView[] = []
  let total = 0
  for (const b of boxes) {
    const items = Array.isArray(b.items) ? b.items : []
    total += items.length
    // `doneCount` 由 IO 层给；缺省 0（**不许把「没给」读成「归档过」**）
    const done = typeof b.doneCount === 'number' && Number.isFinite(b.doneCount) && b.doneCount > 0
      ? Math.trunc(b.doneCount)
      : 0
    const v: BoxView = {
      box: b.box,
      items,
      hasConsumer: knownIds.has(b.box),
      doneCount: done,
      delivery: classifyDelivery(b.statePresent, b.handledCount ?? 0),
      handledCount: typeof b.handledCount === 'number' && Number.isFinite(b.handledCount) && b.handledCount > 0
        ? Math.trunc(b.handledCount)
        : 0,
    }
    if (v.hasConsumer) withConsumer.push(v)
    else noConsumer.push(v)
  }
  // 有件的箱排前面（空的箱不该占视野）——**这不是「重要性排序」，是「有没有内容」**
  const byItems = (a: BoxView, b: BoxView): number => b.items.length - a.items.length || (a.box < b.box ? -1 : 1)
  withConsumer.sort(byItems)
  noConsumer.sort(byItems)
  return { withConsumer, noConsumer, total }
}

/**
 * 四态 → 人话。**导出的纯函数**（★ 不写成渲染里的内联三元 —— 2026-10-14 的教训：
 * `rowTag` 曾内联在 `execute` 里 ⇒ **不受任何测试保护**，分档改了而它没跟上，同一节点被报两遍）。
 * ⚠ 措辞必须**能区分四态**：四个字符串两两不同（测试钉住这一条）。
 */
export function deliveryNote(b: { delivery: DeliveryFace; handledCount: number }): string {
  switch (b.delivery) {
    case 'no-adapter':
      // ★★ 2026-10-14 **措辞收窄**（真调当场抓出）：原版写「⚠ 建箱以来无适配器」——
      //   **字面对、语义会误导**：读者会读成「**从来没有人来过**」。
      //   反例现读就在盘上：`primary` 的 `done/` 里有 **6 件归档（2026-09-15 / 09-26）**
      //   ⇒ 那个消费者**取走过**，只是它**不写 state 文件**（不是庄园适配器）。
      //   ⇒ 域必须**收窄到「庄园适配器」**，并把「这不等于没人来过」**写进同一句**。
      return ' · ⚠ **无庄园适配器注册**（无 `state/<箱>.tasks.json` ⇒ 从未有**庄园适配器**以它注册过；'
        + '**这不等于从来没有人来过** —— 别的消费者不写这个文件）'
    case 'never-delivered':
      return ' · ⚠ **入站从未通**（适配器跑过，但 `handled` 空 ⇒ **一件都没取走过**）'
    case 'delivered':
      return ' · 入站通过（已取走 ' + String(b.handledCount) + ' 件）'
    case 'unknown':
      return ' · ⚠ **投递面未知**（state 目录读不到 ⇒ 不作判）'
    default: {
      // 穷尽性守卫：新增一态而忘了改这里 ⇒ 立刻响（fail-loud，不静默回落）
      const never: never = b.delivery
      return ' · ⚠ 未识别的投递面 ' + String(never)
    }
  }
}

/**
 * **两条判据分叉**时的那一行读数（`''` = 不分叉 ⇒ 一个字都不加）。
 *
 * ★ 存在理由（2026-10-14 · 真调当场抓出的形状）：`primary` 同时是
 *   「**无庄园适配器注册**」**且**「`done/` 有 6 件归档」—— **两条判据方向相反**。
 *   ⚠ 旧渲染**不告诉你它们分叉了** ⇒ 读者会拿其中一条当全部。
 *   ★ 分叉**本身就是信息**：它证明「**那个消费者不是庄园适配器**」——
 *     即 state 面**结构上看不见**它（它不写 `state/<box>.tasks.json`）。
 *     ⇒ 这正是「`done/` 只能作**旁证**」的现场证据。
 *
 * ⚠ **零额外 IO**（只用已读到的两个数）—— 时刻锚（归档件的 `createdAt`）留给 IO 层可选补。
 */
export function divergenceNote(b: { delivery: DeliveryFace; doneCount: number }): string {
  if (b.doneCount > 0 && b.delivery === 'no-adapter') {
    return ' ⚠ **两条判据分叉**（state 面说无庄园适配器 ∧ `done/` 有归档 ⇒ '
      + '那个消费者**不是庄园适配器**，state 面结构上看不见它）'
  }
  return ''
}

/** 人类可读时距。
 *  ⚠ **这不是「重复实现」，是「结构性重复」**（2026-10-12 复核后我改了判断）：
 *    `stranded.mjs` 活在**适配器进程**（独立运行时，不经过 TS 构建），本文件活在**插件构建单元**里
 *    —— **两者无法物理合并**。⇒ 处置：**声明同源**（与 `stranded.mjs:32` 对 `CLAIMABLE_KINDS` 的处置同形）：
 *    **改一处要一起改**。
 *  ⚠ **对照结果（我跑了，织标未验）**：两支**基本一致**，但有一处**真差异** ——
 *    `stranded.mjs` 那份**自带** `Math.max(0, ms)` 保护，我这份原来把保护**推给调用方**；
 *    在 `ms < 0` 时会输出**负数**（当前调用点已保护 ⇒ 未触发，但那是潜在缺陷，
 *    **不是「暂时没事」而是「靠调用方的纪律兜着」**）。⇒ 已补上保护，与另一份**同口径**。 */
export function humanAge(ms: number): string {
  const m = Math.max(0, ms)
  const h = m / 3600000
  if (h < 1) return String(Math.round(m / 60000)) + ' 分钟'
  if (h < 48) return h.toFixed(1) + ' 小时'
  return (h / 24).toFixed(1) + ' 天'
}

/**
 * 渲染全域搁浅面。
 * ★ 形状要求（哨的四件）：**名字**（`全域搁浅`，与成员信箱那档一眼可辨）· **异形** ·
 *   谁+多久 · **每轮都在**。★ 分两格的理由（织的分层）：**可处置性是事实，重要性是价值**。
 * ★ `unknownFace` 为真时**不作判**（名册读不到 ⇒ 「没有消费者」这个判断不成立）。
 */
export function renderStrandedBus(
  r: BusScanResult,
  nowMs: number,
  opts: { maxRows?: number; unknownFace?: boolean; faceError?: string } = {},
): string {
  const lines: string[] = []
  if (opts.unknownFace === true) {
    return '⚠ **全域搁浅：本轮未作判** —— 名册读不到（' + (opts.faceError ?? '未给原因') + '）\n'
      + '（**这不是「没有搁浅件」**：件数照报，但「哪些箱有消费者」这一格是**未知**。）'
      + '本轮实扫 ' + String(r.total) + ' 件。'
  }
  if (r.total === 0) return '' // 空 ⇒ 一个字都不加（与搁浅块同纪律）
  const maxRows = opts.maxRows ?? 8
  lines.push('🔻 **全域搁浅**（总线 `mailbox/*` 全箱 —— **与「成员信箱」不是同一域**）')
  lines.push('（`manor_find` 的域是**成员信箱**；这里补的是**它覆盖不到的那一半**。）')

  const wcItems = r.withConsumer.reduce((n, b) => n + b.items.length, 0)
  lines.push('')
  lines.push('**① 箱有消费者** —— ' + String(wcItems) + ' 件（**会被搭车取走**：投递即移出，等下一次唤醒）')
  if (wcItems > 0) {
    for (const b of r.withConsumer.slice(0, maxRows)) {
      const oldest = b.items.reduce((m, it) => (m === 0 || (it.createdAt > 0 && it.createdAt < m) ? it.createdAt : m), 0)
      const age = oldest > 0 ? humanAge(Math.max(0, nowMs - oldest)) : '时刻不详'
      lines.push('  · `' + b.box + '` —— ' + String(b.items.length) + ' 件 · 最旧 ' + age)
    }
  }

  const ncItems = r.noConsumer.reduce((n, b) => n + b.items.length, 0)
  const ncBoxes = r.noConsumer.filter((b) => b.items.length > 0).length
  // ★★ **0 件时整块不出现** —— 由成员织在复核里当场抓出（2026-10-12）：
  //   旧版会打印「② 箱没有消费者 —— **0 件**，散在 0 个箱里」，然后照样断言
  //   「**箱里这些件**的落点还要跟一次」⇒ **替不存在的件报了缺口**。
  //   ⇒ 「**空 ⇒ 一个字都不加**」这条纪律**必须同样做在这一层**，
  //     不能只做在 `total === 0` 那一层（那是我原来的覆盖缺口）。
  if (ncItems > 0) {
    lines.push('')
    lines.push('**② ⚠ 箱没有消费者** —— ' + String(ncItems) + ' 件，散在 ' + String(ncBoxes) + ' 个箱里')
    // ⚠ 数字**必须现算**：我第一版写死了「那 12 个箱」，而**活体验收时实盘只有 4 个箱有件** ——
    //   硬编码的读数会**静默过期**（「存当时的数值 vs 存复取命令」那条纪律的典型病灶）。
    lines.push('   ★ **先要处置的是箱**（这 ' + String(ncBoxes) + ' 个箱还要不要）—— 判据是「这个箱**有没有唤醒路径**」（心跳自述 `harness` 是不是庄园适配器），是**事实**不是价值。')
    // ★ **织按住的一格**（2026-10-12）：我原来的措辞「要处置的是箱，**不是件**」会引导人跳过件。
    //   她的原话（其中的「16 件」是她当时的实盘读数 —— **数随时刻变，判据不变**）：
    //   「箱的决定一旦做完（留/废），箱里那 16 条件的落点才被定，**件的处置仍要跟一次**。
    //   否则『箱没了』会把『件去哪』一起吞掉 —— **那是另一种不可见面**。」
    //   ⇒ 所以这一格**必须显形为缺口**，不能被前一句吞掉。
    lines.push('   ⚠ **但「件」不能跟着箱一起消失**：箱的决定（留 / 废）做完之后，'
      + '箱里这些件的落点**还要跟一次** —— 否则「箱没了」会把「件去哪」一起吞掉，'
      + '**那是另一种不可见面**。')
    // ★★ 2026-10-14：这一格**从「缺口」变成了「有机制」**（`G-strand` 机制化）。
    //   ⚠ 旧版这句写的是「**今天没有机制承载这件事**（没有 `expired/` 目录、没有归档路径、
    //     也没有人认领这一格）⇒ 这是缺口，不是已完成」—— 它**当时是真的**，现在**是假的**。
    //   ⇒ 留着它 = 工具继续报一个已不存在的缺口（**过期的真话**，本文件旁注那节正是讲这个）。
    //   ⚠ 但**新机制不是「自动归档」**（那仍是缺口）——新机制做的是**把「入站通没通」
    //     变成每条读数上的一个事实**，从而**处置动作有了判据**（不再是靠人猜）。
    lines.push('   ★ **这一格现在有判据了**（2026-10-14）：每条读数带**投递面四态** ——'
      + '**先看它有没有过消费者，再决定这个箱留还是废**。'
      + '⚠ **仍没有「自动归档路径」**（那部分仍是缺口）：本层只把事实**显形**，处置动作仍归人。')
    for (const b of r.noConsumer.filter((x) => x.items.length > 0).slice(0, maxRows)) {
      const oldest = b.items.reduce((m, it) => (m === 0 || (it.createdAt > 0 && it.createdAt < m) ? it.createdAt : m), 0)
      const age = oldest > 0 ? humanAge(Math.max(0, nowMs - oldest)) : '时刻不详'
      const kinds = Array.from(new Set(b.items.map((it) => it.kind))).join('/')
      lines.push('  · `' + b.box + '` —— ' + String(b.items.length) + ' 件（' + kinds + '）· 最旧 ' + age
        + deliveryNote(b)
        // ★ 2026-10-14：**分叉必须显形**（真调抓出 `primary` 两条判据方向相反，
        //   而旧渲染不告诉你）—— 分叉本身就是「那个消费者不是庄园适配器」的证据。
        + divergenceNote(b)
        // ★ 2026-10-14 **判据替换**（`G-strand` 机制化）：原来这里挂的是
        //   `doneCount > 0 ? 历史归档 N 件 : ⚠ 从未归档过` —— 那条**已被勘推翻**：
        //   `done/` 只证明「归档动作发生过」，而 `state/<箱>.tasks.json` 证明
        //   **适配器进程以该 nodeId 活过** ⇒ 后者才是「曾经有过消费者」的直接证据。
        //   `done/` 保留为**旁证**（同一条读数里并列，不合并 —— 两者可同时为真也可分叉）。
        + (b.doneCount > 0 ? ' · 旁证：`done/` 归档 ' + String(b.doneCount) + ' 件' : ''))
    }
    const ncWithItems = r.noConsumer.filter((x) => x.items.length > 0)
    if (ncWithItems.length > maxRows) {
      lines.push('  （另有 ' + String(ncWithItems.length - maxRows) + ' 个箱未列出。）')
    }
  }
  lines.push('')
  lines.push('——')
  lines.push('**口径**：判据是「**心跳自述的 `harness` 是不是庄园适配器**」—— 两层同时成立才算有消费者：'
    + '**有节点身份**（`nodes/*.json` 里有它 ⇒ 有进程在轮询那个箱）**且取了会注入会话**。'
    + '那是**可算的事实**，不是价值判断。')
  lines.push('⚠ **只判第一层是错的**（2026-10-12 由成员勘当场推翻我那一版）：'
    + '她的反例是「**在册、正心跳，信照样被 `held`**」（`autoInject=false` ⇒ 取走也不注入）'
    + '⇒ **在册 ≠ 有消费者**；「一个 `autoInject=false` 的箱子**在册也照样是死箱**」。')
  // ★★ 2026-10-14：**第二条事实**（勘给的升级方向落地）。
  //   她原话给的判据升级方向是「读**投递计数**（`delivered` / `handled`）而不是
  //   『箱名在不在 `nodes/` 里』——`delivered: 0` 与 `delivered: >0` 是**两种世界**」。
  //   ⚠ 而实测抓出**第三种世界**：那三个死箱**连 state 文件都没有** ⇒ 她那两态之外还有
  //   「**建箱以来无适配器**」这一态（没有 state 文件 ≠ handled 为 0）。
  lines.push('★ **每条读数带两条独立的事实**（**不许合并** —— 勘的反例正是「今天有消费者 ∧ 入站从未通」）：'
    + '① **今天有没有消费者**（读 `nodes/` 心跳自述 `harness`）· '
    + '② **历史上入站通没通**（读 `state/<箱>.tasks.json` 的 `handled`）。')
  lines.push('★ 投递面**四态**（互不掩盖，**「读不到」不许读成「没有」**）：'
    + '**无庄园适配器注册**（无 state 文件 —— ⚠ **≠「没人来过」**：别的消费者不写这个文件）· '
    + '**入站从未通**（有 state、`handled` 空）· '
    + '**入站通过**（`handled` >0）· **未知**（state 目录读不到 ⇒ 不作判）。'
    + '⚠ 它仍**答不了「件为什么没被取走」**（`held` / 报错 / 刚起还没轮到，三者同貌）。')
  lines.push('★ **两条判据分叉时必须显形**（真调抓出的形状）：state 面说无庄园适配器 ∧ `done/` 有归档 '
    + '⇒ 分叉**本身就是信息** —— 它证明「**那个消费者不是庄园适配器**」（state 面结构上看不见它）。'
    + '⚠ 分叉**不是矛盾**，是「**有另一条通道曾在此工作过**」的证据。')
  // ⚠ **旧口径必须收窄**（2026-10-14）：原文是「它答不了『历史上有没有人来过』」——
  //   那句**当时是真的**，但新增投递面之后，**「适配器来过吗 + 取走过件吗」确实被答出来了**
  //   ⇒ 留着原句会让两条读数并列成矛盾。收窄成**它仍然答不了的那两格**：
  //   ① 件**为什么**没被取走 ② 历史上有没有人**读过**（**取走 ≠ 读过** —— 与 `done/` 那条
  //   「归档 ≠ 读过」同形，都是本文件反复栽过的「把两个不同的东西装进一个读数」）。
  lines.push('⚠ **它答不了「件为什么没被取走」，也答不了「历史上有没有人读过」**'
    + '（**取走 ≠ 读过** —— 与「归档 ≠ 读过」同形）：`never-delivered` 至少有三条成因'
    + '（按配置 `held` / 消费侧报错 / 刚起还没轮到），**三者同貌**。')
  lines.push('★ **重要性仍归人**：本面只分类与计数，**不替你决定先处理哪个**。')
  return lines.join('\n')
}
