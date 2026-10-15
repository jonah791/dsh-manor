/**
 * `claim` 的 **IO 层** —— 独占领取的落盘与原子操作（③ 竞争面 · E12）。
 *
 * 为什么单独成模块（与 `hold-store.ts` 同理）：闭包里的逻辑**只能在真插件组合里跑**，
 * 而这一层的判据（尤其是**原子性**）必须在**真磁盘**上重跑 ⇒ 路径全部显式入参，
 * 可以在临时总线上做端到端验收。
 *
 * ★ 两条**原子操作**，本模块的全部要害都在这里：
 *   ① **领取 = `writeFileSync(..., { flag: 'wx' })`** —— `O_EXCL` 语义：
 *      「创建**已存在**的文件会失败」是文件系统上唯一不需要锁的原子操作。
 *      ⇒ 并发两笔，恰好一个拿到 `EEXIST` 之外的路径。
 *   ② **过期抢占 = `renameSync` 的 CAS** —— 抢占本质是 read-check-write（**非原子**），
 *      故先把旧记录 `rename` 进 `expired/`：**同分区 rename 原子、只有一个能成功**；
 *      成功者才获得「写新 claim」的资格。
 *
 * ⚠ **fail-closed 的三处**（都不静默）：
 *   - 坏记录 ⇒ `blocked`，**不覆盖、不删除**（它是证据）；
 *   - `wx` 抛 `EEXIST` 之外的错（权限/磁盘）⇒ 原样抛出（**不吞**）；
 *   - `rename` 失败（别人先抢到）⇒ 如实报「已被抢」，**不硬写**。
 *
 * ⚠ **单测覆盖的是顺序语义**（两笔依次调用）；**真并发**（两个进程同时领）无法在纯单测里证
 *   —— 那属**活体验收**（与 `kindmap-contract.test.ts` 同一种诚实：盘上/进程条件不具备时
 *   **显式 SKIP**，不假绿）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAIM_DIRNAME,
  CLAIM_EXPIRED_DIRNAME,
  DEFAULT_CLAIM_TTL_MS,
  buildClaimRecord,
  claimFileNameOf,
  judgeClaim,
  parseClaim,
  serializeClaim,
  type ClaimJudgement,
  type ClaimRecord,
} from './claim.ts'

export const claimDirOf = (busDir: string): string => join(busDir, CLAIM_DIRNAME)
export const expiredDirOf = (busDir: string): string => join(claimDirOf(busDir), CLAIM_EXPIRED_DIRNAME)
export const claimPathOf = (busDir: string, taskId: string): string =>
  join(claimDirOf(busDir), claimFileNameOf(taskId))

/**
 * 读一条 claim。**三态必须分开**（这是「读不到 ≠ 不在」在入口处的落点）：
 *   - `undefined` = 确认**不存在** ⇒ 可领取
 *   - `null`      = **存在但读不出/结构不符** ⇒ fail-closed
 *   - 记录        = 正常
 */
export function readClaim(busDir: string, taskId: string): ClaimRecord | undefined | null {
  const p = claimPathOf(busDir, taskId)
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return undefined // 不存在（含目录不存在）
  }
  return parseClaim(text)
}

/** 过期留痕的文件名：**带时刻** ⇒ 同一件活被抢占多次时不会互相覆盖。 */
const expiredNameOf = (taskId: string, atMs: number): string =>
  taskId + '-' + String(atMs) + '.json'

export interface ClaimResult extends ClaimJudgement {
  /** 抢占留痕的落点（仅 `takeover` 时非空；空串 = 未留痕）。 */
  expiredPath: string
}

/**
 * **原子领取**。全部判定走 `judgeClaim`（纯层），本函数只做「按判定去落盘」。
 *
 * 失败模式逐条显式：`granted` / `renewed` / `denied` / `takeover` / `blocked`。
 */
export function tryClaim(
  busDir: string,
  taskId: string,
  holder: string,
  nowMs: number,
  ttlMs: number = DEFAULT_CLAIM_TTL_MS,
): ClaimResult {
  mkdirSync(claimDirOf(busDir), { recursive: true })
  const p = claimPathOf(busDir, taskId)
  const rec = buildClaimRecord(taskId, holder, nowMs, ttlMs)

  // ① 快路径：wx 新建（原子）
  try {
    writeFileSync(p, serializeClaim(rec), { flag: 'wx' })
    return { ...judgeClaim(undefined, taskId, holder, nowMs, ttlMs), expiredPath: '' }
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code !== 'EEXIST') throw e // 权限/磁盘错误：**不吞**，如实抛出
  }

  // ② 已存在 ⇒ 读 + 判
  const existing = readClaim(busDir, taskId)
  const j = judgeClaim(existing, taskId, holder, nowMs, ttlMs)

  if (j.decision === 'renewed') {
    writeFileSync(p, serializeClaim(rec)) // 同一持有人：覆盖 = 续期（新 at 落盘 ⇒ 续期可见）
    return { ...j, expiredPath: '' }
  }
  if (j.decision === 'denied' || j.decision === 'blocked') return { ...j, expiredPath: '' }

  // ③ takeover：先 rename 旧记录留痕（CAS），成功者才写新记录
  mkdirSync(expiredDirOf(busDir), { recursive: true })
  const exp = join(expiredDirOf(busDir), expiredNameOf(taskId, nowMs))
  try {
    renameSync(p, exp) // ★ 原子：并发抢占里只有一个能成功
  } catch {
    // 别人先抢到了（或旧文件已不在）⇒ 如实报，不硬写
    const after = readClaim(busDir, taskId)
    const j2 = judgeClaim(after, taskId, holder, nowMs, ttlMs)
    return {
      ...j2,
      decision: j2.decision === 'takeover' ? 'blocked' : j2.decision,
      note: j2.decision === 'takeover'
        ? '**抢占失败**：rename 竞争中被别人先取走，且新记录仍未成型 ⇒ 未取得（请重试）'
        : j2.note,
      expiredPath: '',
    }
  }
  try {
    writeFileSync(p, serializeClaim(rec), { flag: 'wx' })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'EEXIST') {
      // 极窄窗口：rename 与 wx 之间别人插进来 ⇒ 旧记录已留痕，本次未取得
      return {
        ...j,
        decision: 'denied',
        note: '**抢占未完成**：旧记录已留痕（`' + exp + '`），但新记录被他人抢先写入 ⇒ 本次未取得',
        holder,
        remainMs: 0,
        expiredPath: exp,
      }
    }
    throw e
  }
  return { ...j, expiredPath: exp }
}

/**
 * **自愿释放**。只有持有人自己能释放 —— 别人替他释放就是**夺权**
 * （本文档 §5.19 单点所有权；`roster-lock` 的「释放不夺权」同一条纪律）。
 */
export function releaseClaim(
  busDir: string,
  taskId: string,
  holder: string,
): { ok: boolean; note: string } {
  const p = claimPathOf(busDir, taskId)
  const cur = readClaim(busDir, taskId)
  if (cur === undefined) return { ok: false, note: '没有这条 claim（可能已释放或从未领过）' }
  if (cur === null) {
    return { ok: false, note: '**记录坏** ⇒ 不动作（fail-closed：坏记录是证据，不删）' }
  }
  if (cur.holder !== holder) {
    return {
      ok: false,
      note: '**拒绝释放**：持有人是 `' + cur.holder + '`，你是 `' + holder
        + '` ⇒ 替别人释放就是夺权（若要接管，等它过期后走抢占，那条路会留痕）',
    }
  }
  try {
    unlinkSync(p)
  } catch {
    return { ok: false, note: '删除失败（可能已被释放）' }
  }
  return { ok: true, note: '已释放（**主动释放不留痕** —— 留痕只给抢占，因为那才是需要解释的动作）' }
}

const readClaimTextSafe = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** 列全部 claim（供可见面用）。坏记录单独收集，**不静默丢**。 */
export function loadClaims(busDir: string): { records: ClaimRecord[]; bad: string[] } {
  const dir = claimDirOf(busDir)
  if (!existsSync(dir)) return { records: [], bad: [] }
  const records: ClaimRecord[] = []
  const bad: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return { records: [], bad: [] }
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const text = readClaimTextSafe(join(dir, n))
    if (text === null) {
      bad.push(n + '：读不到')
      continue
    }
    const r = parseClaim(text)
    if (r === null) {
      bad.push(n + '：结构不符')
      continue
    }
    records.push(r)
  }
  return { records, bad }
}
