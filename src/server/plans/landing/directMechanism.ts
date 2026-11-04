// directMechanism.ts - The direct landing mechanism (plan-execution D13),
// wrapping its shipped functions unchanged: the probe is `probeLanding`, a
// change starts from the commit the provision records (its dependencies' newest
// landing in the execution, else its Start-time base commit), a passed change
// lands through `applyLanding`, and the update-branch and merge effects are
// its own.
import { applyLanding, applyLandingOutcome, mergeAdapter, updateBranchAdapter } from '../execution/executionLanding'
import type { LandingMechanism, LandingMechanisms } from './landingMechanisms'
import { probeLanding } from './landingProbe'

export const directMechanism: LandingMechanism = {
  mode: 'direct',
  probe: (input, options) => probeLanding(input, options),
  startBase: async ({ recorded }) => ({ ok: true, sha: recorded }),
  land: (deps, adapters, row, round) => applyLanding(deps, adapters, row, round),
  landOutcome: (deps, effect, adapters) => applyLandingOutcome(deps, effect, adapters),
  effectAdapter: (kind, adapters, ghOptions) => (kind === 'update-branch' ? updateBranchAdapter(adapters, ghOptions)
    : kind === 'merge' ? mergeAdapter(adapters, ghOptions)
      : undefined),
}

/** The direct-only registry: the default for executors and services built outside the composition. */
export const DIRECT_MECHANISMS: LandingMechanisms = new Map([[directMechanism.mode, directMechanism]])
