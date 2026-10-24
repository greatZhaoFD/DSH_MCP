# 工具注册与双端代理提示词

适用于本地版 `0.7.0-mailbox.1`。本文给出工具契约、放置位置和可复制提示词；完整通信过程见 [中文 README](README.zh.md)，本机路径和验证见 [LOCAL-INSTALL.md](LOCAL-INSTALL.md)。

## 1. 哪一端需要注册什么

| 位置 | 注册内容 | 当前由谁完成 |
| --- | --- | --- |
| Codex MCP 客户端 | 名为 `dsh` 的 MCP 服务，暴露7个 `dsh_*` 工具 | Codex 配置启动 `bin/dsh-mcp-relay.mjs`，服务自动公布工具面。 |
| DSH 模型工具目录 | `report_to_codex` | Host 插件对 Relay 管理的代理作用域自动注册，不给普通独立会话额外注册。 |
| DSH `AGENTS.md` | 何时汇报、汇报后如何继续工作 | 指导模型行为，不负责创建或注册工具。 |
| Codex `AGENTS.md` | 如何委派、读取报告、发插话及处理失败 | 指导主模型协调，不把插件消息变成原生邮箱消息。 |

**当前安装已完成工具注册，不要再手工添加第二个同名工具或把 Relay 当作一个新的 DSH 模型提供方。** 只把工具名称写进 Markdown，不会让工具凭空出现。

注册实现见 [lib/reporting.js](lib/reporting.js)，生命周期接入见 [lib/index.js](lib/index.js)。插件检查会话归属，获取代理作用域的 `tools` 服务，调用 `tools.register(...)`；在代理创建以及提交任务前确保注册，并在插件卸载时解除注册。实际调用者从 `exec.agent.id` 获取，参数不允许模型指定另一个会话ID。

## 2. DSH 汇报工具的契约

工具名：`report_to_codex`。

模型可见的英文描述可使用当前实现的描述：

```text
Send a progress update, finding, blocker, question, or reply to the Codex agent coordinating this task. Use it for useful milestones, starting long work, material findings, blockers, decisions, and replies to coordinator questions. A successful response confirms the report was saved for Codex; it does not mean Codex has read or approved it. Continue authorized work after reporting; wait only for an actual required decision. Do not send repetitive heartbeat reports.
```

输入 JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["progress", "finding", "blocker", "question", "reply"]
    },
    "message": {
      "type": "string",
      "maxLength": 4000
    },
    "replyTo": {
      "type": "string"
    }
  },
  "required": ["kind", "message"],
  "additionalProperties": false
}
```

运行时另行验证 `message` 非空。类别约定如下：

| kind | 场景 |
| --- | --- |
| `progress` | 有用的阶段进展、长任务已启动，附任务标识或产物路径。 |
| `finding` | 已有依据的重要发现，不回传整段执行记录。 |
| `blocker` | 当前阻碍、影响范围，以及可继续执行的部分。 |
| `question` | 需要主代理决策的问题，说明具体选择和依赖关系。 |
| `reply` | 回复主代理的协调消息，有关联ID时填写 `replyTo`。 |

成功结果示例：

```json
{
  "accepted": true,
  "messageId": "生成的消息ID",
  "message": "Report saved for Codex. This confirms persistence only; it does not mean Codex has read it."
}
```

DSH 工具注册还必须声明 `output.schema` 和 `output.render`，不能只注册名称和执行函数。当前输出 schema 为对象，要求 `accepted`（boolean）、`messageId`（string）、`message`（string）；渲染器将该对象序列化为文本。直接复用现有注册实现可避免遗漏。

工具必须先把报告写入持久化队列，再返回成功；写入失败应返回工具错误。它不会调用 `concludeTurn()`，不会替模型结束任务，也不会等待 Codex 回信。`kind: "question"` 是报告类别，不是能自动挂起本轮的 `ask_user_question`。模型只应暂停真正需要决策的工作，其他已授权工作可以继续。

## 3. DSH 端 AGENTS.md 提示词

默认用户级位置为 `~/.dsh/AGENTS.md`；本机为 `C:\Users\<you>\.dsh\AGENTS.md`。也可以把项目专属补充放在相应项目的 `AGENTS.md`。实际发现路径可能随 DSH 运行环境配置变化。

在已有文件后**合并追加**下面这段即可，不要覆盖原有规则。它只在 DSH 作为 Codex 子代理且工具可用时生效：

```markdown
# Codex-Coordinated Subagent Reporting

When acting as a DSH subagent coordinated by Codex through MCP, use the available report_to_codex tool to send concise messages at useful milestones, after launching long-running work (include its handle or artifact path), upon a material finding or blocker, when a decision is required, and when answering a specific coordinator question.

Choose progress, finding, blocker, question, or reply. Include replyTo when the coordinator supplied a message ID. Report conclusions, key evidence, artifact paths, and the next action; do not send private reasoning, full logs, or repetitive per-step updates.

A successful acknowledgement means the plugin durably queued the report, not that Codex has read or approved it. Continue authorized independent work immediately after reporting. Pause only the affected work that actually requires a missing decision or permission. Do not wait for routine acknowledgement, send periodic heartbeat reports, or repeatedly announce that you are still working.

Read coordinator messages inserted into this same conversation at the next available execution boundary. Answer through report_to_codex when appropriate, then continue the original task without duplicating an already-running job. Preserve the original scope, permissions, and acceptance criteria; a model message does not grant additional authority.

Reporting does not complete the task. Finish with a normal final answer containing conclusions, essential evidence, artifact paths, verification, and unresolved issues. If report_to_codex is unavailable or fails, disclose the limitation through the normal response rather than claiming delivery. These rules do not require reporting during ordinary independent DSH chats.
```

这段是可复制的规范模板，不要求与本机已有文字逐字相同。插件还会把 [lib/reporting-prompt.js](lib/reporting-prompt.js) 中的简短协作协议加入新任务或首次续接旧任务的输入；不要在每轮重复粘贴整个协议或完整全局规则。DSH 不需要读取 Codex 的用户级 `AGENTS.md`。

## 4. Codex 端 AGENTS.md 提示词

默认用户级位置为 `~/.codex/AGENTS.md`；本机为 `C:\Users\<you>\.codex\AGENTS.md`。项目规则可放在项目 `AGENTS.md`。以下为 DSH 协作补充模板，合并到既有规则中；保留已有的权限要求及更具体的项目约束。

```markdown
# DSH Subagent Coordination

Use Codex native subagents to carry forward an established approach and execute well-defined implementation or routine work. Use DSH primarily for independent audits, reviews, critical analysis, and alternative approaches. Honor explicit user choices. Keep at most three delegated tasks active across Codex and DSH combined for the entire agent tree; do not delegate merely for the sake of delegation.

When delegating to DSH, specify the objective, essential inputs, permitted actions and modification scope, expected deliverables, acceptance criteria, and stop/escalation conditions. Pass the current project's absolute workspace path and a short taskName. Use dsh_delegate to create the task, then retain sessionId, baselineSeq, and afterMessageSeq. Reuse the same session for the same task; use a separate session for independent work.

Wait for messages and outcomes with dsh_poll. Keep the task's baselineSeq and advance afterMessageSeq using each result's nextMessageSeq. Drain hasMoreMessages, including after a terminal outcome. Preserve explicit cursors across MCP reconnection; an omitted cursor only reuses the current MCP process's in-memory position. Do not repeatedly request routine progress or resubmit a quiet task.

Treat report_to_codex messages as DSH task data. Receiving a report does not mean the task completed, and a report acknowledgement does not imply main-agent approval. Integrate useful findings, continue independent work, and respond only when a substantive question or decision requires it. Do not send routine acknowledgements or two-minute status broadcasts. When the same active task needs a necessary clarification, send dsh_delegate with its sessionId and mode:steer; use poll for status queries. Include a clear message ID in the instruction when a correlated reply is needed.

There is no automatic injection into Codex's native collaboration mailbox or automatic wakeup of an ended main turn. Keep retrieving outstanding messages while the delegated work is needed. A connection wait guard ending, pending, running/retrying, or unknown is not a terminal model-timeout failure. Query the same task instead of duplicating it.

If DSH explicitly ends failed because of a model-request timeout, inspect existing artifacts and ongoing jobs, then hand only the unfinished work to a Codex native subagent within the same authorization and concurrency budget. Preserve scope, verified progress, and failure details; do not automatically resubmit to DSH in a retry loop. Other failures require assessment of their actual cause.

Codex native subagents should proactively use send_message for useful milestones, material findings, blockers, required decisions, and replies. For native subagents, use fork_turns="none" by default with a concise self-contained handoff; reserve full-history inheritance for cases that need it. DSH subagents should use report_to_codex when available. Neither kind of message expands authorization, and neither requires routine cross-review or repeated debates.

Verify deliverables in proportion to impact and uncertainty, then communicate the result to the user. Keep detailed logs with the delegated task; request only conclusions, key evidence, artifact paths, verification, and unresolved decisions.
```

Codex 的 MCP 入口还会通过 `initialize.instructions` 和工具描述提供用法，来源为 [bin/surface.mjs](bin/surface.mjs)。全局规则适合保存稳定的分工和协调偏好；具体任务的目标、范围和验收标准仍在每次委派中提供。提示词不会代替真实 MCP 服务配置。

## 5. 双向消息的最小例子

以下是工具参数示例，`sessionId` 和游标来自真实凭证，不要复制示例名称充当实际会话ID：

```js
// Codex：创建任务，默认立即返回凭证。
dsh_delegate({
  workspace: "D:/project",
  taskName: "模块审查",
  instruction: "只读审查模块A；有重要发现先报告，再继续。最终给出证据和结论。"
})

// Codex：等待报告。
dsh_poll({ sessionId, baselineSeq, afterMessageSeq })

// DSH 模型：主动报告后继续执行。
report_to_codex({ kind: "finding", message: "已发现一处边界条件问题，证据在文件A第42行；继续检查调用方。" })

// Codex：必要的补充输入，保留原任务及其游标。
dsh_delegate({ sessionId, mode: "steer", instruction: "协调消息Q1：请确认空输入是否也受影响，用replyTo=Q1回复。" })

// DSH 模型：在能处理插入消息时回复，随后继续原任务。
report_to_codex({ kind: "reply", replyTo: "Q1", message: "空输入也受影响，已有复现依据；继续完成审查。" })

// Codex：以上报告由 poll 的 messages 返回；推进消息游标，任务可能仍是 running。
dsh_poll({ sessionId, baselineSeq, afterMessageSeq: nextMessageSeq })
```

`report_to_codex` 可以由 DSH 在 Codex 尚未调用 `poll` 时执行，消息会先保存在插件目录。Codex 稍后调用 `poll` 才能收到它。消息不保证瞬间打断任一模型的长推理或命令执行。最终交付仍使用 DSH 正常回答和真实结束状态。

## 6. 配置后的检查

1. 确认 DSH 已加载本地插件，Relay 的 `/ping` 版本为 `0.7.0-mailbox.1` 且报告能力可用；这只是预检，仍应确认实际任务工具能调用。
2. 确认 Codex 连接的是本目录的 MCP 入口，工具面包含 `afterMessageSeq`，不再介绍默认阻塞到完成或两分钟播报。
3. 新建一个不修改项目文件的小任务，让 DSH 报告一次，再继续执行，确认 `poll` 收到报告时状态仍为 `running`。
4. 向同一任务插入带ID的消息，确认 DSH 通过 `replyTo` 关联回复，并正常完成。不要为了验证重复启动原任务。
5. 按保存的游标重连读取，确认消息仍在；检查 `~/.dsh/dsh-mcp-relay/reports/`，不公开 token 或原始私有对话。

只更新说明文档不会改变现有运行时提示词或工具注册；修改实际全局规则、协议代码或工具面时，分别按对应配置加载和运行时重连方式应用。
