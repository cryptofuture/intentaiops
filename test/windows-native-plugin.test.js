import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceUrl = new URL('../plugin/webminai.plugin.windows.c', import.meta.url)
const runnerUrl = new URL('../remote/webminai-command-runner-windows.ps1', import.meta.url)

test('Windows plugin preserves the signed command security boundary', async () => {
  const source = await readFile(fileURLToPath(sourceUrl), 'utf8')

  assert.match(source, /DEFAULT_KEY_FILE L"C:\\\\ProgramData\\\\WebminAI\\\\action\.key"/)
  assert.match(source, /BCryptOpenAlgorithmProvider\(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_ALG_HANDLE_HMAC_FLAG\)/)
  assert.match(source, /constant_time_equal/)
  assert.match(source, /issued_at < now - 60 \|\| issued_at > now \+ 60/)
  assert.match(source, /nonce_seen\(fields\.nonce\)/)
  assert.match(source, /SecureZeroMemory\(key, sizeof\(key\)\)/)
  assert.match(source, /return success && length_read == 64 && decode_hex/)
})

test('Windows command text goes over restricted named pipes to a fixed PowerShell runner', async () => {
  const source = await readFile(fileURLToPath(sourceUrl), 'utf8')
  const runner = await readFile(fileURLToPath(runnerUrl), 'utf8')

  assert.match(source, /powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File/)
  assert.match(source, /CreateNamedPipeW/)
  assert.match(source, /D:P\(A;;GA;;;SY\)\(A;;GA;;;BA\)/)
  assert.match(source, /ConnectNamedPipe/)
  assert.match(runner, /\$reader\.ReadToEnd\(\)/)
  assert.match(runner, /\. \(\[ScriptBlock\]::Create\(\$source\)\)/)
  assert.match(runner, /\) 2>&1 \| ForEach-Object/)
  assert.match(runner, /Management\.Automation\.ErrorRecord/)
  assert.match(runner, /\$writer\.WriteLine\(\$rendered\)/)
  assert.match(runner, /\$errorWriter\.WriteLine\(\$rendered\)/)
  assert.match(source, /CreateProcessW\(executable, command_line/)
  assert.match(source, /WriteFile\(stdin_write, command \+ offset/)
  assert.doesNotMatch(source, /ExecutionPolicy(?:=|\s+)Bypass/i)
})

test('Windows command process tree is bounded and output is captured', async () => {
  const source = await readFile(fileURLToPath(sourceUrl), 'utf8')

  assert.match(source, /CreateJobObjectW\(NULL, NULL\)/)
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/)
  assert.match(source, /TerminateJobObject\(job, 124\)/)
  assert.match(source, /CREATE_SUSPENDED \| CREATE_NO_WINDOW \| CREATE_UNICODE_ENVIRONMENT/)
  assert.match(source, /WaitForSingleObject\(stdout_thread, INFINITE\)/)
  assert.match(source, /MAX_OUTPUT_BYTES \(64 \* 1024\)/)
  assert.match(source, /timeout_seconds > 300/)
  assert.match(source, /L"ProgramData"/)
  assert.match(source, /L"ProgramFiles"/)
})

test('Windows durable jobs use restart-safe worker processes and protected atomic state', async () => {
  const source = await readFile(fileURLToPath(sourceUrl), 'utf8')

  assert.match(source, /--job-worker/)
  assert.match(source, /CopyFileW\(current_path, worker_path, FALSE\)/)
  assert.match(source, /DEFAULT_JOB_ROOT L"C:\\\\ProgramData\\\\WebminAI\\\\jobs"/)
  assert.match(source, /MAX_CONCURRENT_JOBS 4/)
  assert.match(source, /MAX_RETAINED_JOBS 64/)
  assert.match(source, /MAX_JOB_STORAGE_BYTES/)
  assert.match(source, /SetFileSecurityW\(DEFAULT_JOB_ROOT/)
  assert.match(source, /\\"durableJobs\\":true/)
  assert.match(source, /MAX_JOB_TIMEOUT_SECONDS 86400/)
  assert.match(source, /MoveFileExW\(temporary, path, MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH\)/)
  assert.match(source, /process_matches_identity/)
  assert.match(source, /creation_time/)
  assert.match(source, /TerminateProcess\(process, 130\)/)
  assert.match(source, /FUNCTION GLOBAL \\"webminai:job_start\\"/)
  assert.match(source, /FUNCTION GLOBAL \\"webminai:job_status\\"/)
  assert.match(source, /FUNCTION GLOBAL \\"webminai:job_cancel\\"/)
  assert.match(source, /FUNCTION GLOBAL \\"webminai:job_cleanup\\"/)
})

test('Windows Stage 2 deactivation cancels jobs before removing protected state', async () => {
  const lifecycle = await readFile(fileURLToPath(new URL('../remote/webminai-stage2-windows.ps1', import.meta.url)), 'utf8')

  assert.match(lifecycle, /--cancel-all-jobs/)
  assert.match(lifecycle, /Remove-Item -LiteralPath \$JobsDirectory -Recurse -Force/)
})

test('Windows health reports LocalSystem identity and integrity', async () => {
  const source = await readFile(fileURLToPath(sourceUrl), 'utf8')

  assert.match(source, /OpenProcessToken\(GetCurrentProcess\(\), TOKEN_QUERY/)
  assert.match(source, /CreateWellKnownSid\(WinLocalSystemSid/)
  assert.match(source, /GetTokenInformation\(token, TokenIntegrityLevel/)
  assert.match(source, /isLocalSystem/)
  assert.match(source, /executionMode.*windows-system/)
})

test('Windows release builders target an x64 PE artifact', async () => {
  const shellBuild = await readFile(fileURLToPath(new URL('../scripts/build-native-plugin.sh', import.meta.url)), 'utf8')
  const nativeBuild = await readFile(fileURLToPath(new URL('../scripts/build-native-plugin-windows.ps1', import.meta.url)), 'utf8')
  const packageFile = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

  assert.match(shellBuild, /webminai\.plugin-windows-amd64\.exe/)
  assert.match(shellBuild, /-lbcrypt -ladvapi32/)
  assert.match(shellBuild, /IMAGE_FILE_MACHINE_AMD64/)
  assert.match(nativeBuild, /'\/MT'/)
  assert.match(nativeBuild, /'\/MACHINE:X64'/)
  assert.match(nativeBuild, /bcrypt\.lib/)
  assert.match(nativeBuild, /Get-FileHash[^\r\n]*SHA256/)
  assert.match(nativeBuild, /SHA256SUMS/)
  assert.equal(packageFile.scripts['build:plugin:windows'], 'sh scripts/build-native-plugin.sh windows')
  assert.equal(packageFile.scripts['build:plugin:macos'], 'sh scripts/build-native-plugin.sh macos')
})
