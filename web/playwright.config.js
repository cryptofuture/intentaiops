import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '../browser-checks', outputDir: '../artifacts/browser-screenshots', reporter: 'list', workers: 1, use: { browserName: 'chromium', launchOptions: process.env.INTENT_BROWSER_EXECUTABLE ? { executablePath: process.env.INTENT_BROWSER_EXECUTABLE } : {}, viewport: { width: 1440, height: 1000 } } })
