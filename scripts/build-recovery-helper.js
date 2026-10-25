import { readFile, mkdir, writeFile } from 'node:fs/promises'
const directory = new URL('../artifacts/native/', import.meta.url)
await mkdir(directory, { recursive: true })
const helper = await readFile(new URL('../remote/recovery-store.sh', import.meta.url), 'utf8')
await writeFile(new URL('kubernetes-recovery-script.h', directory), `static const char recovery_helper[] = ${JSON.stringify(helper)};\n`)
