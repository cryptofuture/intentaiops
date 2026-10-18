export function applicationDatabaseCommand ({ state, database, host, credentials, rollback = false }) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(database) || !['localhost', '127.0.0.1'].includes(host)) throw new TypeError('invalid application database identity')
  const marker = quote(`${state}/database-owned`)
  const passwordLength = '$' + '{#dbpass}'
  const identity = quote(`${database}@${host}`)
  const occupied = `SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${database}') + (SELECT COUNT(*) FROM mysql.user WHERE User='${database}');`
  const read = sql => `mariadb --protocol=socket -uroot -Nse ${quote(sql)} 2>/dev/null`
  const blocked = "printf '%s\\n' 'DATABASE_OWNERSHIP_UNCONFIRMED: preserve database and request operator review' >&2; exit 1"
  const checkMarker = `[ ! -L ${marker} ] && [ -f ${marker} ] && [ "$(cat ${marker})" = ${identity} ] || { ${blocked}; }`
  if (rollback) {
    return [
      'set -eu', `[ -d ${quote(state)} ] || exit 0`,
      `if [ ! -e ${marker} ] && [ ! -L ${marker} ]; then command -v mariadb >/dev/null 2>&1 || { ${blocked}; }; occupied=$(${read(occupied)}) || { ${blocked}; }; [ "$occupied" = 0 ] && exit 0; ${blocked}; fi`,
      checkMarker,
      `printf '%s\\n' ${quote(`DROP DATABASE IF EXISTS ${database}; DROP USER IF EXISTS '${database}'@'${host}'; FLUSH PRIVILEGES;`)} | mariadb --protocol=socket -uroot >/dev/null 2>&1 || { ${blocked}; }`,
      `rm -f -- ${marker}`, "printf '%s\\n' database-removed"
    ].join('; ')
  }
  return [
    `test -d ${quote(state)}`, 'umask 077',
    `if [ -e ${marker} ] || [ -L ${marker} ]; then ${checkMarker}; owned=$(${read(`SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${database}') + (SELECT COUNT(*) FROM mysql.user WHERE User='${database}' AND Host='${host}');`)}); [ "$owned" = 2 ] || { ${blocked}; }; else :`,
    `occupied=$(${read(occupied)}) || { ${blocked}; }; [ "$occupied" = 0 ] || { ${blocked}; }`,
    `dbpass=$(sed -n 1p ${quote(`${credentials}/db_password`)})`,
    `case "$dbpass" in ''|*[!0-9a-fA-F]*) exit 1;; esac; [ "${passwordLength}" -eq 64 ]`,
    `printf "CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER '${database}'@'${host}' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON ${database}.* TO '${database}'@'${host}'; FLUSH PRIVILEGES;\\n" "$dbpass" | mariadb --protocol=socket -uroot >/dev/null 2>&1 || { ${blocked}; }`,
    `(set -C; printf '%s\\n' ${identity} > ${marker})`, 'fi', "printf '%s\\n' database-ready"
  ].join('; ')
}

function quote (value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
