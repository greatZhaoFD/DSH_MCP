/**
 * Relay-client checks: a slow or silent relay must fail the call, not hang it.
 *
 * The blocking wait is the normal path since dsh_delegate waits by default, so a
 * relay that accepts a connection and never answers used to stall a whole turn
 * with no way out. These cases pin the timeout and the settle contract.
 *
 *   node test/relay-client.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRelayClient } from '../bin/relay-client.mjs'

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const json = (res, payload, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const cases = []
const test = (label, fn) => cases.push([label, fn])

test('a normal response is unwrapped', async () => {
  const server = await startServer((req, res) => json(res, { ok: true, data: { relay: 'x', path: req.url } }))
  try {
    const client = createRelayClient({ url: server.url })
    const data = await client.call('/ping')
    assert.deepEqual(data, { relay: 'x', path: '/ping' })
  } finally {
    await server.close()
  }
})

test('a relay that never answers fails the call instead of hanging', async () => {
  // Accept the connection and read the request, then never respond.
  const server = await startServer(() => {})
  try {
    const client = createRelayClient({ url: server.url, callTimeoutMs: 80 })
    const started = Date.now()
    await assert.rejects(() => client.call('/poll?sessionId=s'), /did not answer/)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `expected a fast failure, took ${elapsed}ms`)
  } finally {
    await server.close()
  }
})

test('a poll timeout is capped by the caller budget', async () => {
  const server = await startServer(() => {})
  try {
    const client = createRelayClient({ url: server.url, callTimeoutMs: 5000 })
    const started = Date.now()
    // waitForSettle must not wait longer than the budget it was given.
    await assert.rejects(() => client.waitForSettle('s', 0, 100), /did not answer/)
    assert.ok(Date.now() - started < 2000, 'the per-call budget should win over the long default')
  } finally {
    await server.close()
  }
})

test('waitForSettle reports completed once the session goes idle past the cursor', async () => {
  let polls = 0
  const server = await startServer((req, res) => {
    polls += 1
    json(res, { ok: true, data: polls === 1 ? { statusVersion: 2, running: true, lastSeq: 1 } : { statusVersion: 2, running: false, lastSeq: 5, lastTurnEndSeq: 5, terminalStatus: 'completed' } })
  })
  try {
    const client = createRelayClient({ url: server.url, pollIntervalMs: 5 })
    const { outcome, view } = await client.waitForSettle('s', 1, 2000)
    assert.equal(outcome, 'completed')
    assert.equal(view.lastSeq, 5)
  } finally {
    await server.close()
  }
})

test('waitForSettle does not treat a pre-existing idle session as completed', async () => {
  // lastSeq never passes the baseline: the caller asked for a NEW turn.
  const server = await startServer((req, res) => json(res, { ok: true, data: { running: false, lastSeq: 1 } }))
  try {
    const client = createRelayClient({ url: server.url, pollIntervalMs: 10 })
    const { outcome } = await client.waitForSettle('s', 1, 400)
    assert.equal(outcome, 'timeout')
  } finally {
    await server.close()
  }
})

test('waitForSettle returns as soon as the session waits on a human', async () => {
  const server = await startServer((req, res) =>
    json(res, { ok: true, data: { running: true, lastSeq: 3, status: 'waiting', waiting: { kind: 'approval' } } }),
  )
  try {
    const client = createRelayClient({ url: server.url, pollIntervalMs: 5 })
    const { outcome, view } = await client.waitForSettle('s', 0, 2000)
    assert.equal(outcome, 'waiting')
    assert.equal(view.waiting.kind, 'approval')
  } finally {
    await server.close()
  }
})

test('legacy host transcript forwards the exact exhausted model error', async () => {
  const server = await startServer((req, res) => json(res, { ok: true, data:
    req.url.startsWith('/transcript') ? { records: [
      { event: { type: 'turn/start', seq: 2, data: {} } },
      { event: { type: 'llm/retry', seq: 3, data: { retry: 5, maxRetries: 5, failure: { code: 'RATE_LIMIT', message: '429: Endpoint is unavailable.' } } } },
      { event: { type: 'turn/end', seq: 5, data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429: Endpoint is unavailable.' } } } } },
    ] } : { running: false, status: 'idle', lastSeq: 5, lastTurnEndSeq: 5, output: '' }
  }))
  try {
    const { outcome, view } = await createRelayClient({ url: server.url }).waitForSettle('s', 1, 2000)
    assert.equal(outcome, 'failed')
    assert.equal(view.error.code, 'RATE_LIMIT')
    assert.equal(view.error.message, '429: Endpoint is unavailable.')
    assert.equal(view.retry.attempt, 5)
  } finally { await server.close() }
})

test('missing end reason cannot be promoted to success', async () => {
  const server = await startServer((req, res) => json(res, { ok: true, data:
    req.url.startsWith('/transcript') ? { records: [] } : { running: false, lastSeq: 5, lastTurnEndSeq: 5 }
  }))
  try {
    const { outcome } = await createRelayClient({ url: server.url }).waitForSettle('s', 1, 2000)
    assert.equal(outcome, 'unknown')
  } finally { await server.close() }
})

let failed = 0
for (const [label, fn] of cases) {
  try {
    await fn()
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${label}\n      ${error && error.message}`)
  }
}
console.log(failed === 0 ? `\nall ${cases.length} cases passed` : `\n${failed} case(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
