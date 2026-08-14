import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('macOS plugin target and Stage 2 bootstrap are defined', async () => {
  const source = await readFile(fileURLToPath(new URL('../plugin/webminai.plugin.c', import.meta.url)), 'utf8')
  const build = await readFile(fileURLToPath(new URL('../scripts/build-native-plugin.sh', import.meta.url)), 'utf8')
  const installer = await readFile(fileURLToPath(new URL('../remote/webminai-stage2.sh', import.meta.url)), 'utf8')
  assert.match(source, /WEBMINAI_TARGET_MACOS/)
  assert.match(source, /WEBMINAI_PLATFORM_NAME "macos"/)
  assert.match(source, /#define _DARWIN_C_SOURCE/)
  assert.doesNotMatch(source, /extern int setgroups/)
  assert.match(source, /\/var\/db\/webminai\/action\.key/)
  assert.match(build, /webminai\.plugin-macos-\$architecture/)
  assert.match(build, /macOS does not support fully static executables/)
  assert.match(installer, /Darwin\)/)
  assert.match(installer, /PLATFORM_ID=macos/)
  assert.match(installer, /Homebrew is required to install Netdata automatically on macOS/)
  assert.match(installer, /'\$brew_path' install netdata/)
  assert.match(installer, /'\$brew_path' uninstall --force netdata/)
  assert.match(installer, /\/usr\/local\|\/opt\/homebrew/)
  assert.match(installer, /find "\$managed_directory" -depth -delete/)
  assert.match(installer, /\/opt\/homebrew\/opt\/netdata/)
  assert.match(installer, /'\$brew_path' services restart netdata/)
  assert.match(installer, /check for new plugins every = 1/)

  const removeBeforeRestart = installer.indexOf('rm -f "$plugin_target"\n    restart_netdata')
  const waitForApi = installer.indexOf('http://127.0.0.1:19999/api/v3/info', removeBeforeRestart)
  const installAfterWait = installer.indexOf('install -o root -g "$NETDATA_GROUP" -m 4750 "$plugin_source" "$plugin_target"', waitForApi)
  assert.ok(removeBeforeRestart > 0, 'macOS activation must hide the plugin during restart')
  assert.ok(waitForApi > removeBeforeRestart, 'macOS activation must wait for the restarted Netdata API')
  assert.ok(installAfterWait > waitForApi, 'macOS activation must install the plugin after Netdata startup')
})
