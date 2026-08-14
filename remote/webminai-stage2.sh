#!/bin/sh
set -eu

PLATFORM=$(uname -s)
case "$PLATFORM" in
  Linux)
    PLATFORM_ID=linux
    ROOT_GROUP=root
    NETDATA_GROUP=netdata
    STATE_DIR=/var/lib/webminai
    KEY_FILE=/var/lib/webminai/action.key
    LEGACY_SUDOERS_FILE=/etc/sudoers.d/webminai
    ;;
  FreeBSD)
    PLATFORM_ID=freebsd
    ROOT_GROUP=wheel
    NETDATA_GROUP=netdata
    STATE_DIR=/var/db/webminai
    KEY_FILE=/var/db/webminai/action.key
    LEGACY_SUDOERS_FILE=/usr/local/etc/sudoers.d/webminai
    ;;
  Darwin)
    PLATFORM_ID=macos
    ROOT_GROUP=staff
    NETDATA_GROUP=staff
    STATE_DIR=/var/db/webminai
    KEY_FILE=/var/db/webminai/action.key
    LEGACY_SUDOERS_FILE=/etc/sudoers.d/webminai
    ;;
  *)
    echo "unsupported Stage 2 platform: $PLATFORM" >&2
    exit 2
    ;;
esac
: "${NETDATA_GROUP:=${ROOT_GROUP}}"
RUNNER_PATH=/usr/local/libexec/webminai-stage2
LEGACY_ROOT_HELPER_PATH=/usr/local/libexec/webminai-root
BEGIN_MARKER='# BEGIN WEBMINAI MANAGED BLOCK'
END_MARKER='# END WEBMINAI MANAGED BLOCK'
NETDATA_LXC_DROPIN=/etc/systemd/system/netdata.service.d/webminai-lxc.conf
NETDATA_ROOT_PLUGIN_DROPIN=/etc/systemd/system/netdata.service.d/webminai-root-plugin.conf
NETDATA_LXC_DAEMON_LOG=/var/log/netdata/webminai-daemon.log
NETDATA_LXC_COLLECTOR_LOG=/var/log/netdata/webminai-collector.log
NETDATA_LXC_LOGROTATE=/etc/logrotate.d/webminai-netdata

has_netdata() {
  command -v netdata >/dev/null 2>&1 ||
    [ -x /usr/sbin/netdata ] ||
    [ -x /usr/local/sbin/netdata ] ||
    [ -x /usr/local/opt/netdata/sbin/netdata ] ||
    [ -x /opt/homebrew/opt/netdata/sbin/netdata ] ||
    [ -x /opt/netdata/usr/sbin/netdata ] ||
    [ -x /opt/netdata/bin/netdata ] ||
    [ -x /usr/local/netdata/usr/sbin/netdata ] ||
    [ -x /usr/local/netdata/bin/netdata ]
}

find_homebrew() {
  for brew_path in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$brew_path" ]; then
      printf '%s\n' "$brew_path"
      return 0
    fi
  done
  return 1
}

find_homebrew_owner() {
  brew_path=$1
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && id "$SUDO_USER" >/dev/null 2>&1; then
    printf '%s\n' "$SUDO_USER"
    return 0
  fi
  brew_prefix=$(dirname "$(dirname "$brew_path")")
  for brew_directory in "$brew_prefix/Homebrew" "$brew_prefix/Cellar" "$(dirname "$brew_path")"; do
    if [ -e "$brew_directory" ]; then
      brew_owner=$(stat -f '%Su' "$brew_directory")
      if [ -n "$brew_owner" ] && [ "$brew_owner" != root ]; then
        printf '%s\n' "$brew_owner"
        return 0
      fi
    fi
  done
  echo 'could not determine the non-root Homebrew owner' >&2
  return 1
}

has_netdata_group() {
  if [ "$PLATFORM_ID" = macos ]; then
    dscl . -read /Groups/"$NETDATA_GROUP" >/dev/null 2>&1
    return $?
  fi
  if command -v getent >/dev/null 2>&1; then
    getent group netdata >/dev/null 2>&1
  elif command -v dscl >/dev/null 2>&1; then
    dscl . -read /Groups/netdata >/dev/null 2>&1
  else
    grep -Eq '^netdata:' /etc/group 2>/dev/null
  fi
}

has_static_netdata() {
  [ -x /opt/netdata/usr/sbin/netdata ] || [ -x /opt/netdata/bin/netdata ]
}

find_config_dir() {
  if has_static_netdata && [ -d /opt/netdata/etc/netdata ]; then
    printf '%s\n' /opt/netdata/etc/netdata
    return 0
  fi
  if [ "$PLATFORM_ID" = freebsd ] || [ "$PLATFORM_ID" = macos ]; then
    search_directories='/opt/homebrew/etc/netdata /usr/local/etc/netdata /usr/local/netdata/etc/netdata /opt/netdata/etc/netdata /etc/netdata'
  else
    search_directories='/etc/netdata /opt/netdata/etc/netdata /usr/local/etc/netdata'
  fi
  for directory in $search_directories; do
    if [ -d "$directory" ]; then
      printf '%s\n' "$directory"
      return 0
    fi
  done
  return 1
}

find_plugin_dir() {
  if has_static_netdata && [ -d /opt/netdata/usr/libexec/netdata/plugins.d ]; then
    printf '%s\n' /opt/netdata/usr/libexec/netdata/plugins.d
    return 0
  fi
  if [ "$PLATFORM_ID" = freebsd ] || [ "$PLATFORM_ID" = macos ]; then
    search_directories='/opt/homebrew/opt/netdata/libexec/netdata/plugins.d /usr/local/opt/netdata/libexec/netdata/plugins.d /usr/local/libexec/netdata/plugins.d /usr/local/lib/netdata/plugins.d /usr/local/netdata/usr/libexec/netdata/plugins.d /opt/netdata/usr/libexec/netdata/plugins.d'
  else
    search_directories='/usr/libexec/netdata/plugins.d /usr/lib/netdata/plugins.d /opt/netdata/usr/libexec/netdata/plugins.d /usr/local/libexec/netdata/plugins.d'
  fi
  for directory in $search_directories; do
    if [ -d "$directory" ]; then
      printf '%s\n' "$directory"
      return 0
    fi
  done
  return 1
}

restart_netdata() {
  if [ "$PLATFORM_ID" = macos ]; then
    brew_path=$(find_homebrew 2>/dev/null || true)
    if [ -n "$brew_path" ] &&
      { [ -x /usr/local/opt/netdata/sbin/netdata ] || [ -x /opt/homebrew/opt/netdata/sbin/netdata ]; }; then
      brew_owner=$(find_homebrew_owner "$brew_path")
      su -l "$brew_owner" -c "'$brew_path' services restart netdata"
      return 0
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart netdata
    return 0
  fi
  if command -v rc-service >/dev/null 2>&1; then
    if ! rc-service --exists netdata && has_static_netdata &&
      [ -f /opt/netdata/usr/lib/netdata/system/openrc/init.d/netdata ]; then
      install -o root -g "$ROOT_GROUP" -m 0755 \
        /opt/netdata/usr/lib/netdata/system/openrc/init.d/netdata \
        /etc/init.d/netdata
      if [ -f /opt/netdata/usr/lib/netdata/system/openrc/conf.d/netdata ]; then
        install -d -o root -g "$ROOT_GROUP" -m 0755 /etc/conf.d
        install -o root -g "$ROOT_GROUP" -m 0644 \
          /opt/netdata/usr/lib/netdata/system/openrc/conf.d/netdata \
          /etc/conf.d/netdata
      fi
      rc-update add netdata default
    fi
    if rc-service --exists netdata; then
      rc-service netdata restart || rc-service netdata start
      return 0
    fi
  fi
  if [ "$PLATFORM_ID" = freebsd ] && command -v service >/dev/null 2>&1; then
    if service netdata onerestart >/dev/null 2>&1; then
      return 0
    fi
    if command -v pgrep >/dev/null 2>&1 && pgrep -x netdata >/dev/null 2>&1; then
      return 0
    fi
    service netdata onestart
    return 0
  fi
  if command -v service >/dev/null 2>&1 && service netdata status >/dev/null 2>&1; then
    service netdata restart
    return 0
  fi
  if command -v pgrep >/dev/null 2>&1 && pgrep -x netdata >/dev/null 2>&1; then
    return 0
  fi
  if [ -x /opt/netdata/usr/sbin/netdata ]; then
    /opt/netdata/usr/sbin/netdata
  elif [ -x /usr/local/sbin/netdata ]; then
    /usr/local/sbin/netdata
  elif [ -x /usr/local/netdata/usr/sbin/netdata ]; then
    /usr/local/netdata/usr/sbin/netdata
  elif [ -x /usr/sbin/netdata ]; then
    /usr/sbin/netdata
  else
    echo 'Netdata is installed but no service or runnable daemon was found' >&2
    return 1
  fi
}

configure_managed_netdata_service() {
  if [ "$PLATFORM_ID" != linux ]; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1 ||
    ! command -v systemd-detect-virt >/dev/null 2>&1 ||
    [ "$(systemd-detect-virt --container 2>/dev/null || true)" != lxc ]; then
    return 0
  fi

  # In LXC, passing Netdata's journald stream through SCM_RIGHTS can truncate
  # the external-plugin spawn request. Regular log files keep the packaged
  # service sandbox intact while allowing built-in and Intent AI Ops plugins to run.
  install -d -o root -g "$ROOT_GROUP" -m 0755 "$(dirname "$NETDATA_LXC_DROPIN")"
  install -d -o root -g netdata -m 0775 "$(dirname "$NETDATA_LXC_DAEMON_LOG")"
  cat > "$NETDATA_LXC_DROPIN" <<'EOF'
[Service]
LogNamespace=
StandardOutput=append:/var/log/netdata/webminai-daemon.log
StandardError=append:/var/log/netdata/webminai-collector.log
EOF
  chmod 0644 "$NETDATA_LXC_DROPIN"
  install -d -o root -g "$ROOT_GROUP" -m 0755 "$(dirname "$NETDATA_LXC_LOGROTATE")"
  cat > "$NETDATA_LXC_LOGROTATE" <<'EOF'
/var/log/netdata/webminai-daemon.log /var/log/netdata/webminai-collector.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
EOF
  chmod 0644 "$NETDATA_LXC_LOGROTATE"
  systemctl daemon-reload
}

configure_root_plugin_service() {
  if [ "$PLATFORM_ID" != linux ] || ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi

  # Packaged Netdata units commonly restrict CapabilityBoundingSet. A setuid
  # plugin can regain only capabilities left in that boundary, which produces
  # a misleading uid=0 process that cannot perform normal root administration
  # such as signalling a package-owned service process. Intent AI Ops's plugin is an
  # explicitly token-authenticated host administrator, so restore the complete
  # host capability set for its process tree. Netdata still drops its own uid.
  install -d -o root -g "$ROOT_GROUP" -m 0755 "$(dirname "$NETDATA_ROOT_PLUGIN_DROPIN")"
  if [ -e "$NETDATA_ROOT_PLUGIN_DROPIN" ] && [ ! -f "$STATE_DIR/root-plugin-dropin-owned" ]; then
    cp -p "$NETDATA_ROOT_PLUGIN_DROPIN" "$STATE_DIR/root-plugin-dropin-backup"
  fi
  cat > "$NETDATA_ROOT_PLUGIN_DROPIN" <<'EOF'
[Service]
CapabilityBoundingSet=~
EOF
  chmod 0644 "$NETDATA_ROOT_PLUGIN_DROPIN"
  : > "$STATE_DIR/root-plugin-dropin-owned"
  systemctl daemon-reload
}

remove_root_plugin_service() {
  if [ "$PLATFORM_ID" != linux ] || [ ! -f "$STATE_DIR/root-plugin-dropin-owned" ]; then
    return 0
  fi
  if [ -f "$STATE_DIR/root-plugin-dropin-backup" ]; then
    mv -f "$STATE_DIR/root-plugin-dropin-backup" "$NETDATA_ROOT_PLUGIN_DROPIN"
  else
    rm -f "$NETDATA_ROOT_PLUGIN_DROPIN"
  fi
  rm -f "$STATE_DIR/root-plugin-dropin-owned"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
  fi
}

remove_stale_netdata_statoverrides() {
  if ! command -v dpkg-statoverride >/dev/null 2>&1; then
    return 0
  fi

  netdata_user_missing=no
  netdata_group_missing=no
  if ! getent passwd netdata >/dev/null 2>&1; then
    netdata_user_missing=yes
  fi
  if ! has_netdata_group; then
    netdata_group_missing=yes
  fi
  if [ "$netdata_user_missing" = no ] && [ "$netdata_group_missing" = no ]; then
    return 0
  fi

  dpkg-statoverride --list | while read -r owner group mode override_path; do
    remove=no
    if [ "$owner" = netdata ] && [ "$netdata_user_missing" = yes ]; then
      remove=yes
    fi
    if [ "$group" = netdata ] && [ "$netdata_group_missing" = yes ]; then
      remove=yes
    fi
    if [ "$remove" = yes ] && [ -n "$override_path" ]; then
      dpkg-statoverride --remove "$override_path"
    fi
  done
}

remove_managed_block() {
  config_file=$1
  temporary_file=$(mktemp)
  awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { managed = 1; next }
    $0 == end { managed = 0; next }
    !managed { print }
  ' "$config_file" > "$temporary_file"
  cat "$temporary_file" > "$config_file"
  rm -f "$temporary_file"
}

install_netdata() {
  if [ "$PLATFORM_ID" = freebsd ]; then
    if ! command -v pkg >/dev/null 2>&1; then
      echo 'FreeBSD pkg is required to install Netdata' >&2
      exit 2
    fi
    if ! pkg rquery -e '%n = netdata' '%n' 2>/dev/null | grep -qx netdata; then
      echo 'The FreeBSD netdata package is unavailable; install Netdata manually, then use plugin-only activation' >&2
      exit 2
    fi
    ASSUME_ALWAYS_YES=yes pkg install -y netdata
    mkdir -p "$STATE_DIR"
    chmod 0700 "$STATE_DIR"
    : > "$STATE_DIR/netdata-owned"
    if command -v sysrc >/dev/null 2>&1; then
      sysrc netdata_enable=YES >/dev/null
    fi
    restart_netdata
    return 0
  fi
  if [ "$PLATFORM_ID" = macos ]; then
    brew_path=$(find_homebrew 2>/dev/null || true)
    if [ -z "$brew_path" ]; then
      echo 'Homebrew is required to install Netdata automatically on macOS' >&2
      exit 2
    fi
    brew_owner=$(find_homebrew_owner "$brew_path")
    su -l "$brew_owner" -c "'$brew_path' install netdata"
    mkdir -p "$STATE_DIR"
    chmod 0700 "$STATE_DIR"
    : > "$STATE_DIR/netdata-owned"
    restart_netdata
    return 0
  fi
  temporary_directory=$(mktemp -d)
  trap 'rm -rf "$temporary_directory"' EXIT INT TERM
  remove_stale_netdata_statoverrides
  if command -v systemctl >/dev/null 2>&1; then
    # Netdata's uninstaller may mask these units. Remove stale masks before a
    # managed reinstall so the installer can install and start them.
    systemctl unmask netdata.service netdata-updater.timer >/dev/null 2>&1 || true
  fi
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/kickstart.sh" \
    https://get.netdata.cloud/kickstart.sh
  DISABLE_TELEMETRY=1 sh "$temporary_directory/kickstart.sh" \
    --non-interactive \
    --release-channel stable \
    --no-updates
  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  : > "$STATE_DIR/netdata-owned"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    systemctl unmask netdata.service >/dev/null 2>&1 || true
    systemctl enable netdata.service >/dev/null 2>&1 || true
    systemctl restart netdata.service
  elif [ "$PLATFORM_ID" = freebsd ]; then
    if command -v sysrc >/dev/null 2>&1; then
      sysrc netdata_enable=YES >/dev/null
    fi
    service netdata restart >/dev/null 2>&1 || service netdata start
  fi
  rm -rf "$temporary_directory"
  trap - EXIT INT TERM
}

activate() {
  plugin_source=$1
  netdata_mode=${2:-install-if-needed}
  plugin_version=${3:-}
  if [ ! -f "$plugin_source" ]; then
    echo 'plugin artifact is missing' >&2
    exit 2
  fi
  chmod 0700 "$plugin_source"
  case "$plugin_version" in
    ''|*[!0-9A-Za-z.-]*) echo 'invalid plugin version' >&2; exit 2 ;;
  esac
  artifact_platform=$("$plugin_source" --platform 2>/dev/null || true)
  if [ "$artifact_platform" != "$PLATFORM_ID" ]; then
    echo "plugin artifact platform mismatch: expected $PLATFORM_ID, received ${artifact_platform:-unknown}" >&2
    exit 2
  fi
  artifact_version=$("$plugin_source" --version 2>/dev/null || true)
  if [ "$artifact_version" != "$plugin_version" ]; then
    echo "plugin artifact version mismatch: expected $plugin_version, received ${artifact_version:-unknown}" >&2
    exit 2
  fi

  IFS= read -r action_key
  case "$action_key" in
    *[!0-9a-fA-F]*|'') echo 'invalid action key' >&2; exit 2 ;;
  esac
  if [ "${#action_key}" -ne 64 ]; then
    echo 'invalid action key length' >&2
    exit 2
  fi

  ownership=preexisting
  netdata_action=existing
  if [ -f "$STATE_DIR/netdata-owned" ]; then
    ownership=managed
  elif ! has_netdata; then
    if [ "$netdata_mode" = require-existing ]; then
      echo 'Netdata is not installed; plugin-only activation requires an existing Netdata installation' >&2
      exit 2
    elif [ "$netdata_mode" = install-if-needed ]; then
      install_netdata
      mkdir -p "$STATE_DIR"
      chmod 0700 "$STATE_DIR"
      : > "$STATE_DIR/netdata-owned"
      ownership=managed
      netdata_action=installed
    else
      echo 'invalid Netdata activation mode' >&2
      exit 2
    fi
  fi

  config_dir=$(find_config_dir)
  plugin_dir=$(find_plugin_dir)
  if ! has_netdata_group; then
    echo 'Netdata group is missing after installation' >&2
    exit 2
  fi
  plugin_target="$plugin_dir/webminai.plugin"
  previous_plugin_version=none
  plugin_action=installed
  if [ -e "$plugin_target" ]; then
    previous_plugin_version=unknown
    if [ -f "$STATE_DIR/plugin-version" ]; then
      previous_plugin_version=$(cat "$STATE_DIR/plugin-version")
    fi
    if cmp -s "$plugin_source" "$plugin_target"; then
      plugin_action=unchanged
    else
      plugin_action=updated
      rm -f "$STATE_DIR/plugin-backup" "$STATE_DIR/plugin-version-before"
      cp -p "$plugin_target" "$STATE_DIR/plugin-backup"
      if [ -f "$STATE_DIR/plugin-version" ]; then
        cp -p "$STATE_DIR/plugin-version" "$STATE_DIR/plugin-version-before"
      fi
    fi
  fi
  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  if [ "$ownership" = managed ]; then
    configure_managed_netdata_service
  fi
  configure_root_plugin_service
  install -d -o root -g "$ROOT_GROUP" -m 0755 /usr/local/libexec

  install -o root -g "$ROOT_GROUP" -m 0755 "$0" "$RUNNER_PATH"
  rm -f "$LEGACY_SUDOERS_FILE" "$LEGACY_ROOT_HELPER_PATH"
  install -o root -g "$NETDATA_GROUP" -m 4750 "$plugin_source" "$plugin_target"
  printf '%s\n' "$plugin_target" > "$STATE_DIR/plugin-path"
  printf '%s\n' "$plugin_version" > "$STATE_DIR/plugin-version"
  if [ "$ownership" = managed ]; then
    : > "$STATE_DIR/netdata-owned"
  fi

  umask 027
  printf '%s\n' "$action_key" > "$KEY_FILE"
  chown root:"$ROOT_GROUP" "$KEY_FILE"
  chmod 0600 "$KEY_FILE"

  config_file="$config_dir/netdata.conf"
  touch "$config_file"
  remove_managed_block "$config_file"
  cat >> "$config_file" <<'EOF'
# BEGIN WEBMINAI MANAGED BLOCK
[plugins]
    check for new plugins every = 1
    webminai = yes
EOF

  cat >> "$config_file" <<'EOF'
[web]
    bind to = 127.0.0.1
    allow connections from = localhost
    allow dashboard from = localhost
EOF

  cat >> "$config_file" <<'EOF'
# END WEBMINAI MANAGED BLOCK
EOF
  chown root:"$NETDATA_GROUP" "$config_file"
  chmod 0640 "$config_file"

  if [ "$PLATFORM_ID" = macos ]; then
    # Netdata's macOS spawn supervisor starts asynchronously. If the plugin is
    # present during daemon startup, its first launch can race the supervisor
    # socket and Netdata disables it for the lifetime of that process.
    rm -f "$plugin_target"
    restart_netdata
    attempts=0
    while ! curl --fail --silent --output /dev/null \
      http://127.0.0.1:19999/api/v3/info; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 100 ]; then
        echo 'Netdata API did not become ready after restart' >&2
        exit 1
      fi
      sleep 0.1
    done
    # The API can become ready just before the asynchronous spawn supervisor.
    # Give that child process one full scheduling interval before live discovery.
    sleep 1
    install -o root -g "$NETDATA_GROUP" -m 4750 "$plugin_source" "$plugin_target"
  else
    restart_netdata
  fi
  printf 'WEBMINAI_RESULT {"ownership":"%s","status":"active","platform":"%s","netdataAction":"%s","pluginAction":"%s","pluginVersion":"%s","previousPluginVersion":"%s"}\n' \
    "$ownership" "$PLATFORM_ID" "$netdata_action" "$plugin_action" "$plugin_version" "$previous_plugin_version"
}

commit_activation() {
  rm -f "$STATE_DIR/plugin-backup" "$STATE_DIR/plugin-version-before"
  printf 'WEBMINAI_RESULT {"status":"committed"}\n'
}

rollback_activation() {
  if [ ! -f "$STATE_DIR/plugin-backup" ] || [ ! -f "$STATE_DIR/plugin-path" ]; then
    deactivate keep-netdata
    return 0
  fi
  plugin_path=$(cat "$STATE_DIR/plugin-path")
  install -o root -g "$NETDATA_GROUP" -m 4750 "$STATE_DIR/plugin-backup" "$plugin_path"
  if [ -f "$STATE_DIR/plugin-version-before" ]; then
    install -o root -g "$ROOT_GROUP" -m 0600 "$STATE_DIR/plugin-version-before" "$STATE_DIR/plugin-version"
  else
    rm -f "$STATE_DIR/plugin-version"
  fi
  rm -f "$STATE_DIR/plugin-backup" "$STATE_DIR/plugin-version-before"
  restart_netdata
  printf 'WEBMINAI_RESULT {"status":"restored"}\n'
}

claim_cloud() {
  if ! has_netdata; then
    echo 'Netdata is not installed; Cloud claiming requires an existing Agent' >&2
    exit 2
  fi
  IFS= read -r claim_token
  IFS= read -r claim_url
  IFS= read -r claim_rooms
  if [ "${#claim_token}" -lt 32 ] || [ "${#claim_token}" -gt 512 ] ||
    ! printf '%s' "$claim_token" | grep -Eq '^[A-Za-z0-9_-]+$'; then
    echo 'invalid Netdata Cloud claim token' >&2
    exit 2
  fi
  if ! printf '%s' "$claim_url" |
    grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~!$&()*+,;=:@%/-]*)?$'; then
    echo 'invalid Netdata Cloud claim URL' >&2
    exit 2
  fi
  if ! printf '%s' "$claim_rooms" |
    grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$'; then
    echo 'invalid Netdata Cloud room IDs' >&2
    exit 2
  fi

  config_dir=$(find_config_dir)
  claim_file="$config_dir/claim.conf"
  temporary_claim=$(mktemp "$config_dir/.webminai-claim.XXXXXXXX")
  trap 'rm -f "$temporary_claim"' EXIT INT TERM
  umask 027
  printf '%s\n' '[global]' "    url = $claim_url" "    token = $claim_token" "    rooms = $claim_rooms" > "$temporary_claim"
  chown root:netdata "$temporary_claim"
  chmod 0640 "$temporary_claim"
  mv -f "$temporary_claim" "$claim_file"
  trap - EXIT INT TERM

  reloaded=no
  for netdatacli_path in \
    /usr/sbin/netdatacli \
    /usr/bin/netdatacli \
    /usr/local/sbin/netdatacli \
    /usr/local/bin/netdatacli \
    /opt/netdata/usr/sbin/netdatacli \
    /opt/netdata/bin/netdatacli; do
    if [ -x "$netdatacli_path" ] && "$netdatacli_path" reload-claiming-state; then
      reloaded=yes
      break
    fi
  done
  if [ "$reloaded" = no ]; then
    restart_netdata
  fi
  printf 'WEBMINAI_RESULT {"status":"configured","reload":"%s"}\n' "$reloaded"
}

uninstall_managed_netdata() {
  if [ "$PLATFORM_ID" = macos ]; then
    brew_path=$(find_homebrew 2>/dev/null || true)
    if [ -n "$brew_path" ]; then
      brew_owner=$(find_homebrew_owner "$brew_path")
      su -l "$brew_owner" -c "'$brew_path' services stop netdata >/dev/null 2>&1 || true; '$brew_path' uninstall --force netdata"
      brew_prefix=$(dirname "$(dirname "$brew_path")")
      case "$brew_prefix" in
        /usr/local|/opt/homebrew) ;;
        *) echo "unsafe Homebrew prefix: $brew_prefix" >&2; return 1 ;;
      esac
      for managed_directory in \
        "$brew_prefix/etc/netdata" \
        "$brew_prefix/var/lib/netdata" \
        "$brew_prefix/var/cache/netdata" \
        "$brew_prefix/var/log/netdata" \
        "$brew_prefix/var/run/netdata"; do
        if [ -e "$managed_directory" ]; then
          find "$managed_directory" -depth -delete
        fi
      done
      return 0
    fi
  fi
  if [ "$PLATFORM_ID" = freebsd ] && command -v pkg >/dev/null 2>&1 && pkg info -e netdata; then
    service netdata stop >/dev/null 2>&1 || true
    ASSUME_ALWAYS_YES=yes pkg delete -y netdata
    return 0
  fi
  if [ -x /usr/local/libexec/netdata/netdata-uninstaller.sh ] &&
    [ -f /usr/local/etc/netdata/.environment ]; then
    /usr/local/libexec/netdata/netdata-uninstaller.sh \
      --yes --force --env /usr/local/etc/netdata/.environment
    return 0
  fi
  if [ -x /usr/local/netdata/usr/libexec/netdata/netdata-uninstaller.sh ] &&
    [ -f /usr/local/netdata/etc/netdata/.environment ]; then
    /usr/local/netdata/usr/libexec/netdata/netdata-uninstaller.sh \
      --yes --force --env /usr/local/netdata/etc/netdata/.environment
    return 0
  fi
  if [ -x /opt/netdata/usr/libexec/netdata/netdata-uninstaller.sh ] &&
    [ -f /opt/netdata/etc/netdata/.environment ]; then
    /opt/netdata/usr/libexec/netdata/netdata-uninstaller.sh \
      --yes --force --env /opt/netdata/etc/netdata/.environment
    return 0
  fi
  if [ -x /usr/libexec/netdata/netdata-uninstaller.sh ] &&
    [ -f /etc/netdata/.environment ]; then
    /usr/libexec/netdata/netdata-uninstaller.sh \
      --yes --force --env /etc/netdata/.environment
    return 0
  fi

  temporary_directory=$(mktemp -d)
  trap 'rm -rf "$temporary_directory"' EXIT INT TERM
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/kickstart.sh" \
    https://get.netdata.cloud/kickstart.sh
  sh "$temporary_directory/kickstart.sh" --uninstall --non-interactive
}

cancel_webminai_jobs() {
  job_root="$STATE_DIR/jobs"
  [ -d "$job_root" ] || return 0

  for pid_file in "$job_root"/*/pid; do
    [ -f "$pid_file" ] || continue
    job_pid=$(sed -n '1p' "$pid_file" 2>/dev/null || true)
    case "$job_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$job_pid" -gt 1 ] || continue
    kill -TERM "-$job_pid" 2>/dev/null || kill -TERM "$job_pid" 2>/dev/null || true
  done
  sleep 1
  for pid_file in "$job_root"/*/pid; do
    [ -f "$pid_file" ] || continue
    job_pid=$(sed -n '1p' "$pid_file" 2>/dev/null || true)
    case "$job_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$job_pid" -gt 1 ] || continue
    kill -KILL "-$job_pid" 2>/dev/null || kill -KILL "$job_pid" 2>/dev/null || true
  done
  for controller_file in "$job_root"/*/controller.pid; do
    [ -f "$controller_file" ] || continue
    controller_pid=$(sed -n '1p' "$controller_file" 2>/dev/null || true)
    case "$controller_pid" in ''|*[!0-9]*) continue ;; esac
    [ "$controller_pid" -gt 1 ] || continue
    kill -KILL "$controller_pid" 2>/dev/null || true
  done
  rm -rf -- "$job_root"
}

deactivate() {
  removal=${1:-keep-netdata}
  config_dir=$(find_config_dir 2>/dev/null || true)
  plugin_path=''
  if [ -f "$STATE_DIR/plugin-path" ]; then
    plugin_path=$(cat "$STATE_DIR/plugin-path")
  fi

  cancel_webminai_jobs
  rm -f "$KEY_FILE"
  rm -f "$LEGACY_SUDOERS_FILE" "$LEGACY_ROOT_HELPER_PATH"
  if [ -n "$plugin_path" ]; then
    rm -f "$plugin_path"
  fi
  if [ -n "$config_dir" ] && [ -f "$config_dir/netdata.conf" ]; then
    remove_managed_block "$config_dir/netdata.conf"
  fi
  remove_root_plugin_service

  ownership=preexisting
  if [ -f "$STATE_DIR/netdata-owned" ]; then
    ownership=managed
  fi

  if [ "$removal" = remove-managed ] && [ "$ownership" = managed ]; then
    uninstall_managed_netdata
    rm -f "$NETDATA_LXC_DROPIN"
    rm -f "$NETDATA_LXC_DAEMON_LOG" "$NETDATA_LXC_COLLECTOR_LOG"
    rm -f "$NETDATA_LXC_LOGROTATE"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload
    fi
    status=removed
  else
    restart_netdata
    status=inactive
  fi

  rm -rf "$STATE_DIR"
  if [ "$status" = inactive ] && [ "$ownership" = managed ]; then
    mkdir -p "$STATE_DIR"
    chmod 0700 "$STATE_DIR"
    : > "$STATE_DIR/netdata-owned"
  fi
  rm -f "$RUNNER_PATH"
  printf 'WEBMINAI_RESULT {"ownership":"%s","status":"%s","platform":"%s"}\n' "$ownership" "$status" "$PLATFORM_ID"
}

case "${1:-}" in
  activate) activate "${2:-}" "${3:-install-if-needed}" "${4:-}" ;;
  claim) claim_cloud ;;
  commit) commit_activation ;;
  rollback-activation) rollback_activation ;;
  deactivate) deactivate "${2:-keep-netdata}" ;;
  *) echo 'usage: webminai-stage2 activate PLUGIN [install-if-needed|require-existing] VERSION | claim | commit | rollback-activation | deactivate [keep-netdata|remove-managed]' >&2; exit 2 ;;
esac
