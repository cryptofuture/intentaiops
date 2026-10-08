/**
 * @typedef {object} ExecutionEvent
 * @property {1} version
 * @property {number} id
 * @property {string} hostId
 * @property {number | null} runId
 * @property {number} taskId
 * @property {string} revision
 * @property {string | null} commandId
 * @property {string | null} attemptId
 * @property {string} timestamp
 * @property {string} type
 * @property {Record<string, unknown>} metadata
 */

/**
 * @typedef {object} ReviewedDecision
 * @property {string} hostId
 * @property {number} taskId
 * @property {string} expectedVersion
 * @property {string} fingerprint
 * @property {true} approved
 */

/**
 * @typedef {object} CommandState
 * @property {string} commandId
 * @property {'pending' | 'completed' | 'failed' | 'uncertain'} status
 * @property {string | null} attemptId
 * @property {string | null} jobId
 */

export {}
