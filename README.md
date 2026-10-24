# dsh-creativity-nudge

DSH 插件：**在模型锁定路线的那一刻，注入一次"先发散"的提醒。**
建议型（advisory only）——不否决调用、不改写结果、不评价输出好坏。

配套技能：`creative-divergence`（在 `~/.dsh/skills/creative-divergence/SKILL.md`；"怎么做"的工序在技能里，插件只负责"什么时候想起来"）。

默认 `enabled: false`：**装上不生效**，改配置才注册监听。

---

## 为什么是钩子而不是提示词

创新提示最怕高频。每轮都出现的"要有创意"，等于每轮都不出现——它会退化成格式噪音，模型和人都一样免疫。

所以这里的设计是 **低频 + 硬预算 + 只落在决策点**，而不是"每次都提醒"。

## 触发时机（只判断时机，不判断内容）

判"这个任务要不要创意"只有两条路：多烧一次模型调用，或者写关键词正则误伤。所以插件**不做判断**，只观测确定性的结构事实：

| 时机 | 观测条件 | 文案要它做什么 | 每会话 |
|---|---|---|---|
| **T1 承诺点** | 本会话第一次 `write`/`edit`，且用户最近一条消息命中了 `keywords` | 给出两个"机制不同"的候选，各写一句牺牲 | 1 次 |
| **T2 卡住点** | 同一个文件被改到第 `stuckEdits` 次（默认 5） | 换机制，别再微调同一处 | 1 次 |
| T3 连续失败 | 连续 `stuckFailures` 次 `isError`（**默认 0 = 关闭**） | 回退到能工作的状态再换方向 | 0 次 |

T2 默认 5 而不是 3：正常开发里改同一个文件 3 次是常态，5 次才开始像打转。
T3 默认关闭：一次失败的测试再改一次是很正常的迭代，误报率高于信息量；要开就设 `stuckFailures: 2`。

**不做 T4「交付前提醒」**：答案已经写完，这时候提醒只能逼模型推倒重写，成本翻倍、收益不可证。

## 频率（硬预算，不是节流）

- `maxPerSession: 2` —— 每会话最多两次，用完就没有
- `cooldownCalls: 8` —— 两次提醒之间至少隔 8 次工具调用
- **用户发新消息**清空 T2 的文件计数与失败计数（T1 的"第一次落盘"不重置；同一条用户消息在每一 step 重复出现，按 message id 去重）
- **措辞轮换**：同一句话出现第三次会被当样板忽略，所以两条文案按 seed 轮换
- **单调递减**：预算本身就是递减的——第 3 次机会不存在

## 配置

在 `cordis.patch.yml` 的 config 段改：

```yaml
        enabled: false          # 总开关（装上不生效就靠它）
        maxPerSession: 2        # 每会话最多注入几次
        cooldownCalls: 8        # 两次提醒之间的最小工具调用间隔
        stuckEdits: 5           # 同一文件改到第几次算打转
        stuckFailures: 0        # 连续失败阈值，0 = 关闭
        mutatingTools: ['write', 'edit']
        keywords: ['设计', '方案', '架构', '命名', ...]
        dryRun: false           # 只记日志不注入
        auditFile: ''           # jsonl 审计路径，空 = 不写
```

非法配置（如 `stuckEdits: 1`、`keywords: []`）在装载时直接抛错，不静默改行为。

## 开关（装完默认是关的）

在 `<profile>/cordis.patch.yml` 末尾追加这三行，重启 DSH 即生效：

```yaml
- id: creativity-nudge
  name: 'dsh-creativity-nudge'
  config:
    enabled: true
```

部分字段就够——插件内部的 `normalizeConfig` 会拿 `DEFAULTS` 合并，没写的键走默认值。
想先观测不打扰，就换成：

```yaml
- id: creativity-nudge
  name: 'dsh-creativity-nudge'
  config:
    enabled: false
    dryRun: true
    auditFile: '%USERPROFILE%/.dsh/logs/creativity-nudge.jsonl'
```

注意 `dryRun` 单独也能激活监听（不需要 `enabled`），但只写日志、不注入。

## 安装 / 卸载

```powershell
node scripts/install.mjs --dry-run     # 预演
node scripts/install.mjs               # 装进档案（会备份 package.json）
node scripts/install.mjs --uninstall   # 彻底摘干净
```

安装 = 复制到 `<profile>/node_modules/dsh-creativity-nudge` + 追加进 `dsh.profile.bundles`。
**装完必须完全退出并重开 DSH。**

> 不要在这个档案里跑 `pnpm install`：它会按 package.json 的 dependencies 重装 node_modules，把手放的这份冲掉。

## 验证

1. **单元测试**：`npm test`（15 条，覆盖预算、冷却、重置、dryRun、block 透传）
2. **只看不注入**：`enabled: true` + `dryRun: true` + `auditFile: '.../nudge.jsonl'`，跑一天，看 jsonl 里 `event: would-fire` 的条数与理由是否符合预期
3. **确认生效**：`enabled: true` 后开一个开放式任务，第一次落盘之后日志里会有 `creativity-nudge: 已接管 tools/post-execute`

## 已知限制

- **只看得见 `write`/`edit`**。用 `run_code` 写文件、用 `pwsh` 重定向写文件都不计数。
- **关键词是唯一的启发式**，也是唯一会误判的地方：中文任务描述里"设计/方案/架构"出现频率高，可能会在非创意任务上响一次（但有预算兜着）。
- **状态只在内存里**：恢复会话从零开始计数，重启后预算刷新。这是有意为之——它是启发式提醒，不是记录在案的不变量。
- 不跨 agent 互相影响（每个 agent 一份状态）。

## 结构

```
lib/index.js           插件本体（零 @deepseek-ai 依赖，只 import node 内建模块）
cordis.patch.yml       loader entry + 默认配置
scripts/install.mjs    装/卸进档案
scripts/profile-io.mjs 档案读写（复制自 dsh-command-guard）
tests/nudge.test.mjs   假 ctx 驱动的单元测试
```

依赖为零是有意的：档案里装的插件只保证能解析 node 内建模块，靠住的越少，宿主升级时越不会炸。
