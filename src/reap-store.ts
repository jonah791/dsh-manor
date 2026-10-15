/**
 * 裁决记录的落盘（IO 层）—— 写走 `wx`（no-clobber），坏记录**不静默丢**。
 *
 * 与 `claim-store.ts` 同构（同一套纪律、同一套失败语义），差别只在**写一次就不再变**：
 * 裁决是「一个已经作出的判断」，没有续期、没有抢占、没有过期。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReap, reapFileNameOf, serializeReap, type ReapRecord } from './reap.ts'

/** 裁决目录（**单一真源**：写侧、读侧、文档引用共用）。 */
export function reapDirOf(busDir: string): string {
  return join(busDir, 'reap')
}

/**
 * 写一条裁决。返回 `''` = 成功；非空 = 错误文本。
 *
 * ★ 走 `wx`（`O_EXCL`）⇒ **同一条活只能被裁决一次**。
 *   幂等的形态在这里是「第二次**拒**」而不是「覆盖」：覆盖会让「谁先判的、为什么」消失，
 *   而裁决的全部价值正在于它是**谁的判断**（`by` 字段只有配 no-clobber 才立得住）。
 */
export function writeReap(busDir: string, rec: ReapRecord): string {
  const dir = reapDirOf(busDir)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return '建目录失败 ' + dir + '：' + String(e)
  }
  const p = join(dir, reapFileNameOf(rec.taskId))
  try {
    writeFileSync(p, serializeReap(rec), { encoding: 'utf8', flag: 'wx' })
  } catch (e) {
    return '写裁决失败（no-clobber：这条活已有裁决，或目录不可写）' + p + '：' + String(e)
  }
  return ''
}

/**
 * 读全部裁决：正常进 `records`，坏记录进 `bad`（**不静默丢** —— 与 `loadClaims` 同纪律）。
 *
 * ⚠ **目录不存在 = 首次使用的常态**（返回空，不是错误）；
 *   而**目录存在但文件全读不出** ⇒ 每一条都进 `bad`（「空」与「读不到」是两件事）。
 */
export function loadReaps(busDir: string): { records: Map<string, ReapRecord>; bad: string[] } {
  const records = new Map<string, ReapRecord>()
  const bad: string[] = []
  const dir = reapDirOf(busDir)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return { records, bad }
  }
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch (e) {
      bad.push(f + '：读不了（' + String(e) + '）')
      continue
    }
    const rec = parseReap(text)
    if (rec === null) {
      // ★ 坏记录**原样保留**（fail-closed，不覆盖不删）—— 它本身是证据。
      bad.push(f + '：内容不是合法裁决（**原文件已保留，不覆盖不删**）')
      continue
    }
    records.set(rec.taskId, rec)
  }
  return { records, bad }
}
