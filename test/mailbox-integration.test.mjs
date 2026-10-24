import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { REPORT_TOOL_NAME } from '../lib/reporting.js'

const root = fileURLToPath(new URL('..', import.meta.url))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function startMcp(url, workspace, token) {
  const child = spawn(process.execPath, ['bin/dsh-mcp-relay.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      DSH_RELAY_URL: url,
      DSH_RELAY_TOKEN: token,
      DSH_RELAY_CONNECTION_FILE: '',
      DSH_RELAY_DEFAULT_WORKSPACE: workspace,
      DSH_RELAY_POLL_MS: '5',
      DSH_RELAY_CALL_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const pending = new Map()
  const reader = createInterface({ input: child.stdout })
  reader.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  })
  let nextId = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`MCP request ${method} timed out; stderr: ${stderr}`))
    }, 8000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args })
    assert.ok(response.result, JSON.stringify(response))
    assert.equal(response.result.isError, undefined, response.result.content?.[0]?.text)
    return JSON.parse(response.result.content[0].text)
  }
  return {
    child,
    rpc,
    call,
    async close() {
      child.stdin.end()
      if (child.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(() => { child.kill(); resolve() }, 1500)),
        ])
      }
      reader.close()
    },
  }
}

test('MCP receives scoped DSH reports while the task runs and can recover them after reconnect', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.mailbox-integration-'))
  const sessionId = 'relay-mailbox-integration-session'
  const token = 'mailbox-integration-token'
  let handler
  let reportTool
  let createTimeToolCount = -1
  let running = false
  let promptCount = 0
  let nextDshSeq = 0
  let reportSequence = 0
  let completed = false
  let concludeTurnCalls = 0
  const pendingReports = []
  const records = []
  const taskRelease = deferred()
  const reportSignals = [deferred(), deferred()]
  const agentRegistry = new Map()
  const events = new Map()
  const workspaceByPath = new Map()

  const workspaceRegistry = {
    list: () => [...workspaceByPath.values()],
    resolveByPath: async (path) => workspaceByPath.get(path),
    async create(path) {
      const group = {
        id: `workspace-${workspaceByPath.size + 1}`,
        path,
        sessionIds: [],
        async attachSession(id) {
          if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
        },
      }
      workspaceByPath.set(path, group)
      return group
    },
  }

  const emit = async (name, payload) => {
    for (const listener of events.get(name) || []) await listener(payload)
  }

  const makeAgent = (id) => {
    const tools = []
    const agent = {
      id,
      tools,
      ctx: {
        tools: {
          register(definition) {
            tools.push(definition)
            return () => {
              const index = tools.indexOf(definition)
              if (index >= 0) tools.splice(index, 1)
            }
          },
        },
      },
    }
    agentRegistry.set(id, agent)
    return agent
  }

  const base = {
    async list() {
      return {
        items: agentRegistry.size ? [{
          sessionId,
          cwd: directory,
          running,
          blank: false,
          origin: 'workspace',
          projections: { asOfSeq: nextDshSeq, values: {} },
        }] : [],
      }
    },
    async create() {
      const agent = makeAgent(sessionId)
      // The DSH runtime can announce the new Agent before the controller has
      // persisted ownership. The host hook must safely skip it; /delegate
      // calls ensure() again after ownership is written and before prompt.
      await emit('agent/created', { agent })
      createTimeToolCount = agent.tools.filter((tool) => tool.name === REPORT_TOOL_NAME).length
      return { sessionId }
    },
    async rename() { return { accepted: true } },
    async prompt(request) {
      running = true
      promptCount += 1
      const index = promptCount
      assert.equal(request.sessionId, sessionId)
      if (index === 1) assert.ok(request.content.some((block) => block.type === 'text' && /report_to_codex/.test(block.text)), 'workspace prompt includes the reporting protocol')
      if (request.mode === 'steer') assert.equal(index, 2)
      if (index <= 2) {
        const tool = reportTool || agentRegistry.get(sessionId)?.tools.find((candidate) => candidate.name === REPORT_TOOL_NAME)
        reportTool = tool
        assert.ok(tool, 'the scoped report tool is installed before the prompt reaches the agent')
        const payload = index === 1
          ? { kind: 'progress', message: 'first report while work is active' }
          : { kind: 'finding', message: 'steered report while work is active' }
        const pending = new Promise((resolve, reject) => setTimeout(async () => {
          try {
            const accepted = await tool.execute(payload, {
              agent: agentRegistry.get(sessionId),
              concludeTurn() { concludeTurnCalls += 1 },
            })
            const rendered = tool.output.render(payload, accepted)
            assert.deepEqual(rendered, [{ type: 'text', text: JSON.stringify(accepted) }])
            reportSignals[index - 1].resolve({ accepted, rendered })
            resolve()
          } catch (error) { reject(error) }
        }, 30))
        pendingReports.push(pending)
      }
      return { accepted: true }
    },
    async page() {
      return { records: records.filter((record) => record.event.seq <= nextDshSeq), hasMore: false }
    },
    async cancel() { running = false; return { accepted: true } },
    async modelCatalog() { return { groups: [] } },
  }

  const webServer = {
    protocol: 'http:',
    port: 0,
    register(registration) {
      assert.equal(registration.kind, 'prefix')
      assert.equal(registration.path, '/dsh-relay')
      handler = registration.handler
      return () => { handler = undefined }
    },
  }
  const services = new Map([
    ['webServer', webServer],
    ['sessionController', base],
    ['workspaceRegistry', workspaceRegistry],
    ['agents', { get: (id) => agentRegistry.get(id), list: () => [...agentRegistry.values()] }],
  ])
  const context = {
    get: (name) => services.get(name),
    on(name, listener) {
      if (!events.has(name)) events.set(name, [])
      events.get(name).push(listener)
      return () => events.set(name, (events.get(name) || []).filter((entry) => entry !== listener))
    },
    effect(callback) { return callback() },
  }

  const server = createServer((request, response) => {
    if (!handler) {
      response.writeHead(503).end('relay handler unavailable')
      return
    }
    handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  webServer.port = server.address().port
  const previousToken = process.env.DSH_RELAY_TOKEN
  process.env.DSH_RELAY_TOKEN = token
  let firstClient
  let reconnectedClient
  try {
    apply(context, { sessionMode: 'workspace', stateDirectory: directory })
    const url = `http://127.0.0.1:${server.address().port}/dsh-relay`
    firstClient = startMcp(url, directory, token)
    const initialized = await firstClient.rpc('initialize', {})
    assert.equal(initialized.result.serverInfo.name, 'dsh-mcp-relay')
    const listed = await firstClient.rpc('tools/list', {})
    assert.ok(listed.result.tools.some((tool) => tool.name === 'dsh_delegate'))

    const receipt = await firstClient.call('dsh_delegate', { instruction: 'Run the mailbox integration task.' })
    assert.equal(receipt.status, 'accepted')
    assert.equal(receipt.afterMessageSeq, 0)
    assert.equal(createTimeToolCount, 0, 'early agent/created occurs before workspace ownership is available')
    const actualAgent = agentRegistry.get(sessionId)
    assert.equal(actualAgent.tools.filter((tool) => tool.name === REPORT_TOOL_NAME).length, 1, 'ensure registers the tool once after ownership is written')
    reportTool = actualAgent.tools.find((tool) => tool.name === REPORT_TOOL_NAME)
    assert.deepEqual(reportTool.output.schema.required, ['accepted', 'messageId', 'message'])
    assert.equal(typeof reportTool.output.render, 'function')

    const firstReport = await firstClient.call('dsh_poll', { sessionId, timeoutMs: 1200 })
    const firstToolResult = await reportSignals[0].promise
    assert.equal(firstReport.status, 'running', 'a report must not mark the active task complete')
    assert.equal(firstReport.messages.length, 1)
    assert.equal(firstReport.messages[0].seq, 1)
    assert.equal(firstReport.messages[0].message, 'first report while work is active')
    assert.equal(firstReport.nextMessageSeq, 1)
    const historyRequest = (path, headers = { 'x-dsh-relay-token': token }) => fetch(url + path, { headers })
    const reportHistory = await (await historyRequest('/communications?source=reports&sessionId=' + sessionId)).json()
    assert.equal(reportHistory.ok, true)
    assert.equal(reportHistory.data.entries[0].message, firstReport.messages[0].message)
    assert.equal(reportHistory.data.entries[0].messageId, firstReport.messages[0].messageId)
    assert.equal(reportHistory.data.entries[0].label, 'DSH → Codex · report_to_codex')
    assert.equal((await historyRequest('/communications?source=reports&sessionId=' + sessionId, {})).status, 401)
    assert.equal((await historyRequest('/open-communications')).status, 405, 'opening VS Code requires an explicit POST')
    assert.equal((await historyRequest('/open-communications', {})).status, 401)
    const rejectedOpen = await fetch(url + '/open-communications', { method: 'POST',
      headers: { 'x-dsh-relay-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({sessionId:'not-owned'}) })
    assert.equal((await rejectedOpen.json()).ok, false, 'ordinary or unknown sessions cannot launch the reader')
    assert.equal((await historyRequest('/communications?sessionId=' + sessionId, {
      'x-dsh-relay-token': token, origin: 'https://untrusted.example',
    })).status, 403)
    assert.equal((await (await historyRequest('/communications?sessionId=not-owned')).json()).ok, false)
    assert.equal((await (await historyRequest('/communications?source=reports&sessionId=' + sessionId + '&afterSeq=-1')).json()).ok, false)
    assert.equal(firstReport.feedback, 'message')
    assert.equal(firstToolResult.accepted.accepted, true)
    assert.ok(firstToolResult.accepted.messageId)
    assert.equal(concludeTurnCalls, 0, 'report tool does not conclude the DSH turn')

    const noDuplicate = await firstClient.call('dsh_poll', { sessionId, timeoutMs: 0 })
    assert.equal(noDuplicate.status, 'running')
    assert.deepEqual(noDuplicate.messages, [], 'the MCP process retains the acknowledged mailbox cursor')
    assert.equal(noDuplicate.nextMessageSeq, 1)

    const steered = await firstClient.call('dsh_delegate', {
      sessionId,
      mode: 'steer',
      instruction: 'Continue with this additional direction.',
    })
    assert.equal(steered.status, 'accepted')
    assert.equal(steered.afterMessageSeq, 1)
    const secondReport = await firstClient.call('dsh_poll', { sessionId, timeoutMs: 1200 })
    await reportSignals[1].promise
    assert.equal(secondReport.status, 'running')
    assert.equal(secondReport.messages.length, 1)
    assert.equal(secondReport.messages[0].seq, 2)
    assert.equal(secondReport.messages[0].kind, 'finding')
    assert.equal(secondReport.nextMessageSeq, 2)
    assert.equal(concludeTurnCalls, 0)

    taskRelease.resolve()
    await taskRelease.promise
    const finalAccepted = await reportTool.execute(
      { kind: 'reply', message: 'final report pending alongside completion' },
      { agent: actualAgent, concludeTurn() { concludeTurnCalls += 1 } },
    )
    assert.equal(finalAccepted.accepted, true)
    reportSequence = 3
    nextDshSeq = 1
    records.push({ event: { seq: nextDshSeq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'INTEGRATION_DONE' }] } } } })
    nextDshSeq = 2
    records.push({ event: { seq: nextDshSeq, type: 'turn/end', data: { reason: { kind: 'completed' } } } })
    running = false
    completed = true

    const terminal = await firstClient.call('dsh_poll', { sessionId, baselineSeq: receipt.baselineSeq, timeoutMs: 0 })
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.output, 'INTEGRATION_DONE')
    const nativeHistory = await (await historyRequest('/communications?sessionId=' + sessionId)).json()
    assert.equal(nativeHistory.data.entries[0].message, 'INTEGRATION_DONE')
    assert.equal(nativeHistory.data.entries[1].label, '本轮结束')
    const reportReplay = await (await historyRequest('/communications?source=reports&sessionId=' + sessionId)).json()
    assert.equal(reportReplay.data.entries.length, 3, 'viewer replays consumed reports independently of MCP cursors')
    assert.equal(terminal.messages.length, 1)
    assert.equal(terminal.messages[0].seq, reportSequence)
    assert.equal(terminal.messages[0].kind, 'reply')
    assert.equal(concludeTurnCalls, 0)

    await firstClient.close()
    firstClient = undefined
    reconnectedClient = startMcp(url, directory, token)
    await reconnectedClient.rpc('initialize', {})
    const replay = await reconnectedClient.call('dsh_poll', {
      sessionId,
      baselineSeq: receipt.baselineSeq,
      afterMessageSeq: 2,
      timeoutMs: 0,
    })
    assert.equal(replay.status, 'completed')
    assert.equal(replay.output, 'INTEGRATION_DONE')
    assert.equal(replay.messages.length, 1)
    assert.equal(replay.messages[0].seq, 3, 'explicit cursor restores persisted reports after MCP reconnect')
    assert.equal(replay.nextMessageSeq, 3)
    assert.equal(completed, true)
  } finally {
    taskRelease.resolve()
    if (firstClient) await firstClient.close()
    if (reconnectedClient) await reconnectedClient.close()
    if (previousToken === undefined) delete process.env.DSH_RELAY_TOKEN
    else process.env.DSH_RELAY_TOKEN = previousToken
    await new Promise((resolve) => server.close(resolve))
    await Promise.allSettled(pendingReports)
    rmSync(directory, { recursive: true, force: true })
  }
})

