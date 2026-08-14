const commandField = document.querySelector('#install-command')
const commandText = document.querySelector('#command-text')
const installPrompt = document.querySelector('#install-prompt')
const installExplanation = document.querySelector('#install-explanation')
const copyButton = document.querySelector('#copy-command')
const quickInstallButton = document.querySelector('#quick-install')
const quickInstallLabel = quickInstallButton.querySelector('.quick-install-label')
const copyStatus = document.querySelector('#copy-status')
const platformTabs = [...document.querySelectorAll('.platform-tab')]
const platformPreview = document.querySelector('#platform-preview')
const terminalTitle = document.querySelector('#terminal-title')
const terminalSummary = document.querySelector('#terminal-summary')
const terminalSearchCount = document.querySelector('#terminal-search-count')
const terminalHosts = document.querySelector('#terminal-hosts')
const terminalDetails = document.querySelector('#terminal-details')
let feedbackTimer
let activeActionLabel = 'Quick Install'
let activeCopyLabel = 'Copy installation command'

const platformData = {
  linux: {
    label: 'Linux',
    installMode: 'command',
    actionLabel: 'Quick Install',
    installPrompt: '$',
    installCommand: 'curl -fsSL https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh | sh',
    installDescription: 'Install Intent AI Ops on Linux',
    dataDirectory: '/home/admin/.intentaiops',
    stage2: '9 active',
    hosts: [
      'prod-linux  root@prod.example.com',
      'ubuntu-2404  admin@ubuntu.example.com',
      'debian-13  admin@debian.example.com',
      'almalinux-9  ops@alma.example.com',
      'fedora-44  ops@fedora.example.com'
    ],
    details: {
      Host: 'prod-linux',
      Address: 'root@prod.example.com',
      Authentication: 'OpenSSH key',
      Persistence: 'saved',
      'Desired Stage 2': 'active',
      'Netdata ownership': 'preexisting',
      Runtime: 'connected',
      Platform: 'linux'
    }
  },
  freebsd: {
    label: 'FreeBSD',
    installMode: 'command',
    actionLabel: 'Quick Install',
    installPrompt: '$',
    installCommand: 'curl -fsSL https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh | sh',
    installDescription: 'Install Intent AI Ops on FreeBSD',
    dataDirectory: '/home/admin/.intentaiops',
    stage2: '2 active',
    hosts: [
      'freebsd-15  admin@bsd15.example.com',
      'freebsd-14  admin@bsd14.example.com'
    ],
    details: {
      Host: 'freebsd-15',
      Address: 'admin@bsd15.example.com',
      Authentication: 'OpenSSH key',
      Persistence: 'saved',
      'Desired Stage 2': 'active',
      'Runtime engine': 'Podman',
      Runtime: 'connected',
      Platform: 'freebsd'
    }
  },
  macos: {
    label: 'macOS',
    installMode: 'command',
    actionLabel: 'Quick Install',
    installPrompt: '$',
    installCommand: 'curl -fsSL https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh | sh',
    installDescription: 'Install Intent AI Ops on macOS',
    dataDirectory: '/Users/admin/.intentaiops',
    stage2: '3 active',
    hosts: [
      'mac-studio  admin@mac.example.com',
      'prod-linux  root@prod.example.com',
      'freebsd-15  admin@bsd15.example.com'
    ],
    details: {
      Host: 'mac-studio',
      Address: 'admin@mac.example.com',
      Authentication: 'OpenSSH key',
      Persistence: 'saved',
      'Desired Stage 2': 'active',
      'Container runtime': 'Colima',
      Runtime: 'connected',
      Platform: 'macos'
    }
  },
  windows: {
    label: 'Windows',
    installMode: 'command',
    actionLabel: 'Quick Install',
    installPrompt: 'PS>',
    installCommand: 'irm https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.ps1 | iex',
    installDescription: 'Install Intent AI Ops from Windows PowerShell',
    dataDirectory: 'C:\\Users\\Admin\\.intentaiops',
    stage2: '1 active',
    hosts: [
      'windows-11  DOMAIN\\admin@win.example.com'
    ],
    details: {
      Host: 'windows-11',
      Address: 'DOMAIN\\admin@win.example.com',
      Authentication: 'OpenSSH password prompt',
      Persistence: 'saved',
      'Desired Stage 2': 'active',
      'Command identity': 'LocalSystem',
      Runtime: 'connected',
      Platform: 'windows'
    }
  },
  kubernetes: {
    label: 'Kubernetes',
    installMode: 'explanation',
    installDescription: 'Add a Kubernetes cluster through its kubeconfig and activate the Stage 2 gateway.',
    installSteps: [
      'Install Intent AI Ops on your local administration computer. Select its operating-system tab for the install command.',
      'Choose Add Kubernetes cluster on the main dashboard.',
      'Enter a cluster name.',
      'Paste kubeconfig YAML, or select its local path.',
      'After the API test, confirm the save.',
      'Choose Browse Kubernetes clusters, select the cluster, then activate or update its Stage 2 gateway.'
    ],
    installNote: 'Uses the Kubernetes API directly. No SSH server or per-node plugin is required.',
    dataDirectory: '/home/admin/.intentaiops',
    stage2: '1 active',
    hosts: [
      'production-cluster  context:production',
      'kind-lab  context:kind-intentaiops'
    ],
    details: {
      Host: 'production-cluster',
      Address: 'Kubernetes API',
      Authentication: 'kubeconfig',
      Persistence: 'saved',
      'Desired Stage 2': 'active',
      Nodes: '3 ready',
      Runtime: 'connected',
      Platform: 'kubernetes'
    }
  }
}

if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 2 } })

async function copyInstallCommand () {
  const command = commandText.textContent.trim()
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(command)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = command
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.append(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      textarea.remove()
      if (!copied) throw new Error('Copy was not available')
    }
    showCopiedState()
  } catch {
    selectCommandText()
    copyStatus.textContent = 'Select and copy the highlighted installation command.'
  }
}

function showCopiedState () {
  clearTimeout(feedbackTimer)
  commandField.classList.add('is-copied')
  copyButton.classList.add('is-copied')
  quickInstallButton.classList.add('is-copied')
  copyButton.setAttribute('aria-label', 'Command copied')
  copyButton.title = 'Copied'
  quickInstallLabel.textContent = 'Copied'
  copyStatus.textContent = 'Command copied to the clipboard.'
  feedbackTimer = window.setTimeout(resetCopiedState, 1500)
}

function resetCopiedState () {
  clearTimeout(feedbackTimer)
  commandField.classList.remove('is-copied')
  copyButton.classList.remove('is-copied')
  quickInstallButton.classList.remove('is-copied')
  copyButton.setAttribute('aria-label', activeCopyLabel)
  copyButton.title = activeCopyLabel
  quickInstallLabel.textContent = activeActionLabel
  copyStatus.textContent = ''
}

function selectCommandText () {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(commandText)
  selection.removeAllRanges()
  selection.addRange(range)
  commandText.focus()
}

copyButton.addEventListener('click', copyInstallCommand)
quickInstallButton.addEventListener('click', copyInstallCommand)

function activatePlatform (platform, focusTab = false) {
  const data = platformData[platform]
  const activeTab = platformTabs.find(tab => tab.dataset.platform === platform)
  if (!data || !activeTab) return

  resetCopiedState()

  for (const tab of platformTabs) {
    const active = tab === activeTab
    tab.classList.toggle('is-active', active)
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
  }

  platformPreview.setAttribute('aria-labelledby', activeTab.id)
  const isExplanation = data.installMode === 'explanation'
  activeActionLabel = data.actionLabel ?? 'Quick Install'
  activeCopyLabel = 'Copy installation command'
  commandField.classList.toggle('is-explanation', isExplanation)
  commandField.setAttribute('role', isExplanation ? 'note' : 'group')
  commandField.setAttribute('aria-label', data.installDescription)
  commandField.title = data.installDescription
  installExplanation.hidden = !isExplanation
  renderInstallExplanation(isExplanation ? data : null)
  installPrompt.hidden = isExplanation
  commandText.hidden = isExplanation
  copyButton.hidden = isExplanation
  quickInstallButton.hidden = isExplanation
  if (!isExplanation) {
    installPrompt.textContent = data.installPrompt
    commandText.textContent = data.installCommand
    quickInstallLabel.textContent = activeActionLabel
    copyButton.setAttribute('aria-label', activeCopyLabel)
    copyButton.title = activeCopyLabel
  }
  terminalTitle.textContent = `${data.label} — Intent AI Ops`
  terminalSummary.replaceChildren(
    summaryLine('Data directory: ', data.dataDirectory),
    summaryLine('Hosts: ', `${data.hosts.length} | Stage 2 desired: `, data.stage2),
    summaryLine('Default administrator email: ', 'intentaiops@example.invalid', null, true)
  )
  terminalSearchCount.textContent = `${data.hosts.length} of ${data.hosts.length} hosts`

  terminalHosts.replaceChildren(...data.hosts.map((host, index) => {
    const line = document.createElement('p')
    line.className = `terminal-host${index === 0 ? ' terminal-selected' : ''}`
    line.textContent = `${index === 0 ? '> ' : '  '}${host}`
    return line
  }))

  terminalDetails.replaceChildren()
  terminalDetails.className = 'terminal-details'
  for (const [label, value] of Object.entries(data.details)) {
    const term = document.createElement('dt')
    const description = document.createElement('dd')
    term.textContent = `${label}:`
    description.textContent = value
    if (value === 'active' || value === 'connected') description.className = 'terminal-status'
    terminalDetails.append(term, description)
  }

  if (focusTab) activeTab.focus()
}

function renderInstallExplanation (data) {
  installExplanation.replaceChildren()
  if (!data) return
  const list = document.createElement('ol')
  for (const step of data.installSteps) {
    const item = document.createElement('li')
    item.textContent = step
    list.append(item)
  }
  const note = document.createElement('p')
  note.textContent = data.installNote
  installExplanation.append(list, note)
}

function summaryLine (label, value, status = null, warning = false) {
  const line = document.createElement('p')
  line.append(document.createTextNode(label), document.createTextNode(value))
  if (status) {
    const statusText = document.createElement('strong')
    statusText.textContent = status
    line.append(statusText)
  }
  if (warning) line.lastChild.parentNode.classList.add('terminal-warning')
  return line
}

for (const tab of platformTabs) {
  tab.addEventListener('click', () => activatePlatform(tab.dataset.platform))
  tab.addEventListener('keydown', event => {
    const current = platformTabs.indexOf(tab)
    let next = null
    if (event.key === 'ArrowRight') next = (current + 1) % platformTabs.length
    if (event.key === 'ArrowLeft') next = (current - 1 + platformTabs.length) % platformTabs.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = platformTabs.length - 1
    if (next === null) return
    event.preventDefault()
    activatePlatform(platformTabs[next].dataset.platform, true)
  })
}

activatePlatform('linux')
