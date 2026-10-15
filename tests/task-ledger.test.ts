/**
 * 庄园任务台账（作业层）纯函数测试。
 *
 * 纪律（技能 acceptance-integrity）：**判据器必须先证明自己会拒** ——
 * 前三个用例是 **2026-10-11 现场踩出来的口径坑**做成的尸体样本（C1/C2/C3），
 * 它们证明台账的判据有分辨力，而不是「恰好这几次没数错」。
 *
 * 夹具用的是**真实日志原文**（从 `logs/actions/*.jsonl` 逐字抄来），不是编的
 * —— 编的样本只会证明代码自洽，证明不了它对准了现实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CLUSTER_IDS,
  classifyFailure,
  classifyReject,
  extractReceipts,
  foldTasks,
  isTaskFailure,
  parseActionLine,
  parseActionLog,
  renderFailureClusters,
  renderFilteredEmptyNote,
  renderLedger,
  summarizeReceipts,
  summarizeTasks,
  type TaskRecord,
} from '../src/task-ledger.ts'

// ═══════════════════════════════════════════════════════════════════════════
// ★★ 回执面（2026-10-14 · ⑥ 面「质量验收」后半格的**可见面**）
//
// 存在理由：修前那一格**没有可见面** —— `manor_tasks` 自写着「本行不答后半格」，
//   而**数据在盘上**（现读：656 封带 meta 的信封里 106 封有 evidence）
//   ⇒ 又一次「数据在、可见面不在」（与 E13「仪器早就有、只被自己引用」同型）。
//
// ⚠ **三格必须分开，本套件就是那条判据**：
//   ① 写了判据（派活侧）② 收到回执（回执侧）③ **判据是否满足**（**不答**）
// ═══════════════════════════════════════════════════════════════════════════

test('★ extractReceipts：正常回执 ⇒ 抽出投影（id/taskId/from/status/证据数/字符数）', () => {
  const { receipts, orphanCount } = extractReceipts([
    {
      id: 'm-1', from: 'maid-04', kind: 'result', createdAt: 1791954034340,
      meta: {
        taskId: 't-x', status: 'ok',
        evidence: [{ kind: 'text', chars: 5, inline: { encoding: 'utf8', data: 'hello' } }],
        unverified: [],
      },
    },
  ])
  assert.equal(orphanCount, 0)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0]!.taskId, 't-x')
  assert.equal(receipts[0]!.from, 'maid-04')
  assert.equal(receipts[0]!.evidenceCount, 1)
  assert.equal(receipts[0]!.evidenceChars, 5, 'inline.data 优先（按实际字符数）')
})

test('★ extractReceipts：没带 `meta.taskId` 的回执 ⇒ 计入 orphan，**不混进配对**', () => {
  const { receipts, orphanCount } = extractReceipts([
    { id: 'm-2', from: 'maid-01', kind: 'result', meta: { taskId: '', status: 'ok' } },
    { id: 'm-3', from: 'maid-01', kind: 'result', meta: { status: 'ok' } },
  ])
  assert.equal(receipts.length, 0)
  assert.equal(orphanCount, 2, '★ 对不上任何活的回执**分开报**，不许当成「有回执」')
})

test('★★ 真调抓出的判据缺陷：`kind:"chat"` 带 meta 但没 taskId ⇒ **不是 orphan**（它本来就不该有）', () => {
  // 2026-10-14 真盘读数：初版把「有 meta 但没 taskId」一律算 orphan ⇒ 读出 **363 个**，
  //   而其中 **353 个是 chat** —— chat 是**对话**，带 meta 但不带 taskId 是**正常的**。
  //   ⇒ 「把两个不同的东西装进一个读数」的第四次（且是我刚写下那条判据之后又犯的）。
  const { receipts, orphanCount } = extractReceipts([
    { id: 'c-1', from: 'maid-01', kind: 'chat', meta: { chatRound: 1, chatBudget: 6 } },
    { id: 'c-2', from: 'maid-02', kind: 'chat', meta: {} },
  ])
  assert.equal(receipts.length, 0)
  assert.equal(orphanCount, 0, '★ chat 不许算 orphan —— 判据必须先按 kind 筛，再判 taskId')
})

test('★★ 翻断言（2026-10-14 由成员勘抓出）：`kind:"task"` **不是回执**（它是**派活**，方向相反）', () => {
  // ⚠ 本条**替换**了旧断言 `kind:"task" 也算回执候选` —— **旧断言在保护 bug**。
  //   真形状（勘当场抓出，我独立复算逐字相符）：`task` 是**派活**信封（作者 → 执行者），
  //   方向**与回执相反**；把它计进回执面会**高估**「收到回执」——
  //   实测 **125 封 `task` 里有 114 封带 taskId**，全部落进回执面 ⇒ 那一格虚高 **114**。
  //   ★ 这是**同一次失误的漏网**：源码头注早记过「初版把 `chat` 算 orphan，363 里 353 是 chat」
  //     —— **修了 chat，没修 task**。
  //   ★ 勘给的判据原话：「**只有 `kind:"result"` 才『该带 taskId』**」⇒ 真 orphan **31 → 20**。
  const { receipts, orphanCount } = extractReceipts([
    { id: 't-1', from: 'alice', kind: 'task', meta: { taskId: 't-abc', status: 'ok' } },
  ])
  assert.equal(receipts.length, 0, '★ 派活信封不许被当成回执')
  assert.equal(orphanCount, 0, '★ 且它**也不是 orphan** —— 它是「不该进这一格」的信封，不是「缺 taskId 的回执」')
})

test('★ 对照：只有 `kind:"result"` 进回执面（同一批里 task 必须落空）', () => {
  // 与上一条配对：证明这不是「把所有东西都排除」的过度收紧 —— result 照旧进。
  const { receipts } = extractReceipts([
    { id: 'm-1', from: 'maid-01', kind: 'result', meta: { taskId: 't-abc', status: 'ok', evidence: [{ inline: { data: 'x' } }] } },
    { id: 't-1', from: 'alice', kind: 'task', meta: { taskId: 't-abc', status: 'ok' } },
  ])
  assert.equal(receipts.length, 1, '★ 只有 result 那一封该进')
  assert.equal(receipts[0]!.from, 'maid-01')
})

test('★ extractReceipts：无 meta 的信封 ⇒ **既不是回执也不是 orphan**（它是普通信封）', () => {
  const { receipts, orphanCount } = extractReceipts([{ id: 'm-4', from: 'maid-01', kind: 'chat', text: 'hi' }])
  assert.equal(receipts.length, 0)
  assert.equal(orphanCount, 0, '普通信封不该被算成「缺 taskId 的回执」')
})

test('★ extractReceipts：形状怪（evidence 不是数组 / chars 非数）⇒ 记 0，**不把形状怪当有证据**', () => {
  const { receipts } = extractReceipts([
    { id: 'm-5', from: 'x', kind: 'result', meta: { taskId: 't-y', evidence: 'not-an-array', unverified: 'nope' } },
  ])
  assert.equal(receipts[0]!.evidenceCount, 0)
  assert.equal(receipts[0]!.evidenceChars, 0)
  assert.equal(receipts[0]!.unverifiedCount, 0)
})

test('★ extractReceipts：`chars` 兜底只在**没有 inline.data** 时用（不重复累加）', () => {
  const { receipts } = extractReceipts([
    {
      id: 'm-6', from: 'x', kind: 'result',
      meta: {
        taskId: 't-z',
        evidence: [
          { kind: 'text', chars: 999, inline: { data: 'abc' } }, // inline 优先 ⇒ 3
          { kind: 'text', chars: 7 },                            // 无 inline ⇒ 7
        ],
      },
    },
  ])
  assert.equal(receipts[0]!.evidenceChars, 10, '3 + 7；第一项不许用 chars=999（那会虚报）')
})

test('★ summarizeReceipts：**有判据却无回执** ⇒ 单列一档（判据悬空，最该追）', () => {
  const acc = new Map([['t-a', '检查 X'], ['t-b', '']])
  const r = summarizeReceipts(acc, [
    { id: 'm-7', taskId: 't-b', from: 'x', status: 'ok', evidenceCount: 1, evidenceChars: 9, unverifiedCount: 0, createdAtMs: 1 },
  ])
  assert.deepEqual(r.acceptanceWithoutReceipt, ['t-a'], '★ 写了判据却没回执 —— 这一档必须单列')
  assert.equal(r.tasksWithReceipt, 1)
  assert.equal(r.tasksWithEvidence, 1)
})

test('★ summarizeReceipts：**空手交**（有回执但 0 条证据）⇒ 单独计数，不算「带证据」', () => {
  const r = summarizeReceipts(new Map(), [
    { id: 'm-8', taskId: 't-c', from: 'x', status: 'ok', evidenceCount: 0, evidenceChars: 0, unverifiedCount: 0, createdAtMs: 1 },
  ])
  assert.equal(r.tasksWithReceipt, 1)
  assert.equal(r.tasksWithEvidence, 0)
  assert.equal(r.tasksWithEmptyEvidence, 1, '★ 「交了个空的」必须与「交了东西」分开')
})

test('★ summarizeReceipts：**有回执但没写判据** ⇒ 单列「无法对账」（不是缺陷）', () => {
  const r = summarizeReceipts(new Map([['t-d', '']]), [
    { id: 'm-9', taskId: 't-d', from: 'x', status: 'ok', evidenceCount: 2, evidenceChars: 20, unverifiedCount: 1, createdAtMs: 1 },
  ])
  assert.deepEqual(r.receiptWithoutAcceptance, ['t-d'])
  assert.deepEqual(r.acceptanceWithoutReceipt, [])
})

test('★ summarizeReceipts：同一任务多封回执 ⇒ **按 taskId 去重**（不许重复计数）', () => {
  const r = summarizeReceipts(new Map([['t-e', '判据']]), [
    { id: 'm-10', taskId: 't-e', from: 'x', status: 'ok', evidenceCount: 1, evidenceChars: 5, unverifiedCount: 0, createdAtMs: 1 },
    { id: 'm-11', taskId: 't-e', from: 'x', status: 'ok', evidenceCount: 1, evidenceChars: 5, unverifiedCount: 0, createdAtMs: 2 },
  ])
  assert.equal(r.tasksWithReceipt, 1, '★ 一个任务交两次仍是**一个任务**有回执')
  assert.deepEqual(r.acceptanceWithoutReceipt, [])
})

test('★★ renderLedger：`extraLines` 落在**正文之后**（尾部补充面），且不挤进正文', () => {
  const rows: never[] = []
  const s = summarizeTasks(rows)
  const out = renderLedger(s, rows as never, 12, 1791954034340, { extraLines: ['回执面｜（域 = 信箱）有回执的任务 1 个'] })
  assert.match(out, /回执面/)
  assert.ok(out.indexOf('回执面') > out.indexOf('台账'), '★ 回执面在正文之后 —— 它的域与台账不同，不许混读')
})

// ────────── 「过滤后为空」≠「全域为空」（2026-10-12 实测抓出）──────────
// 现场：台账 96 条，我跑 `manor_tasks outcome=unfinished` ⇒ 渲染说
// 「**没有任何任务记录**（不是「读不到」）」—— 而全域明明有 96 条。
// 形状：**把「这个筛选条件没命中」说成了「整个日志什么都没有」** ⇒
// 读的人会去查一个并不存在的问题。（「空必须分型」的又一次。）

test('★ 过滤后为空 ⇒ 说「过滤后 0 条」并点出全域条数；**不许**只说「没有任何任务记录」', () => {
  const note = renderFilteredEmptyNote(['outcome=unfinished'], 96, 0)
  assert.match(note, /过滤后 0 条/)
  assert.match(note, /全域共 96 条/)
  assert.match(note, /不是「全域为空」/)
})

test('★ 反向对照①：**没有**过滤条件 ⇒ 空串（让调用方走正常渲染，含「真的全域为空」那一句）', () => {
  assert.equal(renderFilteredEmptyNote([], 0, 0), '')
  assert.equal(renderFilteredEmptyNote([], 96, 96), '')
})

test('★ 反向对照②：过滤后**有命中** ⇒ 空串（不许拿这条文案盖掉正常读数）', () => {
  assert.equal(renderFilteredEmptyNote(['outcome=failed'], 96, 19), '')
  assert.equal(renderFilteredEmptyNote(['member=maid-01', 'outcome=done'], 96, 29), '')
})

test('★ 多个过滤条件都要出现在文案里（否则读的人不知道自己在看哪个切片）', () => {
  const note = renderFilteredEmptyNote(['outcome=reaped', 'member=maid-04'], 96, 0)
  assert.match(note, /outcome=reaped/)
  assert.match(note, /member=maid-04/)
})

// ───────────────────────── 真实日志原文（逐字） ─────────────────────────

/** 真样本 A：cwd 越界降级 —— stage=failed 但**不是**任务失败（同 action 后随 done）。口径坑 C1/C2 */
const REAL_CWD_DEGRADE = [
  '{"at":"2026-10-11T13:49:22.328Z","actionId":"a-mv3vqfiv-rum75cu0","stage":"failed","humanText":"工作目录越界 → 降级执行（不拒收）：meta.cwd=C:\\\\Windows 越出本节点工作根 E:\\\\alice-nodes\\\\maid-05（工作目录越界：C:\\\\Windows）⇒ **已忽略它、按本节点工作根执行**。","detail":{"taskId":"t-verify-cwd-1","from":"LAPTOP-BF4IAPLM-web-0","field":"meta.cwd","value":"C:\\\\Windows","workRoot":"E:\\\\alice-nodes\\\\maid-05","fallbackCwd":"E:\\\\alice-nodes\\\\maid-05"}}',
  '{"at":"2026-10-11T13:49:22.336Z","actionId":"a-mv3vqfiv-rum75cu0","stage":"start","step":0,"total":1,"humanText":"收到任务 t-verify-cwd-1：只回复两个字：收到。不要做任何其他事、不要调用任何工具。","detail":{"taskId":"t-verify-cwd-1","from":"LAPTOP-BF4IAPLM-web-0","profile":"maid-05","cwd":"E:\\\\alice-nodes\\\\maid-05","acceptance":"回执应带 cwd 越界警告且任务仍执行","credKeysRequested":["COMMAND_API_KEY"],"credKeysFound":["COMMAND_API_KEY"]}}',
  '{"at":"2026-10-11T13:49:28.864Z","actionId":"a-mv3vqfiv-rum75cu0","stage":"stage","step":1,"total":1,"humanText":"会话已跑完（6s，exit=0）","detail":{"taskId":"t-verify-cwd-1","exit":0,"timedOut":false,"stdoutChars":64,"stderrChars":0,"stderrTail":""}}',
  '{"at":"2026-10-11T13:49:28.866Z","actionId":"a-mv3vqfiv-rum75cu0","stage":"done","step":1,"total":1,"humanText":"任务完成，1 条证据","detail":{"taskId":"t-verify-cwd-1","ok":true,"ms":6539}}',
].join('\n')

/** 真样本 B：超时被杀（口径坑 C1 的正样本——真失败长这样）。 */
const REAL_TIMEOUT = [
  '{"at":"2026-10-10T15:13:14.760Z","actionId":"a-mv2jafwl-4l11oky3","stage":"start","step":0,"total":1,"humanText":"收到任务 t-maid-03-mv2j0amd：**先回你的裁决请求，再派一个新活。**","detail":{"taskId":"t-maid-03-mv2j0amd","from":"LAPTOP-BF4IAPLM-web-0","profile":"maid-03","cwd":"E:\\\\alice-nodes\\\\maid-03","acceptance":"① 8 张（或更多）场景图落在**你自己 workdir 内**"}}',
  '{"at":"2026-10-10T15:30:06.346Z","actionId":"a-mv2jafwl-4l11oky3","stage":"stage","step":1,"total":1,"humanText":"会话已跑完（1012s，exit=-1，超时被杀）","detail":{"taskId":"t-maid-03-mv2j0amd","exit":-1,"timedOut":true,"stdoutChars":61,"stderrChars":183739}}',
  '{"at":"2026-10-10T15:30:06.351Z","actionId":"a-mv2jafwl-4l11oky3","stage":"failed","step":1,"total":1,"humanText":"任务未完成：超时","detail":{"taskId":"t-maid-03-mv2j0amd","ok":false,"ms":1011593}}',
].join('\n')

/** 真样本 C：chat 类动作 —— 有 `kind` 但**没有** taskId（口径坑 C3）。 */
const REAL_CHAT =
  '{"at":"2026-10-11T14:23:02.495Z","actionId":"a-mv3wxqan-dfafy20c","stage":"start","step":0,"total":1,"humanText":"收到对话 ← maid-03：走了。","detail":{"from":"maid-03","profile":"maid-01","cwd":"E:\\\\alice-nodes\\\\maid-01","kind":"chat"}}'

/** 真样本 D：exit=1 型失败。 */
const REAL_EXIT1 = [
  '{"at":"2026-10-10T09:00:00.000Z","actionId":"a-mv1tragg-ppwor433","stage":"start","step":0,"total":1,"humanText":"收到任务 t-x-1：做点事","detail":{"taskId":"t-x-1","from":"LAPTOP-BF4IAPLM-web-0","profile":"maid-01"}}',
  '{"at":"2026-10-10T09:05:00.000Z","actionId":"a-mv1tragg-ppwor433","stage":"failed","step":1,"total":1,"humanText":"任务未完成：exit=1","detail":{"taskId":"t-x-1","ok":false,"ms":300000,"stderrChars":4096}}',
].join('\n')

// ═══════════════════ 尸体样本：三个口径坑（判据必须会拒） ═══════════════════

test('尸体·C1：cwd 越界降级写 stage=failed，但**不是**任务失败（判据不能用 stage）', () => {
  const ev = parseActionLine(REAL_CWD_DEGRADE.split('\n')[0]!)
  assert.notEqual(ev, null)
  assert.equal(ev!.stage, 'failed', '前提：这行的 stage 确实是 failed')
  assert.equal(isTaskFailure(ev!.humanText), false, '⇒ 但它不是任务失败')
  assert.equal(classifyFailure(ev!.humanText), 'none')
})

test('尸体·C1 反向：真失败必须被认出（否则上一条的「拒」只是恒拒）', () => {
  assert.equal(isTaskFailure('任务未完成：超时'), true)
  assert.equal(classifyFailure('任务未完成：超时'), 'timeout')
  assert.equal(classifyFailure('任务未完成：exit=1'), 'exec-error')
  assert.equal(classifyFailure('任务未完成：说不清的别的'), 'unknown')
})

test('尸体·C2：同一 action 兼有 failed 与 done ⇒ 终态必须是 done（否则降级警告污染失败率）', () => {
  const tasks = foldTasks(parseActionLog(REAL_CWD_DEGRADE))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.taskId, 't-verify-cwd-1')
  assert.equal(tasks[0]!.outcome, 'done', '降级警告不得把成功任务记成失败')
  assert.equal(tasks[0]!.failureKind, 'none')
  assert.equal(tasks[0]!.to, 'maid-05')
  assert.equal(tasks[0]!.ms, 6539)
})

test('尸体·C3：chat 类动作有 kind 但无 taskId ⇒ 不得进台账（用 kind 筛会恒为空）', () => {
  const ev = parseActionLine(REAL_CHAT)
  assert.equal(ev!.detail['kind'], 'chat')
  assert.equal(ev!.detail['taskId'], undefined)
  assert.equal(foldTasks([ev!]).length, 0, 'chat 不是任务')
})

// ═══════════════════════════ 解析层 ═══════════════════════════

test('解析：坏行返回 null 且不带塌整份日志', () => {
  assert.equal(parseActionLine('{ not json'), null)
  assert.equal(parseActionLine(''), null)
  assert.equal(parseActionLine('   '), null)
  assert.equal(parseActionLine('[]'), null, '数组不是事件对象')
  const evs = parseActionLog('{ bad\n' + REAL_CHAT + '\nnot json at all\n')
  assert.equal(evs.length, 1, '一行坏不该影响别的行')
})

test('解析：缺 detail 不抛，归一成空对象', () => {
  const ev = parseActionLine('{"at":"x","actionId":"a","stage":"done","humanText":"h"}')
  assert.notEqual(ev, null)
  assert.deepEqual(ev!.detail, {})
})

// ═══════════════════════════ 归并层 ═══════════════════════════

test('归并：真超时任务 ⇒ failed/timeout，读数取自 detail', () => {
  const tasks = foldTasks(parseActionLog(REAL_TIMEOUT))
  assert.equal(tasks.length, 1)
  const t = tasks[0]!
  assert.equal(t.taskId, 't-maid-03-mv2j0amd')
  assert.equal(t.outcome, 'failed')
  assert.equal(t.failureKind, 'timeout')
  assert.equal(t.to, 'maid-03')
  assert.equal(t.ms, 1011593)
  assert.equal(t.stderrChars, 183739)
})

test('归并：exit=1 ⇒ failed/exec-error', () => {
  const t = foldTasks(parseActionLog(REAL_EXIT1))[0]!
  assert.equal(t.outcome, 'failed')
  assert.equal(t.failureKind, 'exec-error')
  assert.equal(t.stderrChars, 4096, 'stage 行的读数要补进来')
})

test('归并：有 start 无终态 ⇒ unfinished（静默失败，最该追的一类）', () => {
  const only = parseActionLine(
    '{"at":"2026-10-11T00:00:00.000Z","actionId":"a-orphan","stage":"start","step":0,"total":1,'
    + '"humanText":"收到任务 t-orphan-1：干点什么","detail":{"taskId":"t-orphan-1","profile":"maid-02"}}',
  )!
  const tasks = foldTasks([only])
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.outcome, 'unfinished')
  assert.equal(tasks[0]!.failureKind, 'none', '未完不是失败——如实分开报')
})

test('归并：按开始时间倒序（最近的在最前）', () => {
  const all = foldTasks(parseActionLog([REAL_CWD_DEGRADE, REAL_TIMEOUT, REAL_EXIT1].join('\n')))
  assert.equal(all.length, 3)
  assert.equal(all[0]!.taskId, 't-verify-cwd-1', '2026-10-11 13:49 的最前')
  assert.equal(all[1]!.taskId, 't-maid-03-mv2j0amd', '2026-10-10 15:13 居中')
  assert.equal(all[2]!.taskId, 't-x-1', '2026-10-10 09:00 的最后')
})

// ═══════════════════════════ 汇总层 ═══════════════════════════

test('汇总：失败率分母 = 成功+失败，**未完不计入**（混进去就会虚高）', () => {
  const all = foldTasks(parseActionLog([REAL_CWD_DEGRADE, REAL_TIMEOUT, REAL_EXIT1].join('\n')))
  const s = summarizeTasks(all)
  assert.equal(s.total, 3)
  assert.equal(s.done, 1)
  assert.equal(s.failed, 2)
  assert.equal(s.unfinished, 0)
  assert.equal(s.failureRate, 2 / 3)
  assert.equal(s.byKind.timeout, 1)
  assert.equal(s.byKind['exec-error'], 1)
  assert.equal(s.byKind.unknown, 0)
})

test('汇总：未完不进分母 —— 1 成 1 败 5 未完 仍是 50%，不是 1/7', () => {
  const orphan = (i: number): string =>
    '{"at":"2026-10-11T00:00:0' + String(i) + '.000Z","actionId":"a-o' + String(i) + '","stage":"start",'
    + '"humanText":"收到任务 t-o' + String(i) + '：x","detail":{"taskId":"t-o' + String(i) + '","profile":"maid-02"}}'
  const text = [REAL_CWD_DEGRADE, REAL_TIMEOUT, orphan(1), orphan(2), orphan(3), orphan(4), orphan(5)].join('\n')
  const s = summarizeTasks(foldTasks(parseActionLog(text)))
  assert.equal(s.done, 1)
  assert.equal(s.failed, 1)
  assert.equal(s.unfinished, 5)
  assert.equal(s.failureRate, 0.5, '未完既不算成功也不算失败')
})

test('汇总：空台账 ⇒ 分母 0 时返回 0 而**不是 NaN**（NaN 会让下游比较静默失效）', () => {
  const s = summarizeTasks([])
  assert.equal(s.total, 0)
  assert.equal(s.failureRate, 0)
  assert.equal(Number.isNaN(s.failureRate), false)
})

test('汇总：按成员归类（成员名取自 detail.profile）', () => {
  const s = summarizeTasks(foldTasks(parseActionLog([REAL_CWD_DEGRADE, REAL_TIMEOUT, REAL_EXIT1].join('\n'))))
  const byId = new Map(s.byMember.map((m) => [m.member, m]))
  assert.equal(byId.get('maid-05')!.done, 1)
  assert.equal(byId.get('maid-03')!.failed, 1)
  assert.equal(byId.get('maid-01')!.failed, 1)
  assert.equal(s.byMember[0]!.total, 1, '每人一条时无所谓序，但总数要守恒')
  assert.equal(s.byMember.reduce((a, m) => a + m.total, 0), s.total, '成员计数之和 == 总数')
})

// ═══════════════════════════ 渲染层 ═══════════════════════════

test('渲染：空台账与「读到了」文案不同（不许都显示成空）', () => {
  const empty = renderLedger(summarizeTasks([]), [], 10)
  assert.match(empty, /没有任何任务记录/)
  const s = summarizeTasks(foldTasks(parseActionLog(REAL_TIMEOUT)))
  const text = renderLedger(s, foldTasks(parseActionLog(REAL_TIMEOUT)), 10)
  assert.match(text, /t-maid-03-mv2j0amd/)
  assert.match(text, /✖/)
  assert.notEqual(text, empty)
})

test('渲染：有未完时显式提示「静默失败」', () => {
  const orphan = parseActionLine(
    '{"at":"2026-10-11T00:00:00.000Z","actionId":"a-orphan","stage":"start","humanText":"收到任务 t-o-1：x",'
    + '"detail":{"taskId":"t-o-1","profile":"maid-02"}}',
  )!
  const s = summarizeTasks(foldTasks([orphan]))
  assert.match(renderLedger(s, [orphan] && foldTasks([orphan]), 10), /静默失败/)
})

// ═════════════ 尸体·C4/C5：拒收 ≠ 故障，且行的顺序不可信 ═════════════

/** 真样本 E：拒收 —— 任务正文为空（**根本没起会话**）。 */
const REAL_REJECT_EMPTY =
  '{"at":"2026-10-11T13:49:22.251Z","actionId":"a-mv3vqfgq-set6gv2j","stage":"failed","humanText":"任务正文为空","detail":{"taskId":"t-verify-empty-1"}}'

/** 真样本 F：拒收 —— cwd 越界被拒（与 REAL_CWD_DEGRADE 同维度、**相反策略**）。 */
const REAL_REJECT_CWD =
  '{"at":"2026-10-10T03:14:25.854Z","actionId":"a-mv1tm1fg-3stic549","stage":"failed","humanText":"工作目录越界被拒：工作目录越界：E:\\\\alice\\\\projects\\\\cet4-game","detail":{"taskId":"t-maid-03-mv1tm167"}}'

test('尸体·C4：拒收 ⇒ 终态 rejected（不是 failed，更不是 unfinished）', () => {
  const t = foldTasks(parseActionLog(REAL_REJECT_EMPTY))[0]!
  assert.equal(t.outcome, 'rejected')
  assert.equal(t.rejectKind, 'empty-body')
  assert.equal(t.failureKind, 'none', '拒收不是执行失败')
  assert.equal(classifyReject('任务正文为空'), 'empty-body')
})

test('尸体·C4 对照：同是 cwd 越界，「被拒」与「降级执行」必须分得开', () => {
  const rejected = foldTasks(parseActionLog(REAL_REJECT_CWD))[0]!
  const degraded = foldTasks(parseActionLog(REAL_CWD_DEGRADE))[0]!
  assert.equal(rejected.outcome, 'rejected')
  assert.equal(rejected.rejectKind, 'cwd-rejected')
  assert.equal(degraded.outcome, 'done', '「不拒收」的那个跑完了')
  assert.notEqual(rejected.outcome, degraded.outcome, '同维度相反策略不得混为一谈')
})

test('尸体·C4 反向：降级警告不得被 classifyReject 认成拒收（它含「不拒收」字样）', () => {
  assert.equal(classifyReject('工作目录越界 → 降级执行（不拒收）：meta.cwd=C:\\Windows'), 'none')
})

test('尸体·C5：降级警告行排在 start 行**之前** ⇒ 仍判 done（行序不可信）', () => {
  const warn = '{"at":"2026-10-11T13:49:22.328Z","actionId":"a-x","stage":"failed",'
    + '"humanText":"工作目录越界 → 降级执行（不拒收）：x","detail":{"taskId":"t-c5-1"}}'
  const start = '{"at":"2026-10-11T13:49:22.336Z","actionId":"a-x","stage":"start",'
    + '"humanText":"收到任务 t-c5-1：x","detail":{"taskId":"t-c5-1","profile":"maid-05"}}'
  const done = '{"at":"2026-10-11T13:49:28.866Z","actionId":"a-x","stage":"done",'
    + '"humanText":"任务完成，1 条证据","detail":{"taskId":"t-c5-1","ok":true,"ms":6539}}'
  const t = foldTasks(parseActionLog([warn, start, done].join('\n')))[0]!
  assert.equal(t.outcome, 'done')
  assert.match(t.warning, /降级执行/, '警告不吞')
})

test('尸体·C5 反向：只有警告行、没有 start ⇒ 那是拒收而不是 done', () => {
  const warnOnly = '{"at":"2026-10-11T00:00:00.000Z","actionId":"a-y","stage":"failed",'
    + '"humanText":"工作目录越界被拒：C:\\\\Windows","detail":{"taskId":"t-c5-2"}}'
  const t = foldTasks(parseActionLog(warnOnly))[0]!
  assert.equal(t.outcome, 'rejected')
})

// ═══════════════ 汇总：拒收不进失败率分母 ═══════════════

test('汇总：拒收**不进**失败率分母（否则防线在工作反而拉高故障率）', () => {
  const text = [REAL_CWD_DEGRADE, REAL_TIMEOUT, REAL_EXIT1, REAL_REJECT_EMPTY, REAL_REJECT_CWD].join('\n')
  const s = summarizeTasks(foldTasks(parseActionLog(text)))
  assert.equal(s.total, 5)
  assert.equal(s.done, 1)
  assert.equal(s.failed, 2)
  assert.equal(s.rejected, 2)
  assert.equal(s.unfinished, 0)
  assert.equal(s.failureRate, 2 / 3, '分母只有 成功1+失败2')
  assert.equal(s.byReject['empty-body'], 1)
  assert.equal(s.byReject['cwd-rejected'], 1)
})

test('汇总：warned 只数「跑完了但有警告」的（未完/失败/拒收都不算）', () => {
  assert.equal(summarizeTasks(foldTasks(parseActionLog(REAL_CWD_DEGRADE))).warned, 1)
  assert.equal(summarizeTasks(foldTasks(parseActionLog(REAL_REJECT_EMPTY))).warned, 0)
  assert.equal(summarizeTasks(foldTasks(parseActionLog(REAL_TIMEOUT))).warned, 0)
})

test('渲染：拒收单列一行并注明「不是失败」，明细用 ⛔ 标记', () => {
  const rows = foldTasks(parseActionLog([REAL_CWD_DEGRADE, REAL_REJECT_EMPTY].join('\n')))
  const out = renderLedger(summarizeTasks(rows), rows, 10, 1_790_000_000_000)
  assert.match(out, /拒收 1/)
  assert.match(out, /不是失败，是防线在工作/)
  assert.match(out, /⛔/)
  assert.match(out, /✔/)
})

// ── ★ 「未完」必须带年龄（2026-10-12 实测：我差点据此判死一个正跑着的成员）──────────

const T_REF = 1_790_000_000_000

const line = (over: Record<string, unknown>): string => JSON.stringify(over)

// ⚠ **字段名照真实日志**：时间字段是 `at`（**ISO 字符串**），**不是** `atMs` ——
//   我第一版写成 `atMs`，于是 `startedAtMs` 恒为 0、年龄那一段**一个字都没出现**，
//   而红读数看起来像「渲染逻辑没生效」。**这正是「夹具即世界」**：
//   **夹具用了生产写入器不会写的字段名 ⇒ 判据的作用域被夹具的形状限死。**
const atIso = (ms: number): string => new Date(ms).toISOString()

/** 一条**只有 start** 的任务（⇒ `unfinished`）。`acc` 非空时带上派活侧的验收判据。 */
const startOnly = (taskId: string, to: string, atMs: number, acc?: string): string => line({
  at: atIso(atMs), actionId: 'a-' + taskId, stage: 'start', step: 0, total: 1,
  humanText: '收到任务 ' + taskId + '：干活',
  detail: {
    taskId, from: 'web-0', profile: to,
    ...(acc === undefined ? {} : { acceptance: acc }),
  },
})

/** 一条**真的跑完**的任务 —— ⚠ **必须有 `stage:"done"` 那一行**，否则它也是 `unfinished`。 */
const doneTask = (taskId: string, to: string, atMs: number, ms: number, acc?: string): string =>
  [
    startOnly(taskId, to, atMs, acc),
    line({
      at: atIso(atMs + ms), actionId: 'a-' + taskId, stage: 'stage', step: 1, total: 1,
      humanText: '会话已跑完（' + String(Math.round(ms / 1000)) + 's，exit=0）',
      detail: { taskId, exit: 0, timedOut: false, stdoutChars: 10, stderrChars: 0 },
    }),
    line({
      at: atIso(atMs + ms), actionId: 'a-' + taskId, stage: 'done', step: 1, total: 1,
      humanText: '任务完成，1 条证据', detail: { taskId, ok: true, ms },
    }),
  ].join('\n')

test('★ 「未完」那一行**必须带年龄** —— 否则「刚起 60 秒」与「起了三天」长得一样', () => {
  const rows = foldTasks(parseActionLog(startOnly('t-u1', 'maid-01', T_REF - 60_000)))
  assert.equal(rows[0]!.outcome, 'unfinished')
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /未完 1 个/)
  assert.match(out, /最老的一条起于 1 分钟 前/, '★ 年龄必须出现')
  assert.match(out, /t-u1/, '点名是哪一条')
})

test('★ 无 `nowMs` ⇒ **响亮说年龄不可算**，不许假装那行已经答了「是死是活」', () => {
  const rows = foldTasks(parseActionLog(startOnly('t-u2', 'maid-01', T_REF - 60_000)))
  const out = renderLedger(summarizeTasks(rows), rows, 10, 0)
  assert.match(out, /年龄不可算/)
  assert.match(out, /不区分「在飞」与「已死」/, '★ 局限必须与读数**同体**')
})

test('★ 同类参照：给「同一成员已完成任务的最长耗时」，判不判死仍归人', () => {
  const rows = foldTasks(parseActionLog([
    doneTask('t-d1', 'maid-01', T_REF - 3_600_000, 600_000),
    startOnly('t-u3', 'maid-01', T_REF - 300_000),
  ].join('\n')))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /最长耗时 10 分钟/, '参照要现算，不许编')
  assert.match(out, /明显超过它才谈得上「卡住」/, '★ 参照给读数，**判断不代填**')
})

test('★ 没有同类可参照时**明说没有**（不编一个数出来）', () => {
  const rows = foldTasks(parseActionLog(startOnly('t-u4', 'maid-09', T_REF - 300_000)))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /没有已完成任务可对照/)
})

// ═════════════ 成本口径（2026-10-12 · ⑥ 面「该有」里缺的一格） ═════════════

test('成本口径：无耗时样本时**报「无样本」**（不报 0 —— 0 会被读成「很快」）', () => {
  const rows = foldTasks(parseActionLog([
    startOnly('t-c1', 'maid-01', T_REF - 120_000),
    startOnly('t-c2', 'maid-02', T_REF - 60_000),
  ].join('\n')))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /成本口径｜\*\*无样本\*\*/)
  assert.doesNotMatch(out, /中位/, '★ 无样本时不得出现「中位」—— 那会被读成一个数')
})

test('成本口径：有样本时报中位 / 最长 / 总计', () => {
  const rows = foldTasks(parseActionLog([
    doneTask('t-c3', 'maid-01', T_REF - 3_600_000, 600_000), // 10 分钟
    doneTask('t-c4', 'maid-02', T_REF - 1_800_000, 1_200_000), // 20 分钟
  ].join('\n')))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /有耗时 2 条/)
  assert.match(out, /中位 15\.0 分钟/)
  assert.match(out, /最长 20\.0 分钟/)
  assert.match(out, /总计 30\.0 分钟/)
})

test('★ 尸体：`ms=0`（算不出耗时）**不得计入分布** —— 计入会把中位系统性拉低', () => {
  const rows = foldTasks(parseActionLog([
    doneTask('t-c5', 'maid-01', T_REF - 3_600_000, 1_000_000), // 唯一有效样本：1000s
    startOnly('t-c6', 'maid-01', T_REF - 60_000), // 无 ms（缺终态行）
  ].join('\n')))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /有耗时 1 条/, '★ 有效样本只有 1 条')
  assert.match(out, /中位 16\.7 分钟/, '★ 若把 ms=0 计入（n=2），中位会变成 8.3 分钟 —— 这正是本尸体要拦的')
  assert.match(out, /另 1 条\*\*无耗时样本\*\*/)
  assert.match(out, /不等于 0 秒/)
})

// ═══════ 判据面（2026-10-12 · ⑥ 面「质量验收」格里能做的那一半） ═══════

test('判据面：全无判据时报「**本面为空**」，不是「0 个」（后者会被读成都合格）', () => {
  const rows = foldTasks(parseActionLog([
    doneTask('t-a1', 'maid-01', T_REF - 600_000, 60_000),
    doneTask('t-a2', 'maid-02', T_REF - 300_000, 30_000),
  ].join('\n')))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /判据面｜\*\*本面为空\*\*/)
  assert.match(out, /不是「都合格」/, '★ 空必须分型：它不能被读成「全都合格」')
})

test('判据面：混合时报计数 + 无判据清单（可追）', () => {
  const rows = foldTasks(parseActionLog([
    doneTask('t-b1', 'maid-01', T_REF - 900_000, 60_000, '回执须含两侧样本'),
    doneTask('t-b2', 'maid-02', T_REF - 600_000, 30_000, '须给出 URL 清单'),
    doneTask('t-b3', 'maid-03', T_REF - 300_000, 20_000),
  ].join('\n')))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /有判据 2 \/ 3 个任务/)
  assert.match(out, /\*\*无判据 1 个\*\*/)
  assert.match(out, /无判据：t-b3 → maid-03/)
})

test('★ 判据面必须写明它**不答**什么（否则会被读成「质量验收」已完成）', () => {
  const rows = foldTasks(parseActionLog(
    doneTask('t-c1', 'maid-01', T_REF - 600_000, 60_000, '须给出证据'),
  ))
  const out = renderLedger(summarizeTasks(rows), rows, 10, T_REF)
  assert.match(out, /不答「判据满没满足」/)
  assert.match(out, /另一份不是作者写的重建/, '★ 缺口的对账需要第二份（技能 acceptance-integrity §十）')
})

// ───────────────────── 已裁决与判据悬空必须分开（2026-10-14 真调抓出的口径分叉） ─────────────────────

test('★★ 已裁决的活**不再算「判据悬空」**，但**必须显形**（不隐藏）', () => {
  // 现场：`t-pwsh-probe-01` 已被裁决 `superseded`，而回执面修前仍把它挂在
  //   「判据悬空 · 最该追的一档」⇒ 台账报「未完 0」而回执面报「悬空 1」
  //   —— **两个读数对同一件事给了相反答案**。
  // ⇒ 修法：读 `reap/` 并**分开报**（「已裁决」是**有主的决定**，不是「没人管」）。
  const acc = new Map([['t-a', '判据A'], ['t-b', '判据B'], ['t-c', '判据C']])
  const receipts = [{ id: 'm-1', taskId: 't-c', from: 'maid-01', status: 'ok', evidenceCount: 1, evidenceChars: 10, unverifiedCount: 0, createdAtMs: 1 }]
  const r = summarizeReceipts(acc, receipts, new Set(['t-b']))
  assert.deepEqual(r.acceptanceWithoutReceipt, ['t-a'], '★ 真悬空只剩 t-a')
  assert.deepEqual(r.acceptanceWithoutReceiptReaped, ['t-b'], '★ 已裁决的**另立一格**（不隐藏、也不混进悬空）')
})

test('★ 裁决集**缺省不区分**（零回归）：不传第三参 ⇒ 与修前同行为', () => {
  const acc = new Map([['t-a', '判据A']])
  const r = summarizeReceipts(acc, [])
  assert.deepEqual(r.acceptanceWithoutReceipt, ['t-a'])
  assert.deepEqual(r.acceptanceWithoutReceiptReaped, [], '★ 缺省时该格恒空 —— 调用方不读 reap 就不会误报「已裁决」')
})

// ═══════════════════════════════════════════════════════════════════════════
// ★★ 成员自报未验证项（2026-10-15 · 论文 arXiv:2610.16117v1 UnCoBench 的「Incomplete」形态）
//
// 存在理由：成员**早在诚实标注**「这些我没验证」（`adapter.mjs:643`：
//   `ok ? [] : [partial ? '任务被撞顶中断，产物未经主脑复现' : '任务结果未经主脑复现']`），
//   而 `ReceiptLite.unverifiedCount` **被抽取却从未被任何渲染消费** ⇒ 数据一直在，缺的只是显示面。
//   论文实测：证据「正确但不足」时**强模型也普遍不追问**（GPT-5.6 Sol 53.4% /
//   DeepSeek-V4.1-Flash **86.7%** 的 trace 无 corrective follow-up）⇒ 缺口信息必须**送到眼前**。
// ⚠ 本格只答「**她自己说哪些没验证**」——**不是**复核结论、**不是**「判据没满足」。
// ═══════════════════════════════════════════════════════════════════════════

test('★ 未验证项：**非空即入格**，且**去重**（同一 taskId 多封回执只算一次）', () => {
  const receipts = [
    { id: 'm-1', taskId: 't-a', from: 'maid-01', status: 'partial', evidenceCount: 1, evidenceChars: 10, unverifiedCount: 1, createdAtMs: 1 },
    { id: 'm-2', taskId: 't-a', from: 'maid-01', status: 'ok', evidenceCount: 1, evidenceChars: 10, unverifiedCount: 0, createdAtMs: 2 },
    { id: 'm-3', taskId: 't-b', from: 'maid-02', status: 'ok', evidenceCount: 1, evidenceChars: 10, unverifiedCount: 0, createdAtMs: 3 },
  ]
  const r = summarizeReceipts(new Map(), receipts)
  assert.deepEqual(r.tasksWithUnverified, ['t-a'], '★ 只有带未验证项的那条进格；同 taskId 的第二封（空）不重复计入')
})

test('★ 尸体：**全部回执都没有未验证项** ⇒ 该格必须**空**（证明判据有区分力，不是恒返全部）', () => {
  // 若实现退化成「把全部有回执的 taskId 都算进来」，这条会红 —— 那正是本尸体的作用。
  const receipts = [
    { id: 'm-1', taskId: 't-a', from: 'maid-01', status: 'ok', evidenceCount: 1, evidenceChars: 10, unverifiedCount: 0, createdAtMs: 1 },
    { id: 'm-2', taskId: 't-b', from: 'maid-02', status: 'ok', evidenceCount: 0, evidenceChars: 0, unverifiedCount: 0, createdAtMs: 2 },
  ]
  const r = summarizeReceipts(new Map(), receipts)
  assert.equal(r.tasksWithReceipt, 2, '金标准：两封都是回执（该格非空 ⇒ 不是「什么都没读出来」）')
  assert.deepEqual(r.tasksWithUnverified, [], '★ 尸体：无未验证项 ⇒ 空（区分力在这里）')
})

test('★ 尸体：无回执 / 空输入 ⇒ 该格恒空（不许把「读不到」当「有未验证项」）', () => {
  const r = summarizeReceipts(new Map([['t-a', '判据A']]), [])
  assert.deepEqual(r.tasksWithUnverified, [], '★ 「没有回执」与「有未验证项」是两件事')
})

// ═══════════════════════════════════════════════════════════════════════════
// ★★ 失败族（2026-10-14 · 论文 AREAL-RSI §4.2 复盘三问的**输入面**）
//
// 存在理由：`byKind`（按类型）与 `byMember`（按成员）**各自独立** ⇒ 能答「超时 10 条」，
//   **答不了「谁超时、在哪类活上超时」** ⇒ 模式浮不出来，「从失败里提取改进」无从下手
//   （论文自己点名的难点③：任务进展**不会自动**改进下一个过程）。
// ⚠ 本组只钉**聚合与口径**，**不钉任何「谁不行」的结论** —— 那是归因，不是本字段的事。
// ═══════════════════════════════════════════════════════════════════════════

/** 造一条最小 TaskRecord（缺省给全，**不用 any** —— 让 TS 盯住漏字段） */
function task(over: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    actionId: 'a-' + over.taskId,
    to: 'maid-01',
    from: 'web-0',
    acceptance: '判据',
    nature: 'internal',
    natureDeclared: true,
    startedAtMs: 1,
    envelopeCreatedAtMs: 0,
    endedAtMs: 2,
    outcome: 'failed',
    failureKind: 'timeout',
    rejectKind: 'none',
    warning: '',
    ms: 1,
    stdoutChars: 0,
    stderrChars: 0,
    tail: '',
    reapVerdict: '',
    reapReason: '',
    reapAtMs: 0,
    ...over,
  }
}

test('失败族：按「类型 × 成员」**交叉**聚合（同一个总数，两个独立维度看不出模式）', () => {
  const s = summarizeTasks([
    task({ taskId: 't1', to: 'maid-03', failureKind: 'timeout' }),
    task({ taskId: 't2', to: 'maid-03', failureKind: 'timeout' }),
    task({ taskId: 't3', to: 'maid-03', failureKind: 'exec-error' }),
    task({ taskId: 't4', to: 'maid-04', failureKind: 'timeout' }),
  ])
  assert.equal(s.failed, 4)
  // 同一批数据：byKind 只说「超时 3 / exit≠0 1」——看不出这 3 条超时来自同一个成员
  assert.equal(s.byKind.timeout, 3)
  assert.equal(s.byKind['exec-error'], 1)
  assert.equal(s.failureClusters.length, 3, '交叉把它拆成可辨认的簇')
  assert.deepEqual(s.failureClusters[0], {
    kind: 'timeout', member: 'maid-03', count: 2, taskIds: ['t1', 't2'], more: 0,
  }, '最大的簇在前；簇内 taskId 字典序')
})

test('失败族：排序**确定性**（同一份数据两次 ⇒ 同顺序）+ 渲染行可直接读', () => {
  const rows = [
    task({ taskId: 'tb', to: 'maid-02', failureKind: 'timeout' }),
    task({ taskId: 'ta', to: 'maid-01', failureKind: 'timeout' }),
  ]
  const a = renderFailureClusters(summarizeTasks(rows).failureClusters)
  const b = renderFailureClusters(summarizeTasks([...rows].reverse()).failureClusters)
  assert.deepEqual(a, b, '输入顺序不影响输出顺序（否则读数会随日志排列抖动）')
  assert.deepEqual(a, ['timeout × maid-01：1 条（ta）', 'timeout × maid-02：1 条（tb）'])
})

test('★ 尸体样本：簇内 taskId 超上限 ⇒ `more` 计数**不静默丢**', () => {
  const rows = Array.from({ length: MAX_CLUSTER_IDS + 3 }, (_, i) =>
    task({ taskId: 't' + String(i).padStart(2, '0'), to: 'maid-05', failureKind: 'timeout' }))
  const c = summarizeTasks(rows).failureClusters[0]!
  assert.equal(c.count, MAX_CLUSTER_IDS + 3)
  assert.equal(c.taskIds.length, MAX_CLUSTER_IDS)
  assert.equal(c.more, 3, '★ 被省略的条数必须显形（截断不静默）')
  assert.ok(renderFailureClusters([c])[0]!.includes('另有 3 条'), renderFailureClusters([c])[0])
})

test('★ 口径：失败族覆盖**全部失败**（含未分类），`byKind` 只覆盖已分类 —— 两组数和**本来就不等**', () => {
  const s = summarizeTasks([
    task({ taskId: 't1', failureKind: 'timeout' }),
    task({ taskId: 't2', failureKind: 'none' }), // 分类不出来 —— **不猜**
  ])
  assert.equal(s.failed, 2)
  assert.equal(s.byKind.timeout, 1, 'byKind 不含未分类者')
  const total = s.failureClusters.reduce((n, c) => n + c.count, 0)
  assert.equal(total, 2, '失败族覆盖全部失败 ⇒ 与 byKind 的和不等是**设计**，不是 bug')
  assert.ok(s.failureClusters.some((c) => c.kind === 'none'), '未分类者落 `none` 簇（**不伪装成某类**）')
})

test('★ 空必须分型：没有失败 ⇒ `failureClusters` 空数组，且渲染**不产**失败族段', () => {
  const s = summarizeTasks([task({ taskId: 't1', outcome: 'done', failureKind: 'none' })])
  assert.equal(s.failed, 0)
  assert.deepEqual(s.failureClusters, [])
  assert.equal(renderLedger(s, [], 12, 0).includes('失败族'), false, '没有失败就不该出现这一段（不编造文案）')
})

// ═══════════════════════════════════════════════════════════════════════════
// ★★ 信封来路（`G-provenance` **Step B** · 2026-10-15）
//
// 缺口原话：分母里那些 taskId **各自是被哪条调用点造出来的**，读数里**没有这一格**
//   ⇒ 三种病在盘上同貌：① 派活方没声明 · ② 日志没记 · ③ **枚举本身漏了格子**。
// 本组钉的正是 ③：`unknown`（**我不认识的那条路 = 枚举漏格的信号**）与 `none`
//   （没盖章）**不可合并** —— 并成一格则「有我没见过的路在造活」静默消失。
//
// 三具尸体（缺一就是假绿）：
//   ① 日志无 `via` ⇒ **空串**（不是兜成某个已知值 —— 那会把「不知道」伪装成「知道」）；
//   ② fold 层**不许归一未知值**（一归，信号就在落盘那一刻消失）；
//   ③ `unknown` 与 `none` 分别计数（造一条未知 + 两条没盖章 ⇒ 1 / 2，不是 3）。
// ═══════════════════════════════════════════════════════════════════════════

/** 造一条最小可折叠的 `start` 事件（detail 形状逐字对齐 `adapter.mjs`）。 */
const startEv = (taskId: string, via?: string) => ({
  at: '2026-10-15T10:00:00.000Z',
  actionId: 'a-via-' + taskId,
  stage: 'start',
  humanText: '收到任务 ' + taskId,
  detail: {
    taskId, from: 'LAPTOP-BF4IAPLM-web-0', profile: 'maid-01',
    acceptance: '', cwd: '.',
    ...(via === undefined ? {} : { via }),
  },
})

test('★ 来路：日志有 detail.via ⇒ 落进 TaskRecord.via', () => {
  assert.equal(foldTasks([startEv('t-via-1', 'manor_dispatch')])[0]!.via, 'manor_dispatch')
})

test('★ 尸体①：日志**无** via ⇒ 空串（「没盖章」≠「走了空的那条路」）', () => {
  assert.equal(
    foldTasks([startEv('t-via-2')])[0]!.via, '',
    '★ 缺失必须落空串，不许兜成某个已知值 —— 那会把「不知道」伪装成「知道」',
  )
})

test('★ 尸体①b：空串同样是「没盖章」（不是一次有效盖章）', () => {
  assert.equal(foldTasks([startEv('t-via-3', '')])[0]!.via, '')
})

test('★ 尸体②：未知来路**不归一**，原样保留 ⇒ 消费侧才能分类成 unknown', () => {
  // ⚠ 本字段的核心分辨力所在：fold 层一归一，「有我没登记过的写者在造活」
  //   这个信号就在**落盘那一刻**消失了（不是「看不见」，是「不存在」）。
  assert.equal(foldTasks([startEv('t-via-4', 'someone-new')])[0]!.via, 'someone-new')
})

test('★★ 尸体③：来路分布 —— unknown 与 none **不合并**', () => {
  const s = summarizeTasks(foldTasks([
    startEv('t-a', 'manor_dispatch'),
    startEv('t-b', 'hold-release'),
    startEv('t-c', 'someone-new'), // 我不认识的那条路
    startEv('t-d'),                // 没盖章
    startEv('t-e'),                // 没盖章
  ]))
  assert.equal(s.total, 5)
  assert.equal(s.viaUnknown, 1, '★ 恰好 1 条未知 —— 它必须单独成格')
  assert.equal(s.viaNone, 2, '★ 2 条没盖章 —— 与未知是**两种世界**')
})

test('★ 全 known ⇒ 两格都为 0（0 与非 0 是相反的两句话）', () => {
  const s = summarizeTasks(foldTasks([startEv('t-k', 'member-adapter')]))
  assert.equal(s.viaUnknown, 0)
  assert.equal(s.viaNone, 0)
})

test('★ 渲染：来路行**始终出**，且未知非 0 时点名「清单漏格」', () => {
  const tasks = foldTasks([startEv('t-u', 'someone-new')])
  const withUnknown = renderLedger(summarizeTasks(tasks), tasks, 10, 0)
  assert.match(withUnknown, /信封来路/, '来路行必须始终出现')
  assert.match(withUnknown, /未知来路非 0/, '★ 未知非 0 ⇒ 必须点名（否则这一格白数）')

  const clean = foldTasks([startEv('t-c2', 'manor_dispatch')])
  const cleanText = renderLedger(summarizeTasks(clean), clean, 10, 0)
  assert.match(cleanText, /信封来路/, '全 known 时那行同样要在')
  assert.match(cleanText, /无未知来路/)
})
