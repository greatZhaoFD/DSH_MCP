import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { createReporting } from '../lib/reporting.js'

test('viewer paginates snapshot history and both migrated report mailboxes without consuming reports', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.communications-api-'))
  const id = 'current', old = 'original'
  writeFileSync(join(directory, 'sessions.json'), JSON.stringify({ workspaceMigration: true,
    sessions: { [id]: { sessionId: id, originalSessionId: old } }, aliases: { [old]: id } }))
  let handler, latest = 65
  const pageRequests = []
  const records = Array.from({ length: 66 }, (_, i) => ({ event: { seq: i + 1, time: i + 1,
    type: 'user/message', data: { content: [{ type: 'text', text: `message ${i + 1}` }] } } }))
  const services = {
    webServer: { protocol: 'http:', port: 1, register(route) { handler = route.handler } },
    sessionController: {
      async list() { return { items: [{ sessionId: id, origin: 'workspace', projections: { asOfSeq: latest } }] } },
      async page(request) {
        pageRequests.push(request)
        const available = records.filter(r => r.event.seq <= request.throughSeq && (request.beforeSeq === undefined || r.event.seq < request.beforeSeq))
        return { records: available.slice(-request.maxMessages), hasMore: available.length > request.maxMessages }
      },
    },
    agents: { list: () => [] },
  }
  try {
    apply({ get: name => services[name], effect: fn => fn(), on() {} }, { sessionMode: 'workspace', stateDirectory: directory })
    const reporting = createReporting({ directory, own: value => { assert.ok([id, old].includes(value)) } })
    for (let n = 1; n <= 25; n++) await reporting.append(id, { kind: 'progress', message: `report ${n}` })
    await reporting.append(old, { kind: 'finding', message: 'before migration' })
    const call = async path => {
      const req = new EventEmitter()
      Object.assign(req, { method: 'GET', url: '/dsh-relay' + path, headers: { 'x-dsh-relay-ui': '1' }, socket: { remoteAddress: '127.0.0.1' } })
      let payload
      const res = { setHeader() {}, writeHead() {}, end(body) { payload = JSON.parse(body) } }
      await handler(req, res)
      if (!payload.ok) throw Error(payload.error)
      return payload.data
    }
    const boot = await call('/ui-config')
    const authenticated = async path => {
      const req = { method: 'GET', url: '/dsh-relay' + path, headers: { 'x-dsh-relay-token': boot.token }, socket: { remoteAddress: '127.0.0.1' } }
      let payload
      await handler(req, { setHeader() {}, writeHead() {}, end(body) { payload = JSON.parse(body) } })
      if (!payload.ok) throw Error(payload.error)
      return payload.data
    }
    const first = await authenticated('/communications?sessionId=current')
    assert.equal(first.cursor, 65)
    assert.equal(first.before, 6)
    assert.equal(first.hasMore, true)
    latest = 66
    const second = await authenticated(`/communications?sessionId=current&cursor=${first.cursor}&beforeSeq=${first.before}`)
    assert.equal(second.hasMore, false)
    assert.deepEqual([...second.entries, ...first.entries].map(e => e.seq), Array.from({ length: 65 }, (_, i) => i + 1))
    assert.equal(pageRequests[1].throughSeq, 65)
    const reports = await authenticated('/communications?source=reports&sessionId=current')
    assert.equal(reports.entries.length, 20)
    assert.equal(reports.hasMore, true)
    const tail = await authenticated(`/communications?source=reports&sessionId=current&afterSeq=${reports.next}`)
    assert.equal(tail.entries.length, 5)
    assert.equal(tail.hasMore, false)
    const original = await authenticated('/communications?source=reports&sessionId=current&original=1')
    assert.equal(original.entries[0].message, 'before migration')
    assert.notEqual(original.entries[0].id, reports.entries[0].id)
    assert.equal(reporting.page(id).messages[0].seq, 1, 'viewer never consumes the mailbox')
    await assert.rejects(authenticated('/communications?sessionId=current&beforeSeq=NaN'), /invalid/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
