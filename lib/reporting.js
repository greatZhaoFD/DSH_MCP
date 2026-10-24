import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const REPORT_TOOL_NAME = 'report_to_codex'
export const REPORT_KINDS = ['progress', 'finding', 'blocker', 'question', 'reply']
export const REPORT_MESSAGE_MAX_LENGTH = 4000

export const REPORT_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: REPORT_KINDS,
      description: 'The type of report to send to Codex.',
    },
    message: {
      type: 'string',
      maxLength: REPORT_MESSAGE_MAX_LENGTH,
      description: 'The report text, up to 4000 characters.',
    },
    replyTo: {
      type: 'string',
      description: 'Optional messageId for the report this replies to.',
    },
  },
  required: ['kind', 'message'],
  additionalProperties: false,
}

function fileKey(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex')
}

function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('arguments must be an object')
  }
  if (!REPORT_KINDS.includes(args.kind)) {
    throw new Error(`kind must be one of: ${REPORT_KINDS.join(', ')}`)
  }
  if (typeof args.message !== 'string' || !args.message.trim()) {
    throw new Error('message must be a non-empty string')
  }
  if (args.message.length > REPORT_MESSAGE_MAX_LENGTH) {
    throw new Error(`message must be at most ${REPORT_MESSAGE_MAX_LENGTH} characters`)
  }
  if (args.replyTo !== undefined && typeof args.replyTo !== 'string') {
    throw new Error('replyTo must be a string when provided')
  }
  for (const key of Object.keys(args)) {
    if (!['kind', 'message', 'replyTo'].includes(key)) throw new Error(`unexpected argument: ${key}`)
  }
}

/**
 * Durable report queue and agent-scoped report_to_codex tool registration.
 * Files are keyed by a hash of the relay session id so ids never become paths.
 */
export function createReporting({ directory, own }) {
  if (typeof directory !== 'string' || !directory) throw new Error('report directory is required')
  if (typeof own !== 'function') throw new Error('session ownership check is required')
  const reportsDirectory = join(directory, 'reports')
  mkdirSync(reportsDirectory, { recursive: true })
  const registeredAgents = new WeakSet()
  const disposers = new Set()
  const writes = new Map()

  const reportPath = (sessionId) => join(reportsDirectory, `${fileKey(sessionId)}.json`)

  const read = (sessionId) => {
    const path = reportPath(sessionId)
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (!value || !Array.isArray(value.messages)) throw new Error('invalid report queue file')
      return value.messages
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  const append = async (sessionId, args) => {
    own(sessionId)
    validateArgs(args)
    const previous = writes.get(sessionId) || Promise.resolve()
    const operation = previous.then(() => {
      const messages = read(sessionId)
      const seq = messages.length ? messages[messages.length - 1].seq + 1 : 1
      const message = {
        seq,
        messageId: randomUUID(),
        kind: args.kind,
        message: args.message,
        ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
        createdAt: new Date().toISOString(),
      }
      messages.push(message)
      const path = reportPath(sessionId)
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify({ messages }), { mode: 0o600 })
        renameSync(temporary, path)
      } catch (error) {
        // Do not acknowledge a report unless the atomic replacement succeeded.
        throw new Error(`could not persist report: ${error.message}`)
      }
      return message
    })
    writes.set(sessionId, operation.catch(() => {}))
    return operation
  }

  const page = (sessionId, afterMessageSeq = 0) => {
    own(sessionId)
    const cursor = Number.isSafeInteger(afterMessageSeq) && afterMessageSeq >= 0 ? afterMessageSeq : 0
    const available = read(sessionId).filter((message) => message.seq > cursor)
    const messages = available.slice(0, 20)
    return {
      messages,
      nextMessageSeq: messages.length ? messages[messages.length - 1].seq : cursor,
      hasMoreMessages: available.length > messages.length,
      reportToolAvailable: true,
    }
  }

  const currentSeq = (sessionId) => {
    own(sessionId)
    const messages = read(sessionId)
    return messages.length ? messages[messages.length - 1].seq : 0
  }

  const register = (agent) => {
    if (!agent || typeof agent.id !== 'string' || !agent.ctx) return false
    // Access the service through the agent context, avoiding undeclared injected
    // property access on host/plugin callbacks while retaining the agent scope.
    const tools = typeof agent.ctx.get === 'function' ? agent.ctx.get('tools') : agent.ctx.tools
    if (typeof tools?.register !== 'function') return false
    try {
      own(agent.id)
    } catch {
      return false
    }
    if (registeredAgents.has(agent)) return true
    const unregister = tools.register({
      name: REPORT_TOOL_NAME,
      description:
        'Send a progress update, finding, blocker, question, or reply to the Codex agent coordinating this task. ' +
        'Use it for useful milestones, starting long work, material findings, blockers, decisions, and replies to coordinator questions. ' +
        'A successful response confirms the report was saved for Codex; it does not mean Codex has read or approved it. ' +
        'Continue authorized work after reporting; wait only for an actual required decision. Do not send repetitive heartbeat reports.',
      parameters: REPORT_TOOL_PARAMETERS,
      output: {
        schema: { type: 'object', properties: { accepted: { type: 'boolean' }, messageId: { type: 'string' }, message: { type: 'string' } }, required: ['accepted', 'messageId', 'message'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId !== agent.id) {
          throw new Error('report caller identity is unavailable or does not match this agent')
        }
        const report = await append(sessionId, args)
        return {
          accepted: true,
          messageId: report.messageId,
          message: 'Report saved for Codex. This confirms persistence only; it does not mean Codex has read it.',
        }
      },
    })
    if (typeof unregister === 'function') disposers.add(unregister)
    registeredAgents.add(agent)
    return true
  }

  const dispose = () => { for (const unregister of disposers) unregister(); disposers.clear() }
  return { register, append, page, currentSeq, dispose, reportToolAvailable: true }
}

