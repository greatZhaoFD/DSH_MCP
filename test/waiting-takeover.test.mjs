/**
 * Waiting/takeover checks for the relay half of this plugin (lib/index.js).
 *
 * These pin the three states that used to be wrong:
 *
 *   - a session that was once under takeover can be handed back to the GUI
 *     (`takeover: false`), which the delegate path previously ignored;
 *   - a question waiting in the GUI is reported as `waiting` with
 *     `intercepted: false`, instead of looking like ordinary work;
 *   - a tool that is merely still running is still NOT a wait.
 *
 *   node test/waiting-takeover.test.mjs
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

const CATALOG = {
  default: null,
  routableProviders: [],
  groups: [],
  failures: [],
}

function createHarness({ records = [], running = true } = {}) {
  const calls = []
  const controller = {
    list: async () => ({
      items: [
        {
          sessionId: 'session-1',
          running,
          blank: false,
          cwd: 'D:\\ws',
          updatedAt: 1,
          projections: { kind: 'sequenced', asOfSeq: 100, values: {} },
        },
      ],
    }),
    page: async () => ({ records }),
    inspect: async () => ({ events: [] }),
    create: async (request) => {
      calls.push(['create', request])
      return { sessionId: 'session-1' }
    },
    modelCatalog: async () => CATALOG,
    selectModel: async (request) => ({ selected: request }),
    prompt: async (request) => {
      calls.push(['prompt', request])
      return {}
    },
    cancel: async () => ({ accepted: true }),
  }

  let handler = null
  const ctx = {
    get(key) {
      if (key === 'webServer') {
        return {
          register(opts) {
            handler = opts.handler
            return () => {}
          },
        }
      }
      if (key === 'sessionController') return controller
      return undefined
    },
    on() {},
    effect(fn) {
      fn()
      return () => {}
    },
  }
  apply(ctx)
  assert.ok(handler, 'plugin registered its route handler')
  return { handler, calls }
}

async function request(handler, { method = 'GET', url, body, remote = '127.0.0.1' }) {
  let status = null
  let payload = null
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      payload = JSON.parse(text)
    },
  }
  const listeners = { data: [], end: [], error: [] }
  const req = {
    method,
    url,
    headers: {},
    socket: { remoteAddress: remote },
    on(event, cb) {
      ;(listeners[event] || (listeners[event] = [])).push(cb)
      return req
    },
  }
  const done = handler(req, res)
  if (body !== undefined) {
    for (const cb of listeners.data) cb(Buffer.from(JSON.stringify(body)))
  }
  for (const cb of listeners.end) cb()
  await done
  return { status, payload }
}

const callEvent = (seq, callId, toolName) => ({
  event: { type: 'tool/call', seq, data: { callId, name: toolName } },
})
const resultEvent = (seq, callId) => ({
  event: { type: 'tool/result', seq, data: { message: { source: { callId } } } },
})

const cases = []
const test = (label, fn) => cases.push([label, fn])

test('exports the relay identity', () => {
  assert.equal(name, 'DSH_MCP')
  assert.deepEqual(inject, ['webServer', 'sessionController'])
})

test('takeover can be turned on and back off on the same session', async () => {
  const { handler } = createHarness()

  const on = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { sessionId: 'session-1', instruction: 'act under takeover', takeover: true },
  })
  assert.equal(on.payload.data.takeover, true)
  const polledOn = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(polledOn.payload.data.takeover, true)

  const off = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { sessionId: 'session-1', instruction: 'hand it back to the GUI', takeover: false },
  })
  assert.equal(off.payload.data.takeover, false, 'takeover:false must clear the flag')
  const polledOff = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(polledOff.payload.data.takeover, false)
})

test('a question waiting in the GUI is reported as waiting, not as running', async () => {
  const { handler } = createHarness({
    records: [callEvent(5, 'call-1', 'ask_user_question')],
  })
  const { payload } = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(payload.data.status, 'waiting')
  assert.equal(payload.data.waiting.kind, 'user-question')
  assert.equal(payload.data.waiting.intercepted, false, 'the GUI owns this one, not the caller')
  assert.equal(payload.data.waiting.toolName, 'ask_user_question')
})

test('an answered question stops reporting as waiting', async () => {
  const { handler } = createHarness({
    records: [callEvent(5, 'call-1', 'ask_user_question'), resultEvent(6, 'call-1')],
  })
  const { payload } = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(payload.data.waiting, null)
})

test('a tool that is merely still running is not a wait', async () => {
  const { handler } = createHarness({
    records: [callEvent(5, 'call-1', 'pwsh')],
  })
  const { payload } = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(payload.data.waiting, null)
  assert.equal(payload.data.status, 'running')
  assert.equal(payload.data.pendingTool.name, 'pwsh')
})

test('a session with no pending work is idle, not waiting', async () => {
  const { handler } = createHarness({ records: [] })
  const { payload } = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(payload.data.waiting, null)
  assert.equal(payload.data.status, 'running')
})

test('turn/end error forwards the real model error and exhausted retries', async () => {
  const { handler } = createHarness({ running: false, records: [
    { event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
    { event: { type: 'llm/retry', seq: 3, data: { retry: 5, maxRetries: 5, delayMs: 8000, failure: { code: 'RATE_LIMIT', message: '429: Endpoint is unavailable.' } } } },
    { event: { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429: Endpoint is unavailable.' } } } } },
  ] })
  const { payload } = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(payload.data.status, 'failed')
  assert.equal(payload.data.error.code, 'RATE_LIMIT')
  assert.equal(payload.data.retry.attempt, 5)
})

test('live retry remains running; a successful end is explicit', async () => {
  const records = [
    { event: { type: 'turn/start', seq: 1, data: {} } },
    { event: { type: 'llm/retry', seq: 2, data: { retry: 1, maxRetries: 5 } } },
  ]
  const active = createHarness({ running: true, records })
  const first = await request(active.handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(first.payload.data.status, 'running')
  assert.equal(first.payload.data.phase, 'retrying')
  const done = createHarness({ running: false, records: [...records,
    { event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } },
  ] })
  assert.equal((await request(done.handler, { url: '/dsh-relay/poll?sessionId=session-1' })).payload.data.status, 'completed')
})

test('missing terminal evidence is unknown, and a new turn clears old failure', async () => {
  for (const records of [[], [
    { event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'error', error: { code: 'TIMEOUT' } } } } },
    { event: { type: 'turn/start', seq: 4, data: {} } },
  ]]) {
    const { handler } = createHarness({ running: false, records })
    const { payload } = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
    assert.equal(payload.data.status, 'unknown')
    assert.equal(payload.data.error, undefined)
  }
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
