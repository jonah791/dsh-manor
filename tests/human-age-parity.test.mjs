/**
 * **跨边界对照**：同一个 `ms` 喂给两位 `humanAge`，比输出。
 *
 * 为什么需要它（判据由成员织在复核里给出，2026-10-12）：
 *   我在复核回执里写了「对照我跑了」—— 但那是**手跑的**。她原话：
 *   **「手跑的仪器只在你记得跑的时候存在。」**
 *   而 ④d 只打在 `stranded-bus.ts` 这一份上 ⇒ 它证明的是「**我这份有保护**」，
 *   **不是「两份同形」**。要证后者，**得有一条夹具把同一个 `ms` 同时喂给两位、比输出** ——
 *   否则「**声明同源**」是**注释里的承诺，而注释不会变红**。
 *
 * ⚠ 本文件**跨构建单元**：`stranded.mjs` 活在适配器进程（不经 TS 构建），
 *   `src/stranded-bus.ts` 活在插件构建单元 —— 它俩**物理上并不了**，
 *   所以这条可红的保障只能长在测试里，长不成一次合并。
 *
 * ⚠ **边界（诚实标注）**：本测试判的是「**两份一致**」，**不是「两份都对」**。
 *   若要判对，得另有一条拿**已知正确答案**做基准的判据（那是另一件事，不在这条里）。
 *
 * 运行：node --test tests/human-age-parity.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ⚠ 相对路径**跨仓树**：`stranded.mjs` 在 `projects/self/alice-manor/`（适配器侧），
//   本测试在 `self-plugins/manor/tests/`（插件侧）—— 这本身就是「结构性重复」的地形证据。
import { humanAge as mjsAge } from '../../../projects/self/alice-manor/stranded.mjs'
import { humanAge as tsAge } from '../src/stranded-bus.ts'

/** 边界与极端值 —— 每一条都可能让两份分叉。 */
const CASES = [
  0, 1, 999, 59_999, 60_000, 1_799_999, 3_599_999,
  3_600_000, 5_400_000, 86_400_000, 172_799_999, 172_800_000,
  86_400_000 * 27.3, 86_400_000 * 365,
  -1, -60_000, -86_400_000, Number.NaN, Number.POSITIVE_INFINITY,
]

test('★ 两份 `humanAge` 对同一个 `ms` 必须给出同一串（含负数与极端值）', () => {
  const diff = []
  for (const ms of CASES) {
    const a = mjsAge(ms)
    const b = tsAge(ms)
    if (a !== b) {
      diff.push(String(ms) + ' ⇒ stranded.mjs=' + JSON.stringify(a) + ' / stranded-bus.ts=' + JSON.stringify(b))
    }
  }
  assert.deepEqual(diff, [], '★ 任何一格不同 ⇒「声明同源」已经变成假承诺，改一处必须一起改')
})

test('★ 负值不得渲染成负数（两份都要守）', () => {
  for (const ms of [-1, -60_000, -86_400_000]) {
    assert.ok(!/-/.test(mjsAge(ms)), 'stranded.mjs 对 ' + String(ms) + ' 输出了负数')
    assert.ok(!/-/.test(tsAge(ms)), 'stranded-bus.ts 对 ' + String(ms) + ' 输出了负数')
  }
})

test('★ 对照本身要有分辨力：**故意造一个分叉，它必须红**', () => {
  // 与上面同一个比较逻辑，但喂两条已知不同的实现 —— 若这条也绿，说明判据是恒真的。
  const a = (ms) => 'A' + String(ms)
  const b = (ms) => 'B' + String(ms)
  const diff = CASES.filter((ms) => a(ms) !== b(ms))
  assert.equal(diff.length, CASES.length, '★ 对照组必须整列不同 —— 否则说明这套比较逻辑本身无分辨力')
})
