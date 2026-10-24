import { readTurnStatus, taskStatus } from '../lib/turn-status.js'
/**
 * Relay HTTP client — the half of the MCP server that talks to the plugin.
 *
 * Every request is bounded by a timeout. That matters because `dsh_delegate`
 * blocks by default: the blocked path is now the normal path, so a relay that
 * accepts a connection and never answers must fail the caller instead of
 * hanging the turn forever.
 */

const DEFAULT_CALL_TIMEOUT_MS = 30000

export function createRelayClient({
  url,
  token = '',
  connection,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  pollIntervalMs = 2000,
} = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function call(path, options = {}) {
    const endpoint = connection ? connection() : { url, token }
    const timeout = Math.max(1, Number(options.timeoutMs || callTimeoutMs))
    const init = { method: options.method || 'GET', headers: {}, signal: AbortSignal.timeout(timeout) }
    if (endpoint.token) init.headers['x-dsh-relay-token'] = endpoint.token
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json; charset=utf-8'
      init.body = JSON.stringify(options.body)
    }

    let response
    try {
      response = await fetch(endpoint.url + path, init)
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error(`the DSH relay at ${url} did not answer ${path} within ${timeout}ms`)
      }
      // A bare "fetch failed" tells the operator nothing. Name the address and
      // the two things that are almost always wrong: DSH is not running, or
      // this shim is pointed at a different port than the Web profile listens on.
      throw new Error(
        `cannot reach the DSH relay at ${url} (${reason}). Check that DSH is running, and that ` +
          'DSH_RELAY_URL matches the port its Web profile listens on — DSH itself defaults to 3080, ' +
          'but a profile may set another port in its cordis.patch.yml.',
      )
    }

    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`relay returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`)
    }
    if (payload && payload.ok === false) throw new Error(payload.error || 'relay reported an error')
    return payload && payload.ok === true ? payload.data : payload
  }

  const pollOnce = async (sessionId, timeoutMs, afterMessageSeq) => {
    const started = Date.now()
    const budget = timeoutMs || callTimeoutMs
    const query = `/poll?sessionId=${encodeURIComponent(sessionId)}` +
      (afterMessageSeq == null ? '' : `&afterMessageSeq=${afterMessageSeq}`)
    const view = await call(query, { timeoutMs: budget })
    if (view?.statusVersion === 2) return view
    // Upgrade observations from a host loaded before status v2 without restarting
    // DSH or disturbing its running tasks. No disk scans or UI scraping.
    try {
      const remaining = budget - (Date.now() - started)
      if (remaining <= 0) return { ...view, terminalStatus: 'unknown' }
      const transcript = await call(`/transcript?sessionId=${encodeURIComponent(sessionId)}`,
        { timeoutMs: remaining })
      if (Array.isArray(transcript?.records)) {
        const state = readTurnStatus(transcript.records)
        return { ...view, ...state, statusSource: 'live-summary+transcript',
          phase: view?.pendingTool ? 'tool' : state.phase }
      }
    } catch { /* No outcome evidence: do not guess successful completion. */ }
    return { ...view, terminalStatus: 'unknown' }
  }

  /**
   * Wait for the turn started after `baselineSeq`.
   *
   * Returns as soon as the turn completed or the session is blocked on a human
   * (`status === 'waiting'`). The second case must not consume the timeout,
   * because no amount of waiting resolves it.
   */
  async function waitForSettle(sessionId, baselineSeq, timeoutMs, afterMessageSeq = 0) {
    const deadline = Date.now() + timeoutMs
    // Never let one poll outlive the caller's own budget, and never ask for an
    // unbounded wait: a hung relay is an error, not something to sit through.
    // The floor keeps the last poll from being handed a 1ms budget it cannot
    // possibly meet on a loaded machine.
    const remaining = () => Math.max(100, Math.min(callTimeoutMs, deadline - Date.now()))

    let view = await pollOnce(sessionId, remaining(), afterMessageSeq)
    while (Date.now() < deadline) {
      const state = taskStatus(view, baselineSeq)
      if (['waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(state)) return { outcome: state, view }
      if (Array.isArray(view?.messages) && view.messages.length > 0) return { outcome: 'message', view }
      if (state === 'unknown' && view?.running !== true && Number(view?.lastSeq ?? 0) > baselineSeq) return { outcome: 'unknown', view }
      const left = deadline - Date.now()
      if (left <= 0) break
      await sleep(Math.min(pollIntervalMs, left))
      if (Date.now() >= deadline) break
      view = await pollOnce(sessionId, remaining(), afterMessageSeq)
    }
    return { outcome: 'timeout', view }
  }

  return { call, pollOnce, waitForSettle }
}
