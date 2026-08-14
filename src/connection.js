const SAFE_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._\\/-]{0,254}$/

/**
 * @param {string} connectionUrl
 * @returns {import('./public-api-contracts.js').SshConnection}
 */
export function parseSshConnection (connectionUrl) {
  const url = new URL(connectionUrl)
  if (url.protocol !== 'ssh:') throw new TypeError('connection URL must use ssh://')
  if (!url.hostname) throw new TypeError('connection URL requires a host')
  if (url.password) throw new TypeError('passwords are not supported by non-interactive system SSH')
  if (url.pathname && url.pathname !== '/') {
    throw new TypeError('connection URL must not contain a path; encode a username slash as %2F or paste an ssh command')
  }

  const username = decodeURIComponent(url.username)
  if (username && !SAFE_USERNAME.test(username)) {
    throw new TypeError('connection URL contains an invalid SSH username')
  }

  const port = url.port ? Number.parseInt(url.port, 10) : 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('connection URL contains an invalid port')
  }

  return {
    host: url.hostname,
    username,
    port,
    identityFile: cleanPath(url.searchParams.get('identity')),
    configFile: cleanPath(url.searchParams.get('config'))
  }
}

/**
 * @param {import('./public-api-contracts.js').SshConnection} connection
 * @returns {string}
 */
export function sshTarget (connection) {
  return connection.username
    ? `${connection.username}@${connection.host}`
    : connection.host
}

function cleanPath (value) {
  if (value === null || value === '') return undefined
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new TypeError('SSH path option contains an invalid character')
  }
  if (!value.startsWith('/')) throw new TypeError('SSH path option must be absolute')
  return value
}
