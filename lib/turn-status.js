// DSH live activity is not an outcome. Only an explicit turn/end determines
// success/failure; missing or truncated evidence must never imply success.
export function readTurnStatus(records) {
  let startSeq = -1, end = null, retry = null, phase = null
  const events = records.map(r => r?.event || r).filter(e => typeof e?.seq === 'number')
    .sort((a, b) => a.seq - b.seq)
  for (const e of events) {
    const d = e.data || {}
    if (e.type === 'turn/start') {
      startSeq = e.seq
      end = null; retry = null; phase = 'model'
    } else if (e.type === 'llm/retry') {
      retry = { attempt: d.retry, maxRetries: d.maxRetries, delayMs: d.delayMs,
        ...(d.failure ? { error: normalizeError(d.failure) } : {}) }
      phase = 'retrying'
    } else if (e.type === 'llm/retry-started') {
      phase = 'retrying'
    } else if (e.type === 'tool/call') phase = 'tool'
    else if (e.type === 'assistant/message' || e.type === 'step/start') phase = 'model'
    else if (e.type === 'turn/end') end = { seq: e.seq, reason: d.reason }
  }
  const reason = end?.reason
  const kind = reason?.kind
  const terminalStatus = kind === 'completed' ? 'completed' : kind === 'error' ? 'failed'
    : kind === 'aborted' ? 'cancelled' : kind === 'interrupted' ? 'interrupted'
    : kind === 'blocked' ? 'blocked' : 'unknown'
  return { statusVersion: 2, lastTurnStartSeq: startSeq, lastTurnEndSeq: end?.seq ?? -1,
    terminalStatus, terminationReason: kind ?? null,
    ...(kind === 'error' ? { error: normalizeError(reason.error) } : {}),
    ...(retry ? { retry } : {}), phase: end ? null : phase }
}

function normalizeError(error) {
  return { code: typeof error?.code === 'string' ? error.code : 'DSH_ERROR',
    message: String(error?.message || error || 'DSH reported an error without details').slice(0, 8000) }
}

export function taskStatus(view, baselineSeq) {
  if (!view) return 'unknown'
  if (view.running === true) return view.status === 'waiting' ? 'waiting' : 'running'
  // Reject a previous turn's outcome, including an old error before a new turn.
  if (Number(view.lastTurnEndSeq ?? -1) > baselineSeq &&
      Number(view.lastTurnEndSeq) >= Number(view.lastTurnStartSeq ?? -1)) {
    return ['completed', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(view.terminalStatus)
      ? view.terminalStatus : 'unknown'
  }
  return view.running === false && Number(view.lastSeq ?? 0) <= baselineSeq ? 'pending' : 'unknown'
}
