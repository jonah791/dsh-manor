<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 庄园门面：找成员（谁在·她是谁·怎么起）、派活（自动合规信封含 meta.taskId）、唤醒（adapter 模式·凭据键从 profile 推导）、成员册（登记层 + 管理面：members/hire/retire/assign）
  inject: ['tools']
  tools: manor_find,manor_dispatch,manor_claim,manor_release,manor_holds,manor_wake,manor_members,manor_hire,manor_retire,manor_assign,manor_patrol,manor_tasks,manor_reap,manor_dispute,manor_task_watch,manor_stranded
  runtime: host-only
  envDeps: 见 README「配置」节
  boundary: 见 README「设计要点」与「生效判据与回退」节
  compat: cordis ^4.0.1 / dsh-tools >=0.1.0-rc.6
-->
# manor · 庄园门面

<p align="center">
  <a href="https://github.com/jonah791/manor"><img src="https://img.shields.io/badge/version-0.2.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-3%20passed-brightgreen" alt="tests">
</p>

> 「找她们」·「把话发对」·「**管住她们是谁**」。

## 快速开始

**1) 装依赖**（在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"manor": "link:E:/alice/self-plugins/manor"
```

**2) 挂组合**：

```yaml
- id: manor
  name: manor
```

**3) 30 秒验证**：`manor_find` → 应列出庄园成员（谁在 · 她是谁 · 该怎么起她）

## 为什么存在（两次真实失败，2026-10-09）

总女仆长要给成员派活时，需要跨四处拼信息（总线名册 / 成员的 AGENTS.md / 她的 profile / 邮箱积压）， 而**启动命令与信封格式只存在于人类文档里**。文档一腐化就出错，当晚连栽两次：

| # | 症状 | 根因 | 代价 |
|---|---|---|---|
| ① | 成员 **2 秒 `exit=1`**，stderr 为空 | 照人类文档传 `--keyName OPEMCODER_API_KEY`，而该成员 provider 已换到 `command` ⇒ 缺 `COMMAND_API_KEY`。**headless 只在正常走完时才把答复吐到 stdout** ⇒ 故障不可自证 | 两次派活全废，诊断耗多轮 |
| ② | 成员拒收：「任务缺少 `meta.taskId`」 | 用集群通用通道派活，其信封**不带 `meta`**，而庄园适配器要求它 | 任务退回 |

⇒ 共同根因：**「该怎么起、该怎么发」被写死在文档里**。本插件把两件事改成**从真源推导**： 启动参数从成员的 profile 解析，信封由工具生成。

## 十一个工具

| 工具 | 干什么 | 副作用 |
|---|---|---|
| `manor_find` | 调度名册：谁在 · 她是谁（名字/职责） · 该怎么起她（命令从 profile 推导） · 收件箱积压**（按「能不能被取走」分档：可处理 / 无人认领 · 最旧多久）** · **暂不可发起几件** | 只读 |
| `manor_members` | **成员册**（登记层）：在职/退役 · 职责 · 状态合并 · 双向分歧显式报出 | 只读 |
| `manor_hire` | **聘用**：把成员登记进名册（已存在即拒绝——不静默覆盖） | 写 `roster.json` |
| `manor_retire` | **退役**：只改状态、**条目保留、可复职**（重复退役报错） | 写 `roster.json` |
| `manor_assign` | **调职 / 改名 / 复职**：字段级合并，并报出**实际变了哪几项** | 写 `roster.json` |
| `manor_dispatch` | 派活：生成**合规信封**（自动补 `meta.taskId/acceptance/cwd`）写入她的收件箱；`dependsOn` 未就绪则**挂进 `hold/`**（不投递） | 写一个文件（no-clobber） |
| `manor_holds` | **暂不可发起**（③ 依赖面）：依赖项 · 挂起者 · 出口裁决 · 「为什么还没跑」（**现读，带来源定位符**）· **反向扫描**（就绪却没跑 / 依赖方已不活） | 只读（`sweep=true` 时跑一轮释放） |
| `manor_wake` | 唤醒：按 **adapter 模式**起成员，凭据键从 profile 推导；经孤儿化启动器转手 | 起进程 |
| `manor_patrol` | **存活巡检**：找出死了的成员并按纪律拉起（有界退避 · 上限告警 · 恢复即清零） | 起进程 · 写巡检账 |
| `manor_tasks` | **任务台账**（作业层）：谁派给谁 · 四终态（done/failed/**rejected**/unfinished）· 失败归因 · 失败率 | 只读 |
| `manor_task_watch` | **任务失败守望**：只把**新增**的失败/静默失败推出去（W1 只报新增 · W2 拒收不报故障 · W3 未完优先 · W4 首轮只建基线） | 写守望账 |

> ⚠ 工具数曾在此写「七个」而实际已有九个 —— 2026-10-11 核对补齐；2026-10-12 加 `manor_holds` 时**同一处又核对一次**（**声明与实现对账**纪律：数字类声明每次改动都要重量产物）。

## 登记层 vs 状态层（2026-10-11 主人定调：「庄园需要有女仆名册，主要是进行成员管理」）

在此之前，庄园**只有状态层**（总线 `nodes/*.json` 的心跳）—— 「谁在线」查得到，「**我们有哪些人、各自担什么职责、谁已退役**」系统里**没有一处权威答案**。 实测形态：`node_list` 里有 maid-01~05 的 profile，名册里只有 01/02/03， 而「她们各担什么职责」散落在各自的 AGENTS.md / 语义文档 / 总女仆长的记忆里。

⇒ 本插件补**登记层**（`<busDir>/roster.json`），两层分工：

| 层 | 真源 | 答什么问题 | 失效后的表现 |
|---|---|---|---|
| **登记层**（权威 · 持久） | `roster.json` | 成员**是谁**、担什么职责、什么状态 | 读坏了 ⇒ **fail-loud**；不存在 ⇒ 空册（首次使用） |
| 状态层（派生 · 易失） | 总线 `nodes/` | 成员**此刻在不在** | 心跳没了 ⇒ 只影响「在不在」，**不影响身份** |

**两条不变量**（写死在纯函数层，测试直接断言）：

- **N1 身份不靠心跳**：成员全部离线时，`manor_members` 仍须列出全部在职成员及其职责
- **N2 退役只移不删**：退役只改 `status`/`retiredAtMs`，条目保留 ⇒ 可回退（`manor_assign {reactivate:true}`）

**双向分歧显式报出**（不隐藏）：`neverSeen`（在册但从未上过线——聘了没起过，或起法失败） 与 `unregistered`（总线上有但未登记——野生节点不该混在成员里）。

## 与既有设施的分工（不造平行载体）

| 既有 | 它管什么 | 本插件不重做的部分 |
|---|---|---|
| `manor_roster`（nodeforge） | **多源核验的存活判定**（atMs / mtime / pid 三源 + 分歧显式报出） | 不重做。`manor_find` 只给单判据速览并指路 |
| `node_retire`（nodeforge） | 退役**节点痕迹**（明确拒绝退役成员，须显式放行） | 不重做。成员语义的退役归 `manor_retire` |
| `cluster_send` | **通用集群投递** | 不重做。`manor_dispatch` 补的是**庄园专属信封契约**（`meta.taskId`） |
| `node_start`（nodeforge） | 把 DSH profile 起成**普通节点**（`bin.js --profile X`） | 不重做。庄园成员走 **adapter 模式**，`manor_wake` 只做后者 |

## 配置

```yaml
- id: manor
  name: dsh-manor
  config:
    busDir: 'C:\Users\tr\.dsh-cluster'        # 总线根（cluster 与 adapter 共用；roster.json 也在这里）
    nodesRoot: 'E:\alice-nodes'               # 节点分区根
    adapterPath: 'E:\alice\projects\self\alice-manor\adapter.mjs'
    credentialsPath: 'E:\alice\.dsh\.credentials.yaml'
    spawnDetachedPath: 'E:\alice\self-plugins\dsh-agent-nodeforge\scripts\spawn-detached.mjs'
    selfId: 'LAPTOP-BF4IAPLM-web-0'           # 派活时的 from
    heartbeatFreshMs: 30000                   # 心跳新鲜阈值
```

⚠ **路径都是锚点不是真源**：换机后要改配置。总线名册读不到时工具**响亮报错**（「空」与「读不到」是两件事）。

## 测试

`npm test` → `node --test "tests/*.test.ts" "tests/*.test.mjs"`（**双 glob**：`.ts` 是主套件，`.mjs` 是跨构建单元的夹具——曾只匹配 `.ts`，那两条 `.mjs` 于是从不进套件）。

**实测读数（2026-10-12）：`# tests 219 / # pass 219 / # fail 0`。**
⚠ **这个数会随实现增长而漂——真源是跑一次 `npm test`，不是读这段文字**（本节曾写 194，漂 29）。因此**不写每个文件的例数**（那类数字没有仪器覆盖），只列**文件**——文件是否存在由 `readme-claim-verify` 门禁核。

13 个文件：

- `tests/roster-registry.test.ts`：登记层纯函数 + 两条不变量 + 排序 + 在线判定边界
- `tests/roster-lock.test.ts`：名册并发写保护——**对照实验（无锁必丢一笔）** + 修复实验（加锁两笔都在）+ 指纹 CAS + 坏锁四具尸体 + TTL 与时钟偏移 + 有界等待 + 释放不夺权
- `tests/pure.test.ts`：门面自身的纯函数（`keyNamesFor` / `parseIdentity` / `judgeFresh` / `buildEnvelope` / `newMsgId`）
- `tests/patrol.test.ts`：存活巡检决策——有界退避 / 上限告警 / 恢复即清零
- `tests/task-ledger.test.ts`：任务台账四终态与归因（含 C1–C5 五个口径坑的尸体样本）+ **未完带年龄与同类参照**
- `tests/task-watch.test.ts`：失败守望 W1–W4 四条纪律——只报新增 / 拒收不报故障 / 未完优先 / 首轮只建基线
- `tests/inbox.test.ts`：收件箱分类——**契约同源**（读适配器 `dispatch.mjs` 的 `MANOR_KINDS` 逐字对账）+ fail-closed 坏 kind 算无人认领 + 「可处理件再旧也不算搁浅」+ 阈值两侧
- `tests/kindmap-contract.test.ts`：**行为面**契约——读适配器**真的调用判定函数**后落下的产物（`state/adapter-kindmap-<id>.json`），断言「声明认领 ⟺ 实际判为它」。⚠ **与上一条互补、缺一条就有盲区**：上一条读**声明**，本条读**行为**。**它是集成检查**：盘上无产物时**显式 SKIP**
- `tests/envelope.test.ts`：信封与指针——`buildEnvelope`（**refs 非空才写**）/ `parseRef` / `checkRefs`（**空与写坏分开报**）
- `tests/hold.test.ts`：③ 依赖面**纯判定层**——出口三条 + 成环 fail-loud（自依赖/两节点/三节点/**深链不误报**）+ 反向扫描双向 + 溯源行 + 异形可见面 + **★ 指针 ≠ 状态**（序列化一字未变而解释句必须变）+ **★ 判死取宽**（抖动不升级）+ **★ 在线面读不到 ⇒ 不作判**
- `tests/hold-store.test.ts`：③ 依赖面 **IO 层端到端**——在**临时总线**（真目录/真文件/真 rename）上跑：落盘往返 · no-clobber · 坏记录 fail-loud · **真磁盘上重跑解释器得同一句话** · 释放+溯源行+移出 · **幂等** · **收敛** · 出口三各走一次 · **升级可撤销** · **反向扫描不对刚释放的报假异常** · 有界批次与 deferred · 信封契约单一真源
- `tests/stranded-bus.test.ts`：全域搁浅面——**箱名在不在 `nodes/` 里**（可算的事实，不并名册）+ `done=0` 的四个理由 + 0 件时缺口块不出现 + 覆盖率口径
- `tests/human-age-parity.test.mjs`：**跨构建单元夹具**——`src/stranded-bus.ts` 与 `stranded.mjs` 各有一份 `humanAge`，此夹具证明两份**同语义**（含 `ms<0` 边界、以及一条**分辨力对照**）

**尸体样本遍布这些文件**（回退分支 / 坏 JSON / 重复 id / 时钟异常 / 空身份 / 缺标题行 / 「降级警告」与「拒收」的区分 / **把依赖状态缓存进记录** / **心跳抖动** / **在线面读不到** …）—— 它们证明这些判据**有分辨力**，而不是「恰好没出错」。

⚠ **更正（2026-10-11）**：本文 v0.1.0 曾声称有 `tests/pure.test.mjs`（10/10），而当时该文件不在仓库里（声明与实现不符）。 处置不是删声明，是**把声明变成真的**：补的 `pure.test.ts` 覆盖同一批函数且更全（15 例，多出「空键名会让成员 2 秒 exit=1」等实测坑）。 事后清账发现那个 `.mjs` 被一次保险库提交带回了仓库，却**从不被执行**——`npm test` 的 glob 只匹配 `*.test.ts`， 于是出现「一份在跑、另一份在装死」的形态。其 10 例已被 `pure.test.ts` 逐条覆盖，同日移除。

## 边界与不主张

1. **只覆盖 adapter 模式的成员**。`manor_find` 对非 adapter 成员（`harness != 'alice-manor-adapter'`）
   不给 `startCmd`（`canWake=false`）——**明确指出而不是编一个**。
2. **心跳判据是单一源**。严格核验请用 `manor_roster`（它有分歧报告）。
3. **成员能活过 web 重启**（2026-10-11 线上验收，**推翻 v0.1.0 的第 3 条**）：
   机制 = `manor_wake` 经**孤儿化启动器**转手（父进程死后 `taskkill /T` 沿父链够不到她）；
   实测 = 织（pid 15932）**跨 web 重启 pid 不变**，心跳连续。
4. **名册的并发保护**（2026-10-11 修，**本条旧版已被推翻**）：三个管理动作走**同一写入口** `mutateRoster`，「读 → 改 → 写」整段在临界区内——① 进程内队列 ② 跨进程文件锁 `<roster>.lock`（owner/atMs/ttlMs；TTL 过期可抢；坏锁放行并留痕）③ 写盘前 CAS 复核（兜住锁的残余窗口：TTL 被抢、时钟跳变）。`writeRoster` 仍是「写临时文件 + 原子替换」，但它**自身不管并发——调用方必须走写入口**。证据：对照实验「无锁并发两笔读-改-写 ⇒ 必丢一笔（只剩 1 人）」vs「加锁后同一实验 ⇒ 两笔都在（2 人）」；端到端真并发两笔 `manor_hire` 的回报是「在册 1 人」→「在册 2 人」（第二笔读到了第一笔的结果）。旧版的处置是「管理动作串行调用的**纪律**」——而纪律不是机制（见庄园语义文档 §5.1 与 §10 E7）。
5. **`manor_wake` 的真源是登记册**（2026-10-11 修）：此前只读心跳 ⇒ **从未上线过的成员永远唤不醒**
   （没有心跳文件就推导不出她的 profile/workdir）——而「招募了却起不来」恰恰是名册要解决的场景。
   现顺序为「登记册 → 心跳回退 → 报错」，两处都没有时提示 `manor_hire`。

## 相关文档

- ⚠ **本插件暂无 `semantic.md`**（未建语义文档）——契约以 README 各节与源码为准；补文档是待办。
- 中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)