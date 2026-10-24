import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  createReporting,
  REPORT_KINDS,
  REPORT_MESSAGE_MAX_LENGTH,
  REPORT_TOOL_NAME,
} from '../lib/reporting.js'

function fixture() {
  const directory = mkdtempSync(join(process.cwd(), '.report-test-'))
  const owned = new Set(['relay-session-1'])
  const own = (id) => {
    if (!owned.has(id)) throw new Error('not relay owned')
    return { sessionId: id }
  }
  return { directory, own, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

function agent(id = 'relay-session-1') {
  const registrations = []
  return {
    id,
    registrations,
    ctx: { tools: { register: (definition) => registrations.push(definition) } },
  }
}

test('registers the report tool only for owned agents with the bounded schema', async () => {
  const f = fixture()
  try {
    const reporting = createReporting(f)
    const ownedAgent = agent()
    const ordinaryAgent = agent('ordinary-session')
    assert.equal(reporting.register(ownedAgent), true)
    assert.equal(reporting.register(ownedAgent), true)
    assert.equal(ownedAgent.registrations.length, 1)
    assert.equal(reporting.register(ordinaryAgent), false)
    assert.equal(ordinaryAgent.registrations.length, 0)

    const tool = ownedAgent.registrations[0]
    assert.equal(tool.name, REPORT_TOOL_NAME)
    assert.deepEqual(tool.parameters.properties.kind.enum, REPORT_KINDS)
    assert.equal(tool.parameters.properties.message.maxLength, REPORT_MESSAGE_MAX_LENGTH)
    assert.deepEqual(tool.parameters.required, ['kind', 'message'])

    let concludeCalled = false
    const result = await tool.execute(
      { kind: 'finding', message: 'A useful result' },
      { agent: { id: ownedAgent.id }, concludeTurn: () => { concludeCalled = true } },
    )
    assert.equal(concludeCalled, false)
    assert.equal(result.accepted, true)
    assert.match(result.message, /does not mean Codex has read it/)
    assert.ok(result.messageId)
    const [stored] = reporting.page(ownedAgent.id).messages
    assert.equal(stored.seq, 1)
    assert.equal(stored.messageId, result.messageId)
    assert.equal(stored.kind, 'finding')
    assert.equal(stored.message, 'A useful result')
    assert.equal(typeof stored.createdAt, 'string')
  } finally {
    f.cleanup()
  }
})

test('persists reports across instances and paginates with an independent sequence', async () => {
  const f = fixture()
  try {
    let reporting = createReporting(f)
    for (let i = 1; i <= 25; i += 1) {
      await reporting.append('relay-session-1', { kind: 'progress', message: `step ${i}` })
    }
    assert.equal(reporting.currentSeq('relay-session-1'), 25)

    reporting = createReporting(f)
    const first = reporting.page('relay-session-1')
    assert.equal(first.messages.length, 20)
    assert.equal(first.messages[0].seq, 1)
    assert.equal(first.messages[19].seq, 20)
    assert.equal(first.nextMessageSeq, 20)
    assert.equal(first.hasMoreMessages, true)
    assert.equal(first.reportToolAvailable, true)

    const second = reporting.page('relay-session-1', first.nextMessageSeq)
    assert.deepEqual(second.messages.map((message) => message.seq), [21, 22, 23, 24, 25])
    assert.equal(second.nextMessageSeq, 25)
    assert.equal(second.hasMoreMessages, false)
    const empty = reporting.page('relay-session-1', 25)
    assert.equal(empty.nextMessageSeq, 25)
    assert.deepEqual(empty.messages, [])
  } finally {
    f.cleanup()
  }
})

test('rejects invalid reports and caller identity mismatches without writing', async () => {
  const f = fixture()
  try {
    const reporting = createReporting(f)
    const ownedAgent = agent()
    reporting.register(ownedAgent)
    const tool = ownedAgent.registrations[0]

    await assert.rejects(
      tool.execute({ kind: 'other', message: 'bad kind' }, { agent: { id: ownedAgent.id } }),
      /kind must be one of/,
    )
    await assert.rejects(
      tool.execute({ kind: 'question', message: 'x'.repeat(REPORT_MESSAGE_MAX_LENGTH + 1) }, { agent: { id: ownedAgent.id } }),
      /at most 4000 characters/,
    )
    await assert.rejects(
      tool.execute({ kind: 'reply', message: 'answer', replyTo: 3 }, { agent: { id: ownedAgent.id } }),
      /replyTo must be a string/,
    )
    await assert.rejects(
      tool.execute({ kind: 'reply', message: 'answer' }, { agent: { id: 'ordinary-session' } }),
      /does not match this agent/,
    )
    await assert.rejects(
      reporting.append('ordinary-session', { kind: 'finding', message: 'no' }),
      /not relay owned/,
    )
    assert.deepEqual(reporting.page('relay-session-1').messages, [])
  } finally {
    f.cleanup()
  }
})

test('does not acknowledge a report when durable persistence fails', async () => {
  const f = fixture()
  try {
    const reporting = createReporting(f)
    const ownedAgent = agent()
    reporting.register(ownedAgent)
    rmSync(join(f.directory, 'reports'), { recursive: true, force: true })
    await assert.rejects(
      ownedAgent.registrations[0].execute(
        { kind: 'blocker', message: 'disk path unavailable' },
        { agent: { id: ownedAgent.id } },
      ),
      /could not persist report/,
    )
  } finally {
    f.cleanup()
  }
})

