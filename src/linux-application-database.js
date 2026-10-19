export function applicationDatabaseCommand ({ state, database, user = database, host, credentials, client = 'mariadb', passwordFile = 'db_password', collation = 'utf8mb4_unicode_ci', rollback = false }) {
  if (!/^[a-z_][a-z0-9_]{0,63}$/u.test(database) || !/^[a-z_][a-z0-9_]{0,31}$/u.test(user) || !['localhost', '127.0.0.1'].includes(host) || !['mariadb', 'mysql'].includes(client) || !['db_password', 'database_password'].includes(passwordFile) || !['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'].includes(collation)) throw new TypeError('invalid application database identity')
  const marker = quote(`${state}/database-owned`)
  const passwordLength = '$' + '{#dbpass}'
  const identity = quote(`${database}${user === database ? '' : `:${user}`}@${host}`)
  const occupied = `SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${database}') + (SELECT COUNT(*) FROM mysql.user WHERE User='${user}');`
  const read = sql => `${client} --protocol=socket -uroot -Nse ${quote(sql)} 2>/dev/null`
  const blocked = "printf '%s\\n' 'DATABASE_OWNERSHIP_UNCONFIRMED: preserve database and request operator review' >&2; exit 1"
  const checkMarker = `[ ! -L ${marker} ] && [ -f ${marker} ] && [ "$(cat ${marker})" = ${identity} ] || { ${blocked}; }`
  if (rollback) {
    return [
      'set -eu', `test ! -L ${quote(state)}`, `[ -d ${quote(state)} ] || exit 0`,
      `if [ ! -e ${marker} ] && [ ! -L ${marker} ]; then command -v ${client} >/dev/null 2>&1 || { ${blocked}; }; occupied=$(${read(occupied)}) || { ${blocked}; }; [ "$occupied" = 0 ] && exit 0; ${blocked}; fi`,
      checkMarker,
      `printf '%s\\n' ${quote(`DROP DATABASE IF EXISTS ${database}; DROP USER IF EXISTS '${user}'@'${host}'; FLUSH PRIVILEGES;`)} | ${client} --protocol=socket -uroot >/dev/null 2>&1 || { ${blocked}; }`,
      `rm -f -- ${marker}`, "printf '%s\\n' database-removed"
    ].join('; ')
  }
  return [
    'set -eu', `test ! -L ${quote(state)}`, `test -d ${quote(state)}`, 'umask 077',
    `if [ -e ${marker} ] || [ -L ${marker} ]; then ${checkMarker}; owned=$(${read(`SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${database}') + (SELECT COUNT(*) FROM mysql.user WHERE User='${user}' AND Host='${host}');`)}); [ "$owned" = 2 ] || { ${blocked}; }; else :`,
    `occupied=$(${read(occupied)}) || { ${blocked}; }; [ "$occupied" = 0 ] || { ${blocked}; }`,
    `dbpass=$(sed -n 1p ${quote(`${credentials}/${passwordFile}`)})`,
    `case "$dbpass" in ''|*[!0-9a-fA-F]*) exit 1;; esac; [ "${passwordLength}" -eq 64 ]`,
    `printf "CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE ${collation}; CREATE USER '${user}'@'${host}' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON ${database}.* TO '${user}'@'${host}'; FLUSH PRIVILEGES;\\n" "$dbpass" | ${client} --protocol=socket -uroot >/dev/null 2>&1 || { ${blocked}; }`,
    `(set -C; printf '%s\\n' ${identity} > ${marker})`, 'fi', "printf '%s\\n' database-ready"
  ].join('; ')
}

export function postgresApplicationDatabaseCommand ({ state, database, user, credentials, createdb = false, rollback = false }) {
  if (![database, user].every(value => /^[a-z_][a-z0-9_]{0,62}$/u.test(value))) throw new TypeError('invalid PostgreSQL application identity')
  const marker = quote(`${state}/postgres-owned`)
  const blocked = "printf '%s\\n' 'DATABASE_OWNERSHIP_UNCONFIRMED: preserve database and request operator review' >&2; exit 1"
  const query = `SELECT (SELECT system_identifier FROM pg_control_system()), COALESCE((SELECT oid::text FROM pg_roles WHERE rolname='${user}'),'0'), COALESCE((SELECT oid::text FROM pg_database WHERE datname='${database}'),'0'), COALESCE((SELECT datdba::text FROM pg_database WHERE datname='${database}'),'0');`
  const read = `observed=$(runuser -u postgres -- psql -X -Atq -F '|' -v ON_ERROR_STOP=1 -c ${quote(query)} postgres 2>/dev/null) || { ${blocked}; }; printf '%s\\n' "$observed" | awk 'NR == 1 && /^[0-9]+\\|[0-9]+\\|[0-9]+\\|[0-9]+$/ {ok=1} END {exit !(NR == 1 && ok)}' || { ${blocked}; }`
  const commands = ['set -eu', `[ ! -L ${quote(state)} ] || { ${blocked}; }`, `[ -d ${quote(state)} ] || ${rollback ? 'exit 0' : `{ ${blocked}; }`}`, 'umask 077', read,
    `if [ -e ${marker} ] || [ -L ${marker} ]; then [ ! -L ${marker} ] && [ -f ${marker} ] && [ "$(cat ${marker})" = "$observed" ] || { ${blocked}; }; owned=yes; else owned=no; fi`]
  if (rollback) {
    commands.push(`if [ "$owned" = no ]; then case "$observed" in *'|0|0|0') exit 0;; *) ${blocked};; esac; fi`,
      `runuser -u postgres -- dropdb --if-exists ${quote(database)} >/dev/null 2>&1 || { ${blocked}; }`,
      `runuser -u postgres -- dropuser --if-exists ${quote(user)} >/dev/null 2>&1 || { ${blocked}; }`, `rm -f -- ${marker}`, "printf '%s\\n' database-removed")
  } else {
    commands.push(`if [ "$owned" = no ]; then case "$observed" in *'|0|0|0') :;; *) ${blocked};; esac`,
      `password=$(cat ${quote(`${credentials}/database_password`)})`, `case "$password" in ''|*[!0-9a-fA-F]*) ${blocked};; esac; [ "${'$'}{#password}" -eq 64 ] || { ${blocked}; }`,
      `printf "CREATE ROLE ${user} LOGIN ${createdb ? 'CREATEDB ' : ''}PASSWORD '%s';\\nCREATE DATABASE ${database} OWNER ${user};\\n" "$password" | runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 postgres >/dev/null 2>&1 || { ${blocked}; }`, read,
      `printf '%s\\n' "$observed" | awk -F '|' 'NF == 4 && $2 != 0 && $3 != 0 && $2 == $4 {ok=1} END {exit !ok}' || { ${blocked}; }`,
      `(set -C; printf '%s\\n' "$observed" > ${marker})`, 'fi', "printf '%s\\n' database-ready")
  }
  return commands.join('; ')
}

function quote (value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
