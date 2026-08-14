export const ROOT_EXECUTION_IDENTITY = 'root'

/** @param {Record<string, any>} [policy] */
export function rootExecutionPolicy (policy = {}) {
  const remaining = { ...policy }
  delete remaining.sudoMode
  delete remaining.sudoCommandPrefix
  delete remaining.sudoActions
  delete remaining.sudoActionSyntax
  return {
    ...remaining,
    allowSudo: false,
    executionIdentity: ROOT_EXECUTION_IDENTITY
  }
}
