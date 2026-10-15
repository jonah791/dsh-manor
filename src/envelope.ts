/**
 * 庄园信封契约（纯函数 · 零 IO）。
 *
 * 为什么独立成模块：`meta.taskId` 是适配器**硬要求**的字段（缺它成员**正确拒收** ——
 * 2026-10-09 实测），而信封有**两条产出路**：`manor_dispatch` 直接投递、`hold` 释放时投递。
 * 两条路各写一份构造 ⇒ 必然分叉（契约漂移的经典形状）。
 * ⇒ 抽取为单一真源，`index.ts` 与 `hold-store.ts` 共用。
 */
import { normalizeTimeoutSpec } from './timeout.ts'

/**
 * 任务**性质**的闭集 —— 派活侧声明，**唯一影响「要不要打扰主人」**。
 *
 * ★ 存在理由（2026-10-12 · 主人问「怎么发了一堆任务失败」）：告警把**庄园建设期的试错**
 *   与**主人交办的活**当成同一类推给主人 ⇒ 8 小时 8 条，其中**没有一条是主人关心的**。
 *   ⇒ 分流的依据**不能在消费侧猜**（猜「哪条像主人的活」＝编造），只能由**派活侧声明**。
 *   ⇒ 它同时也是 `E12` 缺件清单里的那个 `nature` 字段（同一件事的两种说法）。
 */
export const TASK_NATURES = ['owner', 'internal', 'probe'] as const
export type TaskNature = (typeof TASK_NATURES)[number]

/** 声明缺失时读作哪个 —— ★ **取严**：漏报主人的活比多报噪音更坏。 */
export const DEFAULT_TASK_NATURE: TaskNature = 'owner'

export function isTaskNature(v: unknown): v is TaskNature {
  return typeof v === 'string' && (TASK_NATURES as readonly string[]).includes(v)
}

/**
 * 把任意输入归一成 `nature` —— **消费侧的唯一入口**（别处不许自己写三元判断，那会分叉）。
 * 未声明 / 写错 / 空串 ⇒ `owner`（取严）。
 */
export function natureOf(v: unknown): TaskNature {
  return isTaskNature(v) ? v : DEFAULT_TASK_NATURE
}

/**
 * ★ 「这个 `nature` 是**声明的**，还是**缺省兜底**的」—— 取严缺省的**审计把手**。
 *
 * 存在理由（成员织 · 2026-10-12 · **我认，而且她用了一个我没引的推论反驳我**）：
 *   `DEFAULT_TASK_NATURE` 的**点火率 ≡ 声明漏写率** —— 因为 `natureOf` 只在 `isTaskNature`
 *   为假时落到缺省，这是**构造**决定的，不是估计。于是分两种情况，而后果**相反**：
 *   · **声明覆盖完整** ⇒ 缺省几乎不点火 ⇒ 「取严」是个罕见的兜底（我说的「多推一条」此时精确成立）；
 *   · **声明有洞** ⇒ 缺省取 `owner` **不是加一条噪音，是把这个字段当初要拦的洪水原样放回来**
 *     （见 `TASK_NATURES` 头注：这个字段**正是**被「8 小时 8 条」那次洪水造出来的）
 *     ⇒ 而洪水经由**疲劳**造成的漏报，**恰恰就是「漏报主人的活」**。
 *   ⇒ ★★ **取严的缺省会亲手造出它要防的那件事** —— 除非它的**点火率可测**。
 *   ⚠ 测不到点火率时，「取严」与「取宽」在读数上**不可区分**（两侧都表现为「推了」）：
 *     一个把「我没法判」扮成「我判了 `owner`」的缺省，**自己不可审计** ——
 *     数不出它点了几次火，也分不清系统是健康的、还是靠缺省在扛。
 *   ⇒ 本函数不是锦上添花：它是这个取严缺省**唯一的审计把手**。
 *
 * 语义（写死，别读宽）：`true` = 日志里有一个**合法**的 nature 声明；
 *   `false` = 「没写」**或**「写了一个闭集外的值」—— 后者同样不是一次有效声明。
 *
 * ⚠ 与 `natureOf` **同处** = 单一真源：两处各写一份判断，就会出现「一个字段两种缺省语义」。
 */
export function natureDeclaredOf(v: unknown): boolean {
  return isTaskNature(v)
}

/**
 * ★ 写信封的**调用点**（`meta.via`）—— 2026-10-15 · `G-provenance` **Step B**。
 *
 * 存在理由（缺口原话，`docs/known-gaps.md`）：G-provenance 的三种病在盘上**同貌**
 *   （都长成「有 taskId、`nature` 是空串」）：① 派活方没声明 · ② 日志没记 ·
 *   ③ **枚举本身漏了格子**（有调用点没被列进分母）。
 *   Step A 给了 join key（`start` 事件的 `envelopeId`）⇒ 来路**可推断**（反查信封全文）；
 *   Step B 让信封**自报来路** ⇒ 来路**直接读出**，且「我不认识的那条路」**当场可见**。
 *
 * ⚠ **故意不做闭集**（与 `TASK_NATURES` 相反，这不是疏漏）：
 *   闭集会**主动抹掉「未知来路」这个最该看见的信号** —— 而 G-provenance 的核心病
 *   **正是**枚举漏格。⇒ 本常量是**已知清单**，不是合法值域：未知值**照写**，
 *   消费侧分类成 `unknown` 并出声，**不归一、不丢弃**。
 *
 * ⚠ 它同时是**枚举的机器可读副本**：此前「有几条路写信封」只活在我的散文里
 *   （2026-10-12 我数出「五条」，2026-10-15 现读只有四条 —— 代码演进合并了调用点）。
 *   ⇒ 清单与代码的偏离会表现为「某个值出现但不在清单里」（`unknown`），而不是静默。
 */
export const KNOWN_ENVELOPE_VIAS = ['manor_dispatch', 'hold-release', 'member-adapter', 'member-send'] as const

/** `via` 的长度上限（防注入：不许把整段文本塞进 `meta`）。 */
export const VIA_MAX_LEN = 64

/**
 * 归一 `via`：非空字符串 ⇒ trim 后（超长截到 `VIA_MAX_LEN`）；否则 `null`（**不写该字段**）。
 * 与 `refs` / `nature` / `timeout` **同纪律**：空 ⇒ 不写 ——「没写」的语义是
 * 「这条路的代码还没盖章」（Step B 之前的历史记录就是这样），比「写了空串」干净
 * （后者读起来像「他声明了空」）。
 */
export function normalizeVia(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '') return null
  return s.length > VIA_MAX_LEN ? s.slice(0, VIA_MAX_LEN) : s
}

/**
 * 来路分类（**消费侧的唯一入口**）：`known` / `unknown` / `none`。
 *
 * ⚠ 三态**不可合并**（同「空必须分型」纪律）：
 *   · `known` —— 在清单里，正常路；
 *   · `unknown` —— **我不认识的那条路 = 枚举漏格的信号**（最该出声的一态）；
 *   · `none` —— 没写：Step B 之前的历史记录、或某条路还没盖章。
 *   ⇒ 把 `unknown` 并进 `none` 会让「有我没见过的路在造活」静默消失。
 */
export function viaKindOf(v: unknown): 'known' | 'unknown' | 'none' {
  const s = normalizeVia(v)
  if (s === null) return 'none'
  return (KNOWN_ENVELOPE_VIAS as readonly string[]).includes(s) ? 'known' : 'unknown'
}

/**
 * 生成派活信封。`meta.taskId` 是**必需**的——庄园适配器缺它即拒收（本插件因此存在）。
 * `id` 由调用方给（直接投递用随机 id；hold 释放用**确定性 id** 以保证幂等）。
 */
export function buildEnvelope(i: {
  id: string
  from: string
  to: string
  kind: string
  text: string
  taskId: string
  acceptance: string
  cwd: string
  createdAt: number
  ttlMs: number
  /**
   * 证据指针（`path:line`）。**可选增强**，不是必需字段。
   * 存在理由（`R17'` · 由澄给）：成员「我的上下文会**压缩**。复述过的结论一旦丢了原文，
   *   我**再也回不到证据**；带 ref 的结论即使我忘了上下文，也能**现读复算**。
   *   ⇒ 这是**能力**问题，不是礼貌问题。」
   * ⚠ **非空才写**：空数组等于没写，而「没写」的语义是「派活方没给指针」——
   *   比「写了空数组」干净（后者读起来像「他给了，但什么都没给」）。
   */
  refs?: string[]
  /**
   * 任务性质（见 `TASK_NATURES`）。**可选**：非空才写。
   * ⚠ 与 `refs` 同纪律：**空串不写** —— 「没写」的语义是「派活方没声明」，
   *   而消费侧把「没写」读作 `owner`（取严）。写个空串反而像「他声明了空」。
   */
  nature?: string
  /**
   * 超时预算（写进 `meta.timeout`）。**可选**：非空才写。
   *
   * ★ 存在理由（2026-10-14 主人「解决硬顶参数化的问题」）：节点级缺省对长活/短活一视同仁，
   *   而 maid-05 那条扫 19 仓的活**成果全部产出**（19 commit / 19 push）却撞上同一个 30 分钟硬顶
   *   ⇒ 台账判 `failed` 且 `evidence: []` ⇒ 判据与事实完全相反。
   * ⚠ 与 `refs` / `nature` 同纪律：**空不写** ——「没写」= 派活方没声明
   *   ⇒ 执行侧**回落到节点级参数**（`--idleTimeoutMs` / `--hardCapMs`）。
   * ⚠ 类型取宽（`unknown`）+ 运行期归一：信封有两条产出路，其中一条从**磁盘 JSON** 读回，
   *   类型不可信（同 `checkRefs(refs: unknown, …)` 的先例）。
   */
  timeout?: unknown
  /**
   * 写信封的**调用点**（取值见 `KNOWN_ENVELOPE_VIAS`）。**可选**：非空才写。
   *
   * ★ 存在理由（`G-provenance` Step B · 2026-10-15）：缺口是「**分母里那些 taskId
   *   各自是被哪条调用点造出来的**，读数里没有这一格」⇒ 三种病在盘上同貌。
   *   Step A 的 `envelopeId` 让来路**可推断**（反查信封全文）；本字段让它**直接读出**。
   * ⚠ 与 `refs` / `nature` / `timeout` 同纪律：**空不写** ——「没写」的语义是
   *   「这条路的代码还没盖章」，比「写了空串」干净。
   */
  via?: string
}): Record<string, unknown> {
  const meta: Record<string, unknown> = { taskId: i.taskId, acceptance: i.acceptance, cwd: i.cwd }
  if (Array.isArray(i.refs) && i.refs.length > 0) meta.refs = i.refs
  if (typeof i.nature === 'string' && i.nature !== '') meta.nature = i.nature
  // ★ `timeout`（2026-10-14）：归一在 `timeout.ts`（只收有限正数；全空 ⇒ null ⇒ 不写）。
  //   ⚠ **两条产出路都必须带上它** —— 否则就是 `nature` 那个教训的第二个实例
  //     （hold 释放时丢声明 ⇒ 那条活按节点缺省跑，而派活方以为声明生效了）。
  const timeout = normalizeTimeoutSpec(i.timeout)
  if (timeout !== null) meta.timeout = timeout
  // ★ `via`（2026-10-15 · `G-provenance` Step B）：非空才写（同 `refs` / `nature` / `timeout` 纪律）。
  //   ⚠ **不做闭集归一**：未知值**照写** —— 这个字段的目的是**发现未知来路**，
  //     而归一会把「我不认识的那条路」这个最该看见的信号抹成缺省值。
  const via = normalizeVia(i.via)
  if (via !== null) meta.via = via
  return {
    v: 1,
    id: i.id,
    from: i.from,
    to: i.to,
    kind: i.kind,
    text: i.text,
    createdAt: i.createdAt,
    ttlMs: i.ttlMs,
    meta,
  }
}

/**
 * 解析一条证据指针。**纯函数**（不读盘）—— 只判「它写得对不对」。
 * 形态：`<path>:<line>`，path 非空、line 是正整数。
 * @returns 写对 ⇒ `{path,line}`；写错 ⇒ `null`（**不猜、不救**）。
 */
export function parseRef(ref: unknown): { path: string; line: number } | null {
  if (typeof ref !== 'string') return null
  const s = ref.trim()
  const at = s.lastIndexOf(':')
  if (at <= 0 || at === s.length - 1) return null
  const path = s.slice(0, at).trim()
  const lineRaw = s.slice(at + 1).trim()
  if (path === '' || !/^\d+$/.test(lineRaw)) return null
  const line = Number(lineRaw)
  if (!Number.isFinite(line) || line < 1) return null
  return { path, line }
}

/**
 * 校验一组证据指针。**读盘由调用方注入**（`exists`）⇒ 本函数可离线测。
 * 三条判据（`R17'` · 澄定的件）：**非空** · **每条能解析成 `path:line`** · **path 存在**。
 *
 * ⚠ **诚实边界**（她自己标的，我照录）：这只能到「给了**能解析开**的 ref」，
 *   **到不了「ref 指向的内容真的支持那句结论」**——后者要人读。
 *   ⇒ 协议写「必须带 ref」**不等于**写了就保证可复核；以为它保证，那是**假防线**。
 */
export function checkRefs(
  refs: unknown,
  opts: { exists: (p: string) => boolean },
): { ok: boolean; bad: string[]; parsed: Array<{ path: string; line: number }> } {
  const list = Array.isArray(refs) ? refs : []
  const bad: string[] = []
  const parsed: Array<{ path: string; line: number }> = []
  // ★ 「空」与「写坏」**分开报**：前者是「没给」，后者是「给了但没法用」
  //   （「空必须分型」—— 空是个会撒谎的读数）。
  if (list.length === 0) return { ok: false, bad: ['（空：没有给出任何指针）'], parsed }
  for (const r of list) {
    const p = parseRef(r)
    if (p === null) {
      bad.push(String(r) + ' ⇒ 不是 `path:line` 形态')
      continue
    }
    if (!opts.exists(p.path)) {
      bad.push(String(r) + ' ⇒ 路径不存在')
      continue
    }
    parsed.push(p)
  }
  return { ok: bad.length === 0, bad, parsed }
}

/** 新消息 id（与集群/适配器的 `m-…` 形态一致）。 */
export function newMsgId(nowMs: number, rand: string): string {
  return 'm-' + nowMs.toString(36) + '-' + rand
}

/**
 * 从派活正文里抽出被提到的 `manor_*` 工具名（去重、保序）。纯函数（无 IO）⇒ 可离线测。
 *
 * ★ 为什么按「反引号区间」而不是「反引号内紧邻工具名」扫（2026-10-12 · **写测试时才抓到**）：
 *   真实正文里的工具名**几乎总带参数** —— `` `manor_dispute action=claim artifactId=…` ``。
 *   要求工具名紧邻收尾反引号 ⇒ **这条判据恒不触发**（一条恒为空的判据不是证据）。
 *   ⇒ 先取反引号区间，再在区间内找 `manor_*` 词。
 * ⚠ 取宽的代价：区间内任何位置提到都算 ⇒ 只用于**警告**，不用于拒发。
 */
export function mentionedManorTools(text: string): string[] {
  const out: string[] = []
  const spanRe = /`([^`\n]+)`/g
  let s: RegExpExecArray | null
  while ((s = spanRe.exec(text)) !== null) {
    const wordRe = /\b(manor_[a-z_]+)\b/g
    let w: RegExpExecArray | null
    while ((w = wordRe.exec(s[1]!)) !== null) {
      if (!out.includes(w[1]!)) out.push(w[1]!)
    }
  }
  return out
}

/**
 * 正文提到、但**收件人角色看不见**的工具（`visible` = 该角色的工具白名单）。
 *
 * ★ 存在理由（2026-10-12 · **由一次真实失败驱动**）：我给 maid-05 派了一条要求她调
 *   `manor_dispute` 的活，**200 秒后被杀**（台账 `failed/timeout`）—— 根因是
 *   `MEMBER_TOOLS` 是**显式白名单**（fail-closed ⇒ 新工具默认对成员不可见），
 *   而我加了新工具**却没同步它**。
 *   ★ 与「工具面收窄了而**后台循环照起**」同族：**同一个决定、两个落点**；
 *     而「忘了改白名单」**不产生任何可观测异常** —— 直到有人照着一张她看不见的地图被派活。
 * ⚠ 判据取宽：提到工具名**不等于**要她调它（正文可能只是在引用/讨论）⇒ 只警告，不硬拒。
 */
export function invisibleToolMentions(text: string, visible: ReadonlySet<string>): string[] {
  return mentionedManorTools(text).filter((n) => !visible.has(n))
}

/**
 * hold 释放时用的**确定性**信封 id —— 同一条 hold 无论释放几次都撞同一个名字
 * ⇒ 第二次写必 `EEXIST` ⇒ 释放**幂等**（不会重复投递，也不会变成「释放器一忙就发两遍」）。
 * 前缀 `m-hold-` 让「这封信是 hold 释放出来的」在文件名上自证。
 */
export function holdEnvelopeId(taskId: string): string {
  return 'm-hold-' + taskId
}

/**
 * 解析收件人列表 —— **支持多播**（`to` 用逗号分隔）。E12 的真前置（2026-10-12）。
 *
 * 为什么多播是「竞争领取」的前置：成员「澄」的判据是**按任务性质分** ——
 *   **独立型 / 读取型 ⇒ 各做各的**（重复成本 < 协调成本，两份独立结论还能互相校对）；
 *   **独占型 / 写入型 ⇒ 必须先举手**。
 *   两者都要求「**一件活能被多人看见**」。而此前 `to` 只能是一个成员 ⇒
 *   活**天然独占**（直接进一人信箱）⇒ **`claim` 没有对象可领**，整套竞争面是空的。
 *   ⇒ 所以顺序是「**先有多播，竞争才成为真问题**」，不是「先有 claim，再找地方用它」。
 *
 * 语义：trim 每段 → 丢弃空段 → 按**首次出现**去重并**保序**
 *   （顺序有意义：第一个是「主要收件人」，回执/归属会用到）。
 * ⚠ **不做成员存在性校验**：那是 `manor_find` 的知识面；派活侧只管投递。
 *   投给不存在的箱子会留一条**搁浅件** —— 那本身是可观测的（比一个「成员不存在」的
 *   硬拒更诚实：搁浅件把「这封信没人取」暴露在账上，而硬拒把它藏进一次调用失败里）。
 */
export function parseRecipients(raw: string): string[] {
  const out: string[] = []
  for (const seg of raw.split(',')) {
    const s = seg.trim()
    if (s === '') continue
    if (!out.includes(s)) out.push(s)
  }
  return out
}
