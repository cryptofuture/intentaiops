export function freebsdInstallMissingPackages (packages) {
  if (!Array.isArray(packages) || !packages.length || packages.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_+.-]*$/u.test(name))) throw new TypeError('Invalid FreeBSD package families')
  return `missing_packages=; for package in ${packages.map(name => `'${name}'`).join(' ')}; do pkg info -e "$package" >/dev/null 2>&1 || missing_packages="$missing_packages $package"; done; if [ -n "$missing_packages" ]; then env ASSUME_ALWAYS_YES=yes pkg install -y $missing_packages; fi`
}
