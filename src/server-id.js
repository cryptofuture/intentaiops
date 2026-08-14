import path from 'node:path'

const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/

export function validateServerId (serverId) {
  if (typeof serverId !== 'string' || !SERVER_ID.test(serverId)) {
    throw new TypeError('server id must match ^[a-z0-9][a-z0-9_-]{0,62}$')
  }

  return serverId
}

export function resolveServerDirectory (dataRoot, serverId) {
  validateServerId(serverId)

  const root = path.resolve(dataRoot)
  const directory = path.resolve(root, serverId)
  if (path.dirname(directory) !== root) {
    throw new Error('server directory escapes the data root')
  }

  return directory
}
