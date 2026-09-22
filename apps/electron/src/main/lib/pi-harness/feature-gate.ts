/**
 * Pi Host Harness feature gate.
 *
 * Keep the control plane dark until the sidecar, lifecycle integration and
 * evaluations are ready. The gate is intentionally process-local for the
 * first rollout: it does not add a persisted user setting or alter existing
 * Pi/Claude session behaviour by default.
 */

import type { AgentRuntime } from '@profer/shared'

export const PI_HARNESS_FEATURE_ENV = 'PROFER_PI_HARNESS'

/**
 * Returns true only for the explicit opt-in value used by development and
 * controlled diagnostics. Missing, malformed and all other values fail closed.
 */
export function isPiHarnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PI_HARNESS_FEATURE_ENV]?.trim() === '1'
}

/**
 * Harness is Pi-only and opt-in. Keeping the runtime check here prevents callers
 * from accidentally creating sidecar state for Claude or ordinary Pi turns.
 */
export function shouldStartPiHarness(
  agentRuntime: AgentRuntime,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return agentRuntime === 'pi' && isPiHarnessEnabled(env)
}
