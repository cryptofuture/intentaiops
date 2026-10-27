import { auditCatalogSecurity } from '../src/catalog-security-audit.js'

if (process.argv.some(argument => argument.startsWith('--') && !['--online', '--json'].includes(argument))) throw new Error('Usage: node scripts/audit-common-software-security.js [--online] [--json]')
const report = await auditCatalogSecurity({ online: process.argv.includes('--online') })
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`Catalog security review: ${report.observedAt}; ${report.coverage.catalogEntries} entries; rules ${report.rulesReviewedAt}`)
  for (const row of report.entries) console.log(`${row.catalogId}: ${row.declaredPins.join(', ') || 'vendor package version unresolved'}; latest vendor release=${row.vendor?.release ?? 'unknown'}; published advisory candidates=${row.vendor?.advisories?.length ?? 'unknown'}; matching pin candidates=${row.findings.length}; ${row.verdict}${row.vendor?.errors.length ? '; ' + row.vendor.errors.join('; ') : ''}`)
  for (const limit of report.limitations) console.log(limit)
}
