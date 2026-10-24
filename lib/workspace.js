import { mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { REPORTING_PROTOCOL, REPORTING_PROTOCOL_VERSION } from './reporting-prompt.js'

export function taskLabel(value) {
  return String(value || '委派任务').replace(/^子代理[：:]\s*/, '').split(/[\r\n。！？]/)[0].trim().slice(0, 60) || '委派任务'
}

// Ordinary native sessions: the normal DSH model picker and chat composer own
// subsequent human turns. No parent Agent or fixed model hooks are installed.
export function workspaceController(ctx, base, directory) {
  directory ||= join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-mcp-relay')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'sessions.json'), prefFile = join(directory, 'preferences.json')
  let state = { sessions: {}, aliases: {} }, preferences = { selection: null }
  const read = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e; return fallback } }
  state = read(file, state); state.aliases ||= {}; preferences = read(prefFile, preferences)
  const write = (path, data) => { writeFileSync(path + '.tmp', JSON.stringify(data, null, 2)); renameSync(path + '.tmp', path) }
  const save = () => write(file, state)
  const resolveId = id => state.aliases[id] || id
  const own = id => { const entry = state.sessions[resolveId(id)]; if (!entry) throw new Error('This conversation is not a Relay task'); return entry }
  const workspace = async cwd => {
    if (!cwd || !isAbsolute(cwd)) throw new Error('Pass the absolute path of the current Codex project as workspace')
    const registry = ctx.get('workspaceRegistry')
    if (!registry) throw new Error('workspaceRegistry is unavailable')
    return await registry.resolveByPath(cwd) || await registry.create(cwd)
  }
  const ready = (async () => {
    if (existsSync(file) && !state.workspaceMigration) copyFileSync(file, file + '.bak-before-workspace')
    const rows = (await base.list({}, new AbortController().signal)).items
    for (const old of Object.values(state.sessions)) {
      const row = rows.find(x => String(x.sessionId) === old.sessionId)
      if (row?.origin !== 'subagent') continue
      if (row.running) { old.migrationPending = '任务运行中，完成后可重试迁移'; continue }
      try {
        const name = taskLabel(old.taskName || old.title)
        const forked = await base.fork({ sessionId: old.sessionId })
        const id = String(forked.sessionId), group = await workspace(old.cwd)
        await group.attachSession(id)
        await base.rename({ sessionId: id, title: `子代理：${name}` })
        state.sessions[id] = { ...old, sessionId: id, taskName: name, title: `子代理：${name}`, workspaceId: String(group.id), originalSessionId: old.sessionId, sessionMode: 'workspace', started: true, migrationPending: null }
        state.aliases[old.sessionId] = id
        delete state.sessions[old.sessionId]
        save()
      } catch (error) { old.migrationPending = String(error?.message || error); save() }
    }
    state.workspaceMigration = true; save()
  })()
  ready.catch(error => ctx.logger?.warn?.(`DSH_MCP migration: ${error.message}`))
  const controller = {
    modelCatalog: () => base.modelCatalog(),
    async create(request) {
      await ready
      const group = await workspace(request.cwd)
      const result = await base.create({ workspaceId: group.id, ...(request.agentPreset ? { agentPreset: request.agentPreset } : {}) })
      const id = String(result.sessionId)
      state.sessions[id] = { sessionId: id, cwd: String(group.path), workspaceId: String(group.id), taskName: request.taskName || null, title: '', started: false, model: null, createdAt: Date.now(), sessionMode: 'workspace' }
      save(); return result
    },
    async selectModel(request) {
      await ready
      const entry = own(request.sessionId)
      const result = await base.selectModel({ ...request, sessionId: entry.sessionId })
      entry.model = result.selected; save(); return result
    },
    async prompt(request, signal) {
      await ready
      const entry = own(request.sessionId), first = !entry.started
      let content = request.content
      if (first) {
        entry.taskName = taskLabel(entry.taskName || content.filter(x => x.type === 'text').map(x => x.text).join('\n'))
        entry.title = `子代理：${entry.taskName}`
        content = [{ type: 'text', text: entry.title + '\n\n' }, ...content]
        if (!entry.model && preferences.selection) await controller.selectModel({ sessionId: entry.sessionId, ...preferences.selection })
        await base.rename({ sessionId: entry.sessionId, title: entry.title })
      }
      const addReportingProtocol = entry.reportingProtocolVersion !== REPORTING_PROTOCOL_VERSION
      if (addReportingProtocol) {
        const protocol = { type: 'text', text: REPORTING_PROTOCOL + '\n\n' }
        // Keep the first line's ordinary workspace label unchanged.
        content = first ? [content[0], protocol, ...content.slice(1)] : [protocol, ...content]
      }
      const result = await base.prompt({ ...request, sessionId: entry.sessionId, content }, signal)
      if (addReportingProtocol) entry.reportingProtocolVersion = REPORTING_PROTOCOL_VERSION
      entry.started = true; entry.updatedAt = Date.now(); save(); return result
    },
    async list(request, signal) {
      await ready
      const all = await base.list(request, signal)
      return { ...all, items: all.items.filter(x => state.sessions[String(x.sessionId)]) }
    },
    page(request, signal) { const id = own(request.address.sessionId || request.address.childSessionId).sessionId; return base.page({ ...request, address: { kind: 'session', sessionId: id } }, signal) },
    inspect(id, signal) { return base.inspect(own(id).sessionId, signal) },
    cancel(request) { return base.cancel({ ...request, sessionId: own(request.sessionId).sessionId }) },
  }
  const setPreferences = async value => {
    let selection = null
    if (value.selection) {
      const requested = value.selection, catalog = await base.modelCatalog()
      const model = catalog.groups.find(x => x.id === requested.provider)?.models.find(x => x.id === requested.model)
      if (!model) throw new Error('The selected model is no longer registered in DSH')
      if (requested.reasoningEffort && !model.reasoning?.efforts.some(x => x.id === requested.reasoningEffort)) throw new Error('Unsupported reasoning effort')
      selection = { provider: requested.provider, model: requested.model, ...(requested.reasoningEffort ? { reasoningEffort: requested.reasoningEffort } : {}) }
    }
    preferences = { selection }; write(prefFile, preferences); return preferences
  }
  return { mode: 'workspace', controller, directory, ready, entries: () => Object.values(state.sessions), own, resolveId, preferences: () => preferences, setPreferences }
}
