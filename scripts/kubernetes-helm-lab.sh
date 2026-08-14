#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_NAME=${0##*/}
readonly LAB_FORMAT='webminai-kubernetes-helm-lab-v1'

ACTION=${1:-help}
shift || true

CLUSTER_NAME=${WEBMINAI_K8S_CLUSTER_NAME:-webminai-k8s}
KUBE_CONTEXT="kind-$CLUSTER_NAME"
NETDATA_NAMESPACE=${WEBMINAI_K8S_NETDATA_NAMESPACE:-webminai-netdata}
NETDATA_RELEASE=${WEBMINAI_K8S_NETDATA_RELEASE:-netdata}
WORKLOAD_NAMESPACE=${WEBMINAI_K8S_WORKLOAD_NAMESPACE:-webminai-lab-workload}
EXECUTOR_NAMESPACE=${WEBMINAI_K8S_EXECUTOR_NAMESPACE:-webminai-stage2-lab}
LOCAL_API_PORT=${WEBMINAI_K8S_LOCAL_API_PORT:-21999}
WAIT_TIMEOUT=${WEBMINAI_K8S_WAIT_TIMEOUT:-10m}
NODE_IMAGE=${WEBMINAI_K8S_NODE_IMAGE:-}
CHART_VERSION=${WEBMINAI_K8S_NETDATA_CHART_VERSION:-}
STAGE2_VALUES=${WEBMINAI_K8S_STAGE2_VALUES:-}
KUBECTL_MINOR=${WEBMINAI_K8S_KUBECTL_MINOR:-v1.36}
KIND_VERSION=${WEBMINAI_K8S_KIND_VERSION:-v0.32.0}
LAB_DIRECTORY=${WEBMINAI_K8S_LAB_DIRECTORY:-$HOME/.webminai/kubernetes-helm-lab}
MARKER_PATH=$LAB_DIRECTORY/cluster.marker
KIND_CONFIG=$LAB_DIRECTORY/kind.yaml
NETDATA_VALUES=$LAB_DIRECTORY/netdata-values.yaml
PORT_FORWARD_LOG=$LAB_DIRECTORY/port-forward.log
INTERNAL_KUBECONFIG=$LAB_DIRECTORY/kubeconfig.internal
CONTAINER_KUBECONFIG=$LAB_DIRECTORY/kubeconfig.container
CONTAINER_ROUTE_STATE=$LAB_DIRECTORY/container-route.state
CONTAINER_NETWORK_STATE=$LAB_DIRECTORY/container-network.state
YES=false
BOOTSTRAP_DIRECTORY=

for argument in "$@"; do
  case $argument in
    --yes) YES=true ;;
    --*) printf 'error: unknown option: %s\n' "$argument" >&2; exit 1 ;;
    *) printf 'error: unexpected argument: %s\n' "$argument" >&2; exit 1 ;;
  esac
done

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME ACTION [--yes]

Create a disposable three-node kind cluster that starts without Netdata or a
Intent AI Ops plugin, ready for testing the real Stage 2 activation lifecycle.

Actions:
  bootstrap       Install the required host tools on Ubuntu 26.04
  up              Create or update the cluster and sample workload only
  status          Show nodes, workload, and optional monitoring state
  verify          Verify the pre-Stage-2 cluster and sample workload
  monitoring-up   Install optional existing Netdata through its Helm chart
  monitoring-verify Verify the optional Netdata topology and parent API
  monitoring-remove [--yes] Remove Netdata but preserve the cluster
  container-kubeconfig Write a kind-internal kubeconfig for a Docker container
  container-network-up Connect Intent AI Ops to kind and write its kubeconfig
  container-network-down Disconnect the managed Intent AI Ops container from kind
  container-route-up Add narrow host routing for an external Intent AI Ops container
  container-route-down Remove the managed host routing and routed kubeconfig
  node-test       Run one short-lived privileged host-root Job per node
  access          Keep a foreground Netdata API port-forward on loopback
  reset [--yes]   Remove and reinstall lab namespaces inside the cluster
  destroy [--yes] Delete only the marker-owned kind cluster
  help            Show this help

Required tools:
  docker, kind, kubectl, helm, curl

The baseline contains one control-plane, two workers, and an nginx workload.
It intentionally has no Netdata or Intent AI Ops plugin so Intent AI Ops can activate
Stage 2 on an already-running cluster. monitoring-up separately models a
cluster where the normal Netdata Helm chart was installed before activation.

Optional environment:
  WEBMINAI_K8S_CLUSTER_NAME          kind cluster name (default: webminai-k8s)
  WEBMINAI_K8S_LAB_DIRECTORY        generated files and marker directory
  WEBMINAI_K8S_NODE_IMAGE           optional pinned kind node image
  WEBMINAI_K8S_NETDATA_CHART_VERSION optional pinned Netdata chart version
  WEBMINAI_K8S_STAGE2_VALUES        optional absolute Helm values overlay
  WEBMINAI_K8S_KUBECTL_MINOR        kubectl APT stream (default: v1.36)
  WEBMINAI_K8S_KIND_VERSION         kind release (default: v0.32.0)
  WEBMINAI_K8S_CLIENT_IP            exact Intent AI Ops container IPv4 address
  WEBMINAI_CONTAINER_NAME           Intent AI Ops container name or ID
  WEBMINAI_K8S_LOCAL_API_PORT       loopback API port (default: 21999)
  WEBMINAI_K8S_WAIT_TIMEOUT         kubectl/Helm timeout (default: 10m)

Security boundary:
  node-test uses privileged pods, hostPID, and a read-write hostPath mount of /.
  That is equivalent to root on each selected node. It is guarded by the local
  lab marker and kind context, uses a fixed diagnostic command, and leaves no
  persistent executor DaemonSet or node plugin behind.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

as_root() {
  if ((EUID == 0)); then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || fail 'sudo is required to install host tools'
    sudo "$@"
  fi
}

cleanup_bootstrap() {
  if [[ -n ${BOOTSTRAP_DIRECTORY:-} && -d $BOOTSTRAP_DIRECTORY &&
    $BOOTSTRAP_DIRECTORY == "${TMPDIR:-/tmp}"/webminai-k8s-bootstrap.* ]]; then
    rm -rf -- "$BOOTSTRAP_DIRECTORY"
  fi
  BOOTSTRAP_DIRECTORY=
}

bootstrap_host() {
  [[ -r /etc/os-release ]] || fail '/etc/os-release is unavailable'
  local distribution version architecture kind_architecture helm_fingerprint actual_fingerprint
  distribution=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
  version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
  [[ $distribution == ubuntu && $version == 26.04 ]] || fail "bootstrap supports Ubuntu 26.04; detected $distribution $version"
  [[ $KUBECTL_MINOR =~ ^v[0-9]+\.[0-9]+$ ]] || fail 'invalid kubectl minor version'
  [[ $KIND_VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid kind version'
  architecture=$(dpkg --print-architecture)
  case $architecture in
    amd64) kind_architecture=amd64 ;;
    arm64) kind_architecture=arm64 ;;
    *) fail "bootstrap supports amd64 and arm64; detected $architecture" ;;
  esac

  require_command apt-get
  require_command dpkg
  BOOTSTRAP_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/webminai-k8s-bootstrap.XXXXXXXX")
  trap cleanup_bootstrap EXIT INT TERM

  printf 'Installing base packages through Ubuntu APT...\n'
  as_root apt-get update
  as_root apt-get install -y ca-certificates curl gnupg apt-transport-https
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Installing Docker from the Ubuntu archive...\n'
    as_root apt-get install -y docker.io
    as_root systemctl enable --now docker
  else
    printf 'Using the existing Docker installation.\n'
  fi

  printf 'Configuring the Kubernetes kubectl APT repository (%s)...\n' "$KUBECTL_MINOR"
  curl -fsSL "https://pkgs.k8s.io/core:/stable:/$KUBECTL_MINOR/deb/Release.key" \
    -o "$BOOTSTRAP_DIRECTORY/kubernetes.asc"
  gpg --batch --yes --dearmor \
    --output "$BOOTSTRAP_DIRECTORY/kubernetes.gpg" "$BOOTSTRAP_DIRECTORY/kubernetes.asc"
  printf 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/%s/deb/ /\n' \
    "$KUBECTL_MINOR" > "$BOOTSTRAP_DIRECTORY/kubernetes.list"

  printf 'Configuring the Helm APT repository...\n'
  helm_fingerprint=DDF78C3E6EBB2D2CC223C95C62BA89D07698DBC6
  curl -fsSL https://packages.buildkite.com/helm-linux/helm-debian/gpgkey \
    -o "$BOOTSTRAP_DIRECTORY/helm.asc"
  actual_fingerprint=$(gpg --show-keys --with-colons "$BOOTSTRAP_DIRECTORY/helm.asc" |
    awk -F: '$1 == "fpr" && !found {print $10; found=1}')
  [[ $actual_fingerprint == "$helm_fingerprint" ]] || fail "unexpected Helm APT key fingerprint: $actual_fingerprint"
  gpg --batch --yes --dearmor --output "$BOOTSTRAP_DIRECTORY/helm.gpg" "$BOOTSTRAP_DIRECTORY/helm.asc"
  printf '%s\n' \
    'deb [signed-by=/etc/apt/keyrings/helm.gpg] https://packages.buildkite.com/helm-linux/helm-debian/any/ any main' \
    > "$BOOTSTRAP_DIRECTORY/helm.list"

  as_root install -d -m 0755 /etc/apt/keyrings
  as_root install -m 0644 "$BOOTSTRAP_DIRECTORY/kubernetes.gpg" /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  as_root install -m 0644 "$BOOTSTRAP_DIRECTORY/kubernetes.list" /etc/apt/sources.list.d/kubernetes.list
  as_root install -m 0644 "$BOOTSTRAP_DIRECTORY/helm.gpg" /etc/apt/keyrings/helm.gpg
  as_root install -m 0644 "$BOOTSTRAP_DIRECTORY/helm.list" /etc/apt/sources.list.d/helm-stable-debian.list
  as_root apt-get update
  as_root apt-get install -y kubectl helm

  if ! command -v kind >/dev/null 2>&1; then
    printf 'Installing verified kind %s release binary...\n' "$KIND_VERSION"
    local kind_name="kind-linux-$kind_architecture"
    curl -fsSL "https://kind.sigs.k8s.io/dl/$KIND_VERSION/$kind_name" \
      -o "$BOOTSTRAP_DIRECTORY/$kind_name"
    curl -fsSL "https://kind.sigs.k8s.io/dl/$KIND_VERSION/$kind_name.sha256sum" \
      -o "$BOOTSTRAP_DIRECTORY/$kind_name.sha256sum"
    (cd "$BOOTSTRAP_DIRECTORY" && sha256sum --check "$kind_name.sha256sum")
    as_root install -m 0755 "$BOOTSTRAP_DIRECTORY/$kind_name" /usr/local/bin/kind
  fi

  if ((EUID != 0)) && ! id -nG | tr ' ' '\n' | grep -Fqx docker; then
    as_root usermod -aG docker "$(id -un)"
    printf 'Added %s to the docker group. Log out and back in before running the lab.\n' "$(id -un)"
  fi
  cleanup_bootstrap
  trap - EXIT INT TERM
  printf '\nInstalled host tools:\n'
  docker --version
  kind version
  kubectl version --client
  helm version --short
  curl --version | sed -n '1p'
}

validate_configuration() {
  [[ $CLUSTER_NAME =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || fail 'cluster name must contain lowercase letters, numbers, and hyphens'
  [[ $NETDATA_NAMESPACE =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail 'invalid Netdata namespace'
  [[ $WORKLOAD_NAMESPACE =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail 'invalid workload namespace'
  [[ $EXECUTOR_NAMESPACE =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail 'invalid executor namespace'
  [[ $LOCAL_API_PORT =~ ^[0-9]+$ ]] && ((LOCAL_API_PORT >= 1024 && LOCAL_API_PORT <= 65535)) || fail 'local API port must be between 1024 and 65535'
  [[ $LAB_DIRECTORY == /* && $LAB_DIRECTORY != / && $LAB_DIRECTORY != "$HOME" ]] || fail 'lab directory must be a narrow absolute path'
  [[ $LAB_DIRECTORY != *[[:space:]]* ]] || fail 'lab directory cannot contain whitespace'
  if [[ -n $STAGE2_VALUES ]]; then
    [[ $STAGE2_VALUES == /* && -f $STAGE2_VALUES ]] || fail 'WEBMINAI_K8S_STAGE2_VALUES must name a readable absolute file'
  fi
}

require_tools() {
  local command
  for command in docker kind kubectl helm curl; do
    require_command "$command"
  done
  docker info >/dev/null 2>&1 || fail 'Docker is not reachable; start it or grant this user access'
}

cluster_exists() {
  kind get clusters 2>/dev/null | grep -Fqx "$CLUSTER_NAME"
}

write_marker() {
  install -d -m 0700 "$LAB_DIRECTORY"
  umask 077
  printf 'format=%s\ncluster=%s\ncontext=%s\n' "$LAB_FORMAT" "$CLUSTER_NAME" "$KUBE_CONTEXT" > "$MARKER_PATH"
  chmod 0600 "$MARKER_PATH"
}

assert_marker() {
  [[ -f $MARKER_PATH ]] || fail "lab marker is missing: $MARKER_PATH"
  grep -Fqx "format=$LAB_FORMAT" "$MARKER_PATH" || fail 'lab marker format does not match'
  grep -Fqx "cluster=$CLUSTER_NAME" "$MARKER_PATH" || fail 'lab marker cluster does not match'
  grep -Fqx "context=$KUBE_CONTEXT" "$MARKER_PATH" || fail 'lab marker context does not match'
}

assert_cluster() {
  assert_marker
  cluster_exists || fail "marked kind cluster is not running: $CLUSTER_NAME"
  kubectl config get-contexts "$KUBE_CONTEXT" >/dev/null 2>&1 || fail "kubectl context is missing: $KUBE_CONTEXT"
}

kubectl_lab() {
  kubectl --context "$KUBE_CONTEXT" "$@"
}

kubectl_gateway() {
  kubectl --context "$KUBE_CONTEXT" \
    --as="system:serviceaccount:$EXECUTOR_NAMESPACE:webminai-stage2-gateway" "$@"
}

helm_lab() {
  helm --kube-context "$KUBE_CONTEXT" "$@"
}

write_kind_config() {
  install -d -m 0700 "$LAB_DIRECTORY"
  umask 077
  printf '%s\n' \
    'kind: Cluster' \
    'apiVersion: kind.x-k8s.io/v1alpha4' \
    'nodes:' \
    '- role: control-plane' \
    '- role: worker' \
    '- role: worker' > "$KIND_CONFIG"
  chmod 0600 "$KIND_CONFIG"
}

write_netdata_values() {
  install -d -m 0700 "$LAB_DIRECTORY"
  umask 077
  printf '%s\n' \
    'ingress:' \
    '  enabled: false' \
    'restarter:' \
    '  enabled: false' \
    'parent:' \
    '  database:' \
    '    persistence: false' \
    '  alarms:' \
    '    persistence: false' \
    'child:' \
    '  persistence:' \
    '    enabled: false' \
    'k8sState:' \
    '  persistence:' \
    '    enabled: false' > "$NETDATA_VALUES"
  chmod 0600 "$NETDATA_VALUES"
}

create_cluster() {
  if cluster_exists; then
    assert_marker
    printf 'Using existing marker-owned kind cluster %s.\n' "$CLUSTER_NAME"
    return
  fi
  if [[ -e $MARKER_PATH ]]; then
    assert_marker
  fi
  write_kind_config
  local arguments=(create cluster --name "$CLUSTER_NAME" --config "$KIND_CONFIG" --wait "$WAIT_TIMEOUT")
  if [[ -n $NODE_IMAGE ]]; then
    arguments+=(--image "$NODE_IMAGE")
  fi
  printf 'Creating three-node kind cluster %s...\n' "$CLUSTER_NAME"
  kind "${arguments[@]}"
  write_marker
}

install_netdata() {
  write_netdata_values
  helm repo add netdata https://netdata.github.io/helmchart/ --force-update >/dev/null
  helm repo update netdata >/dev/null
  local arguments=(upgrade --install "$NETDATA_RELEASE" netdata/netdata
    --kube-context "$KUBE_CONTEXT"
    --namespace "$NETDATA_NAMESPACE"
    --create-namespace
    --values "$NETDATA_VALUES"
    --wait
    --timeout "$WAIT_TIMEOUT")
  if [[ -n $CHART_VERSION ]]; then
    arguments+=(--version "$CHART_VERSION")
  fi
  if [[ -n $STAGE2_VALUES ]]; then
    arguments+=(--values "$STAGE2_VALUES")
  fi
  printf 'Installing or upgrading Netdata with Helm...\n'
  helm "${arguments[@]}"
}

install_sample_workload() {
  kubectl_lab create namespace "$WORKLOAD_NAMESPACE" --dry-run=client -o yaml | kubectl_lab apply -f - >/dev/null
  kubectl_lab apply -f - <<EOF >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webminai-nginx
  namespace: $WORKLOAD_NAMESPACE
  labels:
    app.kubernetes.io/name: webminai-nginx
    webminai.io/lab: kubernetes-helm
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: webminai-nginx
  template:
    metadata:
      labels:
        app.kubernetes.io/name: webminai-nginx
        webminai.io/lab: kubernetes-helm
    spec:
      containers:
      - name: nginx
        image: nginx:alpine
        ports:
        - name: http
          containerPort: 80
        resources:
          requests:
            cpu: 10m
            memory: 16Mi
          limits:
            cpu: 100m
            memory: 64Mi
---
apiVersion: v1
kind: Service
metadata:
  name: webminai-nginx
  namespace: $WORKLOAD_NAMESPACE
  labels:
    webminai.io/lab: kubernetes-helm
spec:
  selector:
    app.kubernetes.io/name: webminai-nginx
  ports:
  - name: http
    port: 80
    targetPort: http
EOF
  kubectl_lab rollout status deployment/webminai-nginx -n "$WORKLOAD_NAMESPACE" --timeout "$WAIT_TIMEOUT"
}

start_port_forward() {
  : > "$PORT_FORWARD_LOG"
  kubectl_lab port-forward --address 127.0.0.1 -n "$NETDATA_NAMESPACE" \
    "deployment/$NETDATA_RELEASE-parent" "$LOCAL_API_PORT:19999" > "$PORT_FORWARD_LOG" 2>&1 &
  PORT_FORWARD_PID=$!
}

stop_port_forward() {
  if [[ -n ${PORT_FORWARD_PID:-} ]]; then
    kill "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
    wait "$PORT_FORWARD_PID" 2>/dev/null || true
    PORT_FORWARD_PID=''
  fi
}

verify_api() {
  start_port_forward
  trap stop_port_forward EXIT INT TERM
  local attempt api_path
  for attempt in $(seq 1 60); do
    for api_path in '/api/v3/info?options=full' '/api/v1/info'; do
      if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$LOCAL_API_PORT$api_path" >/dev/null 2>&1; then
        stop_port_forward
        trap - EXIT INT TERM
        printf 'Netdata parent API: http://127.0.0.1:%s%s (verified)\n' "$LOCAL_API_PORT" "$api_path"
        return
      fi
    done
    if ! kill -0 "$PORT_FORWARD_PID" >/dev/null 2>&1; then
      sed -n '1,120p' "$PORT_FORWARD_LOG" >&2
      fail 'Netdata API port-forward stopped before becoming ready'
    fi
    sleep 2
  done
  sed -n '1,120p' "$PORT_FORWARD_LOG" >&2
  kubectl_lab get pods -n "$NETDATA_NAMESPACE" -o wide >&2 || true
  kubectl_lab logs -n "$NETDATA_NAMESPACE" "deployment/$NETDATA_RELEASE-parent" --tail=80 >&2 || true
  fail 'Netdata parent API did not become ready'
}

wait_for_rollouts() {
  local namespace=$1
  local resource_type=$2
  local -a workloads=()
  mapfile -t workloads < <(kubectl_lab get "$resource_type" -n "$namespace" -o name)
  [[ ${#workloads[@]} -gt 0 ]] || fail "no $resource_type workloads found in namespace $namespace"
  local workload
  for workload in "${workloads[@]}"; do
    kubectl_lab rollout status "$workload" -n "$namespace" --timeout "$WAIT_TIMEOUT"
  done
}

verify_base_lab() {
  assert_cluster
  kubectl_lab rollout status deployment/webminai-nginx -n "$WORKLOAD_NAMESPACE" --timeout "$WAIT_TIMEOUT"
  local node_count
  node_count=$(kubectl_lab get nodes -o name | wc -l | tr -d ' ')
  [[ $node_count -eq 3 ]] || fail "expected 3 Kubernetes nodes, found $node_count"
  printf 'Baseline cluster: %s ready nodes and sample workload available.\n' "$node_count"
}

verify_monitoring() {
  assert_cluster
  helm_lab status "$NETDATA_RELEASE" -n "$NETDATA_NAMESPACE" >/dev/null
  wait_for_rollouts "$NETDATA_NAMESPACE" deployment
  wait_for_rollouts "$NETDATA_NAMESPACE" daemonset
  kubectl_lab rollout status deployment/webminai-nginx -n "$WORKLOAD_NAMESPACE" --timeout "$WAIT_TIMEOUT"

  local node_count desired_children ready_children
  node_count=$(kubectl_lab get nodes -o name | wc -l | tr -d ' ')
  desired_children=$(kubectl_lab get daemonset "$NETDATA_RELEASE-child" -n "$NETDATA_NAMESPACE" -o jsonpath='{.status.desiredNumberScheduled}')
  ready_children=$(kubectl_lab get daemonset "$NETDATA_RELEASE-child" -n "$NETDATA_NAMESPACE" -o jsonpath='{.status.numberReady}')
  [[ $node_count -eq 3 ]] || fail "expected 3 Kubernetes nodes, found $node_count"
  [[ $desired_children -eq $node_count && $ready_children -eq $node_count ]] || fail "Netdata child readiness is $ready_children/$desired_children for $node_count nodes"

  verify_api
  printf 'Netdata children: %s/%s ready across %s nodes.\n' "$ready_children" "$desired_children" "$node_count"
  printf 'No persistent Intent AI Ops node executor is installed.\n'
}

show_status() {
  assert_cluster
  printf 'Cluster: %s\nContext: %s\n\n' "$CLUSTER_NAME" "$KUBE_CONTEXT"
  kubectl_lab get nodes -o wide
  printf '\nOptional Netdata monitoring:\n'
  if helm_lab status "$NETDATA_RELEASE" -n "$NETDATA_NAMESPACE" >/dev/null 2>&1; then
    helm_lab list -n "$NETDATA_NAMESPACE"
    printf '\nNetdata pods:\n'
    kubectl_lab get pods -n "$NETDATA_NAMESPACE" -o wide
    printf '\nAPI access:\n  %s access\n' "$SCRIPT_NAME"
  else
    printf 'not installed (clean pre-Stage-2 baseline)\n'
  fi
  printf '\nSample workload:\n'
  kubectl_lab get pods -n "$WORKLOAD_NAMESPACE" -o wide
}

write_container_kubeconfig() {
  assert_cluster
  install -d -m 0700 "$LAB_DIRECTORY"
  local temporary_file="$INTERNAL_KUBECONFIG.tmp"
  umask 077
  kind get kubeconfig --name "$CLUSTER_NAME" --internal > "$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f -- "$temporary_file" "$INTERNAL_KUBECONFIG"
  printf 'Internal kubeconfig: %s\n' "$INTERNAL_KUBECONFIG"
  printf 'Docker network: kind\n'
  printf 'Mount it read-only in Intent AI Ops and set KUBECONFIG inside that container.\n'
  printf 'Do not mount the Docker socket or publish the Kubernetes API port.\n'
}

container_network_up() {
  assert_cluster
  local container=${WEBMINAI_CONTAINER_NAME:-}
  [[ $container =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] ||
    fail 'WEBMINAI_CONTAINER_NAME must be a Docker container name or ID'
  local container_id running network_id attached
  container_id=$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null) ||
    fail "Intent AI Ops container does not exist: $container"
  running=$(docker inspect -f '{{.State.Running}}' "$container_id")
  [[ $running == true ]] || fail "Intent AI Ops container is not running: $container"
  network_id=$(docker network inspect -f '{{.Id}}' kind 2>/dev/null) || fail 'kind Docker network does not exist'

  if [[ -f $CONTAINER_NETWORK_STATE ]]; then
    local previous_container previous_network
    previous_container=$(sed -n 's/^container=//p' "$CONTAINER_NETWORK_STATE")
    previous_network=$(sed -n 's/^network=//p' "$CONTAINER_NETWORK_STATE")
    [[ $previous_container == "$container_id" && $previous_network == "$network_id" ]] ||
      fail 'a different managed container/network attachment exists; run container-network-down first'
  fi
  if [[ -f $CONTAINER_ROUTE_STATE ]]; then
    printf 'Removing the obsolete cross-bridge route before attaching the kind network...\n'
    container_route_down
  fi

  attached=$(docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}yes{{end}}' "$container_id")
  if [[ $attached != yes ]]; then
    docker network connect kind "$container_id"
  fi

  local temporary_file="$CONTAINER_KUBECONFIG.tmp"
  install -d -m 0700 "$LAB_DIRECTORY"
  umask 077
  if ! kind get kubeconfig --name "$CLUSTER_NAME" --internal > "$temporary_file"; then
    rm -f -- "$temporary_file"
    fail 'could not generate the kind-internal kubeconfig'
  fi
  chmod 0600 "$temporary_file"
  mv -f -- "$temporary_file" "$CONTAINER_KUBECONFIG"
  printf 'container=%s\nnetwork=%s\n' "$container_id" "$network_id" > "$CONTAINER_NETWORK_STATE"
  chmod 0600 "$CONTAINER_NETWORK_STATE"

  if ! docker exec "$container_id" node -e '
    const net = require("node:net")
    const socket = net.connect(6443, process.argv[1], () => socket.end())
    socket.setTimeout(5000, () => socket.destroy(new Error("timeout")))
    socket.on("error", error => { console.error(error.message); process.exitCode = 1 })
  ' "$CLUSTER_NAME-control-plane"; then
    fail 'Intent AI Ops container could not reach the kind control-plane API after network attachment'
  fi
  printf 'PASS: Intent AI Ops container %s is attached to kind and can reach the API.\n' "$container"
  printf 'Container kubeconfig: %s\n' "$CONTAINER_KUBECONFIG"
  printf 'No container or cluster recreation was required.\n'
}

container_network_down() {
  [[ -f $CONTAINER_NETWORK_STATE ]] || fail "managed container network state is missing: $CONTAINER_NETWORK_STATE"
  local container_id network_id current_network
  container_id=$(sed -n 's/^container=//p' "$CONTAINER_NETWORK_STATE")
  network_id=$(sed -n 's/^network=//p' "$CONTAINER_NETWORK_STATE")
  [[ $container_id =~ ^[a-f0-9]{64}$ && $network_id =~ ^[a-f0-9]{64}$ ]] ||
    fail 'managed container network state is invalid'
  current_network=$(docker network inspect -f '{{.Id}}' kind 2>/dev/null || true)
  [[ -z $current_network || $current_network == "$network_id" ]] ||
    fail 'kind network identity changed; refusing to disconnect from an unowned network'
  if docker inspect "$container_id" >/dev/null 2>&1; then
    local attached
    attached=$(docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}yes{{end}}' "$container_id")
    if [[ $attached == yes ]]; then
      docker network disconnect kind "$container_id"
    fi
  fi
  rm -f -- "$CONTAINER_NETWORK_STATE" "$CONTAINER_KUBECONFIG"
  printf 'Disconnected the managed Intent AI Ops container from the kind network.\n'
}

valid_ipv4() {
  local address=$1
  local -a octets=()
  [[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r -a octets <<< "$address"
  [[ ${#octets[@]} -eq 4 ]] || return 1
  local octet
  for octet in "${octets[@]}"; do
    [[ ${#octet} -le 3 ]] || return 1
    ((10#$octet >= 0 && 10#$octet <= 255)) || return 1
  done
}

route_interface() {
  local address=$1 interface
  interface=$(ip -4 route get "$address" | awk '{for (field = 1; field <= NF; field++) if ($field == "dev") { print $(field + 1); exit }}')
  [[ $interface =~ ^[A-Za-z0-9_.:-]+$ ]] || fail "could not resolve a safe host interface for $address"
  printf '%s\n' "$interface"
}

container_route_up() {
  assert_cluster
  local client_ip=${WEBMINAI_K8S_CLIENT_IP:-}
  valid_ipv4 "$client_ip" || fail 'WEBMINAI_K8S_CLIENT_IP must be the exact Intent AI Ops container IPv4 address'
  [[ $client_ip == 172.17.* ]] || fail 'the lab route accepts only a Intent AI Ops client on 172.17.0.0/16'
  local control_ip client_interface control_interface
  control_ip=$(docker inspect -f '{{with index .NetworkSettings.Networks "kind"}}{{.IPAddress}}{{end}}' \
    "$CLUSTER_NAME-control-plane")
  valid_ipv4 "$control_ip" || fail 'could not detect the kind control-plane IPv4 address'
  client_interface=$(route_interface "$client_ip")
  control_interface=$(route_interface "$control_ip")
  if [[ -f $CONTAINER_ROUTE_STATE ]]; then
    local previous_client previous_control
    previous_client=$(sed -n 's/^client=//p' "$CONTAINER_ROUTE_STATE")
    previous_control=$(sed -n 's/^control=//p' "$CONTAINER_ROUTE_STATE")
    [[ $previous_client == "$client_ip" && $previous_control == "$control_ip" ]] ||
      fail 'a different managed route exists; run container-route-down before replacing it'
  fi

  install -d -m 0700 "$LAB_DIRECTORY"
  local temporary_file="$CONTAINER_KUBECONFIG.tmp"
  umask 077
  if ! kind get kubeconfig --name "$CLUSTER_NAME" --internal > "$temporary_file"; then
    rm -f -- "$temporary_file"
    fail 'could not generate the kind kubeconfig'
  fi
  if ! KUBECONFIG="$temporary_file" kubectl config set-cluster "$KUBE_CONTEXT" \
    --server="https://$control_ip:6443" >/dev/null; then
    rm -f -- "$temporary_file"
    fail 'could not set the routed Kubernetes API address'
  fi
  if ! KUBECONFIG="$temporary_file" kubectl get nodes >/dev/null; then
    rm -f -- "$temporary_file"
    fail 'the routed kubeconfig failed TLS or API verification on the host'
  fi
  chmod 0600 "$temporary_file"

  require_command iptables
  require_command sysctl
  as_root iptables -w 5 -S DOCKER-USER >/dev/null 2>&1 || fail 'Docker DOCKER-USER firewall chain is unavailable on the host'
  as_root sysctl -w net.ipv4.ip_forward=1 >/dev/null

  local outbound_added=false
  if ! as_root iptables -w 5 -C DOCKER-USER \
    -s "$client_ip/32" -d "$control_ip/32" -p tcp --dport 6443 -j ACCEPT 2>/dev/null; then
    if as_root iptables -w 5 -I DOCKER-USER 1 \
      -s "$client_ip/32" -d "$control_ip/32" -p tcp --dport 6443 -j ACCEPT; then
      outbound_added=true
    else
      rm -f -- "$temporary_file"
      fail 'could not add the outbound Kubernetes API firewall rule'
    fi
  fi
  if ! as_root iptables -w 5 -C DOCKER-USER \
    -s "$control_ip/32" -d "$client_ip/32" -p tcp --sport 6443 \
    -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
    if ! as_root iptables -w 5 -I DOCKER-USER 1 \
      -s "$control_ip/32" -d "$client_ip/32" -p tcp --sport 6443 \
      -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; then
      if [[ $outbound_added == true ]]; then
        as_root iptables -w 5 -D DOCKER-USER \
          -s "$client_ip/32" -d "$control_ip/32" -p tcp --dport 6443 -j ACCEPT || true
      fi
      rm -f -- "$temporary_file"
      fail 'could not add the return Kubernetes API firewall rule'
    fi
  fi

  if ! as_root iptables -w 5 -C FORWARD \
    -i "$client_interface" -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
    -p tcp --dport 6443 -j ACCEPT 2>/dev/null; then
    as_root iptables -w 5 -I FORWARD 1 \
      -i "$client_interface" -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
      -p tcp --dport 6443 -j ACCEPT
  fi
  if ! as_root iptables -w 5 -C FORWARD \
    -i "$control_interface" -o "$client_interface" -s "$control_ip/32" -d "$client_ip/32" \
    -p tcp --sport 6443 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
    as_root iptables -w 5 -I FORWARD 1 \
      -i "$control_interface" -o "$client_interface" -s "$control_ip/32" -d "$client_ip/32" \
      -p tcp --sport 6443 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  fi
  if ! as_root iptables -w 5 -t nat -C POSTROUTING \
    -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
    -p tcp --dport 6443 -j MASQUERADE 2>/dev/null; then
    as_root iptables -w 5 -t nat -I POSTROUTING 1 \
      -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
      -p tcp --dport 6443 -j MASQUERADE
  fi

  mv -f -- "$temporary_file" "$CONTAINER_KUBECONFIG"
  printf 'client=%s\ncontrol=%s\nclient_interface=%s\ncontrol_interface=%s\n' \
    "$client_ip" "$control_ip" "$client_interface" "$control_interface" > "$CONTAINER_ROUTE_STATE"
  chmod 0600 "$CONTAINER_ROUTE_STATE"
  printf 'PASS: host route is limited to %s/32 (%s) -> %s/32 (%s) TCP 6443.\n' \
    "$client_ip" "$client_interface" "$control_ip" "$control_interface"
  printf 'Routed kubeconfig: %s\n' "$CONTAINER_KUBECONFIG"
  printf 'Mount or copy that file into Intent AI Ops read-only; no SSH server is used.\n'
}

container_route_down() {
  [[ -f $CONTAINER_ROUTE_STATE ]] || fail "managed route state is missing: $CONTAINER_ROUTE_STATE"
  local client_ip control_ip client_interface control_interface
  client_ip=$(sed -n 's/^client=//p' "$CONTAINER_ROUTE_STATE")
  control_ip=$(sed -n 's/^control=//p' "$CONTAINER_ROUTE_STATE")
  valid_ipv4 "$client_ip" && valid_ipv4 "$control_ip" || fail 'managed route state is invalid'
  client_interface=$(sed -n 's/^client_interface=//p' "$CONTAINER_ROUTE_STATE")
  control_interface=$(sed -n 's/^control_interface=//p' "$CONTAINER_ROUTE_STATE")
  if [[ -z $client_interface || -z $control_interface ]]; then
    client_interface=$(route_interface "$client_ip")
    control_interface=$(route_interface "$control_ip")
  fi
  require_command iptables
  if as_root iptables -w 5 -C DOCKER-USER \
    -s "$client_ip/32" -d "$control_ip/32" -p tcp --dport 6443 -j ACCEPT 2>/dev/null; then
    as_root iptables -w 5 -D DOCKER-USER \
      -s "$client_ip/32" -d "$control_ip/32" -p tcp --dport 6443 -j ACCEPT
  fi
  if as_root iptables -w 5 -C FORWARD \
    -i "$client_interface" -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
    -p tcp --dport 6443 -j ACCEPT 2>/dev/null; then
    as_root iptables -w 5 -D FORWARD \
      -i "$client_interface" -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
      -p tcp --dport 6443 -j ACCEPT
  fi
  if as_root iptables -w 5 -C FORWARD \
    -i "$control_interface" -o "$client_interface" -s "$control_ip/32" -d "$client_ip/32" \
    -p tcp --sport 6443 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
    as_root iptables -w 5 -D FORWARD \
      -i "$control_interface" -o "$client_interface" -s "$control_ip/32" -d "$client_ip/32" \
      -p tcp --sport 6443 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  fi
  if as_root iptables -w 5 -t nat -C POSTROUTING \
    -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
    -p tcp --dport 6443 -j MASQUERADE 2>/dev/null; then
    as_root iptables -w 5 -t nat -D POSTROUTING \
      -o "$control_interface" -s "$client_ip/32" -d "$control_ip/32" \
      -p tcp --dport 6443 -j MASQUERADE
  fi
  if as_root iptables -w 5 -C DOCKER-USER \
    -s "$control_ip/32" -d "$client_ip/32" -p tcp --sport 6443 \
    -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
    as_root iptables -w 5 -D DOCKER-USER \
      -s "$control_ip/32" -d "$client_ip/32" -p tcp --sport 6443 \
      -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  fi
  rm -f -- "$CONTAINER_ROUTE_STATE" "$CONTAINER_KUBECONFIG"
  printf 'Removed the managed Intent-AI-Ops-to-kind host route and routed kubeconfig.\n'
}

prepare_executor_namespace() {
  kubectl_lab create namespace "$EXECUTOR_NAMESPACE" --dry-run=client -o yaml | kubectl_lab apply -f - >/dev/null
  kubectl_lab label namespace "$EXECUTOR_NAMESPACE" \
    pod-security.kubernetes.io/enforce=privileged \
    pod-security.kubernetes.io/audit=privileged \
    pod-security.kubernetes.io/warn=privileged \
    --overwrite >/dev/null
  kubectl_lab apply -f - <<EOF >/dev/null
apiVersion: v1
kind: ServiceAccount
metadata:
  name: webminai-stage2-gateway
  namespace: $EXECUTOR_NAMESPACE
  labels:
    webminai.io/lab: kubernetes-helm
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: webminai-stage2-jobs
  namespace: $EXECUTOR_NAMESPACE
  labels:
    webminai.io/lab: kubernetes-helm
rules:
- apiGroups: [batch]
  resources: [jobs]
  verbs: [create, get, list, watch, patch, delete]
- apiGroups: ['']
  resources: [pods]
  verbs: [get, list, watch, delete]
- apiGroups: ['']
  resources: [pods/log]
  verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: webminai-stage2-jobs
  namespace: $EXECUTOR_NAMESPACE
  labels:
    webminai.io/lab: kubernetes-helm
subjects:
- kind: ServiceAccount
  name: webminai-stage2-gateway
  namespace: $EXECUTOR_NAMESPACE
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: webminai-stage2-jobs
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: webminai-stage2-lab-node-reader
  labels:
    webminai.io/lab: kubernetes-helm
rules:
- apiGroups: ['']
  resources: [nodes]
  verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: webminai-stage2-lab-node-reader
  labels:
    webminai.io/lab: kubernetes-helm
subjects:
- kind: ServiceAccount
  name: webminai-stage2-gateway
  namespace: $EXECUTOR_NAMESPACE
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: webminai-stage2-lab-node-reader
EOF
  [[ $(kubectl_lab auth can-i create jobs.batch -n "$EXECUTOR_NAMESPACE" \
    --as="system:serviceaccount:$EXECUTOR_NAMESPACE:webminai-stage2-gateway") == yes ]] || fail 'gateway service account cannot create Jobs'
  [[ $(kubectl_lab auth can-i create daemonsets.apps -n "$EXECUTOR_NAMESPACE" \
    --as="system:serviceaccount:$EXECUTOR_NAMESPACE:webminai-stage2-gateway") == no ]] || fail 'gateway service account must not create DaemonSets'
}

create_node_job() {
  local node=$1
  local suffix=${node//[^a-zA-Z0-9-]/-}
  local job="webminai-node-${suffix:0:42}"
  kubectl_gateway delete job "$job" -n "$EXECUTOR_NAMESPACE" --ignore-not-found --wait=true >/dev/null
  kubectl_gateway apply -f - <<EOF >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: $job
  namespace: $EXECUTOR_NAMESPACE
  labels:
    webminai.io/lab: kubernetes-helm
    webminai.io/execution: ephemeral-node-test
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 120
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        webminai.io/lab: kubernetes-helm
        webminai.io/execution: ephemeral-node-test
    spec:
      nodeName: $node
      hostPID: true
      restartPolicy: Never
      containers:
      - name: executor
        image: alpine:3.23
        securityContext:
          privileged: true
          allowPrivilegeEscalation: true
          runAsUser: 0
        command: [/bin/sh, -ceu]
        args:
        - |
          marker=/host/tmp/webminai-kubernetes-node-test
          trap 'rm -f "\$marker"' EXIT
          printf '%s\n' '$node' > "\$marker"
          test "\$(cat "\$marker")" = '$node'
          printf 'node=%s host-kernel=%s host-root-write=ok\n' '$node' "\$(chroot /host /bin/sh -c 'uname -r')"
        volumeMounts:
        - name: host-root
          mountPath: /host
      volumes:
      - name: host-root
        hostPath:
          path: /
          type: Directory
EOF
}

run_node_test() {
  assert_cluster
  prepare_executor_namespace
  local node suffix job
  mapfile -t nodes < <(kubectl_gateway get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
  [[ ${#nodes[@]} -eq 3 ]] || fail "expected 3 nodes, found ${#nodes[@]}"
  printf 'Creating one ephemeral privileged Job on each lab node...\n'
  for node in "${nodes[@]}"; do
    create_node_job "$node"
  done
  for node in "${nodes[@]}"; do
    suffix=${node//[^a-zA-Z0-9-]/-}
    job="webminai-node-${suffix:0:42}"
    kubectl_gateway wait --for=condition=complete "job/$job" -n "$EXECUTOR_NAMESPACE" --timeout=180s
    kubectl_gateway logs "job/$job" -n "$EXECUTOR_NAMESPACE"
  done
  kubectl_gateway delete jobs -n "$EXECUTOR_NAMESPACE" -l webminai.io/execution=ephemeral-node-test --wait=true >/dev/null
  for node in "${nodes[@]}"; do
    if docker exec "$node" test -e /tmp/webminai-kubernetes-node-test; then
      fail "node test marker remains on $node"
    fi
  done
  if kubectl_lab get daemonset -n "$EXECUTOR_NAMESPACE" -o name | grep -q .; then
    fail 'unexpected persistent executor DaemonSet exists'
  fi
  printf 'PASS: all nodes allowed ephemeral host-root access; Jobs and host markers were removed.\n'
}

confirm_reset() {
  if [[ $YES == true ]]; then
    return
  fi
  printf 'This removes optional monitoring and reinstalls the baseline lab namespaces. Type reset: '
  local answer
  read -r answer
  [[ $answer == reset ]] || fail 'reset cancelled'
}

remove_monitoring_resources() {
  helm_lab uninstall "$NETDATA_RELEASE" -n "$NETDATA_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  kubectl_lab delete namespace "$NETDATA_NAMESPACE" --ignore-not-found --wait=true >/dev/null
}

confirm_monitoring_remove() {
  if [[ $YES == true ]]; then
    return
  fi
  printf 'This removes only the lab Netdata release and namespace. Type remove-monitoring: '
  local answer
  read -r answer
  [[ $answer == remove-monitoring ]] || fail 'monitoring removal cancelled'
}

remove_monitoring() {
  assert_cluster
  confirm_monitoring_remove
  remove_monitoring_resources
  printf 'Removed optional Netdata monitoring. The cluster and sample workload were preserved.\n'
}

reset_lab() {
  assert_cluster
  confirm_reset
  remove_monitoring_resources
  kubectl_lab delete namespace "$WORKLOAD_NAMESPACE" "$EXECUTOR_NAMESPACE" --ignore-not-found --wait=true >/dev/null
  kubectl_lab delete clusterrolebinding webminai-stage2-lab-node-reader --ignore-not-found >/dev/null
  kubectl_lab delete clusterrole webminai-stage2-lab-node-reader --ignore-not-found >/dev/null
  install_sample_workload
  verify_base_lab
}

confirm_destroy() {
  if [[ $YES == true ]]; then
    return
  fi
  printf 'This permanently deletes the marker-owned kind cluster %s. Type destroy: ' "$CLUSTER_NAME"
  local answer
  read -r answer
  [[ $answer == destroy ]] || fail 'destroy cancelled'
}

destroy_lab() {
  assert_cluster
  confirm_destroy
  if [[ -f $CONTAINER_ROUTE_STATE ]]; then
    container_route_down
  fi
  if [[ -f $CONTAINER_NETWORK_STATE ]]; then
    container_network_down
  fi
  kind delete cluster --name "$CLUSTER_NAME"
  rm -f -- "$MARKER_PATH"
  printf 'Deleted kind cluster %s. Generated configs remain in %s.\n' "$CLUSTER_NAME" "$LAB_DIRECTORY"
}

access_api() {
  assert_cluster
  helm_lab status "$NETDATA_RELEASE" -n "$NETDATA_NAMESPACE" >/dev/null 2>&1 ||
    fail 'optional Netdata monitoring is not installed; run monitoring-up first'
  printf 'Forwarding Netdata parent API to http://127.0.0.1:%s; press Ctrl-C to stop.\n' "$LOCAL_API_PORT"
  exec kubectl --context "$KUBE_CONTEXT" port-forward --address 127.0.0.1 \
    -n "$NETDATA_NAMESPACE" "deployment/$NETDATA_RELEASE-parent" "$LOCAL_API_PORT:19999"
}

up_lab() {
  create_cluster
  assert_cluster
  install_sample_workload
  verify_base_lab
  show_status
  printf '\nCluster is ready for Intent AI Ops Stage 2 activation.\n'
  printf 'Optional existing-Netdata scenario: %s monitoring-up\n' "$SCRIPT_NAME"
}

monitoring_up() {
  assert_cluster
  install_netdata
  verify_monitoring
  show_status
}

validate_configuration
case $ACTION in
  help|-h|--help)
    usage
    ;;
  bootstrap)
    bootstrap_host
    ;;
  up)
    require_tools
    up_lab
    ;;
  status)
    require_tools
    show_status
    ;;
  verify)
    require_tools
    verify_base_lab
    ;;
  monitoring-up)
    require_tools
    monitoring_up
    ;;
  monitoring-verify)
    require_tools
    verify_monitoring
    ;;
  monitoring-remove)
    require_tools
    remove_monitoring
    ;;
  container-kubeconfig)
    require_tools
    write_container_kubeconfig
    ;;
  container-network-up)
    require_tools
    container_network_up
    ;;
  container-network-down)
    require_tools
    container_network_down
    ;;
  container-route-up)
    require_tools
    container_route_up
    ;;
  container-route-down)
    require_tools
    container_route_down
    ;;
  node-test)
    require_tools
    run_node_test
    ;;
  access)
    require_tools
    access_api
    ;;
  reset)
    require_tools
    reset_lab
    ;;
  destroy)
    require_tools
    destroy_lab
    ;;
  *)
    usage >&2
    fail "unknown action: $ACTION"
    ;;
esac
