#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_NAME=${0##*/}
readonly LAB_MARKER='webminai-freebsd-vm-lab'
readonly CLEAN_SNAPSHOT='clean'
readonly DEFAULT_RELEASES=(
  14.4
  15.1
)

declare -Ar RELEASE_LABELS=(
  [14.4]='FreeBSD 14.4-RELEASE'
  [15.1]='FreeBSD 15.1-RELEASE'
)

declare -Ar RELEASE_NAMES=(
  [14.4]='freebsd-14-4'
  [15.1]='freebsd-15-1'
)

declare -Ar RELEASE_IMAGES=(
  [14.4]='FreeBSD-14.4-RELEASE-amd64-BASIC-CLOUDINIT-ufs.qcow2.xz'
  [15.1]='FreeBSD-15.1-RELEASE-amd64-BASIC-CLOUDINIT-ufs.qcow2.xz'
)

declare -Ar RELEASE_IMAGE_ROOTS=(
  [14.4]='https://download.freebsd.org/releases/VM-IMAGES/14.4-RELEASE/amd64/Latest'
  [15.1]='https://download.freebsd.org/releases/VM-IMAGES/15.1-RELEASE/amd64/Latest'
)

declare -Ar RELEASE_MACS=(
  [14.4]='52:54:00:57:4d:44'
  [15.1]='52:54:00:57:4d:51'
)

ACTION=${1:-help}
shift || true

LIBVIRT_URI=${WEBMINAI_FREEBSD_LIBVIRT_URI:-qemu:///system}
LIBVIRT_NETWORK=${WEBMINAI_FREEBSD_NETWORK:-default}
INSTANCE_PREFIX=${WEBMINAI_FREEBSD_PREFIX:-webminai-}
LAB_USER=${WEBMINAI_FREEBSD_USER:-webminai}
MEMORY_MIB=${WEBMINAI_FREEBSD_MEMORY_MIB:-2048}
CPU_COUNT=${WEBMINAI_FREEBSD_CPUS:-2}
DISK_SIZE=${WEBMINAI_FREEBSD_DISK_SIZE:-20G}
VIRT_TYPE=${WEBMINAI_FREEBSD_VIRT_TYPE:-kvm}
LAB_OWNER=${SUDO_USER:-$(id -un)}
LAB_OWNER_HOME=''
LAB_OWNER_GROUP=''
LAB_DIRECTORY=${WEBMINAI_FREEBSD_DIRECTORY:-}
VM_DIRECTORY=${WEBMINAI_FREEBSD_VM_DIRECTORY:-/var/lib/libvirt/images/webminai-freebsd-lab}
KEY_PATH=${WEBMINAI_FREEBSD_KEY:-}
YES=false
DOCKER_FORWARDING=false
SELECTED_RELEASES=()

for argument in "$@"; do
  case $argument in
    --yes) YES=true ;;
    --docker-forwarding) DOCKER_FORWARDING=true ;;
    --*) printf 'error: unknown option: %s\n' "$argument" >&2; exit 1 ;;
    *) SELECTED_RELEASES+=("$argument") ;;
  esac
done
if ((${#SELECTED_RELEASES[@]} == 0)); then
  SELECTED_RELEASES=("${DEFAULT_RELEASES[@]}")
fi

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME ACTION [RELEASE ...] [--yes] [--docker-forwarding]

Create disposable FreeBSD VMs with SSH access and clean libvirt snapshots.

Actions:
  matrix                  Show the release/image/resource matrix
  up [RELEASE ...]        Download, create, provision, and verify VMs
  status [RELEASE ...]    Show VM state, address, and clean-snapshot status
  hosts [RELEASE ...]     Rebuild and print Intent AI Ops-ready SSH commands
  stop [RELEASE ...]      Gracefully stop selected VMs
  reset [RELEASE ...] [--yes]
                          Restore selected VMs to their clean snapshots
  destroy [RELEASE ...] [--yes]
                          Permanently delete selected lab VMs and overlays
  help                    Show this help

Default releases:
  ${DEFAULT_RELEASES[*]}

Run mutating actions as root. On Ubuntu, required host packages are typically:
  qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients
  virt-install cloud-image-utils genisoimage xz-utils curl

Older Ubuntu releases may name the virt-install package virtinst.

Optional environment:
  WEBMINAI_FREEBSD_LIBVIRT_URI   Libvirt connection (default: qemu:///system)
  WEBMINAI_FREEBSD_NETWORK       Libvirt NAT network (default: default)
  WEBMINAI_FREEBSD_PREFIX        Domain/SSH alias prefix (default: webminai-)
  WEBMINAI_FREEBSD_USER          Guest SSH user (default: webminai)
  WEBMINAI_FREEBSD_MEMORY_MIB    Per-VM memory in MiB (default: 2048)
  WEBMINAI_FREEBSD_CPUS          Per-VM vCPU count (default: 2)
  WEBMINAI_FREEBSD_DISK_SIZE     Overlay virtual size (default: 20G)
  WEBMINAI_FREEBSD_VIRT_TYPE     kvm or qemu (default: kvm)
  WEBMINAI_FREEBSD_DIRECTORY     Keys/config/output directory
  WEBMINAI_FREEBSD_VM_DIRECTORY  Base images, seeds, and VM overlays
  WEBMINAI_FREEBSD_KEY           Dedicated Ed25519 private-key path

Host networking:
  --docker-forwarding            For "up", enable IPv4 forwarding and allow
                                 docker0 to reach the selected libvirt bridge.
                                 The sysctl is persistent; iptables rules last
                                 until the host firewall is reloaded or rebooted.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_root() {
  ((EUID == 0)) || fail "run this action as root: sudo $0 $ACTION ${SELECTED_RELEASES[*]}"
}

virsh_command() {
  virsh --connect "$LIBVIRT_URI" "$@"
}

validate_configuration() {
  if [[ $DOCKER_FORWARDING == true && $ACTION != up ]]; then
    fail '--docker-forwarding is supported only by the up action'
  fi
  [[ $INSTANCE_PREFIX =~ ^[a-z0-9-]+$ ]] || fail 'instance prefix must contain lowercase letters, numbers, and hyphens'
  [[ $LAB_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'invalid lab SSH user'
  [[ $MEMORY_MIB =~ ^[0-9]+$ ]] && ((MEMORY_MIB >= 512)) || fail 'memory must be at least 512 MiB'
  [[ $CPU_COUNT =~ ^[0-9]+$ ]] && ((CPU_COUNT >= 1)) || fail 'CPU count must be positive'
  [[ $DISK_SIZE =~ ^[1-9][0-9]*[GMTP]$ ]] || fail 'disk size must look like 20G'
  [[ $VIRT_TYPE == kvm || $VIRT_TYPE == qemu ]] || fail 'virt type must be kvm or qemu'
  [[ $VM_DIRECTORY == /* ]] || fail 'VM directory must be an absolute path'
  [[ $VM_DIRECTORY != / && $VM_DIRECTORY != /var && $VM_DIRECTORY != /var/lib ]] || fail 'VM directory is too broad'
  case $(uname -m) in
    x86_64|amd64) ;;
    *) fail 'this lab currently uses amd64 FreeBSD images and requires an amd64 host' ;;
  esac
  for release in "${SELECTED_RELEASES[@]}"; do
    [[ -n ${RELEASE_IMAGES[$release]:-} ]] || fail "unknown FreeBSD release: $release"
  done
}

resolve_owner_paths() {
  require_command getent
  LAB_OWNER_HOME=$(getent passwd "$LAB_OWNER" | awk -F: 'NR == 1 { print $6 }')
  [[ -n $LAB_OWNER_HOME && $LAB_OWNER_HOME == /* ]] || fail "cannot resolve home directory for $LAB_OWNER"
  LAB_OWNER_GROUP=$(id -gn "$LAB_OWNER")
  if [[ -z $LAB_DIRECTORY ]]; then
    LAB_DIRECTORY=$LAB_OWNER_HOME/.webminai/freebsd-vm-lab
  fi
  [[ $LAB_DIRECTORY == /* ]] || fail 'lab directory must be an absolute path'
  [[ $LAB_DIRECTORY != *[[:space:]]* && $VM_DIRECTORY != *[[:space:]]* ]] || fail 'lab paths cannot contain whitespace'
  if [[ -z $KEY_PATH ]]; then
    KEY_PATH=$LAB_DIRECTORY/id_ed25519
  elif [[ $KEY_PATH != /* ]]; then
    KEY_PATH=$LAB_DIRECTORY/$KEY_PATH
  fi
  [[ $KEY_PATH != *[[:space:]]* ]] || fail 'key path cannot contain whitespace'
}

instance_name() {
  printf '%s%s' "$INSTANCE_PREFIX" "${RELEASE_NAMES[$1]}"
}

image_archive_path() {
  printf '%s/%s' "$VM_DIRECTORY" "${RELEASE_IMAGES[$1]}"
}

base_image_path() {
  local archive
  archive=$(image_archive_path "$1")
  printf '%s' "${archive%.xz}"
}

overlay_path() {
  printf '%s/%s.qcow2' "$VM_DIRECTORY" "$(instance_name "$1")"
}

seed_path() {
  printf '%s/%s-seed.iso' "$VM_DIRECTORY" "$(instance_name "$1")"
}

artifact_marker_path() {
  printf '%s/%s.lab-marker' "$VM_DIRECTORY" "$(instance_name "$1")"
}

domain_exists() {
  virsh_command dominfo "$(instance_name "$1")" >/dev/null 2>&1
}

assert_lab_domain() {
  local release=$1
  local name description
  name=$(instance_name "$release")
  description=$(virsh_command desc "$name" 2>/dev/null || true)
  [[ $description == "$LAB_MARKER:$release" ]] || fail "refusing to modify unmarked domain: $name"
}

assert_artifact_marker() {
  local release=$1
  local marker
  marker=$(artifact_marker_path "$release")
  [[ -f $marker ]] || fail "refusing to remove unmarked VM artifacts for $(instance_name "$release")"
  [[ $(<"$marker") == "$LAB_MARKER:$release" ]] || fail "invalid VM artifact marker: $marker"
}

snapshot_exists() {
  virsh_command snapshot-info "$(instance_name "$1")" "$CLEAN_SNAPSHOT" >/dev/null 2>&1
}

require_libvirt() {
  require_command virsh
  virsh_command uri >/dev/null 2>&1 || fail "cannot connect to libvirt at $LIBVIRT_URI"
  virsh_command net-info "$LIBVIRT_NETWORK" >/dev/null 2>&1 || fail "libvirt network does not exist: $LIBVIRT_NETWORK"
}

ensure_network() {
  local active
  active=$(virsh_command net-info "$LIBVIRT_NETWORK" | awk -F: '$1 ~ /^Active/ { gsub(/[[:space:]]/, "", $2); print $2 }')
  if [[ $active != yes ]]; then
    printf 'Starting libvirt network %s...\n' "$LIBVIRT_NETWORK"
    virsh_command net-start "$LIBVIRT_NETWORK" >/dev/null
  fi
}

configure_docker_forwarding() {
  [[ $DOCKER_FORWARDING == true ]] || return
  require_command ip
  require_command iptables
  require_command sysctl

  local docker_interface=${WEBMINAI_FREEBSD_DOCKER_INTERFACE:-docker0}
  local libvirt_bridge
  libvirt_bridge=$(virsh_command net-info "$LIBVIRT_NETWORK" | awk -F: '$1 ~ /^Bridge/ { gsub(/[[:space:]]/, "", $2); print $2 }')
  [[ $docker_interface =~ ^[a-zA-Z0-9_.:-]+$ ]] || fail 'invalid Docker bridge interface'
  [[ $libvirt_bridge =~ ^[a-zA-Z0-9_.:-]+$ ]] || fail "cannot resolve the bridge for libvirt network: $LIBVIRT_NETWORK"
  ip link show "$docker_interface" >/dev/null 2>&1 || fail "Docker bridge does not exist: $docker_interface"
  ip link show "$libvirt_bridge" >/dev/null 2>&1 || fail "libvirt bridge does not exist: $libvirt_bridge"

  printf 'Enabling Docker forwarding from %s to %s...\n' "$docker_interface" "$libvirt_bridge"
  printf '%s\n' 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-webminai-freebsd-lab-forward.conf
  chmod 644 /etc/sysctl.d/99-webminai-freebsd-lab-forward.conf
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  sysctl --system >/dev/null
  iptables -C FORWARD -i "$docker_interface" -o "$libvirt_bridge" -j ACCEPT 2>/dev/null || \
    iptables -I FORWARD -i "$docker_interface" -o "$libvirt_bridge" -j ACCEPT
  iptables -C FORWARD -i "$libvirt_bridge" -o "$docker_interface" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
    iptables -I FORWARD -i "$libvirt_bridge" -o "$docker_interface" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
}

prepare_lab_files() {
  mkdir -p "$LAB_DIRECTORY"
  chmod 700 "$LAB_DIRECTORY"
  if [[ ! -f $KEY_PATH ]]; then
    ssh-keygen -q -t ed25519 -N '' -C 'webminai-freebsd-vm-lab' -f "$KEY_PATH"
  elif [[ ! -f $KEY_PATH.pub ]]; then
    ssh-keygen -y -f "$KEY_PATH" >"$KEY_PATH.pub"
  fi
  chmod 600 "$KEY_PATH"
  chmod 644 "$KEY_PATH.pub"
  touch "$LAB_DIRECTORY/known_hosts"
  chmod 600 "$LAB_DIRECTORY/known_hosts"
  if ((EUID == 0)); then
    chown -R "$LAB_OWNER:$LAB_OWNER_GROUP" "$LAB_DIRECTORY"
  fi
}

prepare_vm_directory() {
  mkdir -p "$VM_DIRECTORY"
  chmod 755 "$VM_DIRECTORY"
  VM_DIRECTORY=$(cd "$VM_DIRECTORY" && pwd -P)
}

print_matrix() {
  printf '%-10s %-24s %-74s %-8s %-6s %s\n' RELEASE LABEL IMAGE MEMORY VCPUS DISK
  for release in "${DEFAULT_RELEASES[@]}"; do
    printf '%-10s %-24s %-74s %-8s %-6s %s\n' \
      "$release" "${RELEASE_LABELS[$release]}" "${RELEASE_IMAGES[$release]}" \
      "${MEMORY_MIB}M" "$CPU_COUNT" "$DISK_SIZE"
  done
}

verify_archive() {
  local release=$1
  local archive=$2
  local checksum_file=$3
  local filename expected actual
  filename=${archive##*/}
  filename=${filename%.partial}
  expected=$(awk -v filename="$filename" '
    index($0, "(" filename ")") { print $NF; exit }
    $2 == filename || $2 == "*" filename { print $1; exit }
  ' "$checksum_file")
  [[ $expected =~ ^[a-fA-F0-9]{64}$ ]] || fail "cannot find a SHA-256 checksum for $filename"
  actual=$(sha256sum "$archive" | awk '{ print $1 }')
  [[ $actual == "$expected" ]]
}

prepare_base_image() {
  local release=$1
  local image_root=${RELEASE_IMAGE_ROOTS[$release]}
  local archive archive_partial base checksum_file checksum_temporary image_temporary
  archive=$(image_archive_path "$release")
  archive_partial=$archive.partial
  base=$(base_image_path "$release")
  checksum_file=$VM_DIRECTORY/CHECKSUM.SHA256-$release
  checksum_temporary=$checksum_file.partial.$$

  printf 'Fetching FreeBSD %s checksums...\n' "$release"
  curl --fail --location --retry 3 --output "$checksum_temporary" "$image_root/CHECKSUM.SHA256"
  mv "$checksum_temporary" "$checksum_file"

  if [[ -f $archive ]] && ! verify_archive "$release" "$archive" "$checksum_file"; then
    mv "$archive" "$archive.invalid.$(date +%s)"
    if [[ -f $archive_partial ]]; then
      mv "$archive_partial" "$archive_partial.invalid.$(date +%s)"
    fi
    printf 'Preserved an invalid cached archive and will download it again.\n' >&2
  fi
  if [[ ! -f $archive ]]; then
    printf 'Downloading %s...\n' "${RELEASE_IMAGES[$release]}"
    curl --fail --location --retry 3 --continue-at - --output "$archive_partial" \
      "$image_root/${RELEASE_IMAGES[$release]}"
    if ! verify_archive "$release" "$archive_partial" "$checksum_file"; then
      mv "$archive_partial" "$archive_partial.invalid.$(date +%s)"
      fail "checksum mismatch for FreeBSD $release image archive; the invalid download was preserved"
    fi
    mv "$archive_partial" "$archive"
  fi
  verify_archive "$release" "$archive" "$checksum_file" || fail "checksum mismatch for FreeBSD $release image archive"

  if [[ -f $base ]] && qemu-img check -q "$base" >/dev/null 2>&1; then
    return
  fi
  image_temporary=$base.partial.$$
  rm -f -- "$image_temporary"
  printf 'Decompressing the FreeBSD %s base image...\n' "$release"
  xz --decompress --stdout "$archive" >"$image_temporary"
  qemu-img check -q "$image_temporary" || fail "decompressed FreeBSD $release image is invalid"
  mv "$image_temporary" "$base"
  chmod 644 "$base"
}

create_cloud_init_seed() {
  local release=$1
  local name public_key password_hash user_data meta_data seed seed_temporary
  name=$(instance_name "$release")
  public_key=$(<"$KEY_PATH.pub")
  password_hash=$(openssl rand -hex 32 | openssl passwd -6 -stdin)
  user_data=$VM_DIRECTORY/$name-user-data.yaml
  meta_data=$VM_DIRECTORY/$name-meta-data.yaml
  seed=$(seed_path "$release")
  seed_temporary=$seed.partial.$$

  cat >"$user_data" <<EOF
#cloud-config
hostname: $name
ssh_pwauth: false
users:
  - name: $LAB_USER
    gecos: Intent AI Ops FreeBSD test lab
    groups:
      - wheel
    shell: /bin/sh
    locked: false
    passwd: '$password_hash'
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - $public_key
package_update: true
packages:
  - sudo
  - curl
  - ca_root_nss
runcmd:
  - /usr/sbin/sysrc sshd_enable=YES
  - /usr/sbin/service sshd restart
  - /usr/bin/touch /var/db/webminai-lab-ready
EOF
  cat >"$meta_data" <<EOF
instance-id: $name-v1
local-hostname: $name
EOF
  rm -f -- "$seed_temporary"
  cloud-localds "$seed_temporary" "$user_data" "$meta_data"
  mv "$seed_temporary" "$seed"
  chmod 644 "$user_data" "$meta_data" "$seed"
}

select_osinfo() {
  local release=$1
  local candidates candidate
  if [[ $release == 15.1 ]]; then
    candidates='freebsd15.0 freebsd14.0 freebsd13.0 generic'
  else
    candidates='freebsd14.0 freebsd13.0 generic'
  fi
  for candidate in $candidates; do
    if virt-install --osinfo list 2>/dev/null | awk '{ print $1 }' | grep -Fxq "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
  printf 'generic'
}

create_domain() {
  local release=$1
  local name base overlay seed marker user_data meta_data osinfo
  name=$(instance_name "$release")
  base=$(base_image_path "$release")
  overlay=$(overlay_path "$release")
  seed=$(seed_path "$release")
  marker=$(artifact_marker_path "$release")
  user_data=$VM_DIRECTORY/$name-user-data.yaml
  meta_data=$VM_DIRECTORY/$name-meta-data.yaml
  osinfo=$(select_osinfo "$release")

  if [[ -f $marker ]]; then
    assert_artifact_marker "$release"
    rm -f -- "$overlay" "$seed" "$user_data" "$meta_data"
  elif [[ -e $overlay || -e $seed || -e $user_data || -e $meta_data ]]; then
    fail "refusing to overwrite unmarked VM artifacts for $name"
  fi
  printf '%s\n' "$LAB_MARKER:$release" >"$marker"
  chmod 600 "$marker"

  qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$overlay"
  qemu-img resize -q "$overlay" "$DISK_SIZE"
  chmod 660 "$overlay"
  create_cloud_init_seed "$release"

  printf 'Defining and starting %s...\n' "$name"
  virt-install --connect "$LIBVIRT_URI" \
    --name "$name" \
    --description "$LAB_MARKER:$release" \
    --memory "$MEMORY_MIB" \
    --vcpus "$CPU_COUNT" \
    --virt-type "$VIRT_TYPE" \
    --osinfo "$osinfo" \
    --import \
    --disk "path=$overlay,format=qcow2,bus=virtio,cache=none" \
    --disk "path=$seed,device=cdrom,readonly=on" \
    --network "network=$LIBVIRT_NETWORK,model=virtio,mac=${RELEASE_MACS[$release]}" \
    --graphics none \
    --console pty,target_type=serial \
    --noautoconsole
}

domain_ipv4() {
  local release=$1
  local name mac address
  name=$(instance_name "$release")
  mac=${RELEASE_MACS[$release]}
  address=$(virsh_command domifaddr "$name" --source lease 2>/dev/null | awk '$3 == "ipv4" { split($4, fields, "/"); print fields[1]; exit }')
  if [[ -z $address ]]; then
    address=$(virsh_command net-dhcp-leases "$LIBVIRT_NETWORK" --mac "$mac" 2>/dev/null | awk '$5 ~ /^[0-9]+\./ { split($5, fields, "/"); print fields[1]; exit }')
  fi
  printf '%s' "$address"
}

wait_for_address() {
  local release=$1
  local name address=''
  name=$(instance_name "$release")
  for _ in {1..180}; do
    address=$(domain_ipv4 "$release")
    if [[ -n $address ]]; then
      printf '%s' "$address"
      return
    fi
    sleep 1
  done
  virsh_command domifaddr "$name" --source lease >&2 || true
  virsh_command net-dhcp-leases "$LIBVIRT_NETWORK" --mac "${RELEASE_MACS[$release]}" >&2 || true
  fail "VM did not obtain an IPv4 address: $name"
}

wait_for_ssh() {
  local release=$1
  local name address stdout_file stderr_file
  name=$(instance_name "$release")
  address=$(wait_for_address "$release")
  stdout_file=$LAB_DIRECTORY/$name.ssh.stdout
  stderr_file=$LAB_DIRECTORY/$name.ssh.stderr
  ssh-keygen -q -f "$LAB_DIRECTORY/known_hosts" -R "$address" >/dev/null 2>&1 || true

  for _ in {1..240}; do
    if ssh -i "$KEY_PATH" \
      -o IdentitiesOnly=yes \
      -o BatchMode=yes \
      -o ConnectTimeout=3 \
      -o UserKnownHostsFile="$LAB_DIRECTORY/known_hosts" \
      -o StrictHostKeyChecking=accept-new \
      "$LAB_USER@$address" \
      'test -f /var/db/webminai-lab-ready && sudo -n true && command -v curl >/dev/null && test "$(uname -s)" = FreeBSD && printf WEBMINAI_FREEBSD_SSH_OK' \
      >"$stdout_file" 2>"$stderr_file" && grep -q WEBMINAI_FREEBSD_SSH_OK "$stdout_file"; then
      rm -f "$stdout_file" "$stderr_file"
      printf '%s' "$address"
      return
    fi
    sleep 2
  done

  printf '\nSSH or cloud-init readiness failed for %s at %s.\n' "$name" "$address" >&2
  if [[ -s $stderr_file ]]; then
    printf '%s\n' 'Last SSH error:' >&2
    sed -n '1,120p' "$stderr_file" >&2
  fi
  virsh_command domstate "$name" >&2 || true
  virsh_command domifaddr "$name" --source lease >&2 || true
  printf '%s\n' 'Guest-side provisioning diagnostics:' >&2
  ssh -i "$KEY_PATH" \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    -o UserKnownHostsFile="$LAB_DIRECTORY/known_hosts" \
    -o StrictHostKeyChecking=accept-new \
    "$LAB_USER@$address" '
      printf "user: "; id
      printf "system: "; uname -a
      printf "ready marker: "; ls -l /var/db/webminai-lab-ready 2>&1 || true
      printf "sudo: "; command -v sudo 2>&1 || true
      sudo -n true 2>&1 && printf "passwordless sudo: ready\n" || printf "passwordless sudo: unavailable\n"
      printf "curl: "; command -v curl 2>&1 || true
      sudo -n tail -n 80 /var/log/messages 2>&1 || true
    ' >&2 || true
  printf 'Inspect the serial console with: virsh --connect %q console %q\n' "$LIBVIRT_URI" "$name" >&2
  printf 'If this VM came from an older lab seed, recreate it with:\n  %q destroy %q --yes\n  %q up %q\n' \
    "$0" "$release" "$0" "$release" >&2
  fail "FreeBSD VM did not become ready: $name"
}

wait_for_stopped() {
  local release=$1
  local name state
  name=$(instance_name "$release")
  for _ in {1..120}; do
    state=$(virsh_command domstate "$name" 2>/dev/null || true)
    if [[ $state == 'shut off' ]]; then
      return
    fi
    sleep 1
  done
  fail "VM did not stop cleanly: $name"
}

create_clean_snapshot() {
  local release=$1
  local name address
  name=$(instance_name "$release")
  snapshot_exists "$release" && return
  address=$(domain_ipv4 "$release")
  printf 'Creating the clean snapshot for %s...\n' "$name"
  ssh -i "$KEY_PATH" \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    -o UserKnownHostsFile="$LAB_DIRECTORY/known_hosts" \
    "$LAB_USER@$address" 'sudo shutdown -p now' >/dev/null 2>&1 || true
  wait_for_stopped "$release"
  virsh_command snapshot-create-as "$name" "$CLEAN_SNAPSHOT" \
    --description "$LAB_MARKER:$release:$CLEAN_SNAPSHOT" --atomic >/dev/null
  virsh_command start "$name" >/dev/null
  wait_for_ssh "$release" >/dev/null
}

write_connection_files() {
  local ssh_temporary hosts_temporary release name address
  ssh_temporary=$LAB_DIRECTORY/ssh_config.new
  hosts_temporary=$LAB_DIRECTORY/webminai-hosts.tsv.new
  : >"$ssh_temporary"
  printf 'name\trelease\taddress\tssh_command\n' >"$hosts_temporary"
  for release in "${DEFAULT_RELEASES[@]}"; do
    domain_exists "$release" || continue
    assert_lab_domain "$release"
    address=$(domain_ipv4 "$release")
    [[ -n $address ]] || continue
    name=$(instance_name "$release")
    cat >>"$ssh_temporary" <<EOF
Host $name
    HostName $address
    User $LAB_USER
    IdentityFile $KEY_PATH
    IdentitiesOnly yes
    UserKnownHostsFile $LAB_DIRECTORY/known_hosts
    StrictHostKeyChecking accept-new

EOF
    printf '%s\t%s\t%s\tssh -F %s %s\n' \
      "$name" "${RELEASE_LABELS[$release]}" "$address" "$LAB_DIRECTORY/ssh_config" "$name" >>"$hosts_temporary"
  done
  mv "$ssh_temporary" "$LAB_DIRECTORY/ssh_config"
  mv "$hosts_temporary" "$LAB_DIRECTORY/webminai-hosts.tsv"
  chmod 600 "$LAB_DIRECTORY/ssh_config" "$LAB_DIRECTORY/webminai-hosts.tsv"
  if ((EUID == 0)); then
    chown "$LAB_OWNER:$LAB_OWNER_GROUP" "$LAB_DIRECTORY/ssh_config" "$LAB_DIRECTORY/webminai-hosts.tsv" "$LAB_DIRECTORY/known_hosts"
  fi
}

print_selected_hosts() {
  local release name address
  for release in "${SELECTED_RELEASES[@]}"; do
    domain_exists "$release" || continue
    assert_lab_domain "$release"
    name=$(instance_name "$release")
    address=$(domain_ipv4 "$release")
    if [[ -n $address ]]; then
      printf '%-28s %-15s ssh -F %s %s\n' "$name" "$address" "$LAB_DIRECTORY/ssh_config" "$name"
    else
      printf '%-28s %-15s %s\n' "$name" unavailable '(start the VM to obtain an address)'
    fi
  done
}

up() {
  ensure_network
  configure_docker_forwarding
  prepare_lab_files
  prepare_vm_directory
  if [[ $VIRT_TYPE == kvm && ! -e /dev/kvm ]]; then
    fail 'KVM is unavailable; enable hardware virtualization or set WEBMINAI_FREEBSD_VIRT_TYPE=qemu for slow emulation'
  fi
  for release in "${SELECTED_RELEASES[@]}"; do
    local name state address
    name=$(instance_name "$release")
    if domain_exists "$release"; then
      assert_lab_domain "$release"
      state=$(virsh_command domstate "$name")
      if [[ $state == 'shut off' ]]; then
        printf 'Starting existing VM %s...\n' "$name"
        virsh_command start "$name" >/dev/null
      else
        printf 'Using existing VM %s (%s).\n' "$name" "$state"
      fi
    else
      prepare_base_image "$release"
      create_domain "$release"
    fi
    address=$(wait_for_ssh "$release")
    create_clean_snapshot "$release"
    address=$(domain_ipv4 "$release")
    printf 'Ready: %s at %s\n' "$name" "$address"
  done
  write_connection_files
  printf '\nFreeBSD lab is ready. Add hosts using commands from:\n  %s\n' "$LAB_DIRECTORY/webminai-hosts.tsv"
  print_selected_hosts
}

status() {
  prepare_lab_files
  write_connection_files
  printf '%-28s %-12s %-16s %-10s %s\n' DOMAIN STATE ADDRESS SNAPSHOT SSH_COMMAND
  for release in "${SELECTED_RELEASES[@]}"; do
    local name state address snapshot
    name=$(instance_name "$release")
    if domain_exists "$release"; then
      assert_lab_domain "$release"
      state=$(virsh_command domstate "$name")
      address=$(domain_ipv4 "$release")
      snapshot=no
      snapshot_exists "$release" && snapshot=yes
    else
      state=absent
      address=-
      snapshot=-
    fi
    printf '%-28s %-12s %-16s %-10s ssh -F %s %s\n' \
      "$name" "$state" "${address:--}" "$snapshot" "$LAB_DIRECTORY/ssh_config" "$name"
  done
}

stop_lab() {
  for release in "${SELECTED_RELEASES[@]}"; do
    if domain_exists "$release"; then
      local name state
      assert_lab_domain "$release"
      name=$(instance_name "$release")
      state=$(virsh_command domstate "$name")
      if [[ $state != 'shut off' ]]; then
        virsh_command shutdown "$name" >/dev/null
        wait_for_stopped "$release"
      fi
    fi
  done
}

reset_lab() {
  if [[ $YES != true ]]; then
    printf 'This discards changes made since the clean snapshots. Type reset: '
    read -r confirmation
    [[ $confirmation == reset ]] || fail 'snapshot reset cancelled'
  fi
  for release in "${SELECTED_RELEASES[@]}"; do
    domain_exists "$release" || fail "lab VM does not exist: $(instance_name "$release")"
    assert_lab_domain "$release"
    snapshot_exists "$release" || fail "clean snapshot does not exist: $(instance_name "$release")"
    printf 'Resetting %s to %s...\n' "$(instance_name "$release")" "$CLEAN_SNAPSHOT"
    virsh_command snapshot-revert "$(instance_name "$release")" "$CLEAN_SNAPSHOT" --running >/dev/null
    wait_for_ssh "$release" >/dev/null
  done
  write_connection_files
  print_selected_hosts
}

destroy_lab() {
  if [[ $YES != true ]]; then
    printf 'This permanently deletes selected FreeBSD lab VMs and their writable disks. Type destroy: '
    read -r confirmation
    [[ $confirmation == destroy ]] || fail 'destruction cancelled'
  fi
  for release in "${SELECTED_RELEASES[@]}"; do
    local name overlay seed marker user_data meta_data state
    name=$(instance_name "$release")
    overlay=$(overlay_path "$release")
    seed=$(seed_path "$release")
    marker=$(artifact_marker_path "$release")
    user_data=$VM_DIRECTORY/$name-user-data.yaml
    meta_data=$VM_DIRECTORY/$name-meta-data.yaml
    if domain_exists "$release"; then
      assert_lab_domain "$release"
      state=$(virsh_command domstate "$name")
      if [[ $state != 'shut off' ]]; then
        virsh_command destroy "$name" >/dev/null
      fi
      virsh_command undefine "$name" --managed-save --snapshots-metadata >/dev/null
    fi
    if [[ -f $marker ]]; then
      assert_artifact_marker "$release"
      rm -f -- "$overlay" "$seed" "$user_data" "$meta_data" "$marker"
      printf 'Deleted %s and its marked writable artifacts.\n' "$name"
    else
      printf 'No marked writable artifacts found for %s.\n' "$name"
    fi
  done
  prepare_lab_files
  write_connection_files
  printf 'Base image downloads, SSH keys, and configuration remain in:\n  %s\n  %s\n' "$VM_DIRECTORY" "$LAB_DIRECTORY"
}

validate_configuration
resolve_owner_paths
case "$ACTION" in
  help|-h|--help)
    usage
    ;;
  matrix)
    print_matrix
    ;;
  up)
    require_root
    require_command curl
    require_command xz
    require_command sha256sum
    require_command qemu-img
    require_command virt-install
    require_command cloud-localds
    require_command ssh
    require_command ssh-keygen
    require_command openssl
    require_libvirt
    up
    ;;
  status)
    require_command ssh-keygen
    require_libvirt
    status
    ;;
  hosts)
    require_command ssh-keygen
    require_libvirt
    prepare_lab_files
    write_connection_files
    print_selected_hosts
    ;;
  stop)
    require_root
    require_libvirt
    stop_lab
    ;;
  reset)
    require_root
    require_command ssh
    require_command ssh-keygen
    require_libvirt
    prepare_lab_files
    reset_lab
    ;;
  destroy)
    require_root
    require_command ssh-keygen
    require_libvirt
    prepare_vm_directory
    destroy_lab
    ;;
  *)
    usage >&2
    fail "unknown action: $ACTION"
    ;;
esac
