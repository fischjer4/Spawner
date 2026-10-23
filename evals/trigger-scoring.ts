import type { TriggerOutput } from './run-trigger-case.js';
import type { TriggerExpected } from './trigger-cases.js';

export function outcomes(output: TriggerOutput, expected: TriggerExpected) {
  return {
    turn: !expected.lastTurn || output.decisions.at(-1)?.turn === expected.lastTurn,
    launches: output.launches === expected.launches,
    mode: output.handoffs.length === expected.launches && output.handoffs.every(handoff => handoff.plan_mode === (expected.mode !== 'implementation')),
    transcript: output.handoffs.every(handoff => (expected.request === undefined || handoff.request === expected.request) && (expected.context === undefined || handoff.context === expected.context) && handoff.message.includes(handoff.request) && (!handoff.context || handoff.message.includes(handoff.context))),
    cancellation: output.cancelled === expected.cancelled,
    timing: JSON.stringify(output.perChunkLaunches) === JSON.stringify(expected.perChunkLaunches),
    healthy: !output.timedOut && !output.errors.length && output.decisions.length > 0,
  };
}
