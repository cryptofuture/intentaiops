#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_NAME=${0##*/}
readonly DEFAULT_DISTROS=(
  ubuntu-2404
  debian-13
  fedora-44
  almalinux-9
  rocky-9
  opensuse-160
  arch
  alpine-323
  oracle-9
)

declare -Ar DISTRO_LABELS=(
  [ubuntu-2404]='Ubuntu 24.04 LTS'
  [debian-13]='Debian 13'
  [fedora-44]='Fedora 44'
  [almalinux-9]='AlmaLinux 9'
  [rocky-9]='Rocky Linux 9'
  [opensuse-160]='openSUSE Leap 16.0'
  [arch]='Arch Linux'
  [alpine-323]='Alpine Linux 3.23'
  [oracle-9]='Oracle Linux 9'
)

declare -Ar DISTRO_IMAGES=(
  [ubuntu-2404]='ubuntu:24.04'
  [debian-13]='images:debian/13/cloud'
  [fedora-44]='images:fedora/44/cloud'
  [almalinux-9]='images:almalinux/9/cloud'
  [rocky-9]='images:rockylinux/9/cloud'
  [opensuse-160]='images:opensuse/16.0/cloud'
  [arch]='images:archlinux/cloud'
  [alpine-323]='images:alpine/3.23/cloud'
  [oracle-9]='images:oracle/9/cloud'
)

declare -Ar DISTRO_PORT_OFFSETS=(
  [ubuntu-2404]=1
  [debian-13]=2
  [fedora-44]=3
  [almalinux-9]=4
  [rocky-9]=5
  [opensuse-160]=6
  [arch]=7
  [alpine-323]=8
  [oracle-9]=9
)

ACTION=${1:-help}
shift || true

LXD_PROJECT=${WEBMINAI_LXD_PROJECT:-default}
INSTANCE_PREFIX=${WEBMINAI_LXD_PREFIX:-webminai-}
LAB_USER=${WEBMINAI_LXD_USER:-webminai}
PORT_BASE=${WEBMINAI_LXD_PORT_BASE:-2220}
MEMORY_LIMIT=${WEBMINAI_LXD_MEMORY:-768MiB}
CPU_LIMIT=${WEBMINAI_LXD_CPUS:-2}
LAB_DIRECTORY=${WEBMINAI_LXD_DIRECTORY:-$HOME/.webminai/lxd-lab}
KEY_PATH=${WEBMINAI_LXD_KEY:-}
YES=false
SELECTED_DISTROS=()

for argument in "$@"; do
  if [[ $argument == --yes ]]; then
    YES=true
  else
    SELECTED_DISTROS+=("$argument")
  fi
done
if ((${#SELECTED_DISTROS[@]} == 0)); then
  SELECTED_DISTROS=("${DEFAULT_DISTROS[@]}")
fi

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME ACTION [DISTRO ...] [--yes]

Create nine local LXD containers with stable SSH endpoints for Intent AI Ops testing.

Actions:
  matrix              Show the default distro/image/port matrix (no LXD required)
  up [DISTRO ...]     Create, start, and provision all or selected containers
  status              Show lab instance state and SSH endpoints
  hosts               Rebuild and print Intent AI Ops-ready SSH commands
  stop [DISTRO ...]   Stop all or selected lab containers
  destroy [DISTRO ...] [--yes]
                      Permanently delete selected lab containers
  help                Show this help

Default distros:
  ${DEFAULT_DISTROS[*]}

Optional environment:
  WEBMINAI_LXD_PROJECT       LXD project (default: default)
  WEBMINAI_LXD_PREFIX        Instance and SSH alias prefix (default: webminai-)
  WEBMINAI_LXD_USER          SSH user (default: webminai)
  WEBMINAI_LXD_PORT_BASE     First port is base + 1 (default: 2220)
  WEBMINAI_LXD_MEMORY        Per-container memory limit (default: 768MiB)
  WEBMINAI_LXD_CPUS          Per-container CPU limit (default: 2)
  WEBMINAI_LXD_DIRECTORY     Keys/config/output directory
  WEBMINAI_LXD_KEY           Dedicated Ed25519 private-key path
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

validate_configuration() {
  [[ $LXD_PROJECT =~ ^[A-Za-z0-9._-]+$ ]] || fail 'invalid LXD project name'
  [[ $INSTANCE_PREFIX =~ ^[a-z0-9-]+$ ]] || fail 'instance prefix must contain lowercase letters, numbers, and hyphens'
  [[ $LAB_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'invalid lab SSH user'
  [[ $PORT_BASE =~ ^[0-9]+$ ]] || fail 'port base must be numeric'
  ((PORT_BASE >= 1024 && PORT_BASE + 9 <= 65535)) || fail 'port range must stay between 1024 and 65535'
  for distro in "${SELECTED_DISTROS[@]}"; do
    [[ -n ${DISTRO_IMAGES[$distro]:-} ]] || fail "unknown distro id: $distro"
  done
}

instance_name() {
  printf '%s%s' "$INSTANCE_PREFIX" "$1"
}

ssh_port() {
  printf '%s' "$((PORT_BASE + DISTRO_PORT_OFFSETS[$1]))"
}

print_matrix() {
  printf '%-20s %-24s %-36s %s\n' DISTRO LABEL IMAGE SSH_PORT
  for distro in "${DEFAULT_DISTROS[@]}"; do
    printf '%-20s %-24s %-36s %s\n' \
      "$distro" "${DISTRO_LABELS[$distro]}" "${DISTRO_IMAGES[$distro]}" "$(ssh_port "$distro")"
  done
}

require_lxd() {
  require_command lxc
  require_command ssh
  require_command ssh-keygen
  lxc info >/dev/null 2>&1 || fail 'cannot reach the local LXD daemon; check Snap installation and group access'
  lxc project show "$LXD_PROJECT" >/dev/null 2>&1 || fail "LXD project does not exist: $LXD_PROJECT"
}

prepare_lab_files() {
  mkdir -p "$LAB_DIRECTORY"
  chmod 700 "$LAB_DIRECTORY"
  LAB_DIRECTORY=$(cd "$LAB_DIRECTORY" && pwd -P)
  if [[ -z $KEY_PATH ]]; then
    KEY_PATH=$LAB_DIRECTORY/id_ed25519
  elif [[ $KEY_PATH != /* ]]; then
    KEY_PATH=$LAB_DIRECTORY/$KEY_PATH
  fi
  [[ $LAB_DIRECTORY != *[[:space:]]* && $KEY_PATH != *[[:space:]]* ]] || fail 'lab and key paths cannot contain whitespace'
  mkdir -p "${KEY_PATH%/*}"
  if [[ ! -f $KEY_PATH ]]; then
    ssh-keygen -q -t ed25519 -N '' -C 'webminai-lxd-test-lab' -f "$KEY_PATH"
  elif [[ ! -f $KEY_PATH.pub ]]; then
    ssh-keygen -y -f "$KEY_PATH" >"$KEY_PATH.pub"
  fi
  chmod 600 "$KEY_PATH"
  chmod 644 "$KEY_PATH.pub"
  touch "$LAB_DIRECTORY/known_hosts"
  chmod 600 "$LAB_DIRECTORY/known_hosts"
  write_ssh_config
  write_hosts_file
}

write_ssh_config() {
  local temporary=$LAB_DIRECTORY/ssh_config.new
  : >"$temporary"
  chmod 600 "$temporary"
  for distro in "${DEFAULT_DISTROS[@]}"; do
    local name
    name=$(instance_name "$distro")
    cat >>"$temporary" <<EOF
Host $name
    HostName 127.0.0.1
    Port $(ssh_port "$distro")
    User $LAB_USER
    IdentityFile $KEY_PATH
    IdentitiesOnly yes
    UserKnownHostsFile $LAB_DIRECTORY/known_hosts
    StrictHostKeyChecking accept-new

EOF
  done
  mv "$temporary" "$LAB_DIRECTORY/ssh_config"
}

write_hosts_file() {
  local temporary=$LAB_DIRECTORY/webminai-hosts.tsv.new
  printf 'name\tdistro\timage\tssh_command\n' >"$temporary"
  for distro in "${DEFAULT_DISTROS[@]}"; do
    local name
    name=$(instance_name "$distro")
    printf '%s\t%s\t%s\tssh -F %s %s\n' \
      "$name" "${DISTRO_LABELS[$distro]}" "${DISTRO_IMAGES[$distro]}" \
      "$LAB_DIRECTORY/ssh_config" "$name" >>"$temporary"
  done
  mv "$temporary" "$LAB_DIRECTORY/webminai-hosts.tsv"
  chmod 600 "$LAB_DIRECTORY/webminai-hosts.tsv"
}

verify_images() {
  printf 'Verifying remote image aliases before creating containers...\n'
  local failed=false
  for distro in "${SELECTED_DISTROS[@]}"; do
    local image=${DISTRO_IMAGES[$distro]}
    if lxc image info "$image" >/dev/null 2>&1; then
      printf '  ok  %-20s %s\n' "$distro" "$image"
    else
      printf '  missing  %-20s %s\n' "$distro" "$image" >&2
      failed=true
    fi
  done
  [[ $failed == false ]] || fail 'one or more image aliases are unavailable; run the matrix action and update the image map'
}

instance_exists() {
  lxc info "$(instance_name "$1")" --project "$LXD_PROJECT" >/dev/null 2>&1
}

assert_lab_instance() {
  local name
  name=$(instance_name "$1")
  local marker
  marker=$(lxc config get "$name" user.webminai-lab --project "$LXD_PROJECT" 2>/dev/null || true)
  [[ $marker == true ]] || fail "refusing to modify unmarked instance: $name"
}

wait_for_exec() {
  local name=$1
  for _ in {1..60}; do
    if lxc exec "$name" --project "$LXD_PROJECT" -- true >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  fail "instance did not become ready: $name"
}

install_requirements() {
  local name=$1
  lxc exec "$name" --project "$LXD_PROJECT" -- sh -ceu '
    if command -v cloud-init >/dev/null 2>&1; then
      cloud-init status --wait >/dev/null 2>&1 || true
    fi
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends openssh-server sudo curl ca-certificates iproute2 tar gzip openssl coreutils
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y openssh-server sudo curl ca-certificates iproute tar gzip openssl coreutils
    elif command -v yum >/dev/null 2>&1; then
      yum install -y openssh-server sudo curl ca-certificates iproute tar gzip openssl coreutils
    elif command -v zypper >/dev/null 2>&1; then
      zypper --non-interactive refresh
      zypper --non-interactive install openssh openssh-server sudo curl ca-certificates iproute2 tar gzip openssl coreutils
    elif command -v pacman >/dev/null 2>&1; then
      pacman -Sy --noconfirm --needed openssh sudo curl ca-certificates iproute2 tar gzip openssl coreutils
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache openssh sudo curl ca-certificates tar gzip openssl coreutils
    else
      printf "unsupported package manager\n" >&2
      exit 1
    fi
  '
}

configure_user() {
  local name=$1
  lxc exec "$name" --project "$LXD_PROJECT" -- sh -ceu '
    user=$1
    if ! id "$user" >/dev/null 2>&1; then
      if command -v useradd >/dev/null 2>&1; then
        useradd --create-home --shell /bin/sh "$user"
      else
        adduser -D -s /bin/sh "$user"
      fi
    fi
    password_field=$(getent shadow "$user" 2>/dev/null | cut -d: -f2 || true)
    case "$password_field" in
      "!"*|"*"*)
        if command -v usermod >/dev/null 2>&1; then
          usermod --password NP "$user"
        elif command -v chpasswd >/dev/null 2>&1; then
          printf "%s:NP\n" "$user" | chpasswd -e
        else
          passwd -d "$user"
        fi
        ;;
    esac
    group=$(id -gn "$user")
    install -d -m 0700 -o "$user" -g "$group" "/home/$user/.ssh"
    install -d -m 0755 /etc/sudoers.d /etc/ssh/sshd_config.d
  ' sh "$LAB_USER"
  lxc file push "$KEY_PATH.pub" "$name/home/$LAB_USER/.ssh/authorized_keys" --project "$LXD_PROJECT"
  lxc exec "$name" --project "$LXD_PROJECT" -- sh -ceu '
    user=$1
    group=$(id -gn "$user")
    chown "$user:$group" "/home/$user/.ssh/authorized_keys"
    chmod 0600 "/home/$user/.ssh/authorized_keys"
    {
      printf "Defaults:%s !targetpw\n" "$user"
      printf "%s ALL=(ALL) NOPASSWD: ALL\n" "$user"
    } > /etc/sudoers.d/webminai-lab
    chown root:root /etc/sudoers.d/webminai-lab
    chmod 0440 /etc/sudoers.d/webminai-lab
    if command -v visudo >/dev/null 2>&1; then visudo -cf /etc/sudoers.d/webminai-lab; fi
    su "$user" -c "sudo -n true" || {
      printf "passwordless sudo validation failed for %s\n" "$user" >&2
      exit 1
    }
  ' sh "$LAB_USER"
}

configure_sshd() {
  local name=$1
  lxc exec "$name" --project "$LXD_PROJECT" -- sh -ceu '
    install -d -m 0755 /run/sshd
    command -v sshd >/dev/null 2>&1 || {
      printf "OpenSSH server daemon is missing after package installation\n" >&2
      exit 1
    }
    install -d -m 0755 /etc/ssh/sshd_config.d
    touch /etc/ssh/sshd_config
    ssh-keygen -A
    cat > /etc/ssh/sshd_config.d/99-webminai-lab.conf <<EOF
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
ListenAddress 0.0.0.0
EOF
    if ! grep -Eq "^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/\\*\\.conf" /etc/ssh/sshd_config; then
      sed -i "1i Include /etc/ssh/sshd_config.d/*.conf" /etc/ssh/sshd_config
    fi
    sshd -t
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now ssh.service 2>/dev/null || systemctl enable --now sshd.service
      systemctl restart ssh.service 2>/dev/null || systemctl restart sshd.service
    elif command -v rc-service >/dev/null 2>&1; then
      rc-update add sshd default >/dev/null
      rc-service sshd restart
    else
      pkill -x sshd 2>/dev/null || true
      /usr/sbin/sshd
    fi
  '
}

configure_proxy() {
  local distro=$1
  local name
  name=$(instance_name "$distro")
  local port
  port=$(ssh_port "$distro")
  if lxc config device get "$name" webminai-ssh listen --project "$LXD_PROJECT" >/dev/null 2>&1; then
    lxc config device set "$name" webminai-ssh listen="tcp:127.0.0.1:$port" connect=tcp:127.0.0.1:22 --project "$LXD_PROJECT"
  else
    lxc config device add "$name" webminai-ssh proxy \
      "listen=tcp:127.0.0.1:$port" connect=tcp:127.0.0.1:22 --project "$LXD_PROJECT"
  fi
}

wait_for_ssh() {
  local distro=$1
  local name
  name=$(instance_name "$distro")
  local stdout_file=$LAB_DIRECTORY/$name.ssh.stdout
  local stderr_file=$LAB_DIRECTORY/$name.ssh.stderr
  local phase='TCP or public-key SSH authentication'
  ssh-keygen -q -f "$LAB_DIRECTORY/known_hosts" -R "[127.0.0.1]:$(ssh_port "$distro")" >/dev/null 2>&1 || true
  for _ in {1..60}; do
    if ssh -F "$LAB_DIRECTORY/ssh_config" -o BatchMode=yes -o ConnectTimeout=2 \
      "$name" 'printf WEBMINAI_LXD_SSH_OK' >"$stdout_file" 2>"$stderr_file" &&
      grep -q WEBMINAI_LXD_SSH_OK "$stdout_file"; then
      phase='passwordless sudo or curl validation'
      if ssh -F "$LAB_DIRECTORY/ssh_config" -o BatchMode=yes -o ConnectTimeout=2 \
        "$name" 'sudo -n true && command -v curl >/dev/null' >"$stdout_file" 2>"$stderr_file"; then
        rm -f "$stdout_file" "$stderr_file"
        return
      fi
    fi
    sleep 1
  done
  printf '\nSSH readiness failed during %s for %s.\n' "$phase" "$name" >&2
  if [[ -s $stderr_file ]]; then
    printf '%s\n' 'Last host-side SSH error:' >&2
    sed -n '1,120p' "$stderr_file" >&2
  fi
  printf '%s\n' 'LXD proxy device:' >&2
  lxc config device show "$name" --project "$LXD_PROJECT" >&2 || true
  printf '%s\n' 'Remote SSH diagnostics:' >&2
  lxc exec "$name" --project "$LXD_PROJECT" -- sh -c '
    user=$1
    systemctl --no-pager --full status sshd.service 2>&1 || true
    journalctl --no-pager -u sshd.service -n 40 2>&1 || true
    ss -ltnp 2>&1 || true
    id "$user" 2>&1 || true
    ls -ld "/home/$user" "/home/$user/.ssh" "/home/$user/.ssh/authorized_keys" 2>&1 || true
    su "$user" -c "sudo -n true" 2>&1 || true
  ' sh "$LAB_USER" >&2 || true
  fail "SSH readiness failed: $name"
}

up() {
  verify_images
  prepare_lab_files
  for distro in "${SELECTED_DISTROS[@]}"; do
    local name
    name=$(instance_name "$distro")
    if instance_exists "$distro"; then
      assert_lab_instance "$distro"
      lxc config set "$name" --project "$LXD_PROJECT" limits.cpu "$CPU_LIMIT"
      lxc config set "$name" --project "$LXD_PROJECT" limits.memory "$MEMORY_LIMIT"
      printf '\nStarting existing instance %s...\n' "$name"
      lxc start "$name" --project "$LXD_PROJECT" 2>/dev/null || true
    else
      printf '\nLaunching %s from %s...\n' "$name" "${DISTRO_IMAGES[$distro]}"
      lxc launch "${DISTRO_IMAGES[$distro]}" "$name" --project "$LXD_PROJECT" \
        --config user.webminai-lab=true \
        --config "user.webminai-distro=$distro" \
        --config boot.autostart=false \
        --config "limits.cpu=$CPU_LIMIT" \
        --config "limits.memory=$MEMORY_LIMIT"
    fi
    wait_for_exec "$name"
    printf 'Installing SSH prerequisites in %s...\n' "$name"
    install_requirements "$name"
    configure_user "$name"
    configure_sshd "$name"
    configure_proxy "$distro"
    wait_for_ssh "$distro"
    printf 'Ready: ssh -F %s %s\n' "$LAB_DIRECTORY/ssh_config" "$name"
  done
  printf '\nLab is ready. Add hosts in Intent AI Ops using the commands in:\n  %s\n' "$LAB_DIRECTORY/webminai-hosts.tsv"
  print_selected_hosts
}

print_selected_hosts() {
  for distro in "${SELECTED_DISTROS[@]}"; do
    local name
    name=$(instance_name "$distro")
    printf '%-28s ssh -F %s %s\n' "$name" "$LAB_DIRECTORY/ssh_config" "$name"
  done
}

status() {
  prepare_lab_files
  printf '%-28s %-10s %-8s %s\n' INSTANCE STATE PORT SSH_COMMAND
  for distro in "${SELECTED_DISTROS[@]}"; do
    local name state
    name=$(instance_name "$distro")
    if instance_exists "$distro"; then
      assert_lab_instance "$distro"
      state=$(lxc list "$name" --project "$LXD_PROJECT" --format csv -c s)
    else
      state=absent
    fi
    printf '%-28s %-10s %-8s ssh -F %s %s\n' \
      "$name" "$state" "$(ssh_port "$distro")" "$LAB_DIRECTORY/ssh_config" "$name"
  done
}

stop_lab() {
  for distro in "${SELECTED_DISTROS[@]}"; do
    if instance_exists "$distro"; then
      assert_lab_instance "$distro"
      lxc stop "$(instance_name "$distro")" --project "$LXD_PROJECT"
    fi
  done
}

destroy_lab() {
  if [[ $YES != true ]]; then
    printf 'This permanently deletes the selected LXD lab containers. Type destroy: '
    read -r confirmation
    [[ $confirmation == destroy ]] || fail 'destruction cancelled'
  fi
  for distro in "${SELECTED_DISTROS[@]}"; do
    if instance_exists "$distro"; then
      assert_lab_instance "$distro"
      lxc delete "$(instance_name "$distro")" --force --project "$LXD_PROJECT"
    fi
  done
  printf 'Selected lab containers were deleted. SSH keys and config remain in %s.\n' "$LAB_DIRECTORY"
}

validate_configuration
case "$ACTION" in
  help|-h|--help)
    usage
    ;;
  matrix)
    print_matrix
    ;;
  up)
    require_lxd
    up
    ;;
  status)
    require_lxd
    status
    ;;
  hosts)
    require_lxd
    prepare_lab_files
    print_selected_hosts
    ;;
  stop)
    require_lxd
    stop_lab
    ;;
  destroy)
    require_lxd
    destroy_lab
    ;;
  *)
    usage >&2
    fail "unknown action: $ACTION"
    ;;
esac
