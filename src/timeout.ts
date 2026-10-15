/**
 * 超时预算的**派活侧**判据（纯函数 · 零 IO）。
 *
 * ★ 存在理由（2026-10-14 主人「解决硬顶参数化的问题」）：
 *   `adapter.mjs` 的 `idleTimeoutMs` / `hardCapMs` 是**节点级**参数，而任务需求差别极大 ——
 *   「读一个文件」两分钟够，「扫 19 个仓库」要半小时以上。派活方**无法表达**「这条活需要多久」。
 *   实测代价（maid-05 · 2026-10-14）：那条「19 个仓批量脱敏 + 提交 + 推送」的活，
 *   成果**全部产出**（19 commit / 19 push / 5 个插件测试全绿），却撞上所有人的同一个 30 分钟硬顶
 *   ⇒ 台账判 `failed` 且 `evidence: []` ⇒ **判据与事实完全相反**，我据此连误三次。
 *
 * ⚠ 与 `projects/self/alice-manor/timeouts.mjs` 是**跨实现的同一契约** ——
 *   两个包之间**没有共享模块机制**（一个是 DSH 插件（TS），一个是独立适配器脚本（mjs），
 *   唯一的共享面是**总线上的信封 JSON**）⇒ 常量必须**手工同步**（**改一处要改两处**，
 *   两处头注互相点名）。这是**已知的可接受重复**，不是疏漏。
 *
 * ⚠ 两侧**语义不同**，不是重复实现：
 *   · 派活侧（本模块）＝ **校验 + 拒发**（fail-loud：派活方当场知道写错了）
 *   · 执行侧（`timeouts.mjs`）＝ **clamp + 留痕**（劳动不丢、误用不被掩盖）
 *   ⇒ 同一条设计精神的两个落点（同 `meta.cwd` 越界的处置分工：派活侧拒发 / 执行侧降级标注）。
 *
 * ── 拒发 vs 警告的判据（**两侧代价不对称时取轻的那侧** · 2026-10-14）────────────
 *   · **低于下限 ⇒ 拒发**：明显笔误（把秒当毫秒写），且如此短的预算下任务**必然被杀**
 *     ⇒ 放行等于白派一次活（双方都付了代价、什么都得不到）。
 *   · **超过上界 ⇒ 只警告、不拒发**：超上界**不是错误** —— 执行侧会 clamp 并留痕，活照跑（只是跑短些）；
 *     而拒发是**最强动作**（劳动全丢）。⇒ 代价不对称时取轻的那侧。
 *     ⚠ 与 `cwd` 越界**故意不同**：那个有实质风险（在别人的工作根里干活），这个没有。
 */

/**
 * 下限：低于它 ⇒ **拒发**（只挡明显笔误：把秒当毫秒写、手滑少个零）。
 * ⚠ 与 `timeouts.mjs` 的 `MIN_IDLE_MS` / `MIN_HARD_CAP_MS` 同值（跨实现契约，改一处要改两处）。
 */
export const MIN_TASK_TIMEOUT_MS = 10000

/**
 * 上界（**仅用于警告**，不拒发）：与适配器侧 `--maxIdleMs` / `--maxHardCapMs` 的缺省同值。
 * 超过它 ⇒ 执行侧会 clamp 到上界并留痕（活照跑），但派活方**应当被告知**。
 */
export const DEFAULT_MAX_TASK_IDLE_MS = 1800000
export const DEFAULT_MAX_TASK_HARD_CAP_MS = 7200000

/** 信封 `meta.timeout` 的形状。**只写给了的字段**（空 = 未声明，不写噪音字段）。 */
export interface TimeoutSpec {
  idleMs?: number
  hardCapMs?: number
}

/** 有限正数才算数（`0` / 负数 / `NaN` / `Infinity` / 非数字一律不算）。 */
const isPosMs = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * 派活侧校验：**拒发**判据（fail-loud）。
 *
 * @returns `{ spec, errors, warnings }` —— `errors` 非空 ⇒ 调用方**拒发**；
 *          `warnings` 非空 ⇒ 照发，但要把提示带给派活方（他该知道自己会被 clamp）。
 */
export function validateTimeoutSpec(i: { idleMs?: unknown; hardCapMs?: unknown }): {
  spec: TimeoutSpec
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  const spec: TimeoutSpec = {}

  const one = (raw: unknown, key: 'idleMs' | 'hardCapMs', maxMs: number): void => {
    if (raw === undefined || raw === null) return
    if (!isPosMs(raw)) {
      errors.push(key + ' 必须是有限正数（收到 ' + JSON.stringify(raw) + '）——'
        + '单位是**毫秒**（如 30 分钟 = 1800000）。')
      return
    }
    if (raw < MIN_TASK_TIMEOUT_MS) {
      errors.push(key + '=' + String(raw) + 'ms 低于下限 ' + String(MIN_TASK_TIMEOUT_MS) + 'ms ——'
        + '如此短的预算下任务**必然被杀**，派出去等于白派一次活。'
        + '（常见笔误：把秒当毫秒写。30 秒请写 30000。）')
      return
    }
    if (raw > maxMs) {
      // ★ 警告而非拒发（判据见头注「拒发 vs 警告」）
      warnings.push(key + '=' + String(raw) + 'ms 超过适配器缺省上界 ' + String(maxMs) + 'ms ——'
        + '执行侧会 **clamp 到上界并留痕**（活照跑、但会跑短）。'
        + '要真的按这个值跑，需在**成员节点侧**同步抬 `--maxHardCapMs` / `--maxIdleMs`。')
    }
    spec[key] = raw
  }

  one(i.idleMs, 'idleMs', DEFAULT_MAX_TASK_IDLE_MS)
  one(i.hardCapMs, 'hardCapMs', DEFAULT_MAX_TASK_HARD_CAP_MS)

  // 可诊断性：硬顶 ≤ idle ⇒ idle 判据**永远不会先触发**（到点一律按硬顶杀）。
  // ⚠ 不是错误（有人就想要「不管有没有进展，到点一律杀」）⇒ 只提示。
  if (spec.hardCapMs !== undefined && spec.idleMs !== undefined && spec.hardCapMs <= spec.idleMs) {
    warnings.push('hardCapMs（' + String(spec.hardCapMs) + 'ms）≤ idleMs（' + String(spec.idleMs) + 'ms）'
      + ' ⇒ 无进展判据**永远不会先触发**（到点一律按硬顶杀）。若这不符合预期，请把 idleMs 调小。')
  }

  return { spec, errors, warnings }
}

/**
 * 形状归一（**写入侧**共用：`buildEnvelope` 与 `buildHoldRecord`）。
 *
 * 语义（写死，别读宽）：**只收有限正数**，其余一律当**未声明**（不写字段）。
 * ⚠ 与 `nature` 的关键差别：`nature` 未声明 ⇒ 消费侧**取严**（`owner`）；
 *   而 `timeout` 未声明 ⇒ 消费侧**回落到节点级参数**（不是取严）——
 *   两者都是「缺省有语义」，但语义不同 ⇒ 不许把 `natureOf` 的模式照搬过来。
 *
 * @returns 全空 ⇒ `null`（**不写**该字段 —— 「没写」比「写了空对象」干净，同 `refs` 纪律）
 */
export function normalizeTimeoutSpec(v: unknown): TimeoutSpec | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const src = v as Record<string, unknown>
  const out: TimeoutSpec = {}
  if (isPosMs(src['idleMs'])) out.idleMs = src['idleMs']
  if (isPosMs(src['hardCapMs'])) out.hardCapMs = src['hardCapMs']
  return out.idleMs === undefined && out.hardCapMs === undefined ? null : out
}

/** 一行可读（进工具输出：派活方要看见「这条活按什么预算跑」）。未声明 ⇒ 空串（不加噪音）。 */
export function renderTimeoutSpec(spec: TimeoutSpec | null): string {
  if (spec === null) return ''
  const parts: string[] = []
  if (spec.idleMs !== undefined) parts.push('idle ' + String(Math.round(spec.idleMs / 1000)) + 's')
  if (spec.hardCapMs !== undefined) parts.push('硬顶 ' + String(Math.round(spec.hardCapMs / 1000)) + 's')
  return parts.join(' / ')
}
