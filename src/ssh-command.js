import path from 'node:path'
import { parseSshConnection } from './connection.js'

export function parseSshCommand (input) {
  const trimmed = input.trim()
  if (trimmed.startsWith('ssh://')) {
    parseSshConnection(trimmed)
    return trimmed
  }

  const tokens = tokenize(trimmed)
  if (tokens.length < 2 || path.basename(tokens.shift()) !== 'ssh') {
    throw new TypeError('enter an ssh:// URL or an ssh command')
  }

  let port = 22
  let identityFile
  let configFile
  let username
  let target

  while (tokens.length > 0) {
    const token = tokens.shift()
    if (!token.startsWith('-')) {
      target = token
      break
    }
    if (['-4', '-6'].includes(token)) continue
    if (['-p', '-i', '-F', '-l'].includes(token)) {
      const value = tokens.shift()
      if (!value) throw new TypeError(`SSH option ${token} requires a value`)
      if (token === '-p') port = parsePort(value)
      if (token === '-i') identityFile = value
      if (token === '-F') configFile = value
      if (token === '-l') username = value
      continue
    }
    throw new TypeError(`unsupported SSH option: ${token}; use ~/.ssh/config for advanced options`)
  }

  if (!target || tokens.length > 0) {
    throw new TypeError('the SSH command must contain one host and no remote command')
  }
  const separator = target.lastIndexOf('@')
  if (separator !== -1) {
    if (username) throw new TypeError('SSH username was supplied twice')
    username = target.slice(0, separator)
    target = target.slice(separator + 1)
  }
  if (!target) throw new TypeError('SSH command requires a host')

  const url = new URL('ssh://placeholder')
  url.hostname = stripIpv6Brackets(target)
  if (username) url.username = username
  if (port !== 22) url.port = String(port)
  if (identityFile) url.searchParams.set('identity', identityFile)
  if (configFile) url.searchParams.set('config', configFile)
  parseSshConnection(url.toString())
  return url.toString()
}

function tokenize (input) {
  const tokens = []
  let token = ''
  let quote = null
  let escaping = false
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (escaping) {
      token += character
      escaping = false
    } else if (character === '\\' && quote !== "'") {
      const next = input[index + 1]
      if (next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) escaping = true
      else token += character
    } else if (quote) {
      if (character === quote) quote = null
      else token += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token)
        token = ''
      }
    } else {
      token += character
    }
  }
  if (escaping || quote) throw new TypeError('SSH command has an unfinished quote or escape')
  if (token) tokens.push(token)
  return tokens
}

function parsePort (value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid SSH port')
  return port
}

function stripIpv6Brackets (host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}
