// Read the existing durable session log and report mailbox without advancing
// the coordinator's polling cursor or creating a second copy of conversations.
export function communicationRecords(records) {
  const entries = []
  const text = blocks => (Array.isArray(blocks) ? blocks : [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  for (const record of records || []) {
    const e = record?.event || record, d = e?.data || {}
    if (!Number.isSafeInteger(e?.seq)) continue
    let label, message, category = 'message'
    if (e.type === 'user/message') {
      label = 'Codex / 用户 → DSH'; message = text(d.content)
    } else if (e.type === 'assistant/message') {
      label = 'DSH 回复'; message = text(d.message?.content)
    } else if (e.type === 'tool/call') {
      // The mailbox is authoritative for accepted reports; retain the native
      // call as a collapsed tool event, including failed reporting attempts.
      label = `工具调用 · ${d.name || ''}`; message = JSON.stringify(d.arguments ?? {}, null, 2); category = 'tool'
    } else if (e.type === 'tool/result') {
      label = '工具结果'; message = text(d.message?.content); category = 'tool'
    } else if (e.type === 'turn/end') {
      label = '本轮结束'; message = JSON.stringify(d.reason ?? {}, null, 2); category = 'status'
    } else if (e.type === 'approval/asked' || e.type === 'approval/decided') {
      label = e.type === 'approval/asked' ? '权限请求' : '权限决定'; message = JSON.stringify(d, null, 2); category = 'tool'
    } else continue
    if (!message) continue
    entries.push({ id: `native:${e.seq}`, seq: e.seq, time: typeof e.time === 'number' ? e.time : null,
      label, message, category, source: 'native', type: e.type })
  }
  return entries
}

export function reportRecords(messages, sourceSessionId) {
  return messages.map(m => ({ id: `report:${sourceSessionId}:${m.seq}`, seq: m.seq,
    time: Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : null,
    label: 'DSH → Codex · report_to_codex', message: m.message, category: 'report', source: 'report',
    kind: m.kind, messageId: m.messageId, replyTo: m.replyTo, sourceSessionId }))
}
