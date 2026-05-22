/** Provider-neutral SCM handoff error helpers. */

/**
 * Builds a typed error used when SCM handoff data violates the documented local contract.
 *
 * @param {string} code Stable machine-readable error code.
 * @param {string} message Public-safe explanation.
 * @returns {Error & {code: string}}
 */
export function projectionContractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
