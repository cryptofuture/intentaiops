#!/usr/bin/env node

import { runCli } from '../src/cli.js'
import { CLI_NAME } from '../src/product.js'

try {
  await runCli()
} catch (error) {
  process.stderr.write(`${CLI_NAME}: ${error.message}\n`)
  process.exitCode = 1
}
