import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildSurface } from '../bin/surface.mjs'

let state = { running: true, status: 'running', lastSeq: 6, outputSeq: 2, output: 'OLD' }
let submissions = 0
let failPoll = false
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/delegate') {
    submissions++
    res.end(JSON.stringify({ ok: true, data: { sessionId: 'test-session', requestId: 'req-1', baselineSeq: 5 } }))
  } else if (failPoll) {
    res.end(JSON.stringify({ ok: false, error: 'test connection failure' }))
  } else {
    const cursor = Number(new URL(req.url, 'http://localhost').searchParams.get('afterMessageSeq') || 0)
    const messages = state.messages?.filter(m => m.seq > cursor)
    res.end(JSON.stringify({ ok: true, data: { statusVersion: 2, ...state,
      ...(messages ? { messages } : {}) } }))
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const child = spawn(process.execPath, ['bin/dsh-mcp-relay.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, DSH_RELAY_URL: `http://127.0.0.1:${server.address().port}`,
    DSH_RELAY_CONNECTION_FILE: '', DSH_RELAY_POLL_MS: '5' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.resume()
const pending = new Map()
const reader = createInterface({ input: child.stdout })
reader.on('line', line => {
  const msg = JSON.parse(line)
  pending.get(msg.id)?.(msg)
  pending.delete(msg.id)
})
let id = 0
function rpc(method, params) {
  return new Promise(resolve => {
    const n = ++id
    pending.set(n, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
  })
}
async function tool(name, args) {
  const msg = await rpc('tools/call', { name, arguments: args })
  assert.ok(!msg.result.isError, JSON.stringify(msg))
  return JSON.parse(msg.result.content[0].text)
}
try {
  const init = await rpc('initialize', {})
  assert.match(init.result.instructions, /Be patient/)
  assert.match(init.result.instructions, /No periodic status broadcasts/)
  const receipt = await tool('dsh_delegate', { instruction: 'test' })
  assert.equal(receipt.status, 'accepted')
  assert.equal(receipt.afterMessageSeq, 0)
  assert.ok(!('nextPollMs' in receipt))
  assert.equal(receipt.baselineSeq, 5)
  assert.ok(JSON.stringify(receipt).length < 400)
  const running = await tool('dsh_poll', { sessionId: receipt.sessionId, timeoutMs: 35 })
  assert.equal(running.status, 'running')
  assert.equal(running.relayReachable, true)
  assert.ok(!('output' in running), 'running feedback must not repeat stale output')
  state = { running: true, status: 'running', phase: 'retrying', lastSeq: 7,
    lastEventType: 'llm/retry', retry: { attempt: 1, maxRetries: 5, error: { code: 'TRANSPORT', message: 'Connection error.' } } }
  const retryGuard = await tool('dsh_poll', { sessionId: receipt.sessionId, timeoutMs: 35 })
  assert.equal(retryGuard.status, 'running')
  assert.equal(retryGuard.phase, 'model')
  assert.ok(!('retry' in retryGuard), 'guard replies must not advertise transient retries')
  assert.ok(!('error' in retryGuard))
  assert.ok(!('feedback' in retryGuard))
  const explicitRetry = await tool('dsh_poll', { sessionId: receipt.sessionId, timeoutMs: 0 })
  assert.ok(!('retry' in explicitRetry), 'explicit snapshots also suppress intermediate retry diagnostics')
  const quietStart = Date.now()
  let early = false
  const retryWait = tool('dsh_poll', { sessionId: receipt.sessionId, timeoutMs: 2000 }).then(value => { early = true; return value })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(early, false, 'first retry does not wake Codex')
  state = { ...state, retry: { ...state.retry, attempt: 5 } }
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(early, false, 'last retry attempt remains quiet while DSH is still running')
  state = { ...state, running: false, lastSeq: 8, lastTurnEndSeq: 8, terminalStatus: 'failed',
    terminationReason: 'error', error: { code: 'TRANSPORT', message: 'Retries exhausted.' } }
  const exhausted = await retryWait
  assert.equal(exhausted.status, 'failed')
  assert.equal(exhausted.retry.attempt, 5)
  assert.equal(exhausted.error.message, 'Retries exhausted.')
  assert.ok(Date.now() - quietStart < 1900, 'actual terminal error wakes Codex before the wait guard')
  state = { running: true, status: 'running', phase: 'model', lastSeq: 9 }
  const reportStart = Date.now()
  const update = setTimeout(() => { state = { ...state, reportToolAvailable: true,
    messages: [{ seq: 1, messageId: 'm1', kind: 'progress', message: 'EXPERIMENT_STARTED' }] } }, 20)
  const report = await tool('dsh_poll', { sessionId: receipt.sessionId, timeoutMs: 1000 })
  clearTimeout(update)
  assert.equal(report.status, 'running', 'a report is not a terminal outcome')
  assert.equal(report.messages[0].message, 'EXPERIMENT_STARTED')
  assert.equal(report.nextMessageSeq, 1)
  assert.ok(Date.now() - reportStart < 900, 'new report wakes the wait before its guard')
  assert.equal(report.feedback, 'message')
  const next = await tool('dsh_poll', { sessionId: receipt.sessionId, timeoutMs: 15 })
  assert.deepEqual(next.messages, [], 'implicit cursor avoids repeating a delivered report')
  const replay = await tool('dsh_poll', { sessionId: receipt.sessionId, afterMessageSeq: 0, timeoutMs: 0 })
  assert.equal(replay.messages[0].messageId, 'm1', 'explicit cursor recovers messages after reconnect')
  state = { running: false, lastSeq: 5, lastTurnEndSeq: 5 }
  assert.equal((await tool('dsh_poll', { sessionId: receipt.sessionId, timeoutMs: 15 })).status, 'pending')
  state = { running: true, status: 'waiting', waiting: { kind: 'approval' }, lastSeq: 7 }
  assert.equal((await tool('dsh_poll', { sessionId: receipt.sessionId })).status, 'waiting')
  failPoll = true
  assert.equal((await tool('dsh_poll', { sessionId: receipt.sessionId })).status, 'unknown')
  failPoll = false
  state = { running: false, lastSeq: 10, lastTurnEndSeq: 10, terminalStatus: 'completed', outputSeq: 9, output: 'DONE' }
  const completed = await tool('dsh_poll', { sessionId: receipt.sessionId })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.output, 'DONE')
  state = { running: false, lastSeq: 13, lastTurnEndSeq: 13, terminalStatus: 'failed', terminationReason: 'error', error: { code: 'RATE_LIMIT', message: '429: Endpoint is unavailable.' }, retry: { attempt: 5, maxRetries: 5 } }
  const failed = await tool('dsh_poll', { sessionId: receipt.sessionId })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'RATE_LIMIT')
  assert.equal(failed.retry.attempt, 5)
  state = { running: false, lastSeq: 14, lastTurnEndSeq: 14, terminalStatus: 'cancelled', terminationReason: 'aborted' }
  assert.equal((await tool('dsh_poll', { sessionId: receipt.sessionId })).status, 'cancelled')
  state = { running: false, lastSeq: 20, lastTurnEndSeq: 14, terminalStatus: 'failed' }
  assert.equal((await tool('dsh_poll', { sessionId: receipt.sessionId, baselineSeq: 19, timeoutMs: 0 })).status, 'unknown')
  assert.equal(submissions, 1, 'polling must never resubmit the task')
  state = { running: true, status: 'running', phase: 'retrying', lastSeq: 7,
    lastEventType: 'llm/retry-started', retry: { attempt: 3, maxRetries: 5 } }
  const waitedDelegate = await tool('dsh_delegate', { instruction: 'test waited path', wait: true, timeoutMs: 35 })
  assert.equal(waitedDelegate.status, 'running')
  assert.equal(waitedDelegate.phase, 'model')
  assert.ok(!('retry' in waitedDelegate))
  assert.ok(!('lastEventType' in waitedDelegate), 'waited delegate path does not leak retry events')
  state = { running: false, lastSeq: 15, lastTurnEndSeq: 15, terminalStatus: 'completed', phase: null,
    retry: { attempt: 3, maxRetries: 5 }, outputSeq: 14, output: 'RECOVERED' }
  const recovered = await tool('dsh_poll', { sessionId: receipt.sessionId, baselineSeq: 5, timeoutMs: 0 })
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.output, 'RECOVERED')
  assert.ok(!('retry' in recovered), 'recovered requests produce no stale retry notice')
  const surface = buildSurface()
  assert.match(surface.tools.find(t => t.name === 'dsh_poll').inputSchema.properties.timeoutMs.description, /600000/)
  console.log('PASS receipt, event wait without heartbeat, running, pending, waiting, unknown, completion, no resubmission')
} finally {
  child.stdin.end()
  await new Promise(resolve => child.once('exit', resolve))
  await new Promise(resolve => server.close(resolve))
}
