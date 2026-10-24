# DSH_MCP

[English](README.md) | [简体中文](README.zh.md) | [本机部署与验证](LOCAL-INSTALL.md) | [工具注册与双端提示词](AGENT-SETUP.md)

当前版本：**0.7.0-mailbox.1**，基于 [Nigheart/dsh-mcp-relay](https://github.com/Nigheart/dsh-mcp-relay) 修改。本文说明本目录的实现；直接安装上游仓库不代表包含这些本地改动。许可证为 MIT。

本插件让 Codex 等 MCP 客户端把任务交给正在运行的 DeepSeek Harness（DSH），并在同一会话中继续交流。DSH 使用自己注册的模型、工具和权限执行任务，可以主动发送阶段报告，最后返回真实的完成或失败结果。

## 同一个项目的两个端

- **Codex MCP 端**：`bin/DSH_MCP.mjs`、HTTP 客户端及工具定义，配置为 stdio MCP 服务。
- **DSH 插件端**：`lib/index.js`、`lib/client.js`、`cordis.patch.yml`，提供本机中继和原生界面接入。
- **DSH 本地注册工具**：`lib/reporting.js` 提供 `report_to_codex`，由同一 Host 插件为 Relay 管理的会话注册；不用另建仓库或手动复制工具。

两端应使用同一份源码或同一版本。本仓库只保存实现与通用说明，个人全局规则、模型偏好、凭据和聊天记录留在仓库外。

## 当前行为

- 任务是普通 DSH 工作区对话，标题为 `子代理：任务名`，可在原生界面打开、选择模型和继续聊天。
- 新任务按调用方提供的绝对 `workspace` 路径匹配 DSH 工作区；不存在时创建对应工作区。
- `dsh_delegate` 默认立即返回任务凭证，后续用 `dsh_poll` 等待消息或结果。
- DSH 模型通过 `report_to_codex` 主动汇报；报告入队后继续已授权工作，不必等 Codex 确认。
- 必要的执行中补充使用同一 `sessionId` 和 `mode: "steer"`。处理时机取决于 DSH 的执行边界，不保证打断一次正在进行的模型请求或工具调用。
- **没有两分钟定时状态播报。** 新消息、结束结果和需要处理的问题驱动反馈。
- 模型请求自动重试不唤醒 Codex；MCP 状态响应也不包含中途重试次数和错误。即使已进入最后一次重试，只要 DSH 仍在运行就继续等待；只有实际 `turn/end` 错误结束后才返回失败与重试详情。DSH 界面的重试提示照常保留，正常任务报告不受影响。
- 插件邮箱通过 MCP 工具结果交给主模型，不接入 Codex 原生子代理邮箱，也不会自动唤醒已结束的主模型回合。

## 架构与完整工作流

### 查看双向通信记录

在设置 → DSH_MCP 点击“打开对话”旁的“通信记录”，直接在 VS Code 打开一次性的临时 Markdown 快照，不在插件页面展示或导出正文。快照包含 Relay 下发的任务/追问、DSH 中间与最终文本回复、已保存的 report_to_codex 报告；系统提示词、规则与运行环境暂时保留并标注来源。工具调用、工具返回、模型内部推理不显示。

读取当时的原生日志和报告邮箱，不实时刷新，不生成额外 JSON 副本。VS Code 通过 --wait 等待这份 Markdown 标签页关闭，然后删除临时 MD 和专用空目录；不要求退出整个 VS Code。关闭不会改变任何 DSH 任务。原始压缩 JSONL 日志与 reports/*.json 保留，因为后台报告仍以此持久化。

入口为同源且需要 token 的 POST /dsh-relay/open-communications，仅允许 Relay 管理的会话。更新源码后需在方便时重载插件及客户端；不会自动重启 DSH。

```text
Codex 主模型
  │ 调用 dsh_delegate / dsh_poll 等 MCP 工具
  ▼
bin/DSH_MCP.mjs：独立 stdio MCP 进程
  │ 经过回环 HTTP 和 token 鉴权
  ▼
lib/index.js：DSH 进程内的 Cordis 插件
  ├─ sessionController → 普通 DSH 工作区会话 → DSH 模型执行
  └─ lib/reporting.js  ← 模型调用 report_to_codex
          │ 持久化阶段报告
          ▼
      插件消息队列 → MCP 等待提前返回 → Codex 获得工具结果
```

1. Codex 提交任务。插件创建或复用会话，加入协作说明，MCP 返回 `sessionId`、`requestId`、`baselineSeq`、`afterMessageSeq`。
2. Codex 调用 `dsh_poll`。MCP 程序内部检查 DSH 状态和未读报告；这不是反复调用模型。
3. DSH 在有用的检查点调用 `report_to_codex`。插件先保存消息，再确认入队；报告不会结束 DSH 任务。
4. `poll` 发现新消息后提前返回，任务可以仍为 `running`。Codex 处理结论、继续其他工作，或发送必要补充。
5. Codex 保留任务的 `baselineSeq`，用返回的 `nextMessageSeq` 更新消息游标，再等待后续消息。
6. DSH 正常输出最终回答。插件根据真实结束事件返回 `completed` 或其他终态；完成时仍应取完剩余报告页。

## 安装与配置

需要可运行本插件的 DSH 桌面端或 Web profile，以及同机的 Node.js 和 stdio MCP 客户端。包声明 Node.js `>=18`；本机验证使用 Node.js 24.18.0。DSH 内部服务接口可能随版本变化，应以实际注册工具和集成测试为准。

从 `https://github.com/greatZhaoFD/DSH_MCP` 克隆项目到自选目录；下例以 `D:\plugins\DSH_MCP` 为例。DSH profile 通过 `link:` 引用该目录，Codex MCP 入口也指向同一份源码。双端安装步骤见 [安装说明](LOCAL-INSTALL.md)。

保留 `cordis.patch.yml` 中的依赖与 `sessionMode: workspace` 配置；当前 bundle 依赖 `webServer`、`sessionController`、`agents`、`llm`、`workspaceRegistry`。

Codex 的配置示例（替换为实际绝对路径）：

```toml
[mcp_servers.DSH_MCP]
command = "node"
args = ["D:/plugins/DSH_MCP/bin/DSH_MCP.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 900

[mcp_servers.DSH_MCP.env]
DSH_RELAY_CONNECTION_FILE = "C:/Users/<you>/.dsh/dsh-mcp-relay/connection.json"
```

建议用 `connection.json` 发现当前端口和 token，避免写死桌面端动态端口。不要公开其内容。更新 host 代码后重新加载 DSH 插件；更新 MCP 入口或工具说明后，重新连接 Codex 的 MCP 进程。只改 Markdown 不需要重新加载运行时。

| 环境变量 | 当前含义 |
| --- | --- |
| `DSH_RELAY_CONNECTION_FILE` | 读取当前本机中继地址和 token；配置后优先于固定地址与 token。 |
| `DSH_RELAY_URL` | 未配置发现文件时使用，默认 `http://127.0.0.1:3080/dsh-relay`。 |
| `DSH_RELAY_TOKEN` | Host 可用它指定 token；MCP 使用固定地址模式时发送同值。工作区模式未指定时由 host 生成 token 并写入发现文件。 |
| `DSH_RELAY_DEFAULT_WORKSPACE` | 创建任务时省略 `workspace` 的程序回退值；调用方仍应显式传当前项目目录。最终回退为 MCP 进程工作目录。 |
| `DSH_RELAY_POLL_MS` | MCP 内部检查间隔，默认 `2000` 毫秒，不是模型汇报频率。 |
| `DSH_RELAY_CALL_TIMEOUT_MS` | 单次 HTTP 调用上限，默认 `30000` 毫秒。 |
| `DSH_RELAY_SURFACE` | 默认 `lean`。`full` 是冻结的旧版工具面，仅供历史对照，不能作为新版消息协议的用法说明。 |

旧变量 `DSH_RELAY_TIMEOUT_MS` 当前不被 MCP 入口读取。当前单次等待由 `timeoutMs` 控制，默认并最多 `600000` 毫秒；客户端自身也可能有更短的调用超时。该上限只防止连接无限等待，**不取消 DSH 任务，不等于模型请求失败，也不要求向用户播报状态**。

## 工具与调用示例

需要复用配置或迁移到其他机器时，请看 [工具注册与双端代理提示词](AGENT-SETUP.md)：包含 DSH 工具契约、注册位置，以及可直接合并到 DSH 和 Codex `AGENTS.md` 的英文提示词。工具由插件注册，Markdown 负责行为约定。

Codex 侧共 **7 个 MCP 工具**：

| 工具 | 用途 |
| --- | --- |
| `dsh_delegate` | 创建任务、沿用会话续聊，或用 `steer` 补充执行中输入；默认返回凭证。 |
| `dsh_poll` | 等待新报告、终态或人工等待，返回状态、消息及适用的结果字段。 |
| `dsh_list_sessions` | 列出 Relay 管理的会话，可按工作目录过滤；包含可获得的模型提示。 |
| `dsh_models` | 列出当前 DSH 模型目录、提供方和可用思考强度。 |
| `dsh_answer` | 回答已被接管的 `ask_user_question` 问题。 |
| `dsh_approval` | 设置后续审批策略；不追溯已经挂起的审批。 |
| `dsh_cancel` | 停止当前活动轮次；不保证清除 DSH 已排队输入。 |

参数示例：

```js
// 1. 接单：省略 sessionId 创建新会话；wait 默认 false。
dsh_delegate({
  workspace: "D:/project",
  taskName: "代码审查",
  instruction: "只读审查指定模块，发现重要问题先报告，再继续检查。"
})

// 2. 使用凭证中的两个游标等待。
dsh_poll({ sessionId, baselineSeq, afterMessageSeq })

// 3. 下一次保持任务游标，推进消息游标。
dsh_poll({ sessionId, baselineSeq, afterMessageSeq: nextMessageSeq })

// 4. 向同一任务发送必要的执行中补充；查询进度应使用 poll。
dsh_delegate({ sessionId, mode: "steer", instruction: "协调消息Q1：请补充检查边界条件，并在报告中关联Q1。" })
```

`wait: true` 兼容等待模式，但出现新报告、终态或人工等待时也可提前返回，并非保证一次调用只返回最终答案。`timeoutMs: 0` 用于一次即时查询，不要用短轮询反复唤起主模型。

DSH 侧另有 **1 个模型工具**，它不是第八个 Codex MCP 工具：

```js
report_to_codex({
  kind: "reply",             // progress | finding | blocker | question | reply
  message: "已完成6/10组，继续执行。", // 非空，最多4000字符
  replyTo: "Q1"              // 可选，关联协调消息
})
```

它只给 Relay 管理的会话注册，身份由实际执行上下文确定，模型不能指定其他目标会话。成功响应包含 `accepted: true` 和 `messageId`，仅确认持久化入队，不表示 Codex 已读或批准。模型应在阶段结论、长任务启动（附任务标识或路径）、重要发现、阻碍、必要决策或回复询问时使用；避免逐步闲聊和定时心跳，只暂停真正依赖决策或权限的工作。

## 游标、存储与读取时机

`baselineSeq` 是 DSH 日志任务游标，用于排除旧终态和旧输出；`afterMessageSeq` 是独立的插件报告游标，不能互换。

- `poll` 返回 `messages`、`nextMessageSeq`、`hasMoreMessages`，每页最多20条。下次用 `nextMessageSeq` 作为 `afterMessageSeq`，有剩余页则继续取回。
- 未显式传消息游标时，当前 MCP 进程会记住最近取回的位置；重新连接后应传入保存的显式游标，防止重读。
- 传 `afterMessageSeq: 0` 可重读报告。读取不会删除文件，也没有当前版本自动清理约定。
- Codex 未等待时，报告保存在队列；下一次 `poll` 才会交给调用方。普通 MCP 结果不会自动变成原生 `collaboration` 邮箱消息。

默认存储（`DSH_HOME` 或自定义状态目录可能改变实际位置）：

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/sessions/<编码工作目录>/<sessionId>/session.v4.jsonl.zstd` | DSH 原生对话、输入、工具事件和最终回答。 |
| `~/.dsh/dsh-mcp-relay/reports/<会话ID的SHA-256>.json` | 插件阶段消息、序号、消息ID、时间和可选关联ID。 |
| 同目录 `sessions.json` | Relay 会话索引与旧ID映射。 |
| 同目录 `preferences.json` | 新任务的模型偏好。 |
| 同目录 `connection.json` | 当前本机地址和鉴权 token，应保密。 |

工作区是对话的项目归属；聊天日志默认不写进项目源码目录。项目 `AGENTS.md` 提供本项目的条件式汇报规范；部署时还可在 DSH 自己的全局 `AGENTS.md` 中配置。插件会对新任务或首次续接旧任务注入一次协作说明，不假定 DSH 会读取 Codex 的全局规则。

## 状态、模型、问题与权限

| 状态 | 含义 |
| --- | --- |
| `accepted` | 输入已接收，保留凭证继续等待。 |
| `running` | 仍在执行；可能同时携带新报告、工具活动或模型重试信息。 |
| `pending` | 尚未观察到本次输入对应的运行或结束证据。 |
| `waiting` | 正在等待被接管的问题回答，或人工审批等。 |
| `completed` | DSH 明确正常结束，`output` 为本轮最终回答。 |
| `failed` | DSH 明确出错结束，透传 `error.code/message`；适用时附重试信息和 `partialOutput`。 |
| `cancelled` / `interrupted` / `blocked` | 明确停止、中断或受阻结束，不能当作成功。 |
| `unknown` | 查询故障或结束证据不足；不要直接重派任务。 |

Host 用实时 `running` 快照判断活动，用本轮 `turn/end.data.reason` 判断终态。重试、静默、空回答和连接等待到期都不直接等于任务失败。单个工具报错而模型继续处理时，也不能认定整项任务失败。

模型：显式 `model` 参数优先；已有会话未指定时沿用当前选择；新会话使用已保存的插件偏好，没有偏好再使用 DSH 默认值。通过 `dsh_models` 获取注册的提供方、模型和思考强度，不硬编码固定模型数量。插件设置页保存偏好，原生会话仍可改模型。显式或原生选择走 DSH 原生接口，可能同步更新 DSH 实例默认值。查询会话模型使用 `dsh_list_sessions`；不要依赖每个 `poll` 都返回模型字段。

问题接管：默认 `takeover: true`。`waiting.kind: "user-question"` 且 `intercepted: true` 时，用 `dsh_answer` 并保留问题ID回复；约三分钟未回答会回落到 DSH GUI，仍需人处理。`report_to_codex` 的 `kind: "question"` 只是报告消息，不等同于挂起的提问工具调用。

审批：已经挂起的审批需人在 DSH GUI 处理或取消本轮。`dsh_approval` 的 `gui`、`deny`、`auto-approve` 只影响后续请求；自动审批能否生效取决于部署，配置成功不代表实际有效。消息转发不扩大任何既有授权或权限。

## 安全、测试与限制

HTTP 中继只接受回环调用方；工作区模式生成 token，MCP 在请求头发送它。中继有自己的鉴权，不应假定 DSH `/api` 的访问控制也覆盖中继。不要公开发现文件、token 或对话内容。

```bash
npm test
```

测试覆盖工作区会话、模型选择、问题接管、状态/错误转发、消息持久化与分页、调用身份校验，以及真实 MCP stdio 进程与模拟 DSH 主机的整条消息链路。测试需要本机回环网络，不会因此调用外部付费模型。本机真实模型验证记录见 [LOCAL-INSTALL.md](LOCAL-INSTALL.md)。

MCP 内部检查不调用模型；主模型处理报告、DSH 执行工具以及新增上下文仍可能消耗额度。工具调用数量、模型请求数量、token 数量和订阅额度占比不是同一个指标。`bin/dsh-bench.mjs` 可用于观察工具面和历史请求，不提供精确订阅计费归因。

当前不保证即时打断长推理、不转发全部思考内容、不自动唤醒已结束的主对话，也不自动删除消息或存档整个项目。普通状态查询读取近期会话日志，极端长会话若缺乏可靠结束证据会保守返回 `unknown`；持久化报告队列另行分页读取。
