import { SettingsStore } from '../src/settings-store.js'
import { ServerWorkspace } from '../src/server-workspace.js'
import { AdminService } from '../src/admin-service.js'
import { SystemSsh } from '../src/system-ssh.js'

const [hostId, taskIdText, phase] = process.argv.slice(2)
if (process.env.INTENT_LINUX_LAB_ALLOW !== '1' || !process.env.VAULT_TEST || !process.env.WEBMINAI_DATA_ROOT) throw new Error('explicit disposable lab configuration required')
if (!hostId?.startsWith('webminai-') || !['prepared', 'remote-completed', 'completed', 'job-acknowledged'].includes(phase)) throw new Error('invalid crash fixture')
const store = new SettingsStore(process.env.WEBMINAI_DATA_ROOT)
const settings = await store.load()
const workspace = new ServerWorkspace(store.dataRoot, { directoryAliases: new Map(Object.entries(settings.servers).map(([id, host]) => [id, host.historyId ?? id])) })
const admin = new AdminService({ dataRoot: store.dataRoot, settings: store, workspace, ssh: new SystemSsh({ transport: { multiplexing: false } }) })
const taskId = Number(taskIdText)
const task = admin.getTask(hostId, taskId)
if (!task.request.startsWith('Validate Linux reliability:')) throw new Error('not a reliability fixture')
const first = task.plan.commands[0].id
const append = admin.tasks.appendExecutionEvent.bind(admin.tasks)
admin.tasks.appendExecutionEvent = (...args) => {
  const result = append(...args)
  const event = args[3]
  const crash = { prepared: 'command_prepared', completed: 'command_completed', 'job-acknowledged': 'command_acknowledged' }[phase]
  if (event.commandId === first && event.type === crash) process.kill(process.pid, 'SIGKILL')
  return result
}
const netdata = admin.netdata.bind(admin)
admin.netdata = server => {
  const client = netdata(server)
  const run = client.runCommand.bind(client)
  client.runCommand = async (command, options) => {
    const result = await run(command, options)
    if (phase === 'remote-completed' && command === task.plan.commands[0].command) process.kill(process.pid, 'SIGKILL')
    return result
  }
  return client
}
admin.markTaskRunning(hostId, taskId)
await admin.execute({ settings, passphrase: process.env.VAULT_TEST, serverId: hostId, taskId, plan: task.plan, approve: async () => true })
throw new Error('fixture did not reach its crash boundary')
