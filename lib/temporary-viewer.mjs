import { mkdtempSync, writeFileSync, renameSync, unlinkSync, rmdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { conversationRecords, markdown } from './record-labels.mjs'

function vscode() {
  const exe = [process.env.DSH_RELAY_VSCODE, process.env.VSCODE_EXE,
    'D:\\Software\\Vscode\\Microsoft VS Code\\Code.exe',
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Microsoft VS Code', 'Code.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe')].find(p => p && existsSync(p))
  if (!exe) throw Error('未找到 VS Code，请设置 DSH_RELAY_VSCODE 为 Code.exe 路径')
  // Use the installed, version-matched CLI exactly as code.cmd does, without a
  // command shell or interpolated paths. --wait means this FILE closing, not
  // the entire VS Code window closing.
  const cmd = join(dirname(exe), 'bin', 'code.cmd')
  let cli = join(dirname(exe), 'resources', 'app', 'out', 'cli.js')
  if (!existsSync(cli) && existsSync(cmd)) {
    const match = readFileSync(cmd, 'utf8').match(/%~dp0([^"\r\n]*resources\\app\\out\\cli\.js)/i)
    if (match) cli = resolve(dirname(cmd), match[1])
  }
  if (!existsSync(cli)) throw Error('未找到与 VS Code 匹配的 cli.js')
  return { exe, cli }
}
export function launchVscode(file) {
  const { exe, cli } = vscode()
  const child = spawn(exe, [cli, '--reuse-window', '--wait', file], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  let diagnostic = ''
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000) })
  const started = new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail) })
  const closed = new Promise((done, fail) => {
    child.once('error', fail)
    child.once('exit', (code, signal) => code === 0 ? done() : fail(Error(`VS Code CLI 未正常结束 (${code ?? signal})${diagnostic ? ': ' + diagnostic : ''}`)))
  })
  // The waiter is consumed by openTemporaryViewer after launch; avoid a brief
  // unhandled rejection if startup fails first.
  closed.catch(() => {})
  return { started, closed }
}

export async function openTemporaryViewer({ task, readPage, readReports, launcher = launchVscode,
  temporaryRoot = tmpdir(), onError = () => {} }) {
  const directory = mkdtempSync(join(temporaryRoot, 'dsh-relay-view-'))
  const file = join(directory, '通信记录.md'), pending = file + '.tmp'
  const records = new Map()
  let live = true
  const cleanup = () => {
    if (!live) return
    live = false
    // Only our two exact generated files and our empty mkdtemp folder. Never
    // recursively delete, and never touch native session logs or report files.
    for (const path of [pending, file]) { try { unlinkSync(path) } catch (e) { if (e.code !== 'ENOENT') onError(e) } }
    try { rmdirSync(directory) } catch (e) { if (e.code !== 'ENOENT') onError(e) }
  }
  async function snapshot() {
      // Read each durable source once per opening. No timers or follow-up polls.
      const reports = await readReports()
      let before = null, snapshot = null
      while (live) {
        const page = await readPage(before, snapshot)
        if (!live) return
        if (snapshot === null) snapshot = page.cursor ?? null
        const values = page.records || []
        for (const record of values) {
          const e = record.event || record
          if (Number.isSafeInteger(e.seq) && (snapshot === null || e.seq <= snapshot)) records.set(e.seq, record)
        }
        const seqs = values.map(r => (r.event || r).seq).filter(Number.isSafeInteger)
        const next = seqs.length ? Math.min(...seqs) : null
        if (!page.hasMore) break
        if (next === null || (before !== null && next >= before)) throw Error('对话分页未前进')
        before = next
      }
      if (!live) return
      const entries = [...conversationRecords([...records.values()]), ...reports]
      entries.sort((a,b) => (a.time ?? 0) - (b.time ?? 0) || a.seq - b.seq || (a.part || 0) - (b.part || 0))
      const text = markdown(task, entries, snapshot)
      writeFileSync(pending, text, { mode: 0o600 }); renameSync(pending, file)
  }
  try {
    await snapshot()
    const waiter = launcher(file)
    await waiter.started
    const closed = waiter.closed.then(() => { cleanup() }, error => { cleanup(); throw error })
    closed.catch(onError)
    return { file, closed }
  } catch (error) { cleanup(); throw error }
}
