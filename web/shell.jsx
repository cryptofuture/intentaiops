import { useEffect, useRef, useState } from 'preact/hooks'
import { Terminal, FitAddon } from 'ghostty-web'
import { TriangleAlert } from 'lucide-preact'
import { loadTerminal, applyTerminalTheme, terminalTheme } from './terminal.js'
import { terminalOutputFilter } from './terminal-output.js'

export function BrowserShell ({ hostId, hostVersion, api, mount, actions, palette }) {
  const [shells, setShells] = useState([])
  const [selected, select] = useState(null)
  const [status, setStatus] = useState('disconnected')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attachment, attach] = useState(0)
  const [transcript, setTranscript] = useState('')
  const container = useRef(null)
  const terminal = useRef(null)
  const currentPalette = useRef(palette); currentPalette.current = palette
  const currentApi = useRef(api); currentApi.current = api
  const refresh = () => api('/shells').then(values => {
    setShells(values.filter(value => value.hostId === hostId))
    return values
  }).catch(error => setError(error.message))
  useEffect(() => { if (actions) refresh() }, [hostId, actions])
  useEffect(() => {
    if (!selected || !container.current) return
    let live = true
    let cleanup = () => {}
    setStatus('loading terminal'); setTranscript('')
    loadTerminal().then(ghostty => {
      if (!live) return
      const term = new Terminal({ ghostty, theme: terminalTheme(currentPalette.current), scrollback: 3000, cursorBlink: true, fontSize: 13, fontFamily: 'monospace' })
      terminal.current = term
      cleanup = () => { term.dispose(); terminal.current = null }
      const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current)
      applyTerminalTheme(term, currentPalette.current)
      const filter = terminalOutputFilter()
      const surface = container.current
      const blockLinks = event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopImmediatePropagation() } }
      surface.addEventListener('click', blockLinks, true)
      let outputTimer
      const project = () => {
        clearTimeout(outputTimer)
        outputTimer = setTimeout(() => {
          if (!live) return
          const buffer = term.buffer.active
          const lines = []
          for (let i = Math.max(0, buffer.length - 128); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '')
          setTranscript(lines.join('\n').slice(-32768))
        }, 100)
      }
      let sequence = selected.inputSequence
      let input = Promise.resolve()
      let blocked = selected.status !== 'running'
      let timer
      const size = () => {
        if (!live || !container.current?.clientWidth) return
        fit.fit()
        const cols = Math.max(2, Math.min(300, term.cols)); const rows = Math.max(2, Math.min(150, term.rows))
        term.resize(cols, rows)
        currentApi.current('/shell', { action: 'resize', id: selected.id, cols, rows }).catch(error => { if (live) setError(error.message) })
      }
      const observer = new window.ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(size, 100) }); observer.observe(container.current)
      const typed = term.onData(data => {
        input = input.then(async () => {
          if (!live || blocked) return
          await currentApi.current('/shell', { action: 'input', id: selected.id, sequence: sequence + 1, data })
          sequence++
        }).catch(() => { blocked = true; setError('Input acknowledgment lost or another view wrote first. Reattach before typing. Unacknowledged input is never replayed.') })
      })
      const stream = new window.EventSource(mount + '/shell-events?id=' + selected.id)
      stream.onopen = () => setStatus(selected.status === 'closed' ? 'closed' : 'connected')
      stream.onerror = () => setStatus('reconnecting')
      stream.addEventListener('gap', () => { filter.reset(); term.writeln('\r\n[Earlier output expired from the bounded buffer]\r\n'); project() })
      stream.onmessage = event => {
        const value = JSON.parse(event.data)
        if (value.type === 'output') { term.write(filter.write(value.data)); project() }
        if (value.type === 'closed') { blocked = true; setStatus('closed'); setShells(values => values.map(shell => shell.id === selected.id ? { ...shell, status: 'closed' } : shell)); term.writeln(`\r\n[SSH exited: ${value.exitCode ?? 'unknown'}]\r\n`); project(); stream.close() }
      }
      cleanup = () => { clearTimeout(timer); clearTimeout(outputTimer); observer.disconnect(); typed.dispose(); stream.close(); surface.removeEventListener('click', blockLinks, true); term.dispose(); surface.replaceChildren(); terminal.current = null }
      setError(''); size(); term.focus()
    }).catch(error => { cleanup(); if (live) { setError(error.message); setStatus('terminal unavailable') } })
    return () => { live = false; cleanup() }
  }, [selected?.id, attachment])
  useEffect(() => {
    const term = terminal.current
    if (!term) return
    applyTerminalTheme(term, palette)
  }, [palette, selected?.id, attachment])

  const open = async () => {
    if (!window.confirm('Open a direct SSH shell? Commands run as the saved SSH user, outside managed plan validation and rollback. Terminal contents may contain secrets and are not recorded.')) return
    setBusy(true); setError('')
    try {
      const value = await api('/shell', { action: 'open', hostId, hostVersion, requestKey: window.crypto.randomUUID(), approved: true, cols: 100, rows: 30 })
      select(value); setShells(values => [...values, value])
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }
  const reattach = async id => { const values = await refresh(); const value = values?.find(value => value.id === id); if (value) { select(value); attach(v => v + 1) } }
  const close = async () => {
    if (!window.confirm('End this SSH session? This may terminate a foreground process. Background remote work may continue; closing SSH is not rollback.')) return
    try { await api('/shell', { action: 'close', id: selected.id, approved: true }); setStatus('closed'); refresh() } catch (error) { setError(error.message) }
  }
  return <section class='card'><h2>SSH terminal</h2><p>Direct operator shell, not AI execution. It holds host ownership while open. Authentication stays in the launch terminal; password-only connections need multiplexing.</p><p>Closing this view or refreshing does not end the session. Output is private, memory-only and never sent to AI, history or exports.</p>{!actions && <p>Launch with --console-actions to enable interactive SSH.</p>}<div class='actions'><button disabled={!actions || busy || shells.some(shell => shell.status !== 'closed')} onClick={open}>{busy ? 'Opening, check launch terminal…' : 'Open SSH shell'}</button><button disabled={!actions} onClick={refresh}>Refresh sessions</button>{selected && <><span role='status'>{status}</span><button onClick={() => reattach(selected.id)}>Reattach view</button><button class='danger' disabled={status === 'closed'} onClick={close}><TriangleAlert size={16} aria-hidden='true' focusable='false' />End SSH session</button></>}</div><div class='shell-sessions'>{shells.map(shell => <button key={shell.id} onClick={() => reattach(shell.id)}>Attach {shell.hostId} · {shell.status} · {shell.id.slice(0, 8)}</button>)}</div>{error && <p role='alert'>{error}</p>}{selected && <div class='browser-terminal' aria-label={'SSH terminal for ' + hostId}><div ref={container} class='terminal-surface' /><pre class='terminal-transcript' role='log' aria-label='SSH terminal output' aria-live='polite'>{transcript}</pre></div>}</section>
}
