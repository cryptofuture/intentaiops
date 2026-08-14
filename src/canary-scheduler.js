const FAMILY_ORDER = ['debian', 'rpm', 'alpine', 'arch', 'suse']

export function buildValidationStages ({ hosts, applicationId, scorecard }) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new TypeError('validation scheduling requires hosts')
  if (new Set(hosts.map(host => host.serverId)).size !== hosts.length) throw new TypeError('validation hosts must be unique')
  const observations = scorecard?.informationByHost({ applicationId }) ?? []
  const history = new Map(observations.map(item => [item.serverId, item]))
  const ranked = [...hosts].sort((left, right) => informationScore(right, history) - informationScore(left, history) || left.serverId.localeCompare(right.serverId))
  const canary = ranked[0]
  const selected = new Set([canary.serverId])
  const representatives = []
  for (const family of FAMILY_ORDER) {
    const host = ranked.find(item => item.family === family && !selected.has(item.serverId))
    if (host) {
      representatives.push(host)
      selected.add(host.serverId)
    }
  }
  const remaining = ranked.filter(host => !selected.has(host.serverId))
  return [
    { id: 'canary', purpose: 'highest information-value host', hosts: [canary] },
    { id: 'package-families', purpose: 'one additional host from each package family', hosts: representatives },
    { id: 'all-remaining', purpose: 'remaining validated Linux fleet', hosts: remaining }
  ].filter(stage => stage.hosts.length > 0)
}

function informationScore (host, history) {
  const observed = history.get(host.serverId)
  if (!observed) return 1000 + familyNovelty(host.family)
  return Number(observed.failures) * 2000 + Number(observed.distinctFailures) * 250 - Number(observed.observations)
}

function familyNovelty (family) {
  const index = FAMILY_ORDER.indexOf(family)
  return index < 0 ? 0 : FAMILY_ORDER.length - index
}
