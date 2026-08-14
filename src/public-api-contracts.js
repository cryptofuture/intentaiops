// Reusable JSDoc contracts for the supported package boundary. This module has
// no runtime exports; `npm run typecheck` verifies consumers of these shapes.

/**
 * @typedef {object} SshConnection
 * @property {string} host
 * @property {string} username
 * @property {number} port
 * @property {string | undefined} identityFile
 * @property {string | undefined} configFile
 */

/** @typedef {'read' | 'change' | 'destructive'} CommandRisk */
/** @typedef {'job'} CommandExecutionMode */

/**
 * @typedef {object} CommandSource
 * @property {'verified-foundation' | 'verified-application' | 'ai-planned'} type
 * @property {string} [id]
 * @property {number} [version]
 */

/**
 * @typedef {object} CommandRetry
 * @property {number} attempts
 * @property {number} intervalMs
 * @property {number[]} exitCodes
 */

/**
 * @typedef {object} CommandPlanItem
 * @property {string} id
 * @property {string} command
 * @property {string} purpose
 * @property {CommandRisk} risk
 * @property {number} timeoutMs
 * @property {boolean} requiresSudo
 * @property {string[]} dependsOn
 * @property {CommandExecutionMode} [executionMode]
 * @property {string | null} [phase]
 * @property {CommandRetry} [retry]
 * @property {object} [diagnostic]
 * @property {CommandSource} [source]
 */

/**
 * @typedef {object} CommandPlan
 * @property {string} summary
 * @property {string} changeOverview
 * @property {string[]} modifiedFiles
 * @property {CommandPlanItem[]} commands
 * @property {CommandPlanItem[]} revertCommands
 * @property {string[]} [warnings]
 * @property {boolean} [requiresConfirmation]
 * @property {object} [compatibilityManifest]
 * @property {object} [foundationComposition]
 */

/**
 * @typedef {object} ExecutionPolicy
 * @property {number} [maxCommands]
 * @property {number} [maxTimeoutMs]
 * @property {number} [maxJobTimeoutMs]
 * @property {string[]} [deniedPatterns]
 * @property {string} [executionIdentity]
 */

/** @typedef {'ai' | 'catalog'} MultiHostRunKind */
/** @typedef {'planning' | 'planned' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'reverting' | 'reverted' | 'revert_failed'} MultiHostRunStatus */
/** @typedef {'queued' | MultiHostRunStatus} MultiHostStatus */

/**
 * @typedef {object} MultiHostRunHost
 * @property {string} serverId
 * @property {number | null} taskId
 * @property {MultiHostStatus} status
 * @property {string | null} error
 * @property {object | null} verification
 * @property {number} updatedAt
 */

/**
 * @typedef {object} MultiHostRun
 * @property {number} id
 * @property {string} request
 * @property {MultiHostRunKind} kind
 * @property {string | null} catalogId
 * @property {MultiHostRunStatus} status
 * @property {number | null} retryOfRunId
 * @property {string | null} retryInstructions
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {MultiHostRunHost[]} hosts
 */

/**
 * @typedef {object} MultiHostRunInput
 * @property {string} request
 * @property {MultiHostRunKind} [kind]
 * @property {string | null} [catalogId]
 * @property {string[]} serverIds
 * @property {number | null} [retryOfRunId]
 * @property {string | null} [retryInstructions]
 */

/**
 * @typedef {object} MultiHostAdmin
 * @property {(...args: any[]) => any} [getTaskRetryHistory]
 * @property {(...args: any[]) => any} [getTaskConsultations]
 * @property {(...args: any[]) => any} [listPendingConsultations]
 * @property {(...args: any[]) => any} [createTask]
 * @property {(...args: any[]) => any} [appendTaskProgress]
 * @property {(...args: any[]) => any} [capabilities]
 * @property {(...args: any[]) => any} [refreshInventory]
 * @property {(...args: any[]) => any} [plan]
 * @property {(...args: any[]) => any} [saveTaskPlan]
 * @property {(...args: any[]) => any} [saveTaskError]
 * @property {(...args: any[]) => any} [cancelTask]
 * @property {(...args: any[]) => any} [markTaskRunning]
 * @property {(...args: any[]) => any} [saveTaskResults]
 * @property {(...args: any[]) => any} [execute]
 * @property {(...args: any[]) => any} [appendTaskResult]
 * @property {(...args: any[]) => any} [getTask]
 * @property {(...args: any[]) => any} [markTaskReverting]
 * @property {(...args: any[]) => any} [revertTask]
 * @property {(...args: any[]) => any} [appendTaskRevertResult]
 * @property {(...args: any[]) => any} [saveTaskRevertResults]
 * @property {(...args: any[]) => any} [saveTaskRevertError]
 */

/**
 * @typedef {object} MultiHostServiceOptions
 * @property {string} dataRoot
 * @property {(serverId: string) => MultiHostAdmin | Promise<MultiHostAdmin>} adminFor
 * @property {object} [runs]
 * @property {object} [scorecard]
 * @property {number} [concurrency]
 */

/**
 * @typedef {object} MultiHostRunOptions
 * @property {object} settings
 * @property {string} passphrase
 * @property {string[]} serverIds
 * @property {string} request
 * @property {MultiHostRunKind} [kind]
 * @property {string | null} [catalogId]
 * @property {number | null} [retryOfRunId]
 * @property {string | null} [retryInstructions]
 * @property {Record<string, any>} [planningHints]
 * @property {object} [applicationDefaults]
 * @property {(details: object) => boolean | Promise<boolean>} [review]
 * @property {(details: object) => any | Promise<any>} [externalVerify]
 * @property {(event: object) => void} [onEvent]
 */

export {}
