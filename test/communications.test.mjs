import assert from 'node:assert/strict'
import test from 'node:test'
import { communicationRecords, reportRecords } from '../lib/communications.js'

test('keeps full message text and tool arguments, without showing model reasoning', () => {
  const long = '<script>alert(1)</script>\n' + '完整内容'.repeat(3000)
  const entries = communicationRecords([
    { event: { seq: 1, time: 123, type: 'user/message', data: { content: [{ type: 'text', text: long }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '答复' }] } } },
    { seq: 3, type: 'tool/call', data: { name: 'report_to_codex', arguments: { kind: 'finding', message: '报告' } } },
    { seq: 4, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'accepted' }] } } },
    { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 6, type: 'llm/request', data: { text: 'internal' } },
  ])
  assert.equal(entries.length, 5)
  assert.equal(entries[0].message, long)
  assert.equal(entries[0].time, 123)
  assert.equal(entries[1].message, '答复')
  assert.equal(entries[2].category, 'tool')
  assert.match(entries[2].message, /报告/)
  assert.equal(entries[4].category, 'status')
  assert.ok(!JSON.stringify(entries).includes('private'))
})

test('report IDs are independent of native sequence and survive migration and replay', () => {
  const messages = [{ seq: 1, messageId: 'm1', replyTo: 'Q1', kind: 'reply', message: '完整报告', createdAt: '2026-10-22T00:00:00Z' }]
  const current = reportRecords(messages, 'new')
  const historical = reportRecords(messages, 'old')
  assert.notEqual(current[0].id, historical[0].id)
  assert.notEqual(current[0].id, 'native:1')
  assert.equal(current[0].time, Date.parse(messages[0].createdAt))
  assert.equal(current[0].replyTo, 'Q1')
  assert.deepEqual(reportRecords(messages, 'new'), current)
})
