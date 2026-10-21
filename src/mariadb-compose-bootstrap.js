export function mariadbComposeBootstrap (options = []) {
  const argumentsText = options.map(value => " '" + value.replaceAll("'", "'\\''") + "'").join('')
  return [
    '    entrypoint: ["/bin/bash", "-ec"]',
    '    command:',
    '      - |',
    '        source=/usr/local/bin/docker-entrypoint.sh',
    '        test "$$(grep -Fc "for i in {30..0}; do" "$$source")" = 1 || { echo "Unsupported MariaDB bootstrap script" >&2; exit 1; }',
    '        candidate=$$(mktemp /run/webminai-mariadb-entrypoint.XXXXXX)',
    '        sed "s/for i in {30[.][.]0}; do/for i in {300..0}; do/" "$$source" > "$$candidate"',
    '        chmod 0555 "$$candidate"',
    '        mv -fT "$$candidate" /run/webminai-mariadb-entrypoint.sh',
    `        exec /run/webminai-mariadb-entrypoint.sh mariadbd${argumentsText}`
  ]
}
