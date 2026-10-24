import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationRecords, markdown } from '../lib/record-labels.mjs'

const text = value => ({ type: 'text', text: value })
const event = (seq, type, data = {}, time = seq) => ({ seq, time, type, data })
const assistant = (seq, value, extra = {}) => event(seq, 'assistant/message', {
  role: 'assistant', message: { content: [text(value)], ...extra },
})

test('keeps Relay instructions, retained prompts, and all assistant text blocks from the stored snapshot', () => {
  const prompt = 'Project rules: preserve the full injected text.'
  const command = 'Please inspect the implementation and report findings.'
  const entries = conversationRecords([
    event(1, 'user/message', { role: 'user', source: { kind: 'user', rpcId: 'relay-1234-2' }, content: [text(command)] }),
    event(2, 'user/message', { role: 'user', source: { kind: 'user', rpcId: 'not-relay' }, content: [text('ordinary human speech')] }),
    event(3, 'user/message', { role: 'user', content: [text('unknown origin')] }),
    event(4, 'system/message', { message: { content: [text('system prompt')] } }),
    event(5, 'user/message', { source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] }, content: [text(prompt)] }),
    assistant(7, 'intermediate assistant update'),
    assistant(8, 'text accompanying a tool call', { toolCalls: [{ name: 'read_file' }] }),
    event(9, 'tool/call', { name: 'read_file' }),
    event(10, 'tool/result', { message: { content: [text('hidden tool result')] } }),
    assistant(11, 'latest assistant output'),
    assistant(12, 'visible first block', { content: [
      { type: 'reasoning', text: 'hidden reasoning' }, text('visible first block'),
      { type: 'tool_call', name: 'read_file' }, text('visible second block'),
      { type: 'thinking', text: 'hidden thinking' },
    ] }),
  ])

  assert.deepEqual(entries.map(entry => entry.label), [
    'Relay 下发的任务 / 追问指令', 'DSH 原生系统提示词', '项目 / 全局规则',
    'DSH 回复', 'DSH 回复', 'DSH 回复', 'DSH 回复', 'DSH 回复',
  ])
  assert.deepEqual(entries.map(entry => entry.message), [command, 'system prompt', prompt,
    'intermediate assistant update', 'text accompanying a tool call', 'latest assistant output',
    'visible first block', 'visible second block'])
  assert.equal(entries[0].sourceKind, 'user')
  assert.equal(entries[0].rpcId, 'relay-1234-2')
  assert.equal(entries[2].instructionPaths[0], 'AGENTS.md')
  assert.equal(entries[3].sourceKind, undefined)
  assert.match(entries[3].basis, /可能是中间输出/)
  assert.ok(!JSON.stringify(entries).includes('ordinary human speech'))
  assert.ok(!JSON.stringify(entries).includes('unknown origin'))
  assert.ok(!JSON.stringify(entries).includes('hidden tool result'))
  assert.ok(!JSON.stringify(entries).includes('hidden reasoning'))
  assert.ok(!JSON.stringify(entries).includes('hidden thinking'))
})

test('markdown describes a one-time snapshot and temporary tab cleanup', () => {
  const doc = markdown({ sessionId: 'synthetic', title: 'test' }, [], 1)
  assert.match(doc, /一次性快照/)
  assert.match(doc, /不会实时更新/)
  assert.match(doc, /关闭 Markdown 标签页后临时文件自动删除/)
})
