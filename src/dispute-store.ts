/**
 * 争议记录的落盘（IO 层）—— 三种件**全部走 `wx`**（no-clobber），坏记录**不静默丢**。
 *
 * 与 `claim-store.ts` / `reap-store.ts` 同构（同一套纪律、同一套失败语义），
 * 但**比它们更彻底**：这里连「争议本身」和「每一侧的主张」都是**写一次、永不修改**的记录。
 * ⇒ 目录里没有任何字段会被第二个人改写 ⇒ **不需要锁**（理由见 `dispute.ts` 文件头注）。
 *
 * ★ 终局唯一是怎么保证的：`verdict.json` 走 `wx` —— 两个进程同时裁，
 *   后者拿 `EEXIST` 被拒。**这就是「唯一」需要的全部原子性**，不需要额外 CAS。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DISPUTE_META_FILE, DISPUTE_VERDICT_FILE, claimFileNameOf,
  parseDisputeClaim, parseDisputeMeta, parseDisputeVerdict,
  safeSeg, serializeDisputeClaim, serializeDisputeMeta, serializeDisputeVerdict,
  type DisputeClaim, type DisputeMeta, type DisputeVerdict,
} from './dispute.ts'

/** 争议根目录（**单一真源**：写侧、读侧、文档引用共用）。 */
export function disputesRootOf(busDir: string): string {
  return join(busDir, 'dispute')
}

/** 一条争议的目录。`artifactId` 经 `safeSeg` 净化（它进路径，是外部输入）。 */
export function disputeDirOf(busDir: string, artifactId: string): string {
  return join(disputesRootOf(busDir), safeSeg(artifactId))
}

function writeOnce(dir: string, fileName: string, text: string, what: string): string {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return '建目录失败 ' + dir + '：' + String(e)
  }
  const p = join(dir, fileName)
  try {
    writeFileSync(p, text, { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    return '写' + what + '失败（no-clobber：已存在，或目录不可写）' + p + '：' + String(e)
  }
  return ''
}

/**
 * 开一条争议（登记 meta）。返回 `''` = 成功；非空 = 错误文本。
 * ★ `wx` ⇒ **同一条争议只能被开一次**（重复开是拒，不是覆盖：覆盖会让「谁先开的」消失）。
 */
export function writeDisputeMeta(busDir: string, meta: DisputeMeta): string {
  return writeOnce(disputeDirOf(busDir, meta.artifactId), DISPUTE_META_FILE, serializeDisputeMeta(meta), '争议登记')
}

/** 登记一侧的主张。**同一侧只能写一次**（`claim-<by>.json` 走 `wx`）。 */
export function writeDisputeClaim(busDir: string, artifactId: string, c: DisputeClaim): string {
  return writeOnce(disputeDirOf(busDir, artifactId), claimFileNameOf(c.by), serializeDisputeClaim(c), '主张')
}

/**
 * 落终局。**一条争议只能有一个判词**（`verdict.json` 走 `wx`）。
 *
 * ★ 序列化先于写入求值 ⇒ 它的**校验异常必须在这里接住**并转成错误字符串：
 *   否则一个空短结论句会让工具**崩在半路**，而不是响亮地拒写。
 *   ——「失败必须响」不等于「失败可以炸」。
 */
export function writeDisputeVerdict(busDir: string, artifactId: string, v: DisputeVerdict): string {
  let body: string
  try {
    body = serializeDisputeVerdict(v)
  } catch (e) {
    const msg = (e !== null && e !== undefined && typeof e === 'object' && 'message' in e)
      ? String((e as { message: unknown }).message)
      : String(e)
    return '判词非法（**写侧拦下**，未落盘）：' + msg
  }
  return writeOnce(disputeDirOf(busDir, artifactId), DISPUTE_VERDICT_FILE, body, '判词')
}

/**
 * 处置面的状态 —— ★ **空 dispositions 的默认读法必须是「不可数」，不是「无异议」**
 *   （2026-10-12 · 由哨指出，逐字）：
 *   > 缺格子的**默认读法**必须是「**不可数**」，不能是「并立依旧成立」，也不能是「无异议」……
 *   > **空格的默认语义如果落在「没意见」，那条老判词就又被当成有内容的了**：
 *   > 「并立」当时只是一句措辞这件事，**得由结构说，不是由注释说**。
 *
 * ⇒ 所以它是一个**显式三态**（+ 一个「无判词」档），而不是「数组空不空」这种要靠人猜的东西：
 *   · `none` —— 还没有判词（**不是**「无异议」）
 *   · `legacy-unavailable` —— 判词早于该字段（如实标：**不可数**）
 *   · `missing` —— ⚠ **v3 判词却没有处置清单，而两侧是有主张的** ⇒ **异常**：
 *     写侧本该拦（`validateDispositions`），但**直接调 store 能绕过工具**（成员织就用过这条路径）
 *     ⇒ 读的人必须看到「这里本该有东西而它不在」，**不是**看到一片安静
 *   · `complete` —— 有处置清单
 */
export type DispositionsState = 'none' | 'legacy-unavailable' | 'missing' | 'complete'

/** 读回一条争议的全貌。 */
export interface DisputeBundle {
  meta: DisputeMeta
  claims: DisputeClaim[]
  verdict: DisputeVerdict | null
  /** 处置面的状态（见 `DispositionsState` 头注 —— **空 ≠ 无异议**） */
  dispositionsState: DispositionsState
  /** 该目录里读不出的文件名（**原样保留**，不覆盖不删 —— 它本身是证据） */
  bad: string[]
}

/** 判定一条争议的处置面状态（纯逻辑抽出 ⇒ 可离线测）。 */
export function dispositionsStateOf(
  verdict: DisputeVerdict | null,
  claimCount: number,
): DispositionsState {
  if (verdict === null) return 'none'
  if (verdict.legacyNoDispositions) return 'legacy-unavailable'
  if (verdict.dispositions.length > 0) return 'complete'
  // 空且**有主张** ⇒ 异常（写侧本该拦）；空且**零主张** ⇒ 合法（没有东西可处置）
  return claimCount > 0 ? 'missing' : 'complete'
}

/**
 * 读全部争议。
 *
 * ⚠ **「空」与「读不到」是两件事**：
 *   · `dispute/` **不存在 = 首次使用的常态**（返回空表，不是错误）
 *   · 目录存在但**某个子目录读不出 / 文件解析失败** ⇒ 逐条进 `bad`，且**不假装它不存在**
 *   · 子目录里**没有 `meta.json`** ⇒ 进 `bad`（有主张没登记 = 形态不全，读的人要知道）
 */
export function loadDisputes(busDir: string): { list: DisputeBundle[]; bad: string[] } {
  const list: DisputeBundle[] = []
  const bad: string[] = []
  const root = disputesRootOf(busDir)
  let dirs: string[]
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return { list, bad }
  }
  for (const d of dirs) {
    const dir = join(root, d)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch (e) {
      bad.push(d + '：目录读不了（' + String(e) + '）')
      continue
    }
    const bundleBad: string[] = []
    let meta: DisputeMeta | null = null
    let verdict: DisputeVerdict | null = null
    const claims: DisputeClaim[] = []
    for (const f of files) {
      let text: string
      try {
        text = readFileSync(join(dir, f), 'utf8')
      } catch (e) {
        bundleBad.push(f + '：读不了（' + String(e) + '）')
        continue
      }
      if (f === DISPUTE_META_FILE) {
        meta = parseDisputeMeta(text)
        if (meta === null) bundleBad.push(f + '：内容不是合法登记（**原文件已保留**）')
        continue
      }
      if (f === DISPUTE_VERDICT_FILE) {
        verdict = parseDisputeVerdict(text)
        if (verdict === null) bundleBad.push(f + '：内容不是合法判词（**原文件已保留**）')
        continue
      }
      if (f.startsWith('claim-')) {
        const c = parseDisputeClaim(text)
        if (c === null) bundleBad.push(f + '：内容不是合法主张（**原文件已保留**）')
        else claims.push(c)
        continue
      }
      bundleBad.push(f + '：不认识的文件名（既不是 meta/verdict，也不以 claim- 开头）')
    }
    if (meta === null) {
      bad.push(d + '：**没有合法 `meta.json`**（有主张没登记 ⇒ 形态不全）'
        + (bundleBad.length > 0 ? ' · ' + bundleBad.join('；') : ''))
      continue
    }
    claims.sort((a, b) => a.atMs - b.atMs)
    list.push({ meta, claims, verdict, dispositionsState: dispositionsStateOf(verdict, claims.length), bad: bundleBad })
    for (const b of bundleBad) bad.push(d + '/' + b)
  }
  list.sort((a, b) => a.meta.atMs - b.meta.atMs)
  return { list, bad }
}

/* ── 痕迹（`<bus>/manor-dispute.jsonl`）──────────────────────────────
 * 由 `index.ts` 的三处工具写入各追加一行（`dispute-open` / `dispute-claim` / `dispute-judge`）。
 * ⚠ 为什么需要它：修前这三处写入**完全不落任何 trace** ⇒ 「走正规路径」与「手搓 JSON」
 *   在盘上没有任何可区分之处（成员织的论点，2026-10-12）。留痕 + 对账 = 补观测面，不是防线。
 * ⚠ `traceChange` **吞错**（写不进不致命）⇒ **「读不到 trace」不能当成「没人绕路」**：
 *   本函数把 `missing`（文件不存在）与「文件在但空」分开报，调用方据此判「不可判」。
 */

export const DISPUTE_TRACE_FILE = 'manor-dispute.jsonl'

export interface DisputeTraceEvent {
  op: string
  artifactId: string
  by: string
  atMs: number
  /**
   * 锚①：主张的 `refs` **条数**。**`-1` = 这一行没落锚。**
   * ⚠ 它叫 `refsCount` 而**不是** `refs`（2026-10-12 改名 · 成员织 §3.5（三）指出，我认）：
   *   同一个名字 `refs` 在 `manor_dispute` 的参数 schema 里是**数组** ⇒
   *   读侧一旦开始读它，trace 行里的 `refs: 2` 就是一个**同名不同义**的隐蔽契约别名
   *   （任何人看到 `refs` 都会默认它是数组）。
   *   ⇒ 改名时盘上 `manor-dispute.jsonl` **尚不存在**（现读核实）⇒ 零移民成本；
   *     将来若真有旧行，它读出来是 `-1` ⇒ 落 `no-anchor`（**不假报「一致」**，取严方向正确）。
   */
  refsCount: number
  /** 锚②：主张正文的摘要（`digestOf`，写读共用的**同一函数**）。**`''` = 这一行没落锚。** */
  textDigest: string
}

export interface DisputeTrace {
  events: DisputeTraceEvent[]
  /** 坏行数（**不抛**：一行坏不该带塌整份 trace） */
  broken: number
  /** 文件不存在 —— **与「文件在但空」是两件事**（前者 = 机制没上线 / 被删；后者 = 上线了还没人写过） */
  missing: boolean
}

export function loadDisputeTrace(bus: string): DisputeTrace {
  let text = ''
  try {
    text = readFileSync(join(bus, DISPUTE_TRACE_FILE), 'utf8')
  } catch {
    return { events: [], broken: 0, missing: true }
  }
  const events: DisputeTraceEvent[] = []
  let broken = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const raw = JSON.parse(t) as Record<string, unknown>
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { broken += 1; continue }
      const op = typeof raw['op'] === 'string' ? raw['op'] : ''
      const artifactId = typeof raw['artifactId'] === 'string' ? raw['artifactId'] : ''
      const by = typeof raw['by'] === 'string' ? raw['by'] : ''
      const atMs = typeof raw['atMs'] === 'number' && Number.isFinite(raw['atMs']) ? raw['atMs'] : 0
      // 三个字段缺一不可对账 —— 缺了就进 broken（**不猜**：用「同 artifactId 的第一条」代替是编造）
      if (op === '' || artifactId === '' || by === '') { broken += 1; continue }
      // ★ 锚字段**缺了不算 broken**（与上面三个字段**不同级**）：旧行按定义没有锚 ——
      //   「旧」是**合法状态**，不是坏内容。⇒ 缺就走哨兵值，由读侧判成 `no-anchor`。
      //   （织 §1.3：「缺字段就是缺，不许有默认值」—— 哨兵**不是**默认值：
      //     它的下游是「这个问题问不出来」，而不是「一致」。两边方向正好相反。）
      const refsCount = typeof raw['refsCount'] === 'number' && Number.isFinite(raw['refsCount'])
        ? raw['refsCount']
        : -1
      const textDigest = typeof raw['textDigest'] === 'string' ? raw['textDigest'] : ''
      events.push({ op, artifactId, by, atMs, refsCount, textDigest })
    } catch {
      broken += 1
    }
  }
  return { events, broken, missing: false }
}
