import { freebsdContainerImages } from './freebsd-php-runtime.js'
import { buildFreebsdOdooTask } from './freebsd-odoo-task.js'
import { buildFreebsdHomeAssistantTask } from './freebsd-home-assistant-task.js'
import { buildFreebsdMagentoTask } from './freebsd-magento-task.js'
import { buildFreebsdGhostTask } from './freebsd-ghost-task.js'
import { buildFreebsdN8nTask } from './freebsd-n8n-task.js'
import { buildFreebsdMattermostTask } from './freebsd-mattermost-task.js'
import { buildFreebsdJellyfinTask } from './freebsd-jellyfin-task.js'
import { freebsdInstallMissingPackages, freebsdInstallCompilerIfMissing, freebsdCompilerEnvironment, freebsdSourceCompilerEnvironment, freebsdBuildLog } from './freebsd-runtime-packages.js'

const APPLICATIONS = {
  odoo: { build: buildFreebsdOdooTask, port: 18112, subnet: 112, services: ['webminai_odoo_postgresql', 'webminai_odoo', 'nginx'], sourceBuild: 'python', ipc: true, qualified: ['14.4', '15.1'] },
  'home-assistant': { build: buildFreebsdHomeAssistantTask, port: 18115, subnet: 115, services: ['webminai_home_assistant', 'nginx'], sourceBuild: 'python', qualified: ['14.4', '15.1'] },
  magento: { build: buildFreebsdMagentoTask, port: 18108, subnet: 108, services: ['webminai_magento_mysql', 'opensearch', 'valkey', 'php_fpm', 'cron', 'nginx'], qualified: ['14.4', '15.1'] },
  ghost: { build: buildFreebsdGhostTask, port: 18110, subnet: 110, services: ['webminai_ghost_mysql', 'webminai_ghost', 'nginx'], sourceBuild: 'node', qualified: ['15.1'] },
  n8n: { build: buildFreebsdN8nTask, port: 18109, subnet: 109, services: ['webminai_n8n', 'nginx'], sourceBuild: 'node', verifyInside: true, qualified: ['14.4', '15.1'] },
  mattermost: { build: buildFreebsdMattermostTask, port: 18111, subnet: 111, services: ['postgresql', 'webminai_mattermost', 'nginx'], ipc: true, qualified: ['15.1'] },
  jellyfin: { build: buildFreebsdJellyfinTask, port: 18113, subnet: 113, services: ['jellyfin', 'nginx'], mlock: true, qualified: ['14.4', '15.1'] }
}

export function isVerifiedFreebsdPodmanApplication (application, execution) {
  const release = execution?.freebsdVersion?.match(/^([0-9]+[.][0-9]+)-RELEASE(?:-|$)/u)?.[1]
  return Boolean(Object.hasOwn(APPLICATIONS, application) && APPLICATIONS[application].qualified.includes(release) && execution?.platform === 'freebsd' && execution.architecture === 'amd64' && !execution.docker?.hostIsContainer && (execution.docker?.ready || execution.docker?.daemonReachable))
}

export function buildFreebsdPodmanApplicationTask (application, taskId, execution) {
  const profile = Object.hasOwn(APPLICATIONS, application) && APPLICATIONS[application]
  if (!profile) throw new TypeError('Unsupported FreeBSD Podman application')
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new TypeError('Invalid task identifier')
  if (execution?.platform !== 'freebsd' || execution.docker?.hostIsContainer || (!execution.docker?.ready && !execution.docker?.daemonReachable)) throw new Error('FreeBSD application requires the reviewed outer-host Podman runtime')
  if (execution.architecture !== 'amd64' || !/^(?:14[.]4-|15[.][1-9][0-9]*-)/u.test(execution.freebsdVersion ?? '')) throw new Error('FreeBSD application containers require an observed supported amd64 kernel version')
  const images = freebsdContainerImages(execution)
  const legacy = images.base === 'ghcr.io/freebsd/freebsd-runtime:14.4'
  const native = profile.build(taskId, execution)
  const state = `/var/db/webminai/podman-${taskId}-${application}`
  const name = `intentaiops-${application}-${taskId}`
  const image = `localhost/${name}:runtime`
  const address = `10.89.${profile.subnet}.3`
  const credentials = `/root/${application.replaceAll('-', '_')}_credentials`
  const identity = { state, name, image }
  const guard = ownership(identity)
  const publishedAddress = ['magento', 'ghost'].includes(application) ? 'interface=$(route -n get default | awk \'/interface:/{print $2; exit}\'); public_address=$(ifconfig "$interface" inet | awk \'/inet /{print $2; exit}\'); test -n "$public_address"; ' : ''
  const environment = ['magento', 'ghost'].includes(application) ? '--env WEBMINAI_PUBLIC_ADDRESS="$public_address" ' : ''
  const inside = command => `${guard}; ${objectGuard('container', name)}; ${publishedAddress}podman exec ${environment}${name} /bin/sh -c ${quote(command)}`
  const healthCommand = command => application === 'ghost' ? `public_address=$(printenv WEBMINAI_PUBLIC_ADDRESS); ${command.replaceAll('curl ', 'curl --noproxy \'*\' --header "Host: $public_address:18110" --connect-to "$public_address:18110:127.0.0.1:18110" ')}` : command
  const verification = `${guard}; ${objectGuard('container', name)}; test "$(podman port ${name} ${profile.port}/tcp)" = '0.0.0.0:${profile.port}'; ${profile.verifyInside ? inside(native.verifyApplied) : native.verifyApplied.replaceAll('curl ', `curl --noproxy '*' --connect-to "$address:${profile.port}:${address}:${profile.port}" `)}`
  const commands = [
    item('prepare-podman-application', prepare(identity, profile.port, application), 'Validate Podman and reserve task-owned storage without adopting existing containers'),
    item('build-podman-application-base', buildBase(identity, images.base, profile.services), 'Build a native FreeBSD base with curl, certificates and a fixed restart entrypoint; no credentials enter the image', ['prepare-podman-application'], 3600000),
    item('create-podman-application', create(identity, credentials, profile, address), 'Create a private network and persistent container with only the application HTTP port published', ['build-podman-application-base'], 600000),
    ...native.plan.commands.flatMap(command => {
      const runtimeId = `install-${application}-runtime`
      const runtimeReady = application === 'jellyfin' ? 'verify-podman-jellyfin-runtime' : 'clean-podman-package-cache'
      const wrapped = { ...command, id: `podman-${command.id}`, purpose: `Inside the task-owned FreeBSD container: ${command.purpose}`, command: inside(['configure-ghost', 'verify-ghost'].includes(command.id) ? healthCommand(command.command) : command.command), dependsOn: command.dependsOn.length ? command.dependsOn.map(id => id === runtimeId ? runtimeReady : profile.sourceBuild && id === `install-${application}-application` ? 'clean-podman-build-cache' : `podman-${id}`) : ['create-podman-application'], executionMode: 'job' }
      if (['initialize-odoo-database', 'initialize-ghost-database'].includes(command.id)) wrapped.dependsOn.push('clean-podman-build-cache')
      if (profile.sourceBuild && command.id === `install-${application}-application`) {
        const dependencies = wrapped.dependsOn
        wrapped.dependsOn = [profile.sourceBuild === 'node' ? 'verify-podman-build-linker' : 'verify-podman-openssl-development']
        const buildDependencies = `set -eu; ${freebsdInstallCompilerIfMissing()}; if [ ! -r /usr/include/stdlib.h ] || [ ! -r /usr/include/c++/v1/memory ]; then ${freebsdInstallMissingPackages(['FreeBSD-clibs-dev'])}; fi; ${freebsdCompilerEnvironment()}; printf '#include <stdlib.h>\n' | "$CC" -x c -fsyntax-only -; printf '#include <memory>\n' | "$CXX" -x c++ -fsyntax-only -; pkg clean -a -y`
        const buildState = `/var/lib/webminai/task-state/${taskId}-${application}-freebsd`
        const linker = `set -eu; umask 077; if [ ! -r /usr/lib/libcompiler_rt.a ]; then ${freebsdInstallMissingPackages(['FreeBSD-libcompiler_rt-dev'])}; fi; ${freebsdCompilerEnvironment()}; test ! -L ${quote(buildState)}; probe=$(mktemp ${quote(`${buildState}/linker-probe.XXXXXX`)}); trap 'rm -f -- "$probe"' EXIT; printf '#include <stdlib.h>\nint main(void) { return 0; }\n' | "$CC" -x c - -o "$probe"; "$probe"; printf '#include <memory>\nint main() { auto p = std::make_unique<int>(0); return *p; }\n' | "$CXX" -x c++ -std=c++17 - -o "$probe"; "$probe"; pkg clean -a -y`
        if (profile.sourceBuild === 'node') {
          wrapped.command = inside(freebsdBuildLog(buildState, `${freebsdSourceCompilerEnvironment()}; ${command.command}`))
          const cleanup = `set -eu; test ! -L ${quote(buildState)}; test "$(stat -f '%u:%Lp' ${quote(buildState)})" = 0:700; for name in npm-cache node-gyp pnpm-store corepack; do path=${quote(buildState)}/$name; test ! -L "$path"; if [ -e "$path" ]; then test -d "$path"; test "$(stat -f '%u' "$path")" = 0; fi; done; rm -rf -- ${['npm-cache', 'node-gyp', 'pnpm-store', 'corepack'].map(name => quote(`${buildState}/${name}`)).join(' ')}`
          return [item('prepare-podman-build-dependencies', inside(buildDependencies), 'Install and verify native C/C++ source-build prerequisites inside the owned container', dependencies, 3600000), item('verify-podman-build-linker', inside(linker), 'Compile, link and run C/C++ probes inside the owned container', ['prepare-podman-build-dependencies'], 1800000), wrapped, item('clean-podman-build-cache', inside(cleanup), 'Remove only owned build caches, preserving application files and private build logs', [wrapped.id])]
        }
        const sourceLibraries = `set -eu; if [ ! -r /usr/include/bsm/audit.h ]; then ${freebsdInstallMissingPackages([legacy ? 'FreeBSD-libbsm-dev' : 'FreeBSD-audit-dev'])}; fi; if [ ! -r /usr/lib/libprocstat.so ] || [ ! -r /usr/lib/libdevstat.so ]; then ${freebsdInstallMissingPackages(['FreeBSD-utilities-dev'])}; fi; if [ ! -r /usr/include/zlib.h ] || [ ! -r /usr/lib/libz.so ]; then ${freebsdInstallMissingPackages([legacy ? 'FreeBSD-runtime-dev' : 'FreeBSD-zlib-dev'])}; fi; test -r /usr/include/bsm/audit.h; test -r /usr/lib/libprocstat.so; test -r /usr/lib/libdevstat.so; test -r /usr/include/zlib.h; test -r /usr/lib/libz.so; ${application === 'odoo' ? 'pkg-config --exists libxml-2.0 libxslt; ' : ''} pkg clean -a -y`
        const systemLibraries = `set -eu; umask 077; if [ ! -r /usr/lib/libexecinfo.so ]; then ${freebsdInstallMissingPackages(['FreeBSD-libexecinfo-dev'])}; fi; if [ ! -r /usr/lib/libutil.so ] || [ ! -r /usr/lib/libkvm.so ] || [ ! -r /usr/include/kvm.h ]; then ${freebsdInstallMissingPackages(['FreeBSD-runtime-dev'])}; fi; ${freebsdCompilerEnvironment()}; test ! -L ${quote(buildState)}; probe=$(mktemp ${quote(`${buildState}/system-libraries-probe.XXXXXX`)}); trap 'rm -f -- "$probe"' EXIT; printf '#include <kvm.h>\n#include <bsm/audit.h>\n#include <zlib.h>\nint main(void) { return 0; }\n' | "$CC" -x c - -o "$probe" -lexecinfo -lpthread -lgcc_s -lc -lm -lrt -lutil -lkvm -lmemstat -lprocstat -ldevstat -lz; "$probe"; pkg clean -a -y`
        const opensslDevelopment = `set -eu; umask 077; if [ ! -r /usr/include/openssl/opensslv.h ] || [ ! -r /usr/lib/libssl.so ] || [ ! -r /usr/lib/libcrypto.so ]; then ${freebsdInstallMissingPackages([legacy ? 'FreeBSD-openssl-lib-dev' : 'FreeBSD-openssl-dev'])}; fi; ${freebsdCompilerEnvironment()}; pkg-config --exists openssl; test ! -L ${quote(buildState)}; probe=$(mktemp ${quote(`${buildState}/openssl-probe.XXXXXX`)}); trap 'rm -f -- "$probe"' EXIT; printf '#include <openssl/ssl.h>\nint main(void) { return OPENSSL_init_ssl(0, 0) == 1 ? 0 : 1; }\n' | "$CC" -x c - -o "$probe" $(pkg-config --cflags --libs openssl); "$probe"; pkg clean -a -y`
        const cleanBuildCache = `set -eu; test ! -L ${quote(buildState)}; test "$(stat -f '%u:%Lp' ${quote(buildState)})" = 0:700; for name in cargo rustup pip-cache; do path=${quote(buildState)}/$name; test ! -L "$path"; if [ -e "$path" ]; then test -d "$path"; test "$(stat -f '%u' "$path")" = 0; fi; done; test ! -L ${quote(`${buildState}/rust-private-ready`)}; rm -rf -- ${quote(`${buildState}/cargo`)} ${quote(`${buildState}/rustup`)} ${quote(`${buildState}/pip-cache`)}; rm -f -- ${quote(`${buildState}/rust-private-ready`)}`
        return [item('prepare-podman-build-dependencies', inside(buildDependencies), 'Install missing native development headers inside the owned container and verify C/C++ compilation before the application build', dependencies, 1800000), item('verify-podman-build-linker', inside(linker), 'Install missing base compiler runtime inside the owned container, then compile, link and run fixed C/C++ probes', ['prepare-podman-build-dependencies'], 1800000), item('prepare-podman-source-libraries', inside(sourceLibraries), 'Install and verify missing audit, process-statistics and zlib development files inside the owned container', ['verify-podman-build-linker'], 1800000), item('verify-podman-system-libraries', inside(systemLibraries), 'Install missing native runtime development libraries inside the owned container and verify the source dependency link set', ['prepare-podman-source-libraries'], 1800000), item('verify-podman-openssl-development', inside(opensslDevelopment), 'Install missing OpenSSL development files inside the owned container and compile, link and run a fixed TLS-library probe', ['verify-podman-system-libraries'], 1800000), wrapped, item('clean-podman-build-cache', inside(cleanBuildCache), 'Remove only private build-only Rust/Cargo caches after successful acquisition, preserving build logs, credentials and application files', [wrapped.id], 300000)]
      }
      return command.id === runtimeId
        ? [wrapped, item('clean-podman-package-cache', inside('pkg clean -a -y'), 'Remove downloaded package archives inside the owned container only, without removing installed packages', [wrapped.id]), ...(application === 'jellyfin' ? [item('verify-podman-jellyfin-runtime', inside(native.verifyRuntime), 'Check CoreCLR startup as the service identity before starting a respawning daemon', ['clean-podman-package-cache'])] : [])]
        : [wrapped]
    })
  ]
  const restartReady = `${inside(`ready=; for attempt in $(jot 60); do if ${profile.services.map(service => `service ${service} onestatus >/dev/null 2>&1`).join(' && ')}${application === 'magento' ? ' && test -S /var/db/webminai-magento-18108/php-run/php-fpm.sock' : application === 'jellyfin' ? ' && curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8096/health >/dev/null 2>&1' : ''}; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]`)}; `
  commands.push(item('verify-podman-application-restart', `${inside('touch /var/db/intentaiops-application-ready')}; podman restart ${name} >/dev/null; ${restartReady}${inside(healthCommand(native.plan.commands.at(-1).command))}`, 'Restart the container and repeat the native application, database and service health checks', [`podman-${native.plan.commands.at(-1).id}`], 1800000))
  commands.push(item('verify-podman-published-http', verification, 'Verify the declared published-port mapping and direct jail HTTP using the public Host header; external reachability requires a client-side check', ['verify-podman-application-restart'], 300000, 'read'))
  return {
    plan: {
      ...native.plan,
      summary: `Deploy ${application} inside an isolated native FreeBSD Podman container`,
      changeOverview: 'Reuse the pinned native installer inside a task-owned container. Application packages, accounts and service configurations do not modify the host. The container writable layer persists until reviewed rollback.',
      modifiedFiles: [state],
      assumptions: ['A reviewed FreeBSD 14.4 or 15.1+ Podman jail host with working private networking and sufficient disk space', ...(application === 'n8n' ? ['Cold n8n builds require 8 GiB available on the Podman storage filesystem and at least 3.5 GiB usable RAM (4 GiB VM recommended).'] : [])],
      warnings: [...native.plan.warnings, ...(profile.mlock ? ['Jellyfin requests jail memory locking with a 64 KiB process limit; no global jail policy is changed.'] : []), isVerifiedFreebsdPodmanApplication(application, execution) ? 'This native FreeBSD Podman route passed application, container-restart and rollback qualification on this amd64 FreeBSD release. Host-reboot startup remains unverified.' : 'This explicit Podman route is pending live qualification and is not selected by Automatic yet.', 'FreeBSD boot integration uses restart=always: manually stopped containers can start at host boot; reviewed rollback removes task-owned resources.', 'The base image contains no application credentials. Installation occurs in the persistent container writable layer; deleting the container destroys its application data.', 'No host networking, privileged mode, device mounts, or Podman socket is granted. Hardware integrations remain unavailable.'],
      commands,
      revertCommands: [item('remove-podman-application', remove(identity), 'Remove only ownership-verified task containers, network, runtime image and protected task files', [], 1800000, 'destructive')]
    },
    ...(native.verifyRuntime ? { verifyRuntime: inside(native.verifyRuntime) } : {}),
    verifyApplied: verification,
    verifyReverted: `set -eu; test ! -e ${quote(state)}; test ! -L ${quote(state)}; ${absent('container', name)}; ${absent('network', name)}; ${absent('image', image)}`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function paths (state) {
  return `for path in /var /var/db /var/db/webminai ${quote(state)}; do test ! -L "$path"; if test -e "$path"; then test -d "$path"; test "$(stat -f '%u' "$path")" = 0; unsafe=$(find "$path" -prune -perm -0020 -print -o -perm -0002 -print); test -z "$unsafe"; fi; done`
}

function ownership ({ state }) {
  return `set -eu; ${paths(state)}; test -d ${quote(state)}; test ! -L ${quote(`${state}/owner`)}; test "$(stat -f '%u:%Lp' ${quote(`${state}/owner`)})" = 0:600; owner=$(cat ${quote(`${state}/owner`)}); printf '%s\n' "$owner" | grep -Eq '^[a-f0-9]{64}$'`
}

function objectGuard (kind, target) {
  return `test "$(podman ${kind} inspect --format '{{ index .${kind === 'network' ? '' : 'Config.'}Labels "io.intentaiops.owner" }}' ${target})" = "$owner"`
}

function objectState (kind, target) {
  return `if podman ${kind} exists ${target}; then exists=yes; else code=$?; test "$code" -eq 1; exists=no; fi`
}

function absent (kind, target) {
  return `${objectState(kind, target)}; test "$exists" = no`
}

function prepare ({ state, name, image }, port, application) {
  const disk = application === 'n8n'
    ? `storage_root=$(podman info --format '{{.Store.GraphRoot}}') || { printf 'DISK_CAPACITY_UNAVAILABLE: Podman storage location could not be read\n' >&2; exit 78; }
case "$storage_root" in /*) ;; *) printf 'DISK_CAPACITY_UNAVAILABLE: Podman storage location could not be verified\n' >&2; exit 78;; esac
capacity=$(df -kP "$storage_root") || { printf 'DISK_CAPACITY_UNAVAILABLE: Podman storage capacity could not be read\n' >&2; exit 78; }
available=$(printf '%s\n' "$capacity" | awk 'NR == 2 { print $4 }')
printf '%s\n' "$available" | grep -Eq '^-?[0-9]{1,15}$' || { printf 'DISK_CAPACITY_UNAVAILABLE: available storage could not be verified\n' >&2; exit 78; }
[ "$available" -ge 8388608 ] || { printf 'INSUFFICIENT_DISK: n8n Podman cold builds require 8 GiB available on the Podman storage filesystem (found %s KiB). Review unused caches or increase disk capacity.\n' "$available" >&2; exit 78; }
`
    : ''
  return `set -eu; umask 077; test "$(uname -s)" = FreeBSD; test "$(sysctl -n security.jail.jailed)" = 0; podman info >/dev/null; ${disk}${paths(state)}; test ! -e ${quote(state)}; ${absent('container', name)}; ${absent('network', name)}; ${absent('image', image)}; listeners=$(sockstat -46l -P tcp -p ${port}); if printf '%s\n' "$listeners" | awk 'NR > 1 { found=1 } END { exit !found }'; then printf 'APPLICATION_PORT_IN_USE\n' >&2; exit 78; fi; test -d /var/db/webminai; mkdir -m 0700 ${quote(state)}; openssl rand -hex 32 > ${quote(`${state}/owner`)}; chmod 0600 ${quote(`${state}/owner`)}`
}

function buildBase (identity, base, services) {
  const { state, image } = identity
  const starts = services.map(service => `service ${service} onestart`).join('\n')
  const legacy = base === 'ghcr.io/freebsd/freebsd-runtime:14.4'
  const utilities = legacy ? ' && pkg install -y -r FreeBSD-base FreeBSD-utilities && command -v chown && command -v su && command -v pw && command -v service' : ''
  return `${ownership(identity)}; test ! -e ${quote(`${state}/build`)}; mkdir -m 0700 ${quote(`${state}/build`)}; cat > ${quote(`${state}/build/entrypoint`)} <<'SH'
#!/bin/sh
set -eu
chmod 0755 /
if test -e /var/db/intentaiops-application-ready; then
${starts}
fi
trap 'exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
SH
chmod 0755 ${quote(`${state}/build/entrypoint`)}; cat > ${quote(`${state}/build/Containerfile`)} <<'CF'
FROM ${base}
RUN chmod 0755 / && env ASSUME_ALWAYS_YES=yes IGNORE_OS_VERSION=yes pkg bootstrap -r FreeBSD && pkg install -y curl ca_root_nss${utilities} && pkg clean -y
COPY entrypoint /usr/local/sbin/intentaiops-entrypoint
ENTRYPOINT ["/usr/local/sbin/intentaiops-entrypoint"]
CF
TMPDIR=/var/db/containers/tmp podman build ${legacy ? '--no-hosts ' : ''}--label "io.intentaiops.owner=$owner" -t ${image} ${quote(`${state}/build`)}; ${objectGuard('image', image)}`
}

function create (identity, credentials, profile, address) {
  const { state, name, image } = identity
  const containerField = field => `"$(podman container inspect --format '${field}' ${name})"`
  const checks = [
    objectGuard('container', name),
    `test ${containerField('{{.Image}}')} = "$(podman image inspect --format '{{.Id}}' ${image})"`,
    `test ${containerField('{{.HostConfig.Privileged}}')} = false`,
    `test ${containerField('{{.HostConfig.RestartPolicy.Name}}')} = always`,
    ...(profile.ipc ? [`test ${containerField('{{ index .Config.Annotations "org.freebsd.jail.sysvshm" }}')} = new`] : []),
    ...(profile.mlock ? [`test ${containerField('{{ index .Config.Annotations "org.freebsd.jail.allow.mlock" }}')} = true`, `test ${containerField('{{range .HostConfig.Ulimits}}{{if eq .Name "RLIMIT_MEMLOCK"}}{{.Soft}} {{.Hard}}{{end}}{{end}}')} = '65536 65536'`, `jail_name=$(podman container inspect --format '{{.Id}}' ${name}); test "$(jls -j "$jail_name" -n allow.mlock)" = allow.mlock`] : []),
    `test ${containerField('{{len .Mounts}}')} = 1`,
    `test ${containerField('{{(index .Mounts 0).Source}}')} = ${quote(`${state}/credentials`)}`,
    `test ${containerField('{{(index .Mounts 0).Destination}}')} = ${quote(credentials)}`,
    `test ${containerField('{{len .HostConfig.PortBindings}}')} = 1`,
    `test ${containerField(`{{(index (index .HostConfig.PortBindings "${profile.port}/tcp") 0).HostPort}}`)} = ${quote(String(profile.port))}`,
    `test ${containerField('{{range $name,$network := .NetworkSettings.Networks}}{{$name}} {{$network.IPAddress}}{{end}}')} = ${quote(`${name} ${address}`)}`
  ].join('; ')
  return `${ownership(identity)}; ${objectGuard('image', image)}; test ! -L ${quote(`${state}/credentials`)}; if [ ! -e ${quote(`${state}/credentials`)} ]; then mkdir -m 0700 ${quote(`${state}/credentials`)}; fi; test "$(stat -f '%u:%Lp' ${quote(`${state}/credentials`)})" = 0:700; ${objectState('network', name)}; if [ "$exists" = no ]; then podman network create --label "io.intentaiops.owner=$owner" --subnet 10.89.${profile.subnet}.0/24 --gateway 10.89.${profile.subnet}.1 ${name} >/dev/null; fi; ${objectGuard('network', name)}; test "$(podman network inspect --format '{{range .Subnets}}{{.Subnet}} {{.Gateway}}{{end}}' ${name})" = ${quote(`10.89.${profile.subnet}.0/24 10.89.${profile.subnet}.1`)}; ${objectState('container', name)}; if [ "$exists" = no ]; then podman create ${profile.ipc ? '--annotation org.freebsd.jail.sysvshm=new ' : ''}${profile.mlock ? '--annotation org.freebsd.jail.allow.mlock=true --ulimit memlock=65536:65536 ' : ''}--name ${name} --label "io.intentaiops.owner=$owner" --restart always --network ${name} --ip ${address} --publish ${profile.port}:${profile.port} --volume ${quote(`${state}/credentials:${credentials}`)} ${image} >/dev/null; podman start ${name} >/dev/null; fi; ${checks}; test ${containerField('{{.State.Running}}')} = true; podman exec ${name} /bin/sh -c 'chmod 0755 /'; if ! podman exec --user 65534:65534 ${name} /bin/sh -c 'test -x /bin/sh && test -r /etc/passwd'; then printf 'CONTAINER_SERVICE_IDENTITY_UNAVAILABLE\n' >&2; exit 78; fi`
}

function remove (identity) {
  const { state, name, image } = identity
  const objects = [['container', name, `podman rm --force ${name}`], ['network', name, `podman network rm ${name}`], ['image', image, `podman rmi ${image}`]]
  const checks = objects.map(([kind, target]) => `${objectState(kind, target)}; if [ "$exists" = yes ]; then ${objectGuard(kind, target)}; fi`).join('; ')
  const removals = objects.map(([kind, target, command]) => `${objectState(kind, target)}; if [ "$exists" = yes ]; then ${objectGuard(kind, target)}; ${command} >/dev/null; fi`).join('; ')
  return `${ownership(identity)}; ${checks}; ${removals}; rm -rf -- ${quote(state)}`
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, risk = 'change') {
  return { id, command, purpose, dependsOn, timeoutMs, risk, requiresSudo: true, executionMode: 'job' }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
