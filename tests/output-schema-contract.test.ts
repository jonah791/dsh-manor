/**
 * 工具出参与 `output.schema` 的**声明对账**（源码级契约测试）。
 *
 * ## 存在理由（2026-10-14 端到端验收当场抓出）
 *
 * 给 `manor_find` 加「适配器新鲜度」时，我改了 `MemberRow` 接口 + `collectOne` 的返回体，
 * **却漏了 `output.schema` 里 `members.items.properties` 那一份**。
 * 后果不是「读数少一格」——`dsh-tools` 从 schema **推断**返回类型并在**运行时严格校验**
 * （`additionalProperties: false`），于是整个工具**直接报错**：
 *
 *   Error: tool "manor_find" returned invalid output:
 *     "value.members[0].startedAtMs" is not a declared property (additionalProperties: false)
 *
 * ⚠ **测试全绿也发现不了它**：412 tests / 408 pass / 0 fail —— 因为没有任何测试
 *   把「返回体有哪些键」与「schema 声明了哪些键」对起来。**判据不在同一层**
 *   （§5.9 规则 5：绿只证明判据被满足，不证明它检出了目标）。
 *
 * ## 本测试补的那一格
 *
 * 返回体的键集 **⊆** schema 声明的键集。这是**必要条件**，不是充分条件
 * （值类型 / required 是否对得上仍归运行时校验）——但它恰好拦住了今天这个形态。
 *
 * ⚠ 本测试是**源码级**（读 `src/index.ts` 文本），不是行为级：它不需要起进程、
 *   不碰总线。理由：这个缺陷的触发点是**声明与实现的错位**，而那个错位在源码里
 *   就是两个文本块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src', 'index.ts')

/** 从源码文本里截出一段花括号平衡的块（从 `startMarker` 起，到匹配的 `}` 止）。 */
function braceBlock(text: string, startMarker: string): string | null {
  const at = text.indexOf(startMarker)
  if (at < 0) return null
  const open = text.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

/** 取出一个块里所有 `键: {` 形态的属性名（schema 属性声明的形态）。 */
function declaredKeys(block: string): string[] {
  const out: string[] = []
  for (const m of block.matchAll(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/gm)) {
    if (m[1] !== undefined) out.push(m[1])
  }
  return out
}

test('契约：MemberRow 的每个字段都必须在 output.schema 里声明（今天正是这里漏了）', () => {
  const text = readFileSync(SRC, 'utf8')

  const iface = braceBlock(text, 'export interface MemberRow')
  assert.ok(iface !== null, 'MemberRow 接口必须能被截出（截不出 ⇒ 本测试自己失效，响亮失败）')
  // 接口里的字段形态是 `  name: string` / `  /** 注释 */\n  name: number`
  const ifaceKeys: string[] = []
  for (const m of (iface as string).matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) {
    if (m[1] !== undefined) ifaceKeys.push(m[1])
  }
  assert.ok(ifaceKeys.length >= 20, 'MemberRow 字段数应 ≥20（现读 22）；过少说明正则失效')

  // schema 里 members.items.properties 那一段
  const items = braceBlock(text, 'members: {\n            type: \'array\'')
  assert.ok(items !== null, 'members schema 必须能被截出')
  const propIdx = (items as string).indexOf('properties:')
  assert.ok(propIdx > 0, 'members.items 必须带 properties 段')
  const props = braceBlock((items as string).slice(propIdx), 'properties:')
  assert.ok(props !== null, 'properties 段必须能被截出')
  const schemaKeys = declaredKeys(props as string)
  assert.ok(schemaKeys.length >= 20, 'schema 属性数应 ≥20；过少说明正则失效')

  // ★ 本测试的断言：接口字段 **一个都不许漏**在 schema 之外
  const missing = ifaceKeys.filter((k) => !schemaKeys.includes(k))
  assert.deepEqual(
    missing,
    [],
    '这些 MemberRow 字段没在 output.schema 里声明 ⇒ 工具会因 additionalProperties:false 直接报错：'
      + missing.join(', '),
  )
})

test('契约：schema 的属性名不得拼错（错一个 ⇒ 运行时拒绝，且只在调用时才炸）', () => {
  const text = readFileSync(SRC, 'utf8')
  const items = braceBlock(text, 'members: {\n            type: \'array\'')
  assert.ok(items !== null)
  const propIdx = (items as string).indexOf('properties:')
  const props = braceBlock((items as string).slice(propIdx), 'properties:')
  assert.ok(props !== null)
  const schemaKeys = declaredKeys(props as string)
  // 现场读数里的关键字段必须在场（防「整体重写 schema 时丢字段」）
  for (const k of ['id', 'startedAtMs', 'inboxLine', 'canWake', 'heartbeatAgeMs']) {
    assert.ok(schemaKeys.includes(k), 'schema 缺字段：' + k)
  }
  // 不得有重复声明（重复 ⇒ 后者覆盖前者，静默改语义）
  assert.equal(new Set(schemaKeys).size, schemaKeys.length, 'schema 属性名有重复：'
    + schemaKeys.filter((k, i) => schemaKeys.indexOf(k) !== i).join(', '))
})

test('契约：适配器新鲜度的口径必须是「成员适配器」——主脑 web-0 不该进 unknown 桶', () => {
  const text = readFileSync(SRC, 'utf8')
  // 现场读数（2026-10-14 11:32）：首版把全体节点塞进桶 ⇒ 主脑 `web-0` 恒报「判不了 1 个」。
  // 它**根本不是适配器**（harness ≠ MANOR_ADAPTER_HARNESS）⇒ 那是永久噪音，会淹掉真异常。
  const at = text.indexOf('summarizeStaleAdapters(')
  assert.ok(at > 0, 'summarizeStaleAdapters 调用必须能被定位')
  const call = text.slice(at, at + 400)
  assert.match(
    call,
    /filter\(\(m\) => m\['harness'\] === MANOR_ADAPTER_HARNESS\)/,
    '调用前必须先按 harness 过滤——否则非适配器节点（主脑）会被计入 unknown',
  )
})

test('契约：collectOne 返回体与 MemberRow 的键必须同源（今天漏的就是这一格）', () => {
  const text = readFileSync(SRC, 'utf8')
  // ⚠ 标记里没有 `{`（`rec['atMs']` 是方括号）⇒ `braceBlock` 截到的**就是** return 的块。
  const body = braceBlock(text, 'const fresh = judgeFresh(')
  assert.ok(body !== null, 'collectOne 的返回块必须能被截出')
  const retKeys: string[] = []
  // 缩进 = 6 空格；**逗号也要收**——`id,` 是 ES 简写属性（无冒号），
  // 只匹配 `\s*:` 会静默漏掉它（本测试自己踩过：第一次跑 length 兜底抓住了）。
  for (const m of body.matchAll(/^ {6}([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/gm)) {
    if (m[1] !== undefined) retKeys.push(m[1])
  }
  assert.ok(retKeys.length >= 20, '返回体键数应 ≥20；过少说明正则失效')

  const iface = braceBlock(text, 'export interface MemberRow')
  assert.ok(iface !== null)
  const ifaceKeys: string[] = []
  for (const m of (iface as string).matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) {
    if (m[1] !== undefined) ifaceKeys.push(m[1])
  }

  const missing = ifaceKeys.filter((k) => !retKeys.includes(k))
  assert.deepEqual(missing, [], '接口声明了但 collectOne 没返回：' + missing.join(', '))
  // ★ 反向：返回体不得有接口外的野字段（那会让 schema 校验炸）
  const extra = retKeys.filter((k) => !ifaceKeys.includes(k))
  assert.deepEqual(extra, [], 'collectOne 返回了接口外的字段：' + extra.join(', '))
})
