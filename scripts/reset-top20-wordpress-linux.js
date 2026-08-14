#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { NetdataClient } from '../src/netdata-client.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { TaskStore } from '../src/task-store.js'

const HOSTS = [
  'webminai-almalinux-9',
  'webminai-alpine-323',
  'webminai-arch',
  'webminai-debian-13',
  'webminai-fedora-44',
  'webminai-opensuse-160',
  'webminai-oracle-9',
  'webminai-rocky-9',
  'webminai-ubuntu-2404'
]

if (!process.argv.includes('--confirm-reset-wordpress')) {
  throw new Error('refusing destructive lab cleanup without --confirm-reset-wordpress')
}
if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const taskStore = new TaskStore(dataRoot)
const settings = await settingsStore.load()
const ssh = new SystemSsh()
let nextHost = 0
let failed = false

async function resetWorker () {
  while (nextHost < HOSTS.length) {
    const serverId = HOSTS[nextHost++]
    try {
      const taskIds = taskStore.list(serverId, { limit: 100 })
        .filter(task => /\bwordpress\b/iu.test(task.request))
        .map(task => task.id)
      const databaseNames = wordpressDatabaseNames(serverId, taskIds)
      const server = await settingsStore.decryptServer({
        settings,
        passphrase: process.env.VAULT_TEST,
        serverId
      })
      const netdata = new NetdataClient({ ssh, connectionUrl: server.connectionUrl, actionKey: server.actionKey })
      const command = cleanupCommand({ taskIds, databaseNames })
      const result = await netdata.runCommand(command, { timeoutSeconds: 300 })
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cleanup exit ${result.exitCode}`)
      process.stdout.write(`${serverId}: ${result.stdout.trim()}\n`)
    } catch (error) {
      failed = true
      process.stderr.write(`${serverId}: ${String(error.message).split('\n')[0]}\n`)
    }
  }
}

await Promise.all([resetWorker(), resetWorker(), resetWorker()])
if (failed) process.exitCode = 1

function wordpressDatabaseNames (serverId, taskIds) {
  const names = new Set()
  for (const taskId of taskIds) {
    const task = taskStore.get(serverId, taskId)
    for (const item of [...(task.plan?.commands ?? []), ...(task.plan?.revertCommands ?? [])]) {
      for (const match of item.command.matchAll(/(?:DATABASE|USER)(?: IF (?:NOT )?EXISTS)?\s+[`'"]?([A-Za-z][A-Za-z0-9_-]{2,63})/giu)) {
        if (/wordpress|webminai.*wp|wp.*webminai/iu.test(match[1])) names.add(match[1])
      }
    }
  }
  return [...names]
}

function cleanupCommand ({ taskIds, databaseNames }) {
  const sql = databaseNames.map(name => [
    `DROP DATABASE IF EXISTS \`${name}\``,
    `DROP USER IF EXISTS '${name}'@'localhost'`,
    `DROP USER IF EXISTS '${name}'@'127.0.0.1'`,
    `DROP USER IF EXISTS '${name}'@'%'`
  ].join('; ')).join('; ')
  const encodedSql = Buffer.from(`${sql};`, 'utf8').toString('base64')
  const statePaths = taskIds.flatMap(taskId => [
    `/var/lib/webminai/task-state/${taskId}`,
    `/var/lib/webminai/task-state/${taskId}.exists`
  ]).map(shellQuote).join(' ')
  return [
    'set +e',
    'cleanup_log=/tmp/webminai-wordpress-reset.$$; trap \'rm -f -- "$cleanup_log"\' EXIT',
    'if command -v systemctl >/dev/null 2>&1; then systemctl start mariadb >/dev/null 2>&1 || systemctl start mysql >/dev/null 2>&1 || true; elif command -v rc-service >/dev/null 2>&1; then rc-service mariadb start >/dev/null 2>&1 || true; else service mysql start >/dev/null 2>&1 || service mariadb start >/dev/null 2>&1 || true; fi',
    `printf '%s' ${shellQuote(encodedSql)} | base64 -d | if command -v mariadb >/dev/null 2>&1; then mariadb >/dev/null 2>"$cleanup_log" || true; elif command -v mysql >/dev/null 2>&1; then mysql >/dev/null 2>"$cleanup_log" || true; else cat >/dev/null; fi`,
    'if command -v systemctl >/dev/null 2>&1; then systemctl disable --now nginx httpd apache2 php-fpm php8.4-fpm php8.3-fpm mariadb mysql >/dev/null 2>&1 || true; elif command -v rc-service >/dev/null 2>&1; then for service_name in nginx apache2 php-fpm83 mariadb; do rc-service "$service_name" stop >/dev/null 2>&1 || true; rc-update del "$service_name" default >/dev/null 2>&1 || true; done; fi',
    'for signal_name in TERM KILL; do for process_name in mariadbd mysqld nginx php-fpm php-fpm83 php-fpm8; do for comm_path in /proc/[0-9]*/comm; do [ -r "$comm_path" ] || continue; IFS= read -r running_name < "$comm_path" || continue; [ "$running_name" = "$process_name" ] || continue; process_id=' + '$' + '{comm_path#/proc/}' + '; process_id=' + '$' + '{process_id%/comm}' + '; kill -s "$signal_name" "$process_id" >/dev/null 2>&1 || true; done; done; [ "$signal_name" = TERM ] && sleep 1; done',
    'rm -rf -- /root/wordpress_credentials /root/webminai_wordpress_credentials',
    'for task_path in /var/www/*wordpress* /srv/*wordpress* /srv/www/*wordpress* /srv/http/*wordpress* /var/lib/webminai/*wordpress* /etc/nginx/conf.d/*webminai* /etc/nginx/http.d/*webminai* /etc/nginx/sites-available/*webminai* /etc/nginx/sites-enabled/*webminai* /etc/nginx/vhosts.d/*webminai* /etc/httpd/conf.d/*webminai* /etc/apache2/sites-available/*webminai* /etc/apache2/sites-enabled/*webminai* /etc/php/*/fpm/pool.d/*webminai-wordpress* /etc/php*/fpm/php-fpm.d/*webminai-wordpress* /etc/php*/php-fpm.d/*webminai-wordpress* /etc/php/php-fpm.d/*webminai-wordpress* /etc/php-fpm.d/*webminai-wordpress* /etc/systemd/system/*php*fpm*.service.d/*webminai-wordpress*; do [ -e "$task_path" ] && rm -rf -- "$task_path"; done',
    statePaths ? `rm -rf -- ${statePaths}` : ':',
    packageCleanupCommand(),
    'package_status=$?',
    'rm -rf -- /var/lib/mysql /var/log/mysql /var/log/mariadb /run/mysqld /run/mariadb',
    restoreCurlCommand(),
    'printf \'reset=%s curl=%s\\n\' "$(if [ "$package_status" -eq 0 ]; then echo complete; else echo package-failed; fi)" "$(command -v curl >/dev/null 2>&1 && echo present || echo missing)"',
    'exit "$package_status"'
  ].join('; ')
}

function packageCleanupCommand () {
  return 'packages=; if command -v dpkg-query >/dev/null 2>&1; then packages=$(dpkg-query -W 2>/dev/null | awk \'{print $1}\' | grep -E \'^(nginx|apache2|mariadb|mysql|php)\' | tr \'\\n\' \' \'); [ -z "$packages" ] || env DEBIAN_FRONTEND=noninteractive apt-get purge -y $packages >"$cleanup_log" 2>&1; elif command -v apk >/dev/null 2>&1; then packages=$(apk info 2>/dev/null | grep -E \'^(nginx|apache2|mariadb|mysql|php)\' | tr \'\\n\' \' \'); [ -z "$packages" ] || apk del $packages >"$cleanup_log" 2>&1; elif command -v pacman >/dev/null 2>&1; then packages=$(pacman -Qq 2>/dev/null | grep -E \'^(nginx|apache|mariadb|mysql|php)\' | tr \'\\n\' \' \'); [ -z "$packages" ] || pacman -Rns --noconfirm $packages >"$cleanup_log" 2>&1; elif command -v zypper >/dev/null 2>&1; then packages=$(rpm -qa --qf \'%{NAME}\\n\' 2>/dev/null | grep -E \'^(nginx|apache2|mariadb|mysql|php)\' | tr \'\\n\' \' \'); [ -z "$packages" ] || zypper --non-interactive remove --clean-deps $packages >"$cleanup_log" 2>&1; elif command -v dnf >/dev/null 2>&1; then packages=$(rpm -qa --qf \'%{NAME}\\n\' 2>/dev/null | grep -E \'^(nginx|httpd|mariadb|mysql|php)\' | tr \'\\n\' \' \'); [ -z "$packages" ] || dnf -y remove $packages >"$cleanup_log" 2>&1; elif command -v yum >/dev/null 2>&1; then packages=$(rpm -qa --qf \'%{NAME}\\n\' 2>/dev/null | grep -E \'^(nginx|httpd|mariadb|mysql|php)\' | tr \'\\n\' \' \'); [ -z "$packages" ] || yum -y remove $packages >"$cleanup_log" 2>&1; fi'
}

function restoreCurlCommand () {
  return 'if ! command -v curl >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then env DEBIAN_FRONTEND=noninteractive apt-get install -y curl >"$cleanup_log" 2>&1; elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl >"$cleanup_log" 2>&1; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed curl >"$cleanup_log" 2>&1; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install --no-recommends curl >"$cleanup_log" 2>&1; elif command -v dnf >/dev/null 2>&1; then dnf -y install curl >"$cleanup_log" 2>&1; elif command -v yum >/dev/null 2>&1; then yum -y install curl >"$cleanup_log" 2>&1; fi; fi'
}

function shellQuote (value) {
  const quote = String.fromCodePoint(39)
  return quote + String(value).replaceAll(quote, `${quote}"${quote}"${quote}`) + quote
}
