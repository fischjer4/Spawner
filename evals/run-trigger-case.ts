import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Models, Replicas } from '../src/services.js';
import { Engine, LIVE_REQUEST_TIMING } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Settings, Decision } from '../src/types.js';
import type { TriggerInput } from './trigger-cases.js';

export type Trace = { input: unknown; output: unknown; start: number; end: number };
export async function runTriggerCase(input: TriggerInput, report: (trace: Trace) => void) {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error('Run npm run eval to unlock Spawner’s saved connection, or set AI_GATEWAY_API_KEY.');
  const root = await mkdtemp(join(tmpdir(), 'spawner-evalite-'));
  const flow = join(root, 'wispr'); await mkdir(join(flow, 'meetings/test'), { recursive: true });
  const db = new DatabaseSync(join(flow, 'flow.sqlite'));
  db.exec('CREATE TABLE History(transcriptEntityId TEXT PRIMARY KEY, asrText TEXT, formattedText TEXT, timestamp TEXT, status TEXT, platform TEXT, isArchived INTEGER)');
  db.exec("CREATE TABLE Meetings(id TEXT,title TEXT,endedAt INTEGER,isDeleted INTEGER,isTourDemo INTEGER); INSERT INTO Meetings VALUES('test','Evaluation',NULL,0,0)");
  if (input.recordingState === 'previously-ended') db.prepare("UPDATE Meetings SET endedAt=? WHERE id='test'").run(Date.now() - 600000);
  const file = join(flow, 'meetings/test/live.ndjson'); await writeFile(file, '');
  const store = new Store(join(root, 'spawner'));
  const saved = JSON.parse(process.env.SPAWNER_EVAL_SETTINGS || '{}');
  const settings: Settings = { enabled: true, launchAtLogin: false, environmentId: 'eval-only', environmentName: 'Evaluation', decisionModel: 'typesafe-ai/jev-1.14.0', textModel: 'openai/gpt-6-luna', speechModel: '', voice: '', ...saved, wisprDirectory: flow };
  const models = new Models(() => key, () => settings);
  const decisions: Decision[] = [];
  const handoffs: { message: string; plan_mode: boolean; request: string; context: string }[] = [];
  const perChunkLaunches: number[] = [];
  let launches = 0;
  const existing = { id: crypto.randomUUID(), meetingId: 'test', title: 'Existing unrelated research', question: 'Existing research', context: '', createdAt: Date.now(), status: 'researching' as const, replicaId: 'existing-workspace' };
  store.saveTask(existing);
  const engine = new Engine(settings, store, () => ({ gateway: true, replicas: true }), {
    decide: async (...args) => {
      const start = performance.now(); const decision = await models.decide(...args); decisions.push(decision);
      report({ input: { stage: 'Jev decision', model: settings.decisionModel, previousConversation: args[0], candidateUtterances: args[1] }, output: decision, start, end: performance.now() }); return decision;
    },
    summarize: (...args) => models.summarize(...args), speech: (...args) => models.speech(...args),
  }, new Replicas(() => 'eval-only', (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/replica' && init?.method === 'POST') {
      launches++;
      const body = JSON.parse(init.body as string);
      const task = engine.tasks.find(task => task.workspaceName === body.name)!;
      handoffs.push({ message: body.message, plan_mode: body.plan_mode, request: task.question, context: task.context });
      return Response.json({ replica: { id: 'eval-workspace' } });
    }
    if (init?.method === 'PATCH' || path.endsWith('/interrupt')) return Response.json({});
    if (path.endsWith('/wait')) return Response.json({ done: false, status: 'running', chats: [{ id: 'eval-chat', processing: true }] });
    throw new Error(`Unexpected eval HTTP call: ${init?.method} ${path}`);
  }) as typeof fetch));

  let timedOut = false;
  try {
    await engine.watcher.poll(); await delay(20);
    const line = (text: string, speaker = 'You', speakerId?: number) => JSON.stringify({ id: crypto.randomUUID(), text, speaker: { source: speaker === 'You' ? 'mic' : 'system', id: speakerId ?? (speaker === 'You' ? 1 : 2), ...(speaker !== 'You' && speaker !== 'Them' ? { name: speaker } : {}) }, endEpochMs: Date.now() }) + '\n';
    if (input.source !== 'dictation') { await appendFile(file, line(input.prior)); await engine.watcher.poll(); }
    const arrivalsStarted = Date.now();
    for (const [chunkIndex, chunk] of input.chunks.entries()) {
      if (input.arrivalOffsetsMs) {
        await delay(Math.max(0, arrivalsStarted + input.arrivalOffsetsMs[chunkIndex] - Date.now()));
        if (chunkIndex > 0) perChunkLaunches.push(launches);
      }
      await delay(20);
      const chunkText = chunk.map((text, index) => line(text, input.chunkSpeakers?.[chunkIndex]?.[index], input.chunkSpeakerIds?.[chunkIndex]?.[index])).join('');
      if (input.recordingState === 'final-flush') db.prepare("UPDATE Meetings SET endedAt=? WHERE id='test'").run(Date.now());
      if (input.source === 'dictation') db.prepare('INSERT INTO History VALUES(?,?,?,?,?,?,0)').run(crypto.randomUUID(), chunk.join(' '), chunk.join(' '), new Date().toISOString(), 'formatted', 'desktop');
      else await appendFile(file, chunkText);
      await engine.watcher.poll();
      if (input.control && chunkIndex === input.chunks.length - 1) {
        await delay(2200);
        const pending = engine.snapshot().requests[0];
        if (!pending) throw new Error('Expected a pending request for the user control');
        await engine.requestAction(pending.id, pending.revision, input.control);
      }
      if (input.arrivalOffsetsMs && chunkIndex < input.chunks.length - 1) continue;
      await delay(chunkIndex === input.chunks.length - 1 ? input.finalWaitMs ?? (input.source === 'dictation' ? 1600 : LIVE_REQUEST_TIMING.settleMs + 200) : 1600);
      const deadline = Date.now() + 50000;
      while (engine.detection?.message === 'Checking the request…' || engine.tasks.some(t => t.status === 'starting')) {
        if (Date.now() > deadline) { timedOut = true; break; }
        await delay(100);
      }
      perChunkLaunches.push(launches);
      if (timedOut) break;
    }
    const errors = engine.tasks.filter(t => t.id !== existing.id && t.error).map(t => t.error!);
    // A service error must not score as a successful rejection of a non-request.
    if (engine.detection?.message && /could not|unavailable|timed out|API key|credits/i.test(engine.detection.message)) errors.push(engine.detection.message);
    return { launches, cancelled: engine.tasks.find(t => t.id === existing.id)?.status === 'cancelled', perChunkLaunches, decisions, handoffs, errors, timedOut, detection: engine.detection, models: { decision: settings.decisionModel }, diagnostics: engine.diagnosticRuns, tasks: store.tasks().map(t => ({ title: t.title, status: t.status, error: t.error })) };
  } finally { engine.dispose(); store.close(); db.close(); await rm(root, { recursive: true, force: true }); }
}
export type TriggerOutput = Awaited<ReturnType<typeof runTriggerCase>>;
