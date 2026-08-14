const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/
const ROOM_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALUE = "([^\\s'\"\\\\;]+)"

export function parseClaimingInput (input) {
  if (typeof input !== 'string' || input.length > 256 * 1024) throw new TypeError('claiming input must be text no larger than 256 KiB')
  const text = input.trim()
  const urlDetails = parseDetailsUrl(text)
  const claimToken = uniqueValue('claim token', [
    ...matches(text, new RegExp(`--claim-token(?:=|\\s+)${VALUE}`, 'gi')),
    ...matches(text, new RegExp(`(?:NETDATA_CLAIM_TOKEN|TOKEN)=${VALUE}`, 'gi')),
    ...matches(text, new RegExp(`(?:parent|child)\\.claiming\\.token=${VALUE}`, 'gi')),
    ...matches(text, /^\s*token\s*:\s*([^\s#]+)\s*$/gim),
    ...matches(text, /Claim Token\s*\r?\n\s*([^\s]+)/gi),
    urlDetails.claimToken,
    TOKEN_PATTERN.test(text) ? text : null
  ])
  const claimUrl = uniqueValue('claim URL', [
    ...matches(text, new RegExp(`--claim-url(?:=|\\s+)${VALUE}`, 'gi')),
    ...matches(text, new RegExp(`NETDATA_CLAIM_URL=${VALUE}`, 'gi')),
    ...matches(text, /Claim URL\s*\r?\n\s*([^\s]+)/gi),
    urlDetails.claimUrl
  ])
  const roomIds = uniqueValue('room IDs', [
    ...matches(text, new RegExp(`--claim-rooms(?:=|\\s+)${VALUE}`, 'gi')),
    ...matches(text, new RegExp(`(?:NETDATA_CLAIM_ROOMS|ROOMS)=${VALUE}`, 'gi')),
    ...matches(text, new RegExp(`(?:parent|child)\\.claiming\\.rooms=${VALUE}`, 'gi')),
    ...matches(text, /^\s*rooms\s*:\s*([^\s#]+)\s*$/gim),
    ...matches(text, /Room IDs?\s*\r?\n\s*([^\s]+)/gi),
    urlDetails.roomIds
  ].map(normalizeRooms))
  return {
    claimToken,
    claimUrl,
    roomIds,
    missing: [
      !claimToken && 'claim token',
      !claimUrl && 'claim URL',
      !roomIds && 'room IDs'
    ].filter(Boolean)
  }
}

export function validateClaimDetails ({ claimToken, claimUrl, roomIds }) {
  if (typeof claimToken !== 'string' || !TOKEN_PATTERN.test(claimToken)) throw new TypeError('claim token has an invalid format')
  if (typeof claimUrl !== 'string' || claimUrl.length > 2048 || /[\0\r\n]/.test(claimUrl)) throw new TypeError('claim URL has an invalid format')
  let parsed
  try {
    parsed = new URL(claimUrl)
  } catch {
    throw new TypeError('claim URL must be a valid HTTPS URL')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('claim URL must be HTTPS and must not contain credentials, query parameters, or a fragment')
  }
  const normalizedRooms = normalizeRooms(roomIds)
  const rooms = normalizedRooms?.split(',') ?? []
  if (rooms.length === 0 || !rooms.every(room => ROOM_PATTERN.test(room))) throw new TypeError('room IDs must be comma-separated UUIDs')
  return {
    claimToken,
    claimUrl: parsed.toString().replace(/\/$/, ''),
    roomIds: rooms.join(',')
  }
}

function matches (text, pattern) {
  return [...text.matchAll(pattern)].map(match => clean(match[1])).filter(Boolean)
}

function uniqueValue (label, values) {
  const unique = [...new Set(values.filter(Boolean).map(clean))]
  if (unique.length > 1) throw new Error(`pasted claiming data contains conflicting ${label} values`)
  return unique[0] ?? null
}

function clean (value) {
  return typeof value === 'string' ? value.trim().replace(/^['"]|['"]$/g, '') : null
}

function normalizeRooms (value) {
  if (!value) return null
  return clean(value).split(/[\s,]+/).filter(Boolean).join(',')
}

function parseDetailsUrl (text) {
  try {
    const url = new URL(text)
    return {
      claimToken: url.searchParams.get('claim-token') ?? url.searchParams.get('claim_token') ?? url.searchParams.get('token'),
      claimUrl: url.searchParams.get('claim-url') ?? url.searchParams.get('claim_url'),
      roomIds: url.searchParams.get('claim-rooms') ?? url.searchParams.get('claim_rooms') ?? url.searchParams.get('rooms')
    }
  } catch {
    return {}
  }
}
