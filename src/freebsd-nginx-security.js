export function freebsdNginxSecurityCommand (state) {
  if (!/^\/var\/(?:lib|db)\/webminai\/task-state\/[a-zA-Z0-9-]+$/u.test(state)) throw new TypeError('Invalid FreeBSD task state')
  const root = `${state}/nginx-security`
  return `installed_nginx=$(pkg query '%v' nginx)
if [ "$(pkg version -t "$installed_nginx" '1.30.6,3')" = '<' ]; then
  [ "$(uname -r | cut -d. -f1)" = 15 ] && [ "$(uname -m)" = amd64 ] || { echo NGINX_SECURITY_UPDATE_UNAVAILABLE >&2; exit 78; }
  test ! -L '${root}'
  install -d -m 0700 '${root}' '${root}/repos' '${root}/catalog'
  printf '%s\\n' 'IntentNginxSecurity: { url: "pkg+https://pkg.FreeBSD.org/FreeBSD:15:amd64/latest", mirror_type: "srv", signature_type: "fingerprints", fingerprints: "/usr/share/keys/pkg", enabled: yes }' > '${root}/repos/security.conf'
  pkg -o PKG_DBDIR='${root}/catalog' -R '${root}/repos' update -f
  fixed_nginx=$(pkg -o PKG_DBDIR='${root}/catalog' -R '${root}/repos' rquery -r IntentNginxSecurity '%v' nginx)
  case "$fixed_nginx" in ''|*[!0-9.,_]*) echo NGINX_SECURITY_VERSION_INVALID >&2; exit 78;; esac
  [ "$(pkg version -t "$fixed_nginx" '1.30.6,3')" != '<' ]
  pkg -o PKG_DBDIR='${root}/catalog' -R '${root}/repos' fetch -y -U -s -r IntentNginxSecurity -o '${root}/cache' "nginx-$fixed_nginx"
  archive=
  for candidate in '${root}'/cache/All/*.pkg '${root}'/cache/All/Hashed/*.pkg; do
    [ -f "$candidate" ] || continue
    [ "$(pkg query -F "$candidate" '%n-%v')" = "nginx-$fixed_nginx" ] || continue
    if [ -n "$archive" ]; then [ "$(realpath "$archive")" = "$(realpath "$candidate")" ] || { echo NGINX_PACKAGE_AMBIGUOUS >&2; exit 78; }; fi
    archive=$candidate
  done
  [ -n "$archive" ]
  env ASSUME_ALWAYS_YES=yes pkg add -f "$archive"
  [ "$(pkg version -t "$(pkg query '%v' nginx)" '1.30.6,3')" != '<' ]
fi`
}
