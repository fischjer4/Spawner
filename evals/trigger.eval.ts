import { evalite } from 'evalite';
import { reportTrace } from 'evalite/traces';
import { regressionCases, additionalCases, delegationCases, taskModeCases, streamingCases, captureCases, dataset } from './trigger-cases.js';
import { runTriggerCase } from './run-trigger-case.js';
import { outcomes } from './trigger-scoring.js';

for (const [name, cases] of [['Incident regressions', regressionCases], ['Additional phrasing', additionalCases], ['Delegated requests', delegationCases], ['Task modes', taskModeCases], ['Streaming requests', streamingCases], ['Request capture', captureCases]] as const) {
  if (process.env.SPAWNER_EVAL_SUITE && process.env.SPAWNER_EVAL_SUITE !== name) continue;
  evalite(`Spawner trigger · ${name}`, {
    data: dataset(cases),
    trialCount: 2,
    task: input => runTriggerCase(input, reportTrace),
    scorers: [
      { name: 'Agent launches', scorer: ({ output, expected }) => ({ score: Number(outcomes(output, expected).launches), metadata: { expected: expected.launches, actual: output.launches } }) },
      { name: 'Correct task mode', scorer: ({ output, expected }) => ({ score: Number(outcomes(output, expected).mode), metadata: { expected: expected.mode, actualPlanModes: output.handoffs.map(h => h.plan_mode) } }) },
      { name: 'Original transcript preserved', scorer: ({ output, expected }) => Number(outcomes(output, expected).transcript) },
      { name: 'Cancellation', scorer: ({ output, expected }) => ({ score: Number(outcomes(output, expected).cancellation), metadata: { expected: expected.cancelled, actual: output.cancelled } }) },
      { name: 'Waits for complete request', scorer: ({ output, expected }) => ({ score: Number(outcomes(output, expected).timing), metadata: { expected: expected.perChunkLaunches, actual: output.perChunkLaunches } }) },
      { name: 'Execution health', scorer: ({ output, expected }) => ({ score: Number(outcomes(output, expected).healthy), metadata: { errors: output.errors, timedOut: output.timedOut, decisions: output.decisions.length } }) },
      { name: 'Turn interpretation', scorer: ({ output, expected }) => Number(outcomes(output, expected).turn) },
      { name: 'All required outcomes', scorer: ({ output, expected }) => ({ score: Number(Object.values(outcomes(output, expected)).every(Boolean)), metadata: outcomes(output, expected) }) },
    ],
    columns: ({ input, output }) => [{ label: 'Case', value: input.name }, { label: 'Jev decisions', value: output.decisions }, { label: 'Launches', value: output.launches }],
  });
}
