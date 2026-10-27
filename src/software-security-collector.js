const roots = ['/app', '/usr/src/app', '/usr/local/lib/node_modules/n8n', '/opt/webminai-n8n-18109', '/var/lib/ghost/current', '/opt/webminai-ghost-18110/current', 'C:/ProgramData/IntentAIOps/Cli/npm/node_modules/intent-ai-ops']
const names = ['next', 'react-server-dom-webpack', 'react-server-dom-parcel', 'react-server-dom-turbopack']
const nodeProbe = `const fs=require('node:fs');const path=require('node:path');for(const root of ${JSON.stringify(roots)})for(const name of ${JSON.stringify(names)}){try{const file=path.join(root,'node_modules',name,'package.json');if(fs.statSync(file).size>262144)continue;const p=JSON.parse(fs.readFileSync(file,'utf8'));if(p.name===name&&typeof p.version==='string'&&/^[0-9][A-Za-z0-9.+~_-]{0,95}$/.test(p.version))console.log('INTENT_SECURITY_NPM runtime '+name+' '+p.version)}catch{}}`
const nodeArgument = `eval(Buffer.from('${Buffer.from(nodeProbe).toString('base64')}','base64').toString())`
const projects = { wordpress: 18101, woocommerce: 18102, joomla: 18103, drupal: 18104, prestashop: 18105, moodle: 18106, magento: 18108, n8n: 18109, ghost: 18110, mattermost: 18111, odoo: 18112, jellyfin: 18113, 'home-assistant': 18115 }

export function softwareSecurityCommand (platform, application) {
  if (!['linux', 'freebsd', 'macos', 'windows'].includes(platform)) throw new Error('Unsupported software security collector platform')
  const project = Object.hasOwn(projects, application) ? `webminai-${application}-${projects[application]}` : null
  if (platform === 'windows') {
    return [
      "$ErrorActionPreference='Stop'",
      "function Read-SecurityProcess($file,$arguments){$stdout=[IO.Path]::GetTempFileName();$stderr=[IO.Path]::GetTempFileName();try{$quoted=@($arguments|ForEach-Object{$v=[string]$_;if($v -match '[\\s\"]'){'\"'+$v.Replace('\"','\\\"')+'\"'}else{$v}});$process=Start-Process -FilePath $file -ArgumentList $quoted -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr;$null=$process.Handle;if(-not $process.WaitForExit(3000)){$process.Kill();return};if($process.ExitCode -ne 0 -or (Get-Item -LiteralPath $stdout).Length -gt 32768){return};Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue}finally{Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue}}",
      "$php=Get-Command php.exe -ErrorAction SilentlyContinue;if($php){$v=Read-SecurityProcess $php.Source @('-n','-r','echo PHP_VERSION;');if($v -match '^[0-9][A-Za-z0-9.+~_-]{0,95}$'){Write-Output ('INTENT_SECURITY_PHP host-cli '+$v)}}",
      `$node=Get-Command node.exe -ErrorAction SilentlyContinue;if($node){$env:NODE_OPTIONS='';$env:NODE_PATH='';Read-SecurityProcess $node.Source @('-e','${nodeArgument.replaceAll("'", "''")}')}`,
      ...(project
        ? [
          `try{$docker=Get-Command docker.exe -ErrorAction SilentlyContinue;$exe=if($docker){$docker.Source}else{Join-Path $env:ProgramFiles 'Docker\\Docker\\resources\\bin\\docker.exe'};$ids=@(Read-SecurityProcess $exe @('ps','--filter','label=com.docker.compose.project=${project}','--format','{{.ID}}'));foreach($id in ($ids|Select-Object -First 8)){if($id -notmatch '^[a-f0-9]{12,64}$'){continue};try{$v=Read-SecurityProcess $exe @('exec',$id,'php','-n','-r','echo PHP_VERSION;');if($v -match '^[0-9][A-Za-z0-9.+~_-]{0,95}$'){Write-Output ('INTENT_SECURITY_PHP container-'+$id+' '+$v)}}catch{};try{Read-SecurityProcess $exe @('exec','-e','NODE_OPTIONS=','-e','NODE_PATH=',$id,'node','-e','${nodeArgument.replaceAll("'", "''")}')}catch{}}}catch{Write-Output 'INTENT_SECURITY_UNAVAILABLE managed-containers'}`
          ]
        : []),
      "Write-Output 'INTENT_SECURITY_END';exit 0"
    ].join(';')
  }
  return [
    'set -u',
    "for php in php php82 php83 php84 php85; do if command -v \"$php\" >/dev/null 2>&1; then version=$(\"$php\" -n -r 'echo PHP_VERSION;' 2>/dev/null) || continue; printf 'INTENT_SECURITY_PHP host-cli-%s %s\\n' \"$php\" \"$version\"; fi; done",
    `if command -v node >/dev/null 2>&1; then NODE_OPTIONS= NODE_PATH= node -e ${quote(nodeArgument)} 2>/dev/null || :; fi`,
    ...(project
      ? [
      `for engine in ${platform === 'freebsd' ? 'podman' : 'docker podman'}; do command -v "$engine" >/dev/null 2>&1 || continue`,
      `"$engine" ps --filter ${quote(`label=com.docker.compose.project=${project}`)} --format '{{.ID}}' 2>/dev/null | head -n 8 | while IFS= read -r id; do`,
      'case "$id" in \'\'|*[!a-f0-9]*) continue;; esac; [ "$' + '{#id}" -ge 12 ] && [ "$' + '{#id}" -le 64 ] || continue',
      'version=$("$engine" exec "$id" php -n -r \'echo PHP_VERSION;\' 2>/dev/null) && printf \'INTENT_SECURITY_PHP container-%s %s\\n\' "$id" "$version"',
      `"$engine" exec -e NODE_OPTIONS= -e NODE_PATH= "$id" node -e ${quote(nodeArgument)} 2>/dev/null || :`,
      'done; done'
        ]
      : []),
    "printf '%s\\n' INTENT_SECURITY_END"
  ].join('\n')
}

export function withSoftwareSecurity (plan, { platform, catalogId, commandId = 'audit-software-security' }) {
  if (!/^audit-software-security(?:-[a-f0-9]{12})?$/u.test(commandId) || plan.commands.some(command => command.id === commandId)) throw new Error('Security collector requires a unique validated command ID')
  const application = catalogId.slice(0, -(platform.length + 1))
  return {
    ...plan,
    warnings: [...(plan.warnings ?? []), 'Security checks cover tracked PHP/Next.js/RSC advisories only. An unknown runtime or a successful install is not a security clearance; inspect the completion recommendations.'],
    commands: [...plan.commands, {
      id: commandId,
      phase: 'verify',
      command: softwareSecurityCommand(platform, application),
      purpose: 'Collect bounded PHP and resolved Next.js/RSC version evidence without exploit requests, upgrades or source changes; unavailable checks remain unknown.',
      risk: 'read',
      timeoutMs: 60000,
      requiresSudo: true,
      dependsOn: plan.commands.map(command => command.id)
    }]
  }
}

function quote (value) { return "'" + value.replaceAll("'", "'\\''") + "'" }
