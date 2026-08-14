import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { PRODUCT_NAME } from './product.js'

const ANSI_STYLES = Object.freeze({
  heading: '1;96',
  section: '36',
  focus: '1;96',
  selected: '1;96',
  success: '32',
  warning: '33',
  error: '31',
  danger: '1;91',
  muted: '2',
  secondary: null,
  key: '96',
  separator: '2',
  info: '36',
  green: '32',
  yellow: '33',
  red: '31',
  cyan: '36',
  dim: '2'
})

export class TerminalUi {
  constructor ({ input = process.stdin, output = process.stdout, env = process.env, color } = {}) {
    this.input = input
    this.output = output
    this.color = supportsColor({ output, env, color })
    this.initialInputState = this.captureInputState()
    this.rawReaders = new Set()
  }

  clear () {
    if (this.output.isTTY) this.output.write('\u001b[2J\u001b[H')
  }

  terminalSize () {
    const columns = Number.isInteger(this.output.columns) && this.output.columns > 0 ? this.output.columns : 80
    const rows = Number.isInteger(this.output.rows) && this.output.rows > 0 ? this.output.rows : 24
    return {
      width: Math.max(20, columns),
      height: Math.max(8, rows)
    }
  }

  separator ({ width = this.terminalSize().width, character = '-' } = {}) {
    const safeWidth = Math.max(1, Math.floor(Number(width) || 0))
    const unit = typeof character === 'string' && character ? Array.from(character)[0] : '-'
    this.output.write(`${this.paint('separator', unit.repeat(safeWidth))}\n`)
  }

  wrapText (value, width) {
    const safeWidth = Math.max(1, Math.floor(Number(width) || 0))
    const text = value === null || value === undefined ? '' : String(value)
    return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').flatMap(line => wrapLine(line, safeWidth))
  }

  truncateText (value, width) {
    const safeWidth = Math.max(0, Math.floor(Number(width) || 0))
    if (safeWidth === 0) return ''
    const text = (value === null || value === undefined ? '' : String(value)).replaceAll(/[\r\n]+/gu, ' ')
    const characters = Array.from(text)
    if (characters.length <= safeWidth) return text
    if (safeWidth === 1) return '…'
    return `${characters.slice(0, safeWidth - 1).join('')}…`
  }

  renderColumns (columns, options = {}) {
    const lines = this.columnLines(columns, options)
    this.output.write(`${lines.join('\n')}\n`)
    return lines
  }

  columnLines (columns, {
    width = this.terminalSize().width,
    gap = '  ',
    verticalSeparator = false,
    stacked = false,
    minimumWidth = 12
  } = {}) {
    if (!Array.isArray(columns) || columns.length === 0) return []
    const safeWidth = Math.max(1, Math.floor(Number(width) || 0))
    const joiner = verticalSeparator ? ' | ' : gap
    const widths = calculateWidths(columns, safeWidth, joiner.length, minimumWidth)
    if (stacked || !widths) {
      return columns.flatMap((column, index) => {
        const title = column.title ? [this.renderStyled(styledValue(column.title, 'section'), this.truncateText(styledText(column.title), safeWidth))] : []
        const body = normalizeStyledLines(column.lines ?? column.value).flatMap(line => this.wrapStyled(line, safeWidth)).map(line => this.renderStyled(line, line.text))
        return [...(index > 0 ? [''] : []), ...title, ...body]
      })
    }
    const prepared = columns.map((column, index) => {
      const body = normalizeStyledLines(column.lines ?? column.value).flatMap(line => this.wrapStyled(line, widths[index]))
      return column.title ? [styledValue(column.title, 'section'), ...body] : body
    })
    const height = Math.max(...prepared.map(lines => lines.length), 0)
    return Array.from({ length: height }, (_, row) => prepared.map((lines, index) => {
      const descriptor = lines[row] ?? styledValue('')
      const value = this.truncateText(descriptor.text, widths[index])
      const padded = index === prepared.length - 1 ? value : value.padEnd(widths[index])
      return this.renderStyled(descriptor, padded)
    }).join(this.paint('separator', joiner)))
  }

  renderTable (columns, rows, options = {}) {
    const lines = this.tableLines(columns, rows, options)
    this.output.write(`${lines.join('\n')}\n`)
    return lines
  }

  tableLines (columns, rows, {
    width = this.terminalSize().width,
    selectedIndex = -1,
    emptyMessage = 'No entries.',
    header = true
  } = {}) {
    if (!Array.isArray(columns) || columns.length === 0) return []
    const safeWidth = Math.max(1, Math.floor(Number(width) || 0))
    const markerWidth = 2
    const contentWidth = Math.max(1, safeWidth - markerWidth)
    const widths = calculateWidths(columns, contentWidth, 1, 3) ?? compactWidths(columns.length, contentWidth, 1)
    const format = (row, marker = '  ', rowStyle = null, isHeader = false) => {
      const cells = columns.map((column, index) => {
        const value = typeof column.render === 'function' ? column.render(row) : row?.[column.key]
        const style = isHeader ? 'section' : (typeof column.style === 'function' ? column.style(value, row) : column.style)
        const descriptor = styledValue(value, style)
        const lines = column.wrap ? this.wrapStyled(descriptor, widths[index]) : [{ ...descriptor, text: this.truncateText(descriptor.text, widths[index]) }]
        return lines.length > 0 ? lines : [styledValue('')]
      })
      const height = Math.max(...cells.map(cell => cell.length), 1)
      return Array.from({ length: height }, (_, lineIndex) => {
        const prefix = lineIndex === 0 ? marker : '  '
        const content = cells.map((cell, index) => {
          const descriptor = cell[lineIndex] ?? styledValue('')
          const value = this.truncateText(descriptor.text, widths[index])
          const padded = index === cells.length - 1 ? value : value.padEnd(widths[index])
          return this.renderStyled(rowStyle ? { ...descriptor, style: rowStyle } : descriptor, padded)
        }).join(' ')
        return `${rowStyle ? this.paint(rowStyle, prefix) : prefix}${content}`
      })
    }
    const lines = []
    if (header) lines.push(...format(Object.fromEntries(columns.map(column => [column.key, column.label ?? ''])), '  ', null, true))
    if (!Array.isArray(rows) || rows.length === 0) {
      lines.push(...this.wrapText(emptyMessage, safeWidth).map(line => `  ${line}`.slice(0, safeWidth)))
      return lines
    }
    rows.forEach((row, index) => lines.push(...format(row, index === selectedIndex ? '> ' : '  ', index === selectedIndex ? 'focus' : null)))
    return lines
  }

  renderKeyHints (hints, { width = this.terminalSize().width } = {}) {
    const pairs = (Array.isArray(hints) ? hints : [hints]).map(normalizeHint).filter(hint => hint.key || hint.label)
    const lines = wrapHints(pairs, Math.max(1, width)).map(line => line.map(hint => {
      const content = [this.paint('key', hint.key), hint.label].filter(Boolean).join(' ')
      return content
    }).join(this.paint('separator', ' | ')))
    this.output.write(`${lines.join('\n')}\n`)
    return lines
  }

  banner (subtitle = 'AI-assisted server administration over system SSH') {
    this.output.write(`${this.paint('heading', PRODUCT_NAME)}\n`)
    if (subtitle) this.output.write(`${subtitle}\n`)
    this.separator()
  }

  heading (text) {
    this.output.write(`\n${this.paint('heading', text)}\n${this.paint('separator', '-'.repeat(Math.min(this.terminalSize().width, Math.max(12, String(text).length))))}\n`)
  }

  line (label, value, tone) {
    const text = value === null || value === undefined ? '' : String(value)
    const style = tone ?? this.semanticValueStyle(label, text)
    this.output.write(`${this.paint('muted', String(label).padEnd(22))} ${style ? this.paint(style, text) : text}\n`)
  }

  info (message) {
    this.output.write(`${this.paint('info', 'INFO:')} ${message}\n`)
  }

  success (message) {
    this.output.write(`${this.paint('success', 'OK:')} ${message}\n`)
  }

  warn (message) {
    this.output.write(`${this.paint('warning', 'WARNING:')} ${message}\n`)
  }

  error (message) {
    this.output.write(`${this.paint('error', 'ERROR:')} ${message}\n`)
  }

  async ask (label, { defaultValue, required = true } = {}) {
    for (;;) {
      const suffix = defaultValue === undefined ? '' : ` [${defaultValue}]`
      const inputState = this.captureInputState()
      const readline = createInterface({ input: this.input, output: this.output })
      let answer
      try {
        answer = (await readline.question(`${label}${suffix}: `)).trim()
      } finally {
        readline.close()
        this.restoreInputState(inputState)
      }
      if (!answer && defaultValue !== undefined) return defaultValue
      if (answer || !required) return answer
      this.warn('A value is required.')
    }
  }

  async secret (label) {
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== 'function') {
      throw new Error('secret input requires an interactive terminal')
    }
    this.output.write(`${label}: `)
    return new Promise((resolve, reject) => {
      let value = ''
      let settled = false
      const inputState = this.captureInputState()
      const finish = (error) => {
        if (settled) return
        settled = true
        this.input.off('data', onData)
        this.restoreInputState(inputState)
        this.output.write('\n')
        if (error) reject(error)
        else resolve(value)
      }
      const onData = chunk => {
        for (const character of chunk.toString('utf8')) {
          if (character === '\u0003') return finish(new Error('interrupted'))
          if (character === '\r' || character === '\n') return finish()
          if (character === '\u007f' || character === '\b') {
            if (value) {
              value = value.slice(0, -1)
              this.output.write('\b \b')
            }
          } else if (character >= ' ') {
            value += character
            this.output.write('•')
          }
        }
      }
      this.input.setRawMode(true)
      this.input.resume()
      this.input.on('data', onData)
    })
  }

  async confirm (label, defaultValue = false) {
    const marker = defaultValue ? 'Y/n' : 'y/N'
    const answer = (await this.ask(`${label} ${this.paint('key', `[${marker}]`)}`, { required: false })).toLowerCase()
    if (!answer) return defaultValue
    return answer === 'y' || answer === 'yes'
  }

  async choose (label, options) {
    if (this.input.isTTY && this.output.isTTY && typeof this.input.setRawMode === 'function') {
      return this.chooseWithArrows(label, options)
    }
    this.output.write(`\n${label}\n`)
    options.forEach((option, index) => {
      this.output.write(`  ${String(index + 1).padStart(2)}  ${option.label}\n`)
    })
    for (;;) {
      const answer = await this.ask('Select')
      const index = Number(answer) - 1
      if (Number.isInteger(index) && options[index]) return options[index].value
      const byValue = options.find(option => String(option.value).toLowerCase() === answer.toLowerCase())
      if (byValue) return byValue.value
      this.warn('Choose one of the listed options.')
    }
  }

  async chooseWithArrows (label, options) {
    if (!Array.isArray(options) || options.length === 0) throw new TypeError('at least one choice is required')
    let selected = 0
    let rendered = false
    const render = () => {
      if (rendered) this.output.write(`\u001b[${options.length + 2}A\r\u001b[J`)
      this.output.write(`${label}\n`)
      options.forEach((option, index) => {
        const marker = index === selected ? '>' : ' '
        const style = index === selected ? 'focus' : option.style
        const text = style ? this.paint(style, option.label) : option.label
        this.output.write(` ${marker} ${text}\n`)
      })
      this.renderKeyHints([['Left/Up', 'previous'], ['Right/Down', 'next'], ['Enter', 'select']])
      rendered = true
    }
    render()
    return this.readRawKey((string, key, finish) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
      if (['left', 'up'].includes(key.name)) selected = (selected - 1 + options.length) % options.length
      else if (['right', 'down'].includes(key.name)) selected = (selected + 1) % options.length
      else if (key.name === 'return' || key.name === 'enter') return finish(null, options[selected].value)
      else if (/^[1-9]$/.test(string) && options[Number(string) - 1]) {
        return finish(null, options[Number(string) - 1].value)
      } else return
      render()
    })
  }

  async searchChoose (label, options) {
    if (!Array.isArray(options) || options.length === 0) throw new TypeError('at least one choice is required')
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== 'function') {
      return this.choose(label, options)
    }
    let filter = ''
    let selected = 0
    let renderedLines = 0
    const pageSize = Math.max(5, Math.min(15, (this.output.rows ?? 24) - 7))
    const matches = () => {
      const term = filter.toLocaleLowerCase()
      return term
        ? options.filter(option => option.label.toLocaleLowerCase().includes(term))
        : options
    }
    const render = () => {
      const filtered = matches()
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1)
      const pageStart = Math.floor(selected / pageSize) * pageSize
      const visible = filtered.slice(pageStart, pageStart + pageSize)
      if (renderedLines) this.output.write(`\u001b[${renderedLines}A\r\u001b[J`)
      const lines = []
      lines.push(label)
      lines.push(` Search: ${filter || 'type to search'}  ${filtered.length}/${options.length}`)
      if (visible.length === 0) {
        lines.push('   No matching hosts')
      } else {
        visible.forEach((option, index) => {
          const absoluteIndex = pageStart + index
          const marker = absoluteIndex === selected ? '>' : ' '
          const text = option.label
          lines.push(` ${marker} ${absoluteIndex === selected ? this.paint('focus', text) : text}`)
        })
      }
      const page = filtered.length === 0 ? 0 : Math.floor(pageStart / pageSize) + 1
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
      lines.push(...this.keyHintLines([['Up/Down', 'move'], ['Left/Right', 'page'], ['Enter', 'select'], ['Backspace', 'filter'], ['Esc', 'cancel'], ['page', `${page}/${pages}`]], this.terminalSize().width))
      this.output.write(`${lines.join('\n')}\n`)
      renderedLines = lines.length
    }
    render()
    return this.readRawKey((string, key, finish) => {
      const filtered = matches()
      if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
      if (key.name === 'escape') return finish(null, null)
      if (key.name === 'up' && filtered.length > 0) selected = (selected - 1 + filtered.length) % filtered.length
      else if (key.name === 'down' && filtered.length > 0) selected = (selected + 1) % filtered.length
      else if (key.name === 'left' && filtered.length > 0) selected = Math.max(0, selected - pageSize)
      else if (key.name === 'right' && filtered.length > 0) selected = Math.min(filtered.length - 1, selected + pageSize)
      else if (key.name === 'home' && filtered.length > 0) selected = 0
      else if (key.name === 'end' && filtered.length > 0) selected = filtered.length - 1
      else if (key.name === 'backspace') {
        filter = Array.from(filter).slice(0, -1).join('')
        selected = 0
      } else if (key.ctrl && key.name === 'u') {
        filter = ''
        selected = 0
      } else if ((key.name === 'return' || key.name === 'enter') && filtered[selected]) {
        return finish(null, filtered[selected].value)
      } else if (string && !key.ctrl && !key.meta && string >= ' ') {
        filter += string
        selected = 0
      } else return
      render()
    })
  }

  async searchableDetailChoose ({
    title,
    summaryLines = [],
    rows,
    rowSearchText = row => row?.searchText ?? row?.label ?? '',
    renderRow = row => row?.label ?? row?.value ?? '',
    renderDetails = () => [],
    initialRow = null,
    emptyMessage = 'No entries.',
    resultLabel = 'items',
    footerHints = ['Enter open', '/ search', 'Esc back']
  }) {
    if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('at least one row is required')
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== 'function') {
      return this.searchChoose(title, rows.map(row => ({ label: String(renderRow(row, { width: 80 })), value: row.value })))
    }
    let query = ''
    let searching = false
    let selected = Math.max(0, rows.findIndex(row => row.value === initialRow))
    const matches = () => {
      const term = query.toLocaleLowerCase()
      return term ? rows.filter(row => String(rowSearchText(row)).toLocaleLowerCase().includes(term)) : rows
    }
    const render = () => {
      const { width, height } = this.terminalSize()
      const filtered = matches()
      selected = Math.max(0, Math.min(selected, Math.max(0, filtered.length - 1)))
      const pageSize = Math.max(3, height - summaryLines.length - 9)
      const pageStart = Math.floor(selected / pageSize) * pageSize
      const listWidth = width >= 90 ? Math.max(34, Math.floor(width * 0.48)) : width
      const list = filtered.length === 0
        ? this.wrapText(query ? `No ${resultLabel} match "${query}"` : emptyMessage, listWidth)
        : filtered.slice(pageStart, pageStart + pageSize).flatMap((row, index) => normalizeStyledLines(renderRow(row, {
          width: Math.max(1, listWidth - 2),
          selected: pageStart + index === selected
        })).map((line, lineIndex) => ({
          ...line,
          text: `${lineIndex === 0 && pageStart + index === selected ? '> ' : '  '}${line.text}`,
          style: pageStart + index === selected ? 'focus' : line.style,
          format: pageStart + index === selected ? null : line.format
        })))
      const current = filtered[selected] ?? null
      this.clear()
      this.banner(title)
      for (const line of normalizeStyledLines(summaryLines)) {
        const plain = this.truncateText(line.text, width)
        this.output.write(`${this.renderStyled(line, plain)}\n`)
      }
      if (summaryLines.length > 0) this.separator({ width })
      const search = `Search: ${query || (searching ? '_' : 'press /')}  ${filtered.length} of ${rows.length} ${resultLabel}`
      this.renderColumns([
        { title: resultLabel.toLocaleUpperCase(), lines: [this.styleToken(search, 'Search:', 'section'), ...list], width: listWidth },
        { title: 'SELECTED', lines: this.detailLines(renderDetails(current, { width })), flex: 1 }
      ], { width, verticalSeparator: width >= 90, stacked: width < 90, minimumWidth: 24 })
      this.separator({ width })
      this.renderKeyHints(footerHints, { width })
    }
    const onResize = () => render()
    this.output.on?.('resize', onResize)
    try {
      render()
      return await this.readRawKey((string, key, finish) => {
        const filtered = matches()
        if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
        if (searching) {
          if (key.name === 'escape') {
            if (query) query = ''
            else searching = false
          } else if (key.name === 'backspace') query = Array.from(query).slice(0, -1).join('')
          else if (key.name === 'return' || key.name === 'enter') searching = false
          else if (string && !key.ctrl && !key.meta && string >= ' ') query += string
          else return
          selected = 0
          render()
          return
        }
        if (key.name === 'escape' || string.toLowerCase() === 'q') return finish(null, null)
        if (string === '/') {
          searching = true
        } else if (key.name === 'up' && filtered.length > 0) selected = (selected - 1 + filtered.length) % filtered.length
        else if (key.name === 'down' && filtered.length > 0) selected = (selected + 1) % filtered.length
        else if (key.name === 'pageup') selected = Math.max(0, selected - Math.max(1, this.terminalSize().height - summaryLines.length - 9))
        else if (key.name === 'pagedown') selected = Math.min(Math.max(0, filtered.length - 1), selected + Math.max(1, this.terminalSize().height - summaryLines.length - 9))
        else if (key.name === 'home') selected = 0
        else if (key.name === 'end') selected = Math.max(0, filtered.length - 1)
        else if ((key.name === 'return' || key.name === 'enter') && filtered[selected]) return finish(null, filtered[selected].value)
        else return
        render()
      })
    } finally {
      this.output.off?.('resize', onResize)
    }
  }

  async searchableMultiChoose (title, options, {
    initialValues = [],
    rowSearchText = option => option?.searchText ?? option?.label ?? '',
    renderRow = option => option?.label ?? option?.value ?? '',
    resultLabel = 'hosts',
    footerHints = ['Space toggle', 'A all', 'N none', '/ search', 'Enter continue', 'Esc cancel']
  } = {}) {
    if (!Array.isArray(options) || options.length === 0) throw new TypeError('at least one choice is required')
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== 'function') {
      return this.multiChoose(title, options, { initialValues })
    }
    const selected = new Set(initialValues)
    let cursor = 0
    let query = ''
    let searching = false
    const matches = () => {
      const term = query.toLocaleLowerCase()
      return term ? options.filter(option => String(rowSearchText(option)).toLocaleLowerCase().includes(term)) : options
    }
    const render = () => {
      const { width, height } = this.terminalSize()
      const filtered = matches()
      cursor = Math.max(0, Math.min(cursor, Math.max(0, filtered.length - 1)))
      const pageSize = Math.max(4, height - 8)
      const pageStart = Math.floor(cursor / pageSize) * pageSize
      this.clear()
      this.banner(title)
      this.output.write(`${this.paint('section', 'Search:')} ${query || (searching ? '_' : 'press /')}  ${this.paint('muted', `${filtered.length} of ${options.length} ${resultLabel}  Selected: ${selected.size}`)}\n`)
      this.separator({ width })
      const rows = filtered.length === 0
        ? this.wrapText(query ? `No ${resultLabel} match "${query}"` : 'No entries.', width)
        : filtered.slice(pageStart, pageStart + pageSize).map((option, index) => {
          const marker = pageStart + index === cursor ? '>' : ' '
          const checked = selected.has(option.value) ? '[x]' : '[ ]'
          const text = `${marker} ${checked} ${this.truncateText(renderRow(option, { width: Math.max(1, width - 7) }), Math.max(1, width - 7))}`
          return pageStart + index === cursor ? this.paint('focus', text) : text
        })
      this.output.write(`${rows.join('\n')}\n`)
      this.separator({ width })
      this.renderKeyHints(footerHints, { width })
    }
    const onResize = () => render()
    this.output.on?.('resize', onResize)
    try {
      render()
      return await this.readRawKey((string, key, finish) => {
        const filtered = matches()
        if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
        if (searching) {
          if (key.name === 'escape') {
            if (query) query = ''
            else searching = false
          } else if (key.name === 'backspace') query = Array.from(query).slice(0, -1).join('')
          else if (key.name === 'return' || key.name === 'enter') searching = false
          else if (string && !key.ctrl && !key.meta && string >= ' ') query += string
          else return
          cursor = 0
          render()
          return
        }
        if (key.name === 'escape') return finish(null, [])
        if (string === '/') searching = true
        else if (key.name === 'up' && filtered.length > 0) cursor = (cursor - 1 + filtered.length) % filtered.length
        else if (key.name === 'down' && filtered.length > 0) cursor = (cursor + 1) % filtered.length
        else if (key.name === 'pageup') cursor = Math.max(0, cursor - Math.max(1, this.terminalSize().height - 8))
        else if (key.name === 'pagedown') cursor = Math.min(Math.max(0, filtered.length - 1), cursor + Math.max(1, this.terminalSize().height - 8))
        else if (key.name === 'home') cursor = 0
        else if (key.name === 'end') cursor = Math.max(0, filtered.length - 1)
        else if (key.name === 'space' && filtered[cursor]) toggle(selected, filtered[cursor].value)
        else if (string.toLowerCase() === 'a') options.forEach(option => selected.add(option.value))
        else if (string.toLowerCase() === 'n') selected.clear()
        else if ((key.name === 'return' || key.name === 'enter') && selected.size > 0) {
          return finish(null, options.filter(option => selected.has(option.value)).map(option => option.value))
        } else return
        render()
      })
    } finally {
      this.output.off?.('resize', onResize)
    }
  }

  async splitChoose ({ title, summaryLines = [], actions, details = [], initialAction = 0, footerHints = [] }) {
    if (!Array.isArray(actions) || actions.length === 0) throw new TypeError('at least one action is required')
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== 'function') {
      return this.choose(title, actions)
    }
    let selected = Math.max(0, Math.min(actions.length - 1, Number(initialAction) || 0))
    const render = () => {
      const { width, height } = this.terminalSize()
      const pageSize = Math.max(4, height - summaryLines.length - 8)
      const pageStart = Math.floor(selected / pageSize) * pageSize
      const actionLines = actions.slice(pageStart, pageStart + pageSize).map((action, index) => this.styled(`${pageStart + index === selected ? '> ' : '  '}${action.label}`, pageStart + index === selected ? 'focus' : action.style))
      this.clear()
      this.banner(title)
      for (const line of normalizeStyledLines(summaryLines)) {
        const plain = this.truncateText(line.text, width)
        this.output.write(`${this.renderStyled(line, plain)}\n`)
      }
      if (summaryLines.length > 0) this.separator({ width })
      this.renderColumns([
        { title: 'HOST ACTIONS', lines: actionLines, width: Math.min(42, Math.max(24, Math.floor(width * 0.38))) },
        { title: 'HOST STATUS', lines: this.detailLines(details), flex: 1 }
      ], { width, verticalSeparator: width >= 75, stacked: width < 75, minimumWidth: 22 })
      this.separator({ width })
      this.renderKeyHints(footerHints, { width })
    }
    const onResize = () => render()
    this.output.on?.('resize', onResize)
    try {
      render()
      return await this.readRawKey((string, key, finish) => {
        if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
        if (key.name === 'escape' || string.toLowerCase() === 'q') return finish(null, null)
        if (key.name === 'up') selected = (selected - 1 + actions.length) % actions.length
        else if (key.name === 'down') selected = (selected + 1) % actions.length
        else if (key.name === 'pageup') selected = Math.max(0, selected - Math.max(1, this.terminalSize().height - 8))
        else if (key.name === 'pagedown') selected = Math.min(actions.length - 1, selected + Math.max(1, this.terminalSize().height - 8))
        else if (key.name === 'home') selected = 0
        else if (key.name === 'end') selected = actions.length - 1
        else if (key.name === 'return' || key.name === 'enter') return finish(null, actions[selected].value)
        else return
        render()
      })
    } finally {
      this.output.off?.('resize', onResize)
    }
  }

  async searchableSplitChoose ({
    title,
    summaryLines = [],
    actions,
    rows,
    rowSearchText = row => row?.searchText ?? '',
    renderRow = row => row?.label ?? row?.value ?? '',
    renderDetails = () => [],
    initialAction = 0,
    initialRow = null,
    emptyMessage = 'No entries.',
    footerHints = []
  }) {
    if (!Array.isArray(actions) || actions.length === 0) throw new TypeError('at least one action is required')
    if (!Array.isArray(rows)) throw new TypeError('rows must be an array')
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== 'function') {
      const selected = await this.choose(title, actions)
      return { type: 'action', value: selected }
    }
    let focus = 'actions'
    let searching = false
    let query = ''
    let actionIndex = Math.max(0, Math.min(actions.length - 1, Number(initialAction) || 0))
    let rowIndex = Math.max(0, rows.findIndex(row => row.value === initialRow))
    const filteredRows = () => {
      const term = query.toLocaleLowerCase()
      return term ? rows.filter(row => String(rowSearchText(row)).toLocaleLowerCase().includes(term)) : rows
    }
    const selectedRow = () => filteredRows()[rowIndex] ?? null
    const render = () => {
      const { width, height } = this.terminalSize()
      const filtered = filteredRows()
      rowIndex = Math.max(0, Math.min(rowIndex, Math.max(0, filtered.length - 1)))
      const chromeHeight = summaryLines.length + 9
      const pageSize = Math.max(3, height - chromeHeight)
      const rowPaneWidth = width >= 120
        ? Math.max(38, Math.floor((width - 25) * 0.52))
        : width >= 90 ? Math.max(32, Math.floor((width - 20) * 0.55)) : width
      const actionStart = Math.floor(actionIndex / pageSize) * pageSize
      const rowStart = Math.floor(rowIndex / pageSize) * pageSize
      const actionLines = actions.slice(actionStart, actionStart + pageSize).map((action, index) => {
        const current = actionStart + index === actionIndex
        const marker = current ? '> ' : '  '
        return this.styled(`${marker}${action.label}`, current && focus === 'actions' ? 'focus' : action.style)
      })
      const rowLines = filtered.length === 0
        ? this.wrapText(query ? `No hosts match "${query}"` : emptyMessage, Math.max(20, Math.floor(width * 0.4)))
        : filtered.slice(rowStart, rowStart + pageSize).flatMap((row, index) => normalizeStyledLines(renderRow(row, {
          width: Math.max(1, rowPaneWidth - 2),
          selected: focus !== 'actions' && rowStart + index === rowIndex
        })).map((line, lineIndex) => {
          const current = rowStart + index === rowIndex
          const marker = lineIndex === 0 && current ? '> ' : '  '
          return {
            ...line,
            text: `${marker}${line.text}`,
            style: current && focus !== 'actions' ? 'focus' : line.style,
            format: current && focus !== 'actions' ? null : line.format
          }
        }))
      const search = `Search: ${query || (searching ? '_' : 'press /')}  ${filtered.length} of ${rows.length} hosts`
      const detailLines = this.detailLines(renderDetails(selectedRow(), { width }))
      this.clear()
      this.banner(title)
      for (const line of normalizeStyledLines(summaryLines)) {
        const plain = this.truncateText(line.text, width)
        this.output.write(`${this.renderStyled(line, plain)}\n`)
      }
      if (summaryLines.length > 0) this.separator({ width })
      if (width >= 90) {
        const actionWidth = width >= 120 ? 25 : 20
        const rowWidth = width >= 120 ? Math.max(38, Math.floor((width - actionWidth) * 0.52)) : Math.max(32, Math.floor((width - actionWidth) * 0.55))
        this.renderColumns([
          { title: this.paneTitle('ACTIONS', focus === 'actions'), lines: actionLines, width: actionWidth },
          { title: this.paneTitle('HOSTS', focus !== 'actions'), lines: [this.styleToken(search, 'Search:', 'section'), ...rowLines], width: rowWidth },
          { title: 'HOST DETAILS', lines: detailLines, flex: 1 }
        ], { width, verticalSeparator: true, minimumWidth: 16 })
      } else {
        this.renderColumns([
          { title: this.paneTitle('ACTIONS', focus === 'actions'), lines: actionLines },
          { title: this.paneTitle('HOSTS', focus !== 'actions'), lines: [this.styleToken(search, 'Search:', 'section'), ...rowLines] },
          { title: 'HOST DETAILS', lines: detailLines }
        ], { width, stacked: true })
      }
      this.separator({ width })
      this.renderKeyHints(footerHints, { width })
    }
    const onResize = () => render()
    this.output.on?.('resize', onResize)
    try {
      render()
      return await this.readRawKey((string, key, finish) => {
        const filtered = filteredRows()
        if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
        if (searching) {
          if (key.name === 'escape') {
            if (query) query = ''
            else searching = false
          } else if (key.name === 'backspace') {
            query = Array.from(query).slice(0, -1).join('')
          } else if (key.name === 'return' || key.name === 'enter') {
            searching = false
          } else if (string && !key.ctrl && !key.meta && string >= ' ') {
            query += string
          } else return
          rowIndex = 0
          render()
          return
        }
        if (key.name === 'escape') return finish(null, null)
        if (string.toLowerCase() === 'q') return finish(null, { type: 'quit' })
        if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
          focus = focus === 'actions' && rows.length > 0 ? 'rows' : 'actions'
        } else if (focus === 'rows' && string === '/') {
          searching = true
        } else if (key.name === 'up') {
          if (focus === 'actions') actionIndex = (actionIndex - 1 + actions.length) % actions.length
          else if (filtered.length > 0) rowIndex = (rowIndex - 1 + filtered.length) % filtered.length
        } else if (key.name === 'down') {
          if (focus === 'actions') actionIndex = (actionIndex + 1) % actions.length
          else if (filtered.length > 0) rowIndex = (rowIndex + 1) % filtered.length
        } else if (key.name === 'pageup') {
          const step = Math.max(1, this.terminalSize().height - summaryLines.length - 9)
          if (focus === 'actions') actionIndex = Math.max(0, actionIndex - step)
          else rowIndex = Math.max(0, rowIndex - step)
        } else if (key.name === 'pagedown') {
          const step = Math.max(1, this.terminalSize().height - summaryLines.length - 9)
          if (focus === 'actions') actionIndex = Math.min(actions.length - 1, actionIndex + step)
          else rowIndex = Math.min(Math.max(0, filtered.length - 1), rowIndex + step)
        } else if (key.name === 'home') {
          if (focus === 'actions') actionIndex = 0
          else rowIndex = 0
        } else if (key.name === 'end') {
          if (focus === 'actions') actionIndex = actions.length - 1
          else rowIndex = Math.max(0, filtered.length - 1)
        } else if (key.name === 'return' || key.name === 'enter') {
          if (focus === 'actions') {
            if (actions[actionIndex].focusRows && rows.length > 0) focus = 'rows'
            else return finish(null, { type: 'action', value: actions[actionIndex].value })
          } else if (selectedRow()) return finish(null, { type: 'row', value: selectedRow().value })
        } else return
        render()
      })
    } finally {
      this.output.off?.('resize', onResize)
    }
  }

  async multiChoose (label, options, { initialValues = [] } = {}) {
    if (!Array.isArray(options) || options.length === 0) throw new TypeError('at least one choice is required')
    if (this.input.isTTY && this.output.isTTY && typeof this.input.setRawMode === 'function') {
      return this.multiChooseWithArrows(label, options, { initialValues })
    }
    this.output.write(`\n${label}\n`)
    options.forEach((option, index) => {
      this.output.write(`  ${String(index + 1).padStart(2)}  ${option.label}\n`)
    })
    for (;;) {
      const answer = await this.ask('Select comma-separated numbers, or all')
      const indexes = answer.toLowerCase() === 'all'
        ? options.map((option, index) => index)
        : answer.split(',').map(value => Number(value.trim()) - 1)
      if (indexes.length > 0 && indexes.every(index => Number.isInteger(index) && options[index])) {
        return [...new Set(indexes)].map(index => options[index].value)
      }
      this.warn('Choose one or more listed options.')
    }
  }

  async multiChooseWithArrows (label, options, { initialValues = [] } = {}) {
    let cursor = 0
    const selected = new Set(initialValues)
    let rendered = false
    const render = () => {
      if (rendered) this.output.write(`\u001b[${options.length + 2}A\r\u001b[J`)
      this.output.write(`${label}\n`)
      options.forEach((option, index) => {
        const pointer = index === cursor ? '>' : ' '
        const marker = selected.has(option.value) ? '[x]' : '[ ]'
        const text = index === cursor ? this.paint('focus', option.label) : option.label
        this.output.write(` ${pointer} ${marker} ${text}\n`)
      })
      this.renderKeyHints([['Up/Down', 'move'], ['Space', 'toggle'], ['A', 'all/none'], ['Enter', 'accept'], ['Esc', 'cancel']])
      rendered = true
    }
    render()
    return this.readRawKey((string, key, finish) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
      if (key.name === 'escape') return finish(null, [])
      if (key.name === 'up') cursor = (cursor - 1 + options.length) % options.length
      else if (key.name === 'down') cursor = (cursor + 1) % options.length
      else if (key.name === 'space') toggle(selected, options[cursor].value)
      else if (string.toLowerCase() === 'a') {
        if (selected.size === options.length) selected.clear()
        else options.forEach(option => selected.add(option.value))
      } else if (key.name === 'return' || key.name === 'enter') {
        if (selected.size > 0) return finish(null, options.filter(option => selected.has(option.value)).map(option => option.value))
        return
      } else return
      render()
    })
  }

  async editor (label, { initialValue = '', history = [], introLines = [] } = {}) {
    let value = Array.from(initialValue)
    let cursor = value.length
    let historyIndex = -1
    const historyValues = history.map(item => typeof item === 'string' ? item : item.request)
    const insert = text => {
      const characters = Array.from(text)
      value.splice(cursor, 0, ...characters)
      cursor += characters.length
    }
    const render = () => {
      this.clear()
      this.heading(label)
      for (const line of normalizeLines(introLines)) this.output.write(`${line}\n`)
      if (introLines.length > 0) this.separator()
      this.info('Enter submits • Shift+Enter or Ctrl+J adds a line • ↑/↓ recalls task history')
      this.output.write('\n› ')
      this.output.write(value.slice(0, cursor).join(''))
      this.output.write('\u001b[s')
      this.output.write(value.slice(cursor).join(''))
      this.output.write(`\n\nHistory ${historyIndex < 0 ? 'new' : `${historyIndex + 1}/${historyValues.length}`} | Esc cancels\n`)
      this.output.write('\u001b[u')
    }
    render()
    const result = await this.readRawKey((string, key, finish) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
      if (key.name === 'escape') return finish(null, null)
      if (key.ctrl && key.name === 'j') insert('\n')
      else if ((key.name === 'return' || key.name === 'enter') && !key.shift) {
        const request = value.join('').trim()
        if (request) return finish(null, request)
        return
      } else if ((key.name === 'return' || key.name === 'enter') && key.shift) insert('\n')
      else if (key.sequence === '\u001b[13;2u' || key.sequence === '\u001b[27;2;13~') insert('\n')
      else if (key.name === 'left' && cursor > 0) cursor--
      else if (key.name === 'right' && cursor < value.length) cursor++
      else if (key.name === 'home') cursor = 0
      else if (key.name === 'end') cursor = value.length
      else if (key.name === 'backspace' && cursor > 0) value.splice(--cursor, 1)
      else if (key.name === 'delete' && cursor < value.length) value.splice(cursor, 1)
      else if (key.name === 'up' && historyValues.length > 0) {
        historyIndex = Math.min(historyIndex + 1, historyValues.length - 1)
        value = Array.from(historyValues[historyIndex])
        cursor = value.length
      } else if (key.name === 'down' && historyIndex >= 0) {
        historyIndex--
        value = Array.from(historyIndex < 0 ? '' : historyValues[historyIndex])
        cursor = value.length
      } else if (key.name === 'tab') insert('  ')
      else if (string && !key.ctrl && !key.meta && key.name !== 'return') insert(string)
      else return
      render()
    })
    this.clear()
    return result
  }

  async secretEditor (label, { introLines = [] } = {}) {
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== 'function') {
      throw new Error('hidden multiline input requires an interactive terminal')
    }
    let value = []
    const render = () => {
      this.clear()
      this.heading(label)
      for (const line of normalizeLines(introLines)) this.output.write(`${line}\n`)
      if (introLines.length > 0) this.separator()
      this.info('Paste the complete value. Its contents remain hidden.')
      this.output.write('\nKubeconfig captured (hidden)\n\n')
      this.renderKeyHints([['Ctrl+D', 'validate and continue'], ['Esc', 'cancel']])
    }
    render()
    const result = await this.readRawKey((string, key, finish) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('interrupted'))
      if (key.name === 'escape') return finish(null, null)
      if (key.ctrl && key.name === 'd') {
        const secret = value.join('').trim()
        if (secret) return finish(null, secret)
        return
      }
      if (key.name === 'backspace' && value.length > 0) value.pop()
      else if (string && !key.meta) value.push(...Array.from(string))
    })
    value.fill('\0')
    value = []
    this.clear()
    return result
  }

  readRawKey (onKeypress) {
    emitKeypressEvents(this.input)
    const inputState = this.captureInputState()
    this.input.setRawMode(true)
    this.input.resume()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        this.rawReaders.delete(finish)
        this.input.off('keypress', handle)
        this.restoreInputState(inputState)
        if (error) reject(error)
        else resolve(value)
      }
      const handle = (string, key = {}) => {
        try {
          onKeypress(string ?? '', key, finish)
        } catch (error) {
          finish(error)
        }
      }
      this.rawReaders.add(finish)
      this.input.on('keypress', handle)
    })
  }

  async withTerminalSuspended (operation) {
    if (typeof operation !== 'function') throw new TypeError('terminal operation must be a function')
    for (const finish of [...this.rawReaders]) finish(new Error('terminal input suspended'))
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(false)
    if (typeof this.input.pause === 'function') this.input.pause()
    try {
      return await operation()
    } finally {
      if (typeof this.input.setRawMode === 'function') this.input.setRawMode(false)
      if (typeof this.input.pause === 'function') this.input.pause()
    }
  }

  captureInputState () {
    return {
      isRaw: Boolean(this.input.isRaw),
      isPaused: typeof this.input.isPaused === 'function' ? this.input.isPaused() : undefined
    }
  }

  restoreInputState ({ isRaw, isPaused }) {
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(isRaw)
    if (isPaused === false && typeof this.input.resume === 'function') this.input.resume()
    else if (typeof this.input.pause === 'function') this.input.pause()
  }

  dispose () {
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(false)
    if (typeof this.input.pause === 'function') this.input.pause()
  }

  async pause () {
    await this.ask('Press Enter to continue', { required: false })
  }

  styled (value, style = null) {
    return styledValue(value, style)
  }

  styleToken (value, token, style, baseStyle = null) {
    return {
      text: styledText(value),
      style: baseStyle,
      format: text => paintToken(this, text, token, style, baseStyle)
    }
  }

  styleTokens (value, tokens) {
    return {
      text: styledText(value),
      format: text => tokens.reduce((rendered, token) => paintPlainToken(this, rendered, token.text, token.style), text)
    }
  }

  paneTitle (title, current = false) {
    const text = `${title}${current ? ' [current]' : ''}`
    return current ? this.styleToken(text, '[current]', 'focus', 'section') : this.styled(text, 'section')
  }

  statusStyle (value) {
    return semanticStatusStyle(value)
  }

  semanticValueStyle (label, value) {
    const normalizedLabel = String(label ?? '').toLocaleLowerCase()
    const normalizedValue = String(value ?? '').toLocaleLowerCase()
    if (normalizedLabel === 'root required') return normalizedValue === 'yes' ? 'warning' : 'muted'
    if (normalizedLabel.includes('privilege') || normalizedLabel === 'remote user') {
      if (['no', 'unknown'].includes(normalizedValue) || normalizedValue.includes('standard user')) return 'muted'
      if (/root|administrator|sudo|doas/u.test(normalizedValue)) return 'warning'
    }
    if (normalizedLabel.includes('risk')) return riskStyle(normalizedValue)
    if (normalizedLabel.includes('confirmation')) return normalizedValue.includes('required') && !normalizedValue.includes('not') ? 'warning' : 'muted'
    if (normalizedLabel.includes('error')) return 'error'
    if (normalizedLabel.includes('docker') || normalizedLabel.includes('netdata') || normalizedLabel.includes('plugin') || normalizedLabel.includes('stage 2') || normalizedLabel.includes('status') || normalizedLabel.includes('runtime') || normalizedLabel === 'ssh' || normalizedLabel === 'curl' || normalizedLabel.includes('decision')) {
      return semanticStatusStyle(normalizedValue)
    }
    return null
  }

  detailLines (values) {
    return normalizeLines(values).map(line => {
      const separator = line.indexOf(':')
      if (separator < 0) return this.styled(line)
      const label = line.slice(0, separator + 1)
      const value = line.slice(separator + 1).trimStart()
      const valueStyle = this.semanticValueStyle(label.slice(0, -1), value)
      return {
        text: line,
        format: final => {
          const boundary = final.indexOf(':')
          if (boundary < 0) return final
          const finalLabel = final.slice(0, boundary + 1)
          const finalValue = final.slice(boundary + 1)
          return `${this.paint('muted', finalLabel)}${valueStyle ? this.paint(valueStyle, finalValue) : finalValue}`
        }
      }
    })
  }

  keyHintLines (hints, width = this.terminalSize().width) {
    const pairs = (Array.isArray(hints) ? hints : [hints]).map(normalizeHint).filter(hint => hint.key || hint.label)
    return wrapHints(pairs, Math.max(1, width)).map(line => line.map(hint => [this.paint('key', hint.key), hint.label].filter(Boolean).join(' ')).join(this.paint('separator', ' | ')))
  }

  wrapStyled (descriptor, width) {
    return this.wrapText(descriptor.text, width).map(text => ({ ...descriptor, text }))
  }

  renderStyled (descriptor, text = descriptor.text) {
    if (typeof descriptor.format === 'function' && this.color) return descriptor.format(text)
    return descriptor.style ? this.paint(descriptor.style, text) : text
  }

  paint (tone, text) {
    const value = String(text)
    const code = ANSI_STYLES[tone]
    if (!this.color || !code || value === '') return value
    return `\u001b[${code}m${value}\u001b[0m`
  }
}

function toggle (values, value) {
  if (values.has(value)) values.delete(value)
  else values.add(value)
}

function normalizeLines (value) {
  if (Array.isArray(value)) return value.flatMap(item => normalizeLines(item))
  if (value === null || value === undefined) return ['']
  return String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
}

function normalizeStyledLines (value) {
  if (Array.isArray(value)) return value.flatMap(item => normalizeStyledLines(item))
  const descriptor = styledValue(value)
  return descriptor.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').map(text => ({ ...descriptor, text }))
}

function styledValue (value, fallbackStyle = null) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'text')) {
    return { ...value, text: styledText(value), style: value.style ?? fallbackStyle }
  }
  return { text: styledText(value), style: fallbackStyle }
}

function styledText (value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'text')) return String(value.text ?? '')
  return value === null || value === undefined ? '' : String(value)
}

function normalizeHint (hint) {
  if (Array.isArray(hint)) return { key: String(hint[0] ?? ''), label: String(hint[1] ?? '') }
  if (hint && typeof hint === 'object') return { key: String(hint.key ?? ''), label: String(hint.label ?? '') }
  const text = String(hint ?? '').trim()
  const space = text.indexOf(' ')
  return space < 0 ? { key: text, label: '' } : { key: text.slice(0, space), label: text.slice(space + 1) }
}

function wrapHints (hints, width) {
  const lines = []
  let current = []
  let currentWidth = 0
  for (const hint of hints) {
    const hintWidth = Array.from([hint.key, hint.label].filter(Boolean).join(' ')).length
    const added = current.length === 0 ? hintWidth : hintWidth + 3
    if (current.length > 0 && currentWidth + added > width) {
      lines.push(current)
      current = []
      currentWidth = 0
    }
    current.push(hint)
    currentWidth += current.length === 1 ? hintWidth : hintWidth + 3
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : [[]]
}

function paintToken (ui, text, token, style, baseStyle) {
  const index = text.indexOf(token)
  if (index < 0) return baseStyle ? ui.paint(baseStyle, text) : text
  const before = text.slice(0, index)
  const match = text.slice(index, index + token.length)
  const after = text.slice(index + token.length)
  const base = value => baseStyle ? ui.paint(baseStyle, value) : value
  return `${base(before)}${ui.paint(style, match)}${base(after)}`
}

function paintPlainToken (ui, text, token, style) {
  const index = text.indexOf(token)
  if (index < 0) return text
  return `${text.slice(0, index)}${ui.paint(style, token)}${text.slice(index + token.length)}`
}

function semanticStatusStyle (value) {
  const text = String(value ?? '').toLocaleLowerCase().replaceAll('_', ' ')
  if (/revert failed|failed|error/u.test(text)) return 'error'
  if (/not probed|unknown/u.test(text)) return 'muted'
  if (/connecting|running|planning|consulting|updating|informed planning/u.test(text)) return 'info'
  if (/inactive|pending|partial|unavailable|missing|not installed|outdated|cancelled|skipped|ordinary planning|disabled/u.test(text)) return 'warning'
  if (/active|connected|completed|current|ready|installed|available|healthy|verified task|online|preferred/u.test(text)) return 'success'
  return null
}

function riskStyle (value) {
  const text = String(value ?? '').toLocaleLowerCase()
  if (text === 'critical' || text === 'high' || text === 'destructive') return 'danger'
  if (text === 'medium' || text === 'change') return 'warning'
  if (text === 'low' || text === 'read') return 'success'
  return null
}

function supportsColor ({ output, env, color }) {
  if (!output?.isTTY || Object.hasOwn(env ?? {}, 'NO_COLOR')) return false
  if (String(env?.TERM ?? '').toLocaleLowerCase() === 'dumb') return false
  if (color !== undefined) return Boolean(color)
  if (typeof output.getColorDepth === 'function') return output.getColorDepth() >= 4
  if (typeof output.hasColors === 'function') return output.hasColors()
  return false
}

function wrapLine (line, width) {
  if (line === '') return ['']
  const words = line.trim().split(/\s+/u)
  const lines = []
  let current = ''
  for (const word of words) {
    const chunks = chunkText(word, width)
    for (const chunk of chunks) {
      if (!current) current = chunk
      else if (Array.from(current).length + 1 + Array.from(chunk).length <= width) current = `${current} ${chunk}`
      else {
        lines.push(current)
        current = chunk
      }
      if (Array.from(current).length === width) {
        lines.push(current)
        current = ''
      }
    }
  }
  if (current || lines.length === 0) lines.push(current)
  return lines
}

function chunkText (value, width) {
  const characters = Array.from(value)
  if (characters.length === 0) return ['']
  const chunks = []
  for (let index = 0; index < characters.length; index += width) chunks.push(characters.slice(index, index + width).join(''))
  return chunks
}

function calculateWidths (columns, totalWidth, joinerWidth, minimumWidth) {
  const available = totalWidth - joinerWidth * (columns.length - 1)
  if (available < columns.length * minimumWidth) return null
  const widths = columns.map(column => Number.isInteger(column.width) && column.width > 0 ? column.width : null)
  const fixed = widths.reduce((sum, width) => sum + (width ?? 0), 0)
  const flexible = widths.filter(width => width === null).length
  if (fixed + flexible * minimumWidth > available) return null
  let remaining = available - fixed
  for (let index = 0; index < widths.length; index++) {
    if (widths[index] !== null) continue
    const remainingFlexible = widths.slice(index).filter(width => width === null).length
    widths[index] = Math.max(minimumWidth, Math.floor(remaining / remainingFlexible))
    remaining -= widths[index]
  }
  const used = widths.reduce((sum, width) => sum + width, 0)
  widths[widths.length - 1] += available - used
  return widths
}

function compactWidths (columnCount, totalWidth, joinerWidth) {
  const available = Math.max(0, totalWidth - joinerWidth * (columnCount - 1))
  const base = Math.floor(available / columnCount)
  const widths = Array.from({ length: columnCount }, () => base)
  for (let index = 0; index < available - base * columnCount; index++) widths[index]++
  return widths
}
