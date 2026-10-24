import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceController } from '../lib/workspace.js'
const directory = mkdtempSync(join(tmpdir(), 'relay-workspace-'))
const calls = [], rows = [], groups = new Map()
let count = 0
const catalog = { groups: [{ id: 'registered', models: [{ id: 'custom-model', reasoning: { efforts: [{ id: 'max' }] } }] }] }
const base = {
  async list() { return { items: rows } },
  async create(request) { calls.push(['create', request]); const sessionId = `ordinary-${++count}`; rows.push({ sessionId }); return { sessionId } },
  async fork(request) { calls.push(['fork', request]); const sessionId = `fork-${++count}`; rows.push({ sessionId }); return { sessionId } },
  async rename(request) { calls.push(['rename', request]) },
  async prompt(request) { calls.push(['prompt', request]); return { accepted: true } },
  async selectModel(request) { calls.push(['model', request]); const { sessionId, ...selected } = request; return { selected } },
  async modelCatalog() { return catalog },
  async page(request) { calls.push(['page', request]); return {} },
}
const registry = {
  async resolveByPath(path) { return groups.get(path) },
  async create(path) { calls.push(['workspace', path]); const group = { id: `ws-${groups.size}`, path, async attachSession(id) { calls.push(['attach', id]) } }; groups.set(path, group); return group },
}
const ctx = { get: key => key === 'workspaceRegistry' ? registry : undefined }
try {
  const api = workspaceController(ctx, base, directory)
  await api.ready
  await api.setPreferences({ selection: { provider: 'registered', model: 'custom-model', reasoningEffort: 'max' } })
  const created = await api.controller.create({ cwd: process.cwd(), taskName: '审查项目' })
  await api.controller.prompt({ sessionId: created.sessionId, content: [{ type: 'text', text: '检查代码' }] })
  assert.equal(calls.find(x => x[0] === 'create')[1].workspaceId, 'ws-0')
  assert.equal(calls.find(x => x[0] === 'rename')[1].title, '子代理：审查项目')
  assert.equal(calls.find(x => x[0] === 'prompt')[1].content[0].text, '子代理：审查项目\n\n')
  assert.match(calls.find(x => x[0] === 'prompt')[1].content[1].text, /report_to_codex/)
  assert.equal(calls.find(x => x[0] === 'model')[1].model, 'custom-model')
  await api.controller.prompt({ sessionId: created.sessionId, content: [{ type: 'text', text: '继续审查' }] })
  assert.equal(calls.at(-1)[1].content[0].text, '继续审查', 'continuation should not repeat the label')
  await api.controller.create({ cwd: process.cwd() })
  assert.equal(calls.filter(x => x[0] === 'workspace').length, 1, 'reuse workspace by path')
  await assert.rejects(api.setPreferences({ selection: { provider: 'registered', model: 'custom-model', reasoningEffort: 'invalid' } }), /Unsupported/)
  await assert.rejects(api.setPreferences({ selection: { provider: 'unregistered', model: 'other' } }), /no longer registered/)
  const stored = JSON.parse(readFileSync(join(directory, 'sessions.json'), 'utf8'))
  stored.sessions['old-child'] = { sessionId: 'old-child', title: '旧任务', cwd: process.cwd(), started: true }
  rows.push({ sessionId: 'old-child', origin: 'subagent', running: false })
  writeFileSync(join(directory, 'sessions.json'), JSON.stringify(stored))
  const migrated = workspaceController(ctx, base, directory)
  await migrated.ready
  const replacement = migrated.resolveId('old-child')
  assert.notEqual(replacement, 'old-child')
  assert.equal(migrated.own(replacement).originalSessionId, 'old-child')
  assert.ok(calls.some(x => x[0] === 'attach' && x[1] === replacement))
  migrated.controller.page({ address: { kind: 'session', sessionId: 'old-child' } })
  assert.deepEqual(calls.at(-1)[1].address, { kind: 'session', sessionId: replacement })
  console.log('PASS ordinary sessions, project grouping, title and prompt label, registered model preferences, native continuation, legacy history migration')
} finally { rmSync(directory, { recursive: true, force: true }) }
