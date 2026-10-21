export const OPENSEARCH_VERSION = '3.9.0'
export const OPENSEARCH_IMAGE = 'opensearchproject/opensearch@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c'
export const OPENSEARCH_COMPAT_BASE = 'debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8'
export const OPENSEARCH_BUILDKIT = 'moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea'
export const OPENSEARCH_ARCHIVE = `https://artifacts.opensearch.org/releases/core/opensearch/${OPENSEARCH_VERSION}/opensearch-min-${OPENSEARCH_VERSION}-linux-x64.tar.gz`
export const OPENSEARCH_ARCHIVE_SHA512 = 'adb28c45a873946211e203bbf92ba8d618183c9aff4aede66aa04b6ff40c0a4a04d35c77584743760409e8092821683bdc93ff2fb92f952791f6b7f27facb842'
export const OPENSEARCH_JRE = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_linux_hotspot_21.0.12.1_1.tar.gz'
export const OPENSEARCH_JRE_SHA256 = '2413149700df0f7d440500a84a8f764c535f21e5a5e87d38328b64eec2c5b500'

export function opensearchCompatibilityImage (taskId) {
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new TypeError('positive task id required')
  return `intentaiops/magento-opensearch:${OPENSEARCH_VERSION}-bookworm-task-${taskId}`
}

export function opensearchCompatibilityDockerfile () {
  return [
    `FROM ${OPENSEARCH_COMPAT_BASE}`,
    `LABEL org.opencontainers.image.source="https://github.com/opensearch-project/OpenSearch" org.opencontainers.image.version="${OPENSEARCH_VERSION}"`,
    'RUN set -eux; test "$(dpkg --print-architecture)" = amd64; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl bash gzip tar libstdc++6 zlib1g; rm -rf /var/lib/apt/lists/*; groupadd --gid 1000 opensearch; useradd --uid 1000 --gid 1000 --home-dir /usr/share/opensearch --no-create-home opensearch; mkdir -p /usr/share/opensearch /opt/java',
    `RUN set -eux; curl --fail --location --silent --show-error --connect-timeout 15 --max-time 900 '${OPENSEARCH_ARCHIVE}' --output /tmp/opensearch.tar.gz; printf '%s  %s\\n' ${OPENSEARCH_ARCHIVE_SHA512} /tmp/opensearch.tar.gz | sha512sum -c -; tar -xzf /tmp/opensearch.tar.gz -C /usr/share/opensearch --strip-components=1; rm -f /tmp/opensearch.tar.gz; rm -rf /usr/share/opensearch/jdk; curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 '${OPENSEARCH_JRE}' --output /tmp/java.tar.gz; printf '%s  %s\\n' ${OPENSEARCH_JRE_SHA256} /tmp/java.tar.gz | sha256sum -c -; tar -xzf /tmp/java.tar.gz -C /opt/java --strip-components=1; rm -f /tmp/java.tar.gz`,
    'RUN set -eux; test -f /usr/share/opensearch/LICENSE.txt; test -f /usr/share/opensearch/NOTICE.txt; test -f /opt/java/legal/java.base/LICENSE; test -z "$(find /usr/share/opensearch/plugins -mindepth 1 -maxdepth 1 -print)"; printf "cluster.name: intentaiops-magento\\nnode.name: magento-search\\nnetwork.host: 0.0.0.0\\ndiscovery.type: single-node\\ncluster.routing.allocation.disk.threshold_enabled: false\\n" > /usr/share/opensearch/config/opensearch.yml; mkdir -p /usr/share/opensearch/data /usr/share/opensearch/logs; chown -R 1000:1000 /usr/share/opensearch',
    'ENV OPENSEARCH_JAVA_HOME=/opt/java JAVA_HOME=/opt/java',
    'WORKDIR /usr/share/opensearch',
    'USER 1000:1000',
    `RUN /opt/java/bin/java -version; bin/opensearch --version | grep -F 'Version: ${OPENSEARCH_VERSION}'`,
    'EXPOSE 9200',
    'CMD ["/usr/share/opensearch/bin/opensearch"]'
  ].join('\n')
}
