import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMagentoTask, magentoComposeRelease } from '../src/magento-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const context = {
  identity: { id: 'ubuntu', versionId: '24.04' },
  applications: {
    wordpress: {
      primaryAddressCommand: "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
    }
  }
}

test('Magento Compose task pins the resolved service matrix and protects credentials', () => {
  const built = buildMagentoTask(42, context, { preferred: true, ready: true })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  const images = magentoComposeRelease().images

  assert.equal(images.length, 5)
  assert.equal(images.every(image => /@sha256:[a-f0-9]{64}$/u.test(image)), true)
  assert.match(commands, /mappia\/magento2@sha256:/u)
  assert.match(commands, /fastcgi_backend \{ server unix:\/run\/php-fpm\/webminai\.sock; \}/u)
  assert.match(commands, /pm\.max_children = 2[\s\S]*pm\.max_spare_servers = 2/u)
  assert.match(commands, /rm -f \/run\/php-fpm\/webminai\.sock/u)
  assert.match(commands, /"--save", "", "--appendonly", "no"/u)
  assert.match(commands, /WEBMINAI_DB_PASSWORD_FILE=\/run\/webminai\/db_password/u)
  assert.match(commands, /WEBMINAI_DB_USERNAME_FILE=\/run\/webminai\/db_username/u)
  assert.match(commands, /WEBMINAI_ADMIN_USERNAME_FILE=\/run\/webminai\/admin_username/u)
  assert.match(commands, /auto_prepend_file=\/run\/webminai\/installer-argv\.php/u)
  assert.match(built.plan.commands.find(item => item.id === 'prepare-magento-swap').command, /fallocate -l 1G/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /cpuset: "0"/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /-Xms256m -Xmx256m/u)
  assert.match(built.plan.commands.find(item => item.id === 'initialize-magento').command, /deploy:mode:set developer --skip-compilation/u)
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'initialize-magento').command, /setup:di:compile|setup:static-content:deploy/u)
  assert.deepEqual(built.plan.commands.find(item => item.id === 'start-dependencies').dependsOn, ['prepare-magento-swap'])
  assert.match(built.plan.revertCommands.find(item => item.id === 'remove-magento-swap').command, /swapoff/u)
  assert.match(built.plan.revertCommands.find(item => item.id === 'remove-magento-swap').command, /rm -f/u)
  assert.doesNotMatch(commands, /--(?:db|admin)-password=[A-Za-z0-9]/u)
  assert.doesNotMatch(commands, /--(?:db|admin)-user=[A-Za-z0-9]/u)
  assert.match(built.verifyApplied, /WEBMINAI_MAGENTO_OK/u)
  assert.match(built.stateProbe, /\{\{\.State\}\}/u)
  assert.doesNotMatch(built.stateProbe, /\{\{\.Status\}\}/u)
  assert.match(built.verifyReverted, /magento_credentials/u)
})

test('Magento learned task requires the preferred reviewed Compose route', () => {
  assert.throws(() => buildMagentoTask(1, context, { preferred: false, ready: true }), /requires the preferred Compose route/u)
  assert.throws(() => buildMagentoTask(1, { ...context, identity: { id: 'fedora', versionId: '44' } }, { preferred: true, ready: true }), /does not yet support fedora/u)
})
