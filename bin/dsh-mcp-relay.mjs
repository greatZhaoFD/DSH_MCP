#!/usr/bin/env node
import { taskStatus } from '../lib/turn-status.js'
/**
 * DSH Agent Control — MCP stdio server.
 *
 * Relays the Model Context Protocol (stdio, newline-delimited JSON-RPC) to the
 * in-process DSH host relay (HTTP). The relay is mounted by the
 * dsh-mcp-relay Cordis plugin inside the *running* DSH instance, so everything
 * this server drives is the same live runtime the Web GUI is attached to.
 *
 * stdout carries protocol frames only; all diagnostics go to stderr.
 *
 * Waiting is handled deliberately: polling happens here, where it costs
 * nothing, and a session blocked on a human is surfaced immediately instead of
 * consuming the caller's wait window. When takeover is on, the question is held for
 * the caller to answer via dsh_answer; otherwise it stays with the GUI.
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

import { buildSurface } from './surface.mjs'
import { createRelayClient } from './relay-client.mjs'

const RELAY = process.env.DSH_RELAY_URL || 'http://127.0.0.1:3080/dsh-relay'
const RELAY_TOKEN = process.env.DSH_RELAY_TOKEN || ''
// Connection guard only: no periodic model/user heartbeat. Return early on messages.
const MAX_WAIT_MS = 600000
const DEFAULT_TIMEOUT_MS = MAX_WAIT_MS
const receipts = new Map()
const messageCursors = new Map()
function messageCursor(value) {
  const n = Number(value ?? 0)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('afterMessageSeq must be a non-negative safe integer')
  return n
}
function reportFields(sessionId, view, afterMessageSeq) {
  if (!Array.isArray(view?.messages)) return {}
  const messages = view.messages.filter(m => Number.isSafeInteger(m.seq) && m.seq > afterMessageSeq)
  const nextMessageSeq = messages.length ? messages.at(-1).seq : afterMessageSeq
  messageCursors.set(sessionId, nextMessageSeq)
  return { messages, nextMessageSeq, hasMoreMessages: view.hasMoreMessages === true,
    reportToolAvailable: view.reportToolAvailable === true,
    ...(messages.length ? { feedback: 'message', note: 'New DSH message received. Reporting does not finish or pause the task; continue the same task without resubmitting.' } : {}) }
}
function waitBudget(value) {
  const n = Number(value ?? MAX_WAIT_MS)
  if (!Number.isFinite(n) || n < 0) throw new Error('timeoutMs must be a non-negative finite number')
  return Math.min(n, MAX_WAIT_MS)
}
const POLL_INTERVAL_MS = Number(process.env.DSH_RELAY_POLL_MS || 2000)
const RELAY_CALL_TIMEOUT_MS = Number(process.env.DSH_RELAY_CALL_TIMEOUT_MS || 30000)

// Everything the client pays for on every request: the handshake instructions
// and the tool schemas. DSH_RELAY_SURFACE=full serves the frozen 0.6.0 surface
// for A/B measurement; anything else gets the lean one.
const SURFACE = buildSurface({
  variant: process.env.DSH_RELAY_SURFACE || 'lean',
  timeoutMs: DEFAULT_TIMEOUT_MS,
})

const log = (...parts) => process.stderr.write(`[dsh-mcp-relay] ${parts.join(' ')}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const relay = createRelayClient({
  url: RELAY,
  token: RELAY_TOKEN,
  ...(process.env.DSH_RELAY_CONNECTION_FILE ? { connection: () => {
    const value = JSON.parse(readFileSync(process.env.DSH_RELAY_CONNECTION_FILE, 'utf8'))
    const url = new URL(value.url)
    if (url.hostname !== '127.0.0.1') throw new Error('Relay discovery must name a loopback address')
    return value
  }} : {}),
  callTimeoutMs: RELAY_CALL_TIMEOUT_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
})

function summarizeView(view) {
  if (!view) return {}
  return {
    running: view.running === true,
    status: view.status,
    model: view.model,
    takeover: view.takeover === true,
    pendingTool: view.pendingTool,
    lastSeq: view.lastSeq,
    lastEventType: ['llm/retry', 'llm/retry-started'].includes(view.lastEventType) ? undefined : view.lastEventType,
    assistantCount: view.assistantCount,
    cwd: view.cwd,
    cursor: view.cursor,
    readSource: view.source,
  }
}

// Transient provider disconnects are handled inside DSH. They neither wake the
// coordinator wait nor become retry notices in guard/explicit status replies.
// Even attempt === maxRetries is still running until the actual error end.
function modelRequestFields(view, status) {
  return {
    phase: view?.phase === 'retrying' ? 'model' : view?.phase,
    ...(status === 'failed' && view?.retry ? { retry: view.retry } : {}),
  }
}

function waitingNotice(view) {
  const waiting = view && view.waiting
  if (!waiting) return undefined
  if (waiting.intercepted === true) {
    return (
      'DSH asked a question and takeover is holding it for YOU. Answer it with ' +
      'dsh_answer({ sessionId, answers }), using the question ids shown in waiting.detail. ' +
      'If nobody answers within the takeover window the question falls back to the DSH GUI.'
    )
  }
  if (waiting.kind === 'approval') {
    const tools = (waiting.detail || []).map((entry) => entry.toolName).filter(Boolean)
    const what = tools.length > 0 ? `the tool "${tools.join('", "')}"` : 'a tool call'
    return (
      `DSH is blocked on an approval request for ${what}. This approval is ALREADY pending, so it can only be ` +
      'resolved by a person in the DSH GUI, or abandoned with dsh_cancel. ' +
      'dsh_approval changes how FUTURE approvals are handled, not this one: "deny" makes later ones fail at once, ' +
      '"gui" leaves them to the GUI. waiting.detail carries the reason DSH gave for asking.'
    )
  }
  if (waiting.kind === 'user-question') {
    return (
      'DSH is blocked waiting for a HUMAN to answer its question, and the answerer is the DSH Web GUI. ' +
      'Nobody can answer it from here: tell the user to answer it in the DSH GUI, then call dsh_poll again. ' +
      'Turning takeover on for this session (dsh_delegate with takeover) would route such questions to you instead.'
    )
  }
  return `DSH reported an unrecognised wait state (${waiting.kind}); call dsh_poll again to re-read it.`
}

function textBlock(text) {
  return { content: [{ type: 'text', text }] }
}

async function callTool(name, args) {
  if (name === 'dsh_list_sessions') {
    const query = args.workspace ? `?cwd=${encodeURIComponent(args.workspace)}` : ''
    const data = await relay.call(`/list${query}`)
    return textBlock(JSON.stringify(data))
  }

  if (name === 'dsh_models') {
    const data = await relay.call('/models')
    return textBlock(JSON.stringify(data))
  }

  if (name === 'dsh_delegate') {
    const accepted = await relay.call('/delegate', {
      method: 'POST',
      body: {
        instruction: args.instruction,
        workspace: args.workspace || (!args.sessionId ? process.env.DSH_RELAY_DEFAULT_WORKSPACE || process.cwd() : undefined),
        taskName: args.taskName,
        sessionId: args.sessionId,
        mode: args.mode,
        agentPreset: args.agentPreset,
        model: args.model,
        provider: args.provider,
        reasoningEffort: args.reasoningEffort,
        takeover: args.takeover !== false,
      },
    })

    const baselineSeq = Number(accepted.baselineSeq || 0)
    receipts.set(accepted.sessionId, { baselineSeq, requestId: accepted.requestId, startedAt: Date.now() })
    const afterMessageSeq = messageCursor(messageCursors.get(accepted.sessionId) ?? accepted.baselineMessageSeq)
    messageCursors.set(accepted.sessionId, afterMessageSeq)
    if (args.wait !== true) {
      return textBlock(
        JSON.stringify(
          {
            sessionId: accepted.sessionId,
            requestId: accepted.requestId,
            status: 'accepted',
            baselineSeq,
            afterMessageSeq,
            note: 'Accepted. Use dsh_poll to wait for messages or outcome. No periodic status reports; do not resubmit.',
          }),
      )
    }

    const timeoutMs = waitBudget(args.timeoutMs)
    let outcome, view
    try {
      ({ outcome, view } = await relay.waitForSettle(accepted.sessionId, baselineSeq, timeoutMs, afterMessageSeq))
    } catch (error) {
      return textBlock(JSON.stringify({ sessionId: accepted.sessionId, baselineSeq, status: 'unknown',
        error: String(error.message || error),
        note: 'Task was accepted but status check failed. Retry dsh_poll; do not resubmit.' }))
    }
    // Only hand back output this turn produced. lastSeq can advance on unrelated
    // events, and the session's last assistant message may predate the
    // delegation, so the text has to be checked against the cursor too. An older
    // relay that reports no outputSeq keeps the previous behaviour.
    const outputSeq = view && view.outputSeq
    const freshOutput = outputSeq == null ? true : Number(outputSeq) > baselineSeq
    const output = freshOutput && view && view.output ? view.output : ''

    return textBlock(
      JSON.stringify(
        {
          sessionId: accepted.sessionId,
          created: accepted.created,
          ...summarizeView(view),
          // The wait outcome, not the session's own status: the caller branches on
          // completed / waiting / timeout, exactly as the injected instructions say.
          // summarizeView carries the session state under the same key, so it has to
          // be spread first.
          status: taskStatus(view, baselineSeq),
          ...(Number(view?.lastTurnEndSeq ?? -1) > baselineSeq ? { error: view?.error, terminationReason: view?.terminationReason } : {}),
          ...modelRequestFields(view, taskStatus(view, baselineSeq)),
          // The selection this call installed, when it installed one; the spread
          // above already carries the session's own model hint otherwise.
          ...(accepted.model ? { model: accepted.model, modelNote: accepted.modelNote } : {}),
          output: outcome === 'completed' ? output : '',
          ...(outcome === 'failed' && output ? { partialOutput: output } : {}),
          waiting: view && view.waiting ? view.waiting : undefined,
          action: waitingNotice(view),
          baselineSeq,
          note:
            outcome === 'timeout'
              ? 'Wait window ended; task not cancelled. Continue dsh_poll with the same sessionId and baselineSeq; do not resubmit.'
              : undefined,
          ...reportFields(accepted.sessionId, view, afterMessageSeq),
        }),
    )
  }

  if (name === 'dsh_answer') {
    const result = await relay.call('/answer', {
      method: 'POST',
      body: { sessionId: args.sessionId, answers: args.answers },
    })
    return textBlock(
      JSON.stringify(
        {
          sessionId: result.sessionId,
          delivered: result.delivered,
          note: 'The agent is resuming. Call dsh_poll with a baselineSeq to collect its output.',
        }),
    )
  }

  if (name === 'dsh_approval') {
    const result = await relay.call('/approval', {
      method: 'POST',
      body: { sessionId: args.sessionId, mode: args.mode },
    })
    return textBlock(JSON.stringify(result))
  }

  if (name === 'dsh_cancel') {
    const result = await relay.call('/cancel', {
      method: 'POST',
      body: { sessionId: args.sessionId },
    })
    return textBlock(JSON.stringify(result))
  }

  if (name === 'dsh_poll') {
    const receipt = receipts.get(args.sessionId)
    const baselineSeq = Number(args.baselineSeq ?? receipt?.baselineSeq ?? 0)
    const afterMessageSeq = messageCursor(args.afterMessageSeq ?? messageCursors.get(args.sessionId))
    const timeoutMs = waitBudget(args.timeoutMs)
    let outcome, view
    try {
      ({ outcome, view } = timeoutMs > 0
        ? await relay.waitForSettle(args.sessionId, baselineSeq, timeoutMs, afterMessageSeq)
        : { outcome: null, view: await relay.pollOnce(args.sessionId, undefined, afterMessageSeq) })
    } catch (error) {
      return textBlock(JSON.stringify({ sessionId: args.sessionId, baselineSeq, status: 'unknown',
        note: 'Status check failed; the task may still be running. Retry dsh_poll, not dsh_delegate.',
        error: String(error.message || error) }))
    }
    const status = taskStatus(view, baselineSeq)
    const fresh = view?.outputSeq == null || Number(view.outputSeq) > baselineSeq
    return textBlock(JSON.stringify({
      sessionId: args.sessionId, baselineSeq, status,
      ...(receipt ? { elapsedSeconds: Math.floor((Date.now() - receipt.startedAt) / 1000) } : {}),
      ...modelRequestFields(view, status),
      ...(['failed', 'cancelled', 'interrupted', 'blocked'].includes(status) ? { terminationReason: view?.terminationReason, error: view?.error } : {}),
      ...(status === 'unknown' ? { note: 'No reliable terminal outcome is available. Check the same session; do not assume success or resubmit.', statusSource: view?.statusSource } : {}),
      ...(status === 'running' || status === 'pending' ? {
        relayReachable: true, lastSeq: view?.lastSeq,
        ...(view?.lastEventTime != null ? { lastActivityAt: view.lastEventTime } : {}),
        ...(view?.pendingTool ? { pendingTool: view.pendingTool } : {}),
        note: 'Task remains active. A connection wait limit is not task failure; continue waiting without routine user-facing status or reminders.',
      } : {}),
      ...(status === 'completed' ? { output: fresh ? view?.output || '' : '' } : {}),
      ...(status === 'failed' && fresh && view?.output ? { partialOutput: view.output } : {}),
      ...(status === 'waiting' ? { waiting: view.waiting, action: waitingNotice(view) } : {}),
      ...reportFields(args.sessionId, view, afterMessageSeq),
    }))
  }

  throw new Error(`unknown tool: ${name}`)
}

// ── MCP stdio transport ──────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleRequest(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-mcp-relay', version: '0.7.0-mailbox.1' },
        // Injected into the client's context at handshake time, so the caller
        // learns the delegation model and the waiting contract without any
        // manual setup on the user's side.
        instructions: SURFACE.instructions,
      }
    case 'tools/list':
      return { tools: SURFACE.tools }
    case 'tools/call': {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      return await callTool(name, args)
    }
    case 'ping':
      return {}
    default:
      throw new Error(`method not found: ${method}`)
  }
}

let pending = 0

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    log('dropped unparseable line')
    return
  }

  // Notifications carry no id and expect no response.
  if (message.id === undefined || message.id === null) return

  pending += 1
  handleRequest(message.method, message.params)
    .then((result) => {
      send({ jsonrpc: '2.0', id: message.id, result })
    })
    .catch((error) => {
      const text = String(error && error.message ? error.message : error)
      log('request failed:', text)
      // Tool failures belong in the tool result so the model can react to them.
      if (message.method === 'tools/call') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `DSH relay error: ${text}` }], isError: true },
        })
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: text } })
      }
    })
    .finally(() => {
      pending -= 1
    })
})

// A real MCP client keeps stdin open for the whole session; when it closes,
// drain any in-flight request so a piped test run still sees the response.
rl.on('close', () => {
  const waitForIdle = () => {
    if (pending === 0) {
      process.exit(0)
      return
    }
    setTimeout(waitForIdle, 50)
  }
  waitForIdle()
})

log(`ready — relay=${RELAY}`)

