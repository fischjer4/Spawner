import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomes } from '../evals/trigger-scoring.js';
import type { TriggerOutput } from '../evals/run-trigger-case.js';
import type { TriggerExpected } from '../evals/trigger-cases.js';

const expected: TriggerExpected = { launches: 1, cancelled: false, perChunkLaunches: [0, 1] };
function output(patch: Partial<TriggerOutput> = {}): TriggerOutput {
  return { launches: 1, cancelled: false, perChunkLaunches: [0, 1], decisions: [{ invoked: 1, complete: 1, destination: 'replicas', action: 'research' }], handoffs: [{ message: 'request', plan_mode: true, request: 'request', context: '' }], errors: [], timedOut: false, detection: null, diagnostics: [], models: { decision: 'control' }, tasks: [], ...patch };
}

test('eval scorer accepts a completed request without cancelling existing work', () => {
  assert.deepEqual(outcomes(output(), expected), { turn: true, launches: true, mode: true, transcript: true, cancellation: true, timing: true, healthy: true });
});

test('eval scorer rejects missing, duplicate and unwanted launches', () => {
  assert.equal(outcomes(output({ launches: 0 }), expected).launches, false);
  assert.equal(outcomes(output({ launches: 2 }), expected).launches, false);
  assert.equal(outcomes(output(), { launches: 0, cancelled: false, perChunkLaunches: [0, 0] }).launches, false);
});

test('eval scorer catches premature launch even when the final total is correct', () => {
  const scores = outcomes(output({ perChunkLaunches: [1, 1] }), expected);
  assert.equal(scores.launches, true);
  assert.equal(scores.timing, false);
});

test('eval scorer rejects collateral cancellation and ignored cancellation', () => {
  assert.equal(outcomes(output({ cancelled: true }), expected).cancellation, false);
  assert.equal(outcomes(output(), { ...expected, cancelled: true }).cancellation, false);
});

test('API failures, timeouts and absent decisions cannot pass as valid non-requests', () => {
  const negative = { launches: 0, cancelled: false, perChunkLaunches: [0] };
  for (const failure of [{ errors: ['Gateway unavailable'] }, { timedOut: true }, { decisions: [] }]) {
    const scores = outcomes(output({ launches: 0, perChunkLaunches: [0], ...failure }), negative);
    assert.equal(scores.launches, true);
    assert.equal(scores.healthy, false);
    assert.equal(Object.values(scores).every(Boolean), false);
  }
});


test('eval scorer rejects wrong task mode and rewritten or missing transcript', () => {
  assert.equal(outcomes(output(), { ...expected, mode: 'implementation' }).mode, false);
  assert.equal(outcomes(output({ handoffs: [] }), expected).mode, false);
  assert.equal(outcomes(output(), { ...expected, request: 'Different original words' }).transcript, false);
  assert.equal(outcomes(output({ handoffs: [{ message: 'Summary only', plan_mode: true, request: 'Actual words', context: '' }] }), expected).transcript, false);
  assert.equal(outcomes(output({ handoffs: [{ message: 'Actual words', plan_mode: false, request: 'Actual words', context: '' }] }), { ...expected, mode: 'implementation', request: 'Actual words', context: '' }).transcript, true);
});


test('turn scorer rejects a missing or contradictory completion decision', () => {
  assert.equal(outcomes(output(), { ...expected, lastTurn: 'ready' }).turn, false);
  assert.equal(outcomes(output({ decisions: [{ turn: 'collecting', invoked: 1, complete: 0.2, destination: 'replicas', action: 'research' }] }), { ...expected, lastTurn: 'ready' }).turn, false);
});
