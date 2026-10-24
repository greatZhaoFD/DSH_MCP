#!/usr/bin/env node
/**
 * Measure what the tool surface costs — and what a caller's use of it costs.
 *
 *   node bin/dsh-bench.mjs surface
 *   node bin/dsh-bench.mjs usage <file.jsonl | directory> [...more]
 *   node bin/dsh-bench.mjs usage --all <directory>      include sessions without dsh calls
 *
 * `surface` is static: it reads the same objects the server would hand a client
 * in `initialize` and `tools/list`, so it needs neither DSH nor a running
 * server.
 *
 * `usage` replays Codex rollout files and attributes model requests to the dsh
 * tool calls that produced them. A Codex session is split across several
 * rollout files (one per segment), so pass the *directory* rather than a single
 * file: results are merged per session id. Codex reaches the dsh tools either
 * directly (`function_call` named `mcp__dsh__dsh_delegate`) or through its JS
 * sandbox (`custom_tool_call` named `exec`, whose source contains
 * `tools.mcp__dsh__dsh_delegate(...)`), so both forms are counted.
 *
 * The number that matters is requests-per-delegation: a blocking `wait: true`
 * delegation costs one request, an async one followed by polls costs one per
 * poll. Serve both surfaces (DSH_RELAY_SURFACE=lean|full) and run the same task
 * to compare.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

import { buildSurface } from './surface.mjs'

const DSH_CALL = /mcp__[A-Za-z0-9_]+__(dsh_[A-Za-z0-9_]+)/g
const DSH_NAMES = new Set([
  'dsh_delegate',
  'dsh_poll',
  'dsh_answer',
  'dsh_approval',
  'dsh_cancel',
  'dsh_models',
  'dsh_list_sessions',
])

/** Rough token estimate: ASCII runs ~4 chars/token, CJK ~1 token per char. */
function estimateTokens(text) {
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 128) ascii += 1
    else wide += 1
  }
  return Math.round(ascii / 4 + wide)
}

function surfaceReport() {
  const rows = []
  for (const variant of ['lean', 'full']) {
    const surface = buildSurface({ variant, timeoutMs: 600000 })
    const toolsJson = JSON.stringify(surface.tools)
    rows.push({
      variant,
      instructions: surface.instructions.length,
      tools: toolsJson.length,
      total: surface.instructions.length + toolsJson.length,
      tokens: estimateTokens(surface.instructions + toolsJson),
      perTool: surface.tools.map((tool) => [tool.name, JSON.stringify(tool).length]),
    })
  }

  console.log('surface sizes (chars) — paid on EVERY model request\n')
  console.log('variant  instructions  tools   total  est.tokens')
  for (const row of rows) {
    console.log(
      `${row.variant.padEnd(8)} ${String(row.instructions).padStart(13)} ${String(row.tools).padStart(6)} ` +
        `${String(row.total).padStart(7)} ${String(row.tokens).padStart(11)}`,
    )
  }
  const [lean, full] = rows
  console.log(
    `\nsaved: ${full.total - lean.total} chars, ~${full.tokens - lean.tokens} tokens per request — ` +
      'multiply by the number of model requests in a session',
  )

  console.log('\nper-tool JSON size (lean / full)')
  for (let i = 0; i < lean.perTool.length; i += 1) {
    const [name, size] = lean.perTool[i]
    console.log(`  ${name.padEnd(20)} ${String(size).padStart(5)} / ${String(full.perTool[i][1]).padStart(5)}`)
  }
}

/** Expand directories into rollout files, oldest first. */
function rolloutFiles(paths) {
  const files = []
  for (const path of paths) {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry.endsWith('.jsonl')) files.push(join(path, entry))
      }
    } else {
      files.push(path)
    }
  }
  return files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
}

async function readJsonl(file) {
  const records = []
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A truncated tail line does not change aggregate numbers.
    }
  }
  return records
}

/** dsh calls made by one recorded tool call, in source order. */
function dshCallsIn(payload) {
  const name = payload.name || ''
  if (payload.type === 'function_call') {
    const m = name.match(/mcp__[A-Za-z0-9_]+__(dsh_[A-Za-z0-9_]+)/)
    return [m ? m[1] : name].filter((n) => DSH_NAMES.has(n))
  }
  if (payload.type === 'custom_tool_call') {
    return [...(payload.input || '').matchAll(DSH_CALL)].map((m) => m[1])
  }
  return []
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] || 0
}

function reportSession(session) {
  const requests = session.requests
  const sum = requests.reduce(
    (acc, r) => {
      acc.input += r.input
      acc.cached += r.cached
      acc.output += r.output
      acc.uncached += r.input - r.cached
      return acc
    },
    { input: 0, cached: 0, output: 0, uncached: 0 },
  )

  const byTool = new Map()
  for (const call of session.calls) byTool.set(call.name, (byTool.get(call.name) || 0) + 1)
  const listed = [...byTool.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(', ')

  console.log(`\n=== session ${session.id} (${session.files.length} rollout file(s)) ===`)
  console.log(`requests: ${requests.length}`)
  console.log(
    `input:    ${sum.input.toLocaleString()}  cached: ${sum.cached.toLocaleString()} ` +
      `(${((sum.cached / sum.input) * 100).toFixed(2)}%)  uncached: ${sum.uncached.toLocaleString()}`,
  )
  console.log(`output:   ${sum.output.toLocaleString()}`)
  console.log(`dsh tool calls: ${session.calls.length}${listed ? ` — ${listed}` : ''}`)
  if (session.calls.length === 0) return

  const events = [
    ...session.calls.map((c) => ({ kind: 'call', ...c })),
    ...requests.map((r) => ({ kind: 'request', ...r })),
  ].sort((a, b) => a.seq - b.seq || (a.kind === 'call' ? -1 : 1))

  const windows = []
  let current = null
  for (const event of events) {
    if (event.kind === 'call') {
      if (event.name === 'dsh_delegate') {
        if (current) windows.push(current)
        current = { requests: 0, uncached: 0, polls: 0, answers: 0 }
      } else if (current) {
        if (event.name === 'dsh_poll') current.polls += 1
        if (event.name === 'dsh_answer') current.answers += 1
      }
      continue
    }
    if (!current) continue
    current.requests += 1
    current.uncached += event.input - event.cached
  }
  if (current) windows.push(current)
  if (windows.length === 0) return

  const blocking = windows.filter((w) => w.requests <= 2).length
  console.log(`per delegation (${windows.length} delegates; window = until the next delegate)`)
  console.log(
    `  requests: median ${median(windows.map((w) => w.requests))}, ` +
      `max ${Math.max(...windows.map((w) => w.requests))}`,
  )
  console.log(
    `  polls:    median ${median(windows.map((w) => w.polls))}, ` +
      `max ${Math.max(...windows.map((w) => w.polls))}`,
  )
  console.log(`  uncached: median ${median(windows.map((w) => w.uncached)).toLocaleString()} tokens`)
  console.log(`  blocking path (<= 2 requests): ${blocking}/${windows.length}`)
}

async function usageReport(paths, { all = false } = {}) {
  const files = rolloutFiles(paths)
  const sessions = new Map()

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    const base = index * 1_000_000
    let fileSession = null

    for (const rec of await readJsonl(file)) {
      const payload = rec.payload || {}
      if (rec.type === 'session_meta' && payload.session_id) {
        fileSession = payload.session_id
        if (!sessions.has(fileSession)) sessions.set(fileSession, { id: fileSession, files: [], requests: [], calls: [] })
        sessions.get(fileSession).files.push(file)
        continue
      }
      if (!fileSession) continue
      const session = sessions.get(fileSession)
      if (rec.type === 'event_msg' && payload.type === 'token_count') {
        const usage = payload.info && payload.info.last_token_usage
        if (!usage) continue
        session.requests.push({
          seq: base + rec.ordinal,
          input: usage.input_tokens || 0,
          cached: usage.cached_input_tokens || 0,
          output: usage.output_tokens || 0,
        })
      }
      if (rec.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
        for (const name of dshCallsIn(payload)) session.calls.push({ seq: base + rec.ordinal, name })
      }
    }
  }

  const list = [...sessions.values()].filter((s) => all || s.calls.length > 0)
  if (list.length === 0) {
    console.log(`no sessions with dsh calls in ${paths.join(', ')}`)
    return
  }
  console.log(`${files.length} rollout file(s) scanned, ${list.length} session(s) reported`)
  for (const session of list) reportSession(session)
}

const args = process.argv.slice(2)
const command = args[0]
const rest = args.slice(1)

if (command === 'surface') {
  surfaceReport()
} else if (command === 'usage') {
  const all = rest.includes('--all')
  const paths = rest.filter((a) => a !== '--all')
  if (paths.length === 0) {
    console.error('usage: node bin/dsh-bench.mjs usage <file.jsonl|directory> [...] [--all]')
    process.exit(1)
  }
  await usageReport(paths, { all })
} else {
  console.error('usage: node bin/dsh-bench.mjs surface | usage <file.jsonl|directory> [...] [--all]')
  process.exit(1)
}
