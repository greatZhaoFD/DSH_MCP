import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

// The plugin owns the Agent handles and their result delivery. Native subagent
// headers keep them out of the ordinary workspace list, including after reload.
// No high-level subagent manager is used: its cold-resume path delivers results
// to a parent model by default. These control parents are never prompted.
export function isolatedController(ctx, base, directory) {
  const agents = ctx.get('agents')
  if (!agents) throw new Error('isolated relay requires the agents service')
  directory ||= join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-mcp-relay')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'sessions.json')
  let state = { roots: {}, sessions: {} }
  try { state = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const handles = new Map(), pendingRoots = new Map(), pendingAgents = new Map()
  const save = () => { writeFileSync(file + '.tmp', JSON.stringify(state, null, 2)); renameSync(file + '.tmp', file) }
  const own = id => {
    const entry = state.sessions[id]
    if (!entry) throw new Error('This session is not owned by DSH_MCP; ordinary workspace conversations cannot be controlled here')
    return entry
  }
  const parent = async entry => {
    const key = process.platform === 'win32' ? entry.cwd.toLowerCase() : entry.cwd
    if (pendingRoots.has(key)) return pendingRoots.get(key)
    const operation = (async () => {
      let id = state.roots[key]
      if (!id || !agents.get(id)) {
        const value = await base.create({ cwd: entry.cwd, ...(id ? { sessionId: id } : {}) })
        id = String(value.sessionId); state.roots[key] = id; save()
      }
      return agents.get(id)
    })()
    pendingRoots.set(key, operation)
    try { return await operation } finally { pendingRoots.delete(key) }
  }
  const address = id => ({ kind: 'subagent', parentSessionId: own(id).parentId, childSessionId: id, mode: 'continuable' })
  const activate = async (id, root) => {
    if (agents.get(id)) return agents.get(id)
    if (pendingAgents.has(id)) return pendingAgents.get(id)
    const operation = (async () => {
      const entry = own(id)
      entry.model ||= ctx.get('agentDefaultModel').currentSelection()
      const presets = ctx.get('agentPresets')
      entry.agentPreset ||= presets ? (await presets.resolve(undefined)).id : undefined
      const setup = async (scope, agent) => {
        if (presets && entry.agentPreset) await presets.mount(scope, entry.agentPreset)
        // Session-local route hooks, equivalent to installModelSelection in dsh-agent.
        scope.on('system-prompt/assemble', async (_assembly, _cause, next) => {
          const result = await next()
          return { ...result, variables: { ...result.variables, provider: entry.model.provider, model: entry.model.model } }
        })
        scope.on('agent/request', async (_payload, next) => {
          const { reasoningEffort: _inherited, ...result } = await next()
          return { ...result, ...entry.model }
        })
        if (!entry.started) agent.session.append('subagent/descriptor', {
          version: 3, mode: 'continuable', provider: 'dsh-mcp-relay', label: entry.title.slice(0, 60),
          agentProvider: entry.model.provider, agentModel: entry.model.model,
          ...(entry.model.reasoningEffort ? { agentReasoningEffort: entry.model.reasoningEffort } : {}),
        })
        scope.on('agent/error', payload => { entry.error = String(payload.error?.message || payload.error); save() })
      }
      const options = { parentAgent: root, agentOptions: { ...entry.model, subagentDepth: 1 }, setup }
      const handle = entry.started
        ? await agents.resume({ ...options, resumeSessionId: id })
        : await agents.create({ ...options, sessionId: id, meta: { cwd: entry.cwd, parentSession: root.id, origin: 'subagent', delegationDepth: 1, ...(entry.agentPreset ? { agentPreset: entry.agentPreset } : {}) } })
      handles.set(id, handle); entry.started = true; save()
      return handle.agent
    })()
    pendingAgents.set(id, operation)
    try { return await operation } finally { pendingAgents.delete(id) }
  }
  const controller = {
    modelCatalog: () => base.modelCatalog(),
    async create(request) {
      if (!request.cwd || !isAbsolute(request.cwd)) throw new Error('workspace must be an absolute directory for an isolated task')
      const id = `relay-${randomUUID()}`
      const entry = { sessionId: id, cwd: request.cwd, agentPreset: request.agentPreset, createdAt: Date.now(), started: false, title: '', model: null }
      entry.parentId = String((await parent(entry)).id); state.sessions[id] = entry; save()
      return { sessionId: id }
    },
    async selectModel({ sessionId, ...selection }) {
      const entry = own(sessionId)
      const resolved = await ctx.get('llm').resolveCallConfig(selection)
      const selected = { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) }
      if (entry.started && JSON.stringify(selected) !== JSON.stringify(entry.model)) throw new Error('Choose the model when creating a task. Start a new task to change its model.')
      entry.model = selected; save(); return { selected }
    },
    async prompt(request) {
      const entry = own(request.sessionId), root = await parent(entry)
      entry.parentId = String(root.id)
      entry.title ||= request.content.filter(x => x.type === 'text').map(x => x.text).join('\n').slice(0, 180)
      entry.updatedAt = Date.now(); entry.error = null; save()
      const agent = await activate(request.sessionId, root)
      const message = Object.freeze({ id: randomUUID(), role: 'user', content: request.content, source: { kind: 'user', rpcId: request.requestId } })
      if (request.mode === 'steer') agent.steer(message)
      else agent.followup(message)
      return { accepted: true }
    },
    async list(request, abort) {
      const all = await base.list(request, abort)
      return { ...all, items: all.items.filter(row => state.sessions[String(row.sessionId)]) }
    },
    page(request, abort) {
      const id = request.address.sessionId || request.address.childSessionId
      own(id); return base.page({ ...request, address: address(id) }, abort)
    },
    async inspect(id, abort) { own(id); return base.inspect(id, abort) },
    async cancel({ sessionId }) {
      own(sessionId); agents.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: true }); return { accepted: true }
    },
  }
  return { controller, directory, entries: () => Object.values(state.sessions), own, address }
}
