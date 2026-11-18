import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parseTranscript, TranscriptWatcher, hasWakeName } from '../src/transcript.js';
import { Store } from '../src/store.js';
import { Engine, LIVE_REQUEST_TIMING } from '../src/engine.js';
import { extractAnswer, Replicas, ApiError, taskPrompt, replicaLink } from '../src/services.js';
import type { Settings, ResearchTask, Meeting, Decision, TaskMode } from '../src/types.js';

const settings: Settings = { enabled: true, launchAtLogin: false, wisprDirectory: '/missing', environmentId: 'env', environmentName: 'Test', decisionModel: 'test', textModel: 'test', speechModel: 'test', voice: 'test' };
const result = { status: 'answer', answer: 'Supported with configuration.', spokenAnswer: 'It works once the administrator enables SSO.', sources: [{ title: 'Docs', url: 'https://example.com/docs' }] };
const envelope = `<sidekick-result>${JSON.stringify(result)}</sidekick-result>`;
const history = { events: [{ type: 'claude-assistant', payload: { message: { role: 'assistant', content: [{ type: 'text', text: envelope }] } } }] };
const task = (): ResearchTask => ({ id: crypto.randomUUID(), meetingId: 'meeting', title: 'SSO', question: 'Does SSO work?', context: '', createdAt: Date.now(), status: 'ready', spokenAnswer: 'Yes.' });

function line(id: string, epoch: number, text = 'Replicas, go find out.') { return JSON.stringify({ id, text, endEpochMs: epoch, speaker: { source: 'mic', id: 1 } }) + '\n'; }

test('transcript parsing ignores incomplete writes, preserves source and uses final duplicate ID', () => {
  const text = '{"meta":{"v":3}}\n' + line('1', 100, 'Old') + line('1', 101, 'Final') + 'not json\n' + line('2', 102) + '{"id":"partial"';
  const entries = parseTranscript(text);
  assert.equal(entries.length, 2); assert.equal(entries[0].text, 'Final'); assert.equal(entries[0].speaker, 'You');
  assert.equal(parseTranscript('{"id":"a","text":"No absolute time"}\n').length, 0);
});

test('wake names recognize ASR variants, not substrings', () => {
  for (const text of ['T three, look it up', 'Replicas go find out', 'Sidekick, check that']) assert.equal(hasWakeName(text), true);
  assert.equal(hasWakeName('The replicaSet changed'), false);
});

test('real file watcher ignores history and cloud sync, emits new speech once and expires idle meetings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-watch-'));
  let now = Date.now();
  const db = new DatabaseSync(join(root, 'flow.sqlite'));
  db.exec('CREATE TABLE Meetings(id TEXT,title TEXT,endedAt INTEGER,isDeleted INTEGER,isTourDemo INTEGER)');
  db.prepare('INSERT INTO Meetings VALUES(?,?,NULL,0,0)').run('meeting', 'Test call');
  await mkdir(join(root, 'meetings/meeting'), { recursive: true });
  const file = join(root, 'meetings/meeting/live.ndjson');
  await writeFile(file, line('old', now - 10000));
  const received: string[] = [];
  const watcher = new TranscriptWatcher(root, (_m, entries) => received.push(...entries.map(e => e.id)), () => {}, () => now);
  try {
    await watcher.poll(); assert.deepEqual(received, []);
    await delay(20); now += 1000;
    await appendFile(file, line('new', now)); await watcher.poll();
    assert.deepEqual(received, ['new']); assert.equal(watcher.meeting?.title, 'Test call');
    await delay(20); await writeFile(file, line('old', now - 11000) + line('new', now, 'Rewritten text'));
    await watcher.poll(); assert.deepEqual(received, ['new']);
    await mkdir(join(root, 'meetings/cloud'), { recursive: true });
    db.prepare('INSERT INTO Meetings VALUES(?,?,NULL,0,0)').run('cloud', 'Old cloud meeting');
    await writeFile(join(root, 'meetings/cloud/live.ndjson'), line('synced', now - 100000));
    await watcher.poll(); assert.deepEqual(received, ['new']);
    db.prepare('UPDATE Meetings SET endedAt=? WHERE id=?').run(now, 'meeting');
    await watcher.poll(); assert.equal(watcher.meeting?.id, 'meeting');
    now += 5 * 60_000 + 1; await watcher.poll(); assert.equal(watcher.meeting, null);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});


test('extracts provider answers but never treats a tool result as an assistant answer', () => {
  assert.deepEqual(extractAnswer(history).result, result);
  const nested = { events: [{ type: 'claude-assistant', payload: { type: 'claude-assistant', payload: history.events[0].payload } }] };
  assert.deepEqual(extractAnswer(nested).result, result);
  assert.equal(extractAnswer({ events: [{ type: 'claude-user', payload: { message: { content: [{ type: 'text', text: envelope }] } } }] }).result, null);
  assert.equal(extractAnswer({ events: [{ type: 'claude-result', payload: { subtype: 'error', is_error: true, result: envelope } }] }).failed, true);
  assert.equal(extractAnswer({ events: [{ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: envelope }] } }] }).result?.status, 'answer');
  assert.equal(extractAnswer({ codex_asp_transcript: { turns: [{ items: [{ type: 'agentMessage', text: envelope }] }] } }).result?.status, 'answer');
  assert.equal(extractAnswer({ events: [{ type: 'claude-assistant', payload: { inputRequest: { status: 'pending' } } }] }).pending, true);
  assert.equal(extractAnswer({ events: [{ type: 'claude-assistant', payload: { message: { content: [{ type: 'text', text: '<sidekick-result>bad json</sidekick-result>' }] } } }] }).result, null);
});

test('Replicas request uses retained lifecycle and scoped environment, and never retries a create', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new Replicas(() => 'secret', (async (url, init) => { requests.push({ url: String(url), init: init! }); return Response.json({ replica: { id: 'replica-1' } }, { status: 201 }); }) as typeof fetch);
  assert.equal(await client.create('name', 'environment', 'question'), 'replica-1');
  const body = JSON.parse(requests[0].init.body as string);
  assert.equal(body.lifecycle_policy, 'sleep_when_done'); assert.equal(body.environment_id, 'environment'); assert.equal(body.plan_mode, true);
  await client.rename('replica-1', 'check-electron-menu-bar-support');
  assert.equal(requests[1].init.method, 'PATCH');
  assert.equal(JSON.parse(requests[1].init.body as string).name, 'check-electron-menu-bar-support');
  let attempts = 0;
  const failing = new Replicas(() => 'secret', (async () => { attempts++; throw new Error('lost response'); }) as typeof fetch);
  await assert.rejects(() => failing.create('name', 'environment', 'question')); assert.equal(attempts, 1);
  const unauth = new Replicas(() => 'secret', (async () => new Response('private upstream body', { status: 401 })) as typeof fetch);
  await assert.rejects(() => unauth.environments(), e => e instanceof ApiError && !e.message.includes('private'));
});

async function setupEngine(timing = { ...LIVE_REQUEST_TIMING, settleMs: 0 }) {
  const directory = await mkdtemp(join(tmpdir(), 'sidekick-engine-'));
  const store = new Store(directory);
  let creates = 0;
  const decisions: Decision[] = [];
  const models = { decide: async (_context: string, _request: string) => decisions.shift() ?? { invoked: 1, complete: 1, destination: 'replicas' as const, action: 'research' as const }, summarize: async (_answer: string) => ({ status: 'answer' as 'answer' | 'needs_input', spokenAnswer: result.spokenAnswer, sources: result.sources }), speech: async () => ({ base64: 'audio', mediaType: 'audio/wav' }) };
  const replicas = { create: async (_name: string, _environment: string, _message: string, _mode: TaskMode = 'research') => { creates++; return 'replica'; }, findByName: async (_name: string) => 'replica', rename: async (_id: string, _name: string) => {}, wait: async () => ({ done: true, status: 'sleeping', chats: [{ id: 'chat', processing: false }] }), history: async () => history, interrupt: async () => {} };
  const engine = new Engine({ ...settings }, store, () => ({ gateway: true, replicas: true }), models, replicas, timing);
  return { engine, store, models, replicas, decisions, creates: () => creates, cleanup: async () => { engine.dispose(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('request → one remote research → verified answer → playback acknowledgment', async () => {
  const f = await setupEngine();
  const now = Date.now();
  const meeting: Meeting = { id: 'meeting', title: 'Call', lastSpeechAt: now, entries: [{ id: 'wake', text: 'Replicas, check our SSO support.', speaker: 'You', epoch: now }] };
  try {
    f.engine.receive(meeting, meeting.entries); await delay(1700);
    assert.equal(f.creates(), 1); assert.equal(f.engine.tasks[0].status, 'researching');
    f.engine.receive(meeting, meeting.entries); await delay(1700); assert.equal(f.creates(), 1);
    const id = f.engine.tasks[0].id;
    let played = false; f.engine.onPlay = () => { played = true; };
    const notifications: string[] = []; f.engine.onNotify = (title, _body, taskId) => { notifications.push(title); assert.equal(taskId, id); };
    await f.engine.refresh(id); assert.equal(f.engine.tasks[0].status, 'ready');
    await f.engine.tick();
    await f.engine.refresh(id);
    assert.equal(notifications.filter(title => title === 'Your answer is ready').length, 1);
    assert.equal(played, false); assert.equal(f.engine.playing, null);
    assert.ok(notifications.includes('Your answer is ready'));
    assert.equal(f.engine.tasks[0].answer, result.answer);
    await f.engine.speak(id); assert.equal(played, true); assert.equal(f.engine.tasks[0].status, 'speaking');
    f.engine.playbackEnded(id); assert.equal(f.engine.tasks[0].status, 'delivered');
  } finally { await f.cleanup(); }
});

test('a rejected Jev invocation never launches an agent', async () => {
  const f = await setupEngine();
  f.decisions.push({ invoked: 0.1, complete: 1, destination: 'replicas', action: 'none' });
  const e = { id: 'quote', text: 'Imagine saying Replicas go find out.', speaker: 'You', epoch: Date.now() };
  try { f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: e.epoch, entries: [e] }, [e]); await delay(1700); assert.equal(f.creates(), 0); }
  finally { await f.cleanup(); }
});

test('pause while classification is in flight prevents launch', async () => {
  const f = await setupEngine();
  let release!: (d: Decision) => void;
  f.models.decide = () => new Promise(resolve => { release = resolve; });
  const e = { id: 'request', text: 'Replicas, go find out.', speaker: 'You', epoch: Date.now() };
  try {
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: e.epoch, entries: [e] }, [e]); await delay(1600);
    f.engine.updateSettings({ ...settings, enabled: false });
    release({ invoked: 1, complete: 1, destination: 'replicas', action: 'research' }); await delay(10);
    assert.equal(f.creates(), 0);
  } finally { await f.cleanup(); }
});

test('a lost creation response is reconciled by name without creating a duplicate', async () => {
  const f = await setupEngine();
  f.replicas.create = async () => { throw new Error('Connection dropped after server accepted'); };
  try {
    const id = await f.engine.startManual('Does SSO work?');
    assert.equal(f.engine.tasks[0].status, 'needs_attention');
    let recoveredName = '';
    f.replicas.findByName = async name => { recoveredName = name; return 'replica'; };
    await f.engine.refresh(id);
    assert.equal(recoveredName, `sidekick-${id}`);
    assert.equal(f.engine.tasks[0].workspaceName, 'does-sso-work');
    assert.equal(f.engine.tasks[0].replicaId, 'replica'); assert.equal(f.engine.tasks[0].status, 'ready');
  } finally { await f.cleanup(); }
});

test('naming failure preserves the launched agent and refresh retries only the rename', async () => {
  const f = await setupEngine();
  const names: string[] = [];
  f.replicas.rename = async (id, name) => {
    assert.equal(id, 'replica');
    assert.equal(f.store.tasks()[0].replicaId, id);
    names.push(name);
    if (names.length === 1) throw new Error('Temporary rename failure');
  };
  try {
    const id = await f.engine.startManual('Check Electron menu-bar support');
    assert.equal(f.engine.tasks[0].status, 'researching');
    assert.equal(f.engine.tasks[0].replicaId, 'replica');
    await f.engine.refresh(id);
    assert.equal(f.creates(), 1);
    assert.deepEqual(names, ['check-electron-menu-bar-support', 'check-electron-menu-bar-support']);
    assert.equal(f.store.tasks()[0].workspaceName, 'check-electron-menu-bar-support');
    await f.engine.refresh(id);
    assert.equal(names.length, 2);
  } finally { await f.cleanup(); }
});

test('restart restores interrupted playback as a written answer and retains running tasks without relaunching them', async () => {
  const f = await setupEngine();
  const speaking = { ...task(), status: 'speaking' as const };
  const running = { ...task(), status: 'researching' as const, replicaId: 'existing' };
  f.store.saveTask(speaking); f.store.saveTask(running);
  const resumed = new Engine({ ...settings }, f.store, () => ({ gateway: true, replicas: true }), f.models, f.replicas);
  try {
    const old = resumed.tasks.find(t => t.id === speaking.id)!;
    assert.equal(old.status, 'ready');
    assert.equal(resumed.tasks.find(t => t.id === running.id)?.replicaId, 'existing'); assert.equal(f.creates(), 0);
  } finally { resumed.dispose(); await f.cleanup(); }
});

test('stopping speech while TTS is generating prevents later playback', async () => {
  const f = await setupEngine();
  const t = task(); f.engine.tasks.push(t); f.store.saveTask(t);
  let release!: (v: { base64: string; mediaType: string }) => void;
  f.models.speech = () => new Promise(resolve => { release = resolve; });
  let played = false; f.engine.onPlay = () => { played = true; };
  try {
    const promise = f.engine.speak(t.id);
    f.engine.stopSpeech(); release({ base64: 'audio', mediaType: 'audio/wav' }); await promise;
    assert.equal(played, false); assert.equal(f.engine.playing, null);
  } finally { await f.cleanup(); }
});


test('existing settings preserve connections while dropping retired audio options', async () => {
  const f = await setupEngine();
  try {
    f.store.saveSettings({ ...settings, environmentId: 'saved-env', automaticSpeech: true, audioRouteConfirmed: true } as Settings);
    const restored = f.store.settings(settings);
    assert.equal(restored.environmentId, 'saved-env');
    assert.equal('automaticSpeech' in restored, false);
    assert.equal('audioRouteConfirmed' in restored, false);
  } finally { await f.cleanup(); }
});


test('normal Replicas prose is preserved, summarized once, and remains silent', async () => {
  const f = await setupEngine();
  const prose = 'Yes. **SSO is supported** after configuration. [Docs](https://example.com/docs)';
  f.replicas.history = async () => ({ events: [{ type: 'claude-assistant', payload: { message: { role: 'assistant', content: [{ type: 'text', text: prose }] } } }] });
  let summaries = 0;
  f.models.summarize = async answer => { summaries++; assert.equal(answer, prose); return { status: 'answer', spokenAnswer: result.spokenAnswer, sources: result.sources }; };
  try {
    const id = await f.engine.startManual('Does SSO work?');
    await Promise.all([f.engine.refresh(id), f.engine.refresh(id)]);
    await f.engine.refresh(id);
    assert.equal(summaries, 1);
    assert.equal(f.engine.tasks[0].answer, prose);
    assert.equal(f.engine.tasks[0].status, 'ready');
    assert.equal(f.engine.playing, null);
    assert.equal(new URL(replicaLink('workspace-123')).searchParams.get('path'), '/workspace/workspace-123');
    const prompt = taskPrompt({ question: 'Does SSO work?', context: '' });
    assert.ok(prompt.includes('Current request:\nDoes SSO work?'));
    assert.ok(!prompt.includes('sidekick-result') && !prompt.includes('spokenAnswer'));
  } finally { await f.cleanup(); }
});

test('summary failure keeps the original answer and can be retried without relaunching research', async () => {
  const f = await setupEngine();
  f.models.summarize = async () => { throw new Error('Offline'); };
  try {
    const id = await f.engine.startManual('Does SSO work?');
    await f.engine.refresh(id);
    assert.equal(f.engine.tasks[0].answer, result.answer);
    assert.equal(f.engine.tasks[0].status, 'ready');
    assert.equal(f.engine.tasks[0].spokenAnswer, undefined);
    f.models.summarize = async () => ({ status: 'needs_input', spokenAnswer: 'Which plan are you on?', sources: [] });
    await f.engine.refresh(id);
    assert.equal(f.engine.tasks[0].status, 'needs_attention');
    await f.engine.refresh(id);
    assert.equal(f.store.tasks()[0].status, 'needs_attention');
    assert.match(f.store.tasks()[0].error!, /needs your input/);
    assert.equal(f.creates(), 1);
  } finally { await f.cleanup(); }
});


test('Read to me retries a missing summary and only plays after a successful explicit click', async () => {
  const f = await setupEngine();
  const t = { ...task(), answer: result.answer, spokenAnswer: undefined };
  f.engine.tasks.push(t); f.store.saveTask(t);
  let played = 0;
  f.engine.onPlay = () => { played++; };
  try {
    f.models.summarize = async () => { throw new Error('Invalid schema for response_format'); };
    await f.engine.speak(t.id);
    assert.equal(played, 0); assert.equal(f.engine.playing, null);
    assert.ok(f.engine.diagnosticRuns[0].events.some(e => e.stage === 'Summary' && e.status === 'error'));
    f.models.summarize = async () => ({ status: 'answer', spokenAnswer: result.spokenAnswer, sources: [] });
    await f.engine.speak(t.id);
    assert.equal(played, 1); assert.equal(t.spokenAnswer, result.spokenAnswer);
    assert.equal(f.creates(), 0);
  } finally { await f.cleanup(); }
});

test('stopping while a spoken summary is being prepared prevents playback', async () => {
  const f = await setupEngine();
  const t = { ...task(), answer: result.answer, spokenAnswer: undefined };
  f.engine.tasks.push(t); f.store.saveTask(t);
  let release!: (value: { status: 'answer'; spokenAnswer: string; sources: [] }) => void;
  f.models.summarize = () => new Promise(resolve => { release = resolve; });
  let played = false; f.engine.onPlay = () => { played = true; };
  try {
    const reading = f.engine.speak(t.id);
    f.engine.stopSpeech();
    release({ status: 'answer', spokenAnswer: result.spokenAnswer, sources: [] });
    await reading;
    assert.equal(played, false); assert.equal(f.engine.playing, null);
  } finally { await f.cleanup(); }
});

test('request window excludes prior context duplication and accepts an explicit 88% request with a complete contextual reference', async () => {
  const f = await setupEngine();
  const now = Date.now();
  const prior = { id: 'prior', text: 'We need to understand SSO support.', speaker: 'You', epoch: now - 1000 };
  const command = { id: 'command', text: 'Replicas, could you research that?', speaker: 'You', epoch: now };
  const tail = { id: 'tail', text: 'Anyway, let’s keep talking.', speaker: 'You', epoch: now + 1 };
  let observed: string[] = [];
  f.engine.models.decide = async (context, request) => { observed = [context, request]; return { invoked: 0.88, complete: 0.76, destination: 'replicas', action: 'research' }; };
  try {
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: now, entries: [prior, command, tail] }, [command, tail]);
    await delay(1700);
    assert.equal(observed[0], 'You: We need to understand SSO support.');
    assert.ok(observed[1].includes(command.text)); assert.ok(observed[1].includes(tail.text));
    assert.equal(f.creates(), 1);
    assert.equal(f.engine.detection?.message, 'Research request recognized.');
  } finally { await f.cleanup(); }
});

test('incomplete request can finish in a later transcript update without repeating the wake name', async () => {
  const f = await setupEngine();
  f.decisions.push({ invoked: 0.85, complete: 0.1, destination: 'replicas', action: 'research' });
  const command = { id: 'command', text: 'Replicas, find out whether', speaker: 'You', epoch: Date.now() };
  const continuation = { id: 'continuation', text: 'SSO is supported.', speaker: 'You', epoch: Date.now() + 2000 };
  try {
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: command.epoch, entries: [command] }, [command]);
    await delay(1700); assert.equal(f.creates(), 0);
    assert.equal(f.engine.detection?.message, 'Waiting for the rest of the question…');
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: continuation.epoch, entries: [command, continuation] }, [continuation]);
    await delay(1700); assert.equal(f.creates(), 1);
  } finally { await f.cleanup(); }
});

test('diagnostics show skipped speech, actual Jev inputs and response, and confirmed Replicas send', async () => {
  const f = await setupEngine();
  const e = { id: 'diagnostic', text: 'Replicas, check our SSO support.', speaker: 'You', epoch: Date.now() };
  const prior = { ...e, id: 'prior', text: 'We use the enterprise plan.' };
  try {
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: e.epoch, entries: [prior] }, [prior]);
    assert.match(f.engine.diagnosticRuns[0].events.at(-1)!.message, /No wake name/);
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: e.epoch, entries: [prior, e] }, [e]);
    await delay(1700);
    const run = f.engine.snapshot().diagnostics.runs[0];
    const sent = run.events.find(event => event.stage === 'Jev' && event.status === 'pending')!;
    assert.equal((sent.data as any).state.candidateUtterances, 'You: ' + e.text);
    assert.equal((sent.data as any).state.previousConversation, 'You: ' + prior.text);
    assert.ok((sent.data as any).questions.invoked.instructions);
    const returned = run.events.find(event => event.stage === 'Jev' && event.status === 'ok')!;
    assert.equal((returned.data as any).decision.invoked, 1);
    assert.ok(returned.durationMs! >= 0);
    const handoff = run.events.find(event => event.stage === 'Replicas' && event.status === 'pending')!;
    assert.match((handoff.data as any).message, /Replicas, check our SSO support/);
    assert.ok(run.events.some(event => event.message === 'Replicas confirmed the workspace'));
    assert.equal(run.events.at(-1)!.message, 'Named the Replicas workspace');
    assert.equal((run.events.at(-1)!.data as any).name, 'check-our-sso-support');
    assert.equal((run.events.at(-1)!.data as any).replicaId, 'replica');
    assert.ok(run.events.every(event => event.at >= run.startedAt));
    for (let i = 0; i < 40; i++) await f.engine.refresh(run.taskId!);
    assert.equal(run.events.length, 60);
    assert.ok(run.events.includes(sent), 'polling retains original Jev input');
    assert.ok(run.events.includes(handoff), 'polling retains original Replicas handoff');
  } finally { await f.cleanup(); }
});

test('Jev-only diagnostics test never launches or cancels research, and exposes safe errors', async () => {
  const f = await setupEngine();
  try {
    await f.engine.testJev('Context', 'Replicas, look it up.');
    assert.equal(f.creates(), 0); assert.equal(f.engine.tasks.length, 0);
    assert.match(f.engine.diagnosticRuns[0].events.at(-1)!.message, /Jev-only test/);
    f.models.decide = async () => { throw new Error('secret upstream request payload'); };
    await f.engine.testJev('', 'Replicas, look it up.');
    const trace = JSON.stringify(f.engine.diagnosticRuns[0]);
    assert.match(trace, /Jev test failed/); assert.ok(!trace.includes('secret upstream'));
    f.engine.clearDiagnostics(); assert.equal(f.engine.diagnosticRuns.length, 0);
  } finally { await f.cleanup(); }
});

test('a request arriving during another launch is evaluated after that request finishes', async () => {
  const f = await setupEngine();
  let release!: () => void;
  const create = f.replicas.create;
  let calls = 0;
  f.replicas.create = async (...args) => { if (++calls === 1) await new Promise<void>(resolve => { release = resolve; }); return create(...args); };
  const entry = (id: string) => ({ id, text: `Replicas, research ${id}.`, speaker: 'You', epoch: Date.now() });
  try {
    const first = entry('first');
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: first.epoch, entries: [first] }, [first]); await delay(1650);
    const second = entry('second');
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: second.epoch, entries: [first, second] }, [second]); await delay(1650);
    release(); await delay(1750);
    assert.equal(f.creates(), 2);
    assert.equal(f.engine.diagnosticRuns.filter(run => run.events.some(event => event.message === 'Replicas confirmed the workspace')).length, 2);
  } finally { release?.(); await f.cleanup(); }
});

test('resumed speech and final transcript flush pass an ended marker without replaying history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-resume-'));
  let now = Date.now();
  const db = new DatabaseSync(join(root, 'flow.sqlite'));
  db.exec('CREATE TABLE Meetings(id TEXT,title TEXT,endedAt INTEGER,isDeleted INTEGER,isTourDemo INTEGER)');
  db.prepare('INSERT INTO Meetings VALUES(?,?,?,0,0)').run('meeting', 'Resumed recording', now - 600000);
  await mkdir(join(root, 'meetings/meeting'), { recursive: true });
  const file = join(root, 'meetings/meeting/live.ndjson');
  const old = line('old', now - 600000);
  await writeFile(file, old);
  const received: string[] = [];
  const watcher = new TranscriptWatcher(root, (_meeting, entries) => received.push(...entries.map(e => e.id)), () => {}, () => now);
  try {
    await watcher.poll();
    await delay(20); now += 1000;
    const resumed = line('resumed', now, 'Replicas, research Electron menu-bar apps.');
    await appendFile(file, resumed); now += 6700; await watcher.poll();
    assert.deepEqual(received, ['resumed']);
    assert.equal(watcher.meeting?.id, 'meeting');
    assert.deepEqual(watcher.diagnostics.reads[0].freshIds, ['resumed']);
    assert.match(watcher.diagnostics.reads[0].reason, /ended marker/);
    // Stop metadata arrives before the final transcript write.
    now += 1000; const final = line('final', now, 'Replicas, check Electron Windows support too.');
    db.prepare('UPDATE Meetings SET endedAt=? WHERE id=?').run(now + 500, 'meeting');
    await delay(20); await appendFile(file, final); now += 1000; await watcher.poll();
    assert.deepEqual(received, ['resumed', 'final']);
    await delay(20); await writeFile(file, old + resumed + final); await watcher.poll();
    assert.deepEqual(received, ['resumed', 'final'], 'rewrites do not replay commands');
    const restarted = new TranscriptWatcher(root, (_meeting, entries) => received.push(...entries.map(e => e.id)), () => {}, () => now);
    await restarted.poll(); assert.deepEqual(received, ['resumed', 'final'], 'restart baselines all existing entries');
    now += 5 * 60_000 + 1; await watcher.poll(); assert.equal(watcher.meeting, null);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

function createDictationHistory(root: string) {
  const db = new DatabaseSync(join(root, 'flow.sqlite'));
  db.exec('CREATE TABLE History(transcriptEntityId TEXT PRIMARY KEY, asrText TEXT, formattedText TEXT, timestamp TEXT, status TEXT, platform TEXT, isArchived INTEGER)');
  return db;
}
function insertDictation(db: DatabaseSync, id: string, at: number, text: string, status = 'formatted', platform = 'desktop') {
  db.prepare('INSERT INTO History VALUES(?,?,?,?,?,?,0)').run(id, text, 'Formatted wording', new Date(at).toISOString().replace('T', ' ').replace('Z', ' +00:00'), status, platform);
}

test('dictation watcher waits for completion, prefers original speech, ignores edits/history/mobile, and works without Notetaker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidekick-dictation-'));
  const db = createDictationHistory(root);
  let now = Date.now();
  const received: Meeting[] = [];
  insertDictation(db, 'before-start', now - 1000, 'Replicas, old request.');
  const watcher = new TranscriptWatcher(root, meeting => received.push(meeting), () => {}, () => now);
  try {
    await watcher.poll();
    assert.equal(watcher.status.connected, true);
    assert.equal(watcher.diagnostics.dictation?.connected, true);
    assert.equal(received.length, 0);
    now += 1000;
    insertDictation(db, 'new', now, 'Replicas, research Electron menu-bar apps.', 'transcribing');
    await watcher.poll(); assert.equal(received.length, 0);
    assert.match(watcher.diagnostics.reads[0].reason, /Waiting for completed/);
    // Timestamp is the dictation start, so finishing after a minute must still work.
    now += 90000;
    db.prepare("UPDATE History SET status='formatted' WHERE transcriptEntityId='new'").run();
    await watcher.poll();
    assert.equal(received.length, 1);
    assert.equal(received[0].source, 'dictation');
    assert.equal(received[0].entries[0].text, 'Replicas, research Electron menu-bar apps.');
    assert.equal(watcher.meeting, null);
    assert.equal(watcher.diagnostics.reads[0].source, 'dictation');
    db.prepare("UPDATE History SET asrText='Edited request', formattedText='Another edit' WHERE transcriptEntityId='new'").run();
    insertDictation(db, 'synced-old', now - 3600000, 'Replicas, old imported command.');
    insertDictation(db, 'mobile', now, 'Replicas, mobile command.', 'formatted', 'mobile');
    insertDictation(db, 'empty', now, '', 'formatted');
    db.prepare("UPDATE History SET formattedText='' WHERE transcriptEntityId='empty'").run();
    await watcher.poll(); assert.equal(received.length, 1);
    db.prepare("UPDATE History SET formattedText='Replicas, research SQLite WAL.' WHERE transcriptEntityId='empty'").run();
    await watcher.poll(); assert.equal(received.length, 2);
    assert.equal(received[1].entries[0].text, 'Replicas, research SQLite WAL.');
    const restarted = new TranscriptWatcher(root, meeting => received.push(meeting), () => {}, () => now);
    await restarted.poll(); assert.equal(received.length, 2);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('completed dictations use the real watcher → Jev → Replicas path once, with separate context and notifications', async () => {
  const f = await setupEngine();
  const root = await mkdtemp(join(tmpdir(), 'sidekick-dictation-flow-'));
  const db = createDictationHistory(root);
  const checked: { context: string; request: string }[] = [];
  f.engine.models.decide = async (context, request) => { checked.push({ context, request }); return { invoked: 0.95, complete: 0.9, destination: 'replicas', action: 'research' }; };
  f.engine.updateSettings({ ...settings, wisprDirectory: root });
  const notices: string[] = []; f.engine.onNotify = title => notices.push(title);
  try {
    await f.engine.watcher.poll();
    await delay(10);
    insertDictation(db, 'first', Date.now(), 'Replicas, research Electron menu-bar apps.');
    insertDictation(db, 'second', Date.now(), 'Replicas, research SQLite WAL.');
    await f.engine.watcher.poll(); await delay(100);
    assert.equal(f.creates(), 2);
    assert.equal(checked.length, 2);
    assert.ok(checked.every(call => call.context === ''));
    assert.match(checked[0].request, /Electron/); assert.doesNotMatch(checked[1].request, /Electron/);
    assert.equal(f.engine.diagnosticRuns.filter(run => run.source === 'dictation').length, 2);
    for (const run of f.engine.diagnosticRuns) {
      assert.ok(run.events.some(event => event.stage === 'Jev' && event.status === 'ok'));
      assert.ok(run.events.some(event => event.stage === 'Replicas' && event.status === 'ok'));
    }
    await f.engine.watcher.poll(); await delay(30); assert.equal(f.creates(), 2);
    await f.engine.refresh(f.engine.tasks[0].id);
    assert.ok(notices.includes('Your answer is ready'));
    assert.ok(f.engine.tasks[0].answer);
    f.engine.updateSettings({ ...f.engine.settings, enabled: false });
    insertDictation(db, 'paused', Date.now(), 'Replicas, research while paused.');
    await f.engine.watcher.poll(); await delay(30);
    f.engine.updateSettings({ ...f.engine.settings, enabled: true });
    await f.engine.watcher.poll(); await delay(30); assert.equal(f.creates(), 2);
    assert.ok(f.engine.diagnosticRuns.some(run => run.events.some(event => /Listening is paused/.test(event.message))));
  } finally { db.close(); await f.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('unrelated meeting speech does not replace dictation or supply its context; incomplete dictation releases the next command', async () => {
  const f = await setupEngine();
  let release!: (decision: Decision) => void;
  const contexts: string[] = [];
  f.engine.models.decide = async context => { contexts.push(context); return contexts.length === 1 ? await new Promise(resolve => { release = resolve; }) : { invoked: 1, complete: 1, destination: 'replicas', action: 'research' }; };
  try {
    const entry = { id: 'dictation', text: 'Replicas, research that.', epoch: Date.now(), speaker: 'You' };
    f.engine.receive({ source: 'dictation', id: 'dictation:first', title: 'Dictation', lastSpeechAt: entry.epoch, entries: [entry] }, [entry]);
    await delay(20);
    const meetingEntry = { ...entry, id: 'meeting-entry', text: 'Unrelated private meeting context.' };
    f.engine.receive({ id: 'meeting', title: 'Call', lastSpeechAt: entry.epoch, entries: [meetingEntry] }, [meetingEntry]);
    const next = { ...entry, id: 'next', text: 'Replicas, research Electron menu-bar support.' };
    f.engine.receive({ source: 'dictation', id: 'dictation:second', title: 'Dictation', lastSpeechAt: entry.epoch, entries: [next] }, [next]);
    release({ invoked: 1, complete: 0.2, destination: 'replicas', action: 'research' });
    await delay(100);
    assert.equal(f.creates(), 1);
    assert.deepEqual(contexts, ['', '']);
    assert.ok(f.engine.diagnosticRuns.some(run => run.events.some(event => /dictate the full question again/.test(event.message))));
  } finally { await f.cleanup(); }
});

test('implementation hands off the original transcript and context, persists its mode, and launches outside plan mode', async () => {
  const f = await setupEngine();
  f.decisions.push({ invoked: 0.98, complete: 0.96, destination: 'replicas', action: 'implementation' });
  const requests: { message: string; plan_mode: boolean }[] = [];
  const client = new Replicas(() => 'test', (async (_url, init) => {
    if (init?.method === 'POST') { requests.push(JSON.parse(init.body as string)); return Response.json({ replica: { id: 'implementation-workspace' } }); }
    return Response.json({});
  }) as typeof fetch);
  f.engine.replicas.create = client.create.bind(client);
  const prior = { id: 'prior', text: 'The desktop feedback popover must stay unchanged.', speaker: 'You', epoch: Date.now() - 2000 };
  const entry = { id: 'implement', text: 'Replicas, add code so when I hit feedback it opens a drawer on mobile. Use the existing components.', speaker: 'You', epoch: Date.now() };
  try {
    f.engine.receive({ id: 'meeting', title: 'Call', entries: [prior, entry], lastSpeechAt: entry.epoch }, [entry]);
    await delay(1700);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].plan_mode, false);
    const saved = f.store.tasks()[0];
    assert.equal(saved.mode, 'implementation');
    assert.equal(saved.question, 'You: ' + entry.text);
    assert.equal(saved.context, 'You: ' + prior.text);
    assert.ok(requests[0].message.includes(saved.question));
    assert.ok(requests[0].message.includes(saved.context));
    assert.match(requests[0].message, /skills/);
    assert.doesNotMatch(requests[0].message, /Research only|do not modify|answer in Markdown/i);
    assert.ok(!f.engine.diagnosticRuns[0].events.some(event => event.stage === 'Brief'));
    let notice = ''; f.engine.onNotify = title => { notice = title; };
    await f.engine.refresh(saved.id);
    assert.equal(notice, 'Your task update is ready');
    assert.equal(f.engine.playing, null);
  } finally { await f.cleanup(); }
});

test('an implementation classification without an assistant destination never launches', async () => {
  const f = await setupEngine();
  f.decisions.push({ invoked: 0.99, complete: 0.99, destination: 'none', action: 'implementation' });
  const entry = { id: 'no-destination', text: 'Replicas, add the notification bell.', epoch: Date.now(), speaker: 'You' };
  try {
    f.engine.receive({ source: 'dictation', id: 'dictation:no-destination', title: 'Dictation', lastSpeechAt: entry.epoch, entries: [entry] }, [entry]);
    await delay(30);
    assert.equal(f.creates(), 0);
    assert.equal(f.engine.tasks.length, 0);
  } finally { await f.cleanup(); }
});

test('archiving is reversible, persists the answer, and cannot hide running work', async () => {
  const f = await setupEngine();
  try {
    const item = { ...task(), answer: 'Keep the original result.', replicaId: 'replica' };
    f.engine.tasks.push(item); f.store.saveTask(item);
    f.engine.archive(item.id);
    assert.ok(f.store.tasks()[0].archivedAt);
    assert.equal(f.store.tasks()[0].answer, item.answer);
    assert.equal(f.store.tasks()[0].replicaId, item.replicaId);
    f.engine.archive(item.id, false);
    assert.equal(f.store.tasks()[0].archivedAt, undefined);
    for (const status of ['starting', 'researching', 'speaking'] as const) {
      item.status = status;
      assert.throws(() => f.engine.archive(item.id), /finish/);
      assert.equal(item.archivedAt, undefined);
    }
    item.status = 'ready'; f.engine.playing = item.id;
    assert.throws(() => f.engine.archive(item.id), /finish/);
    f.engine.playing = null;
    f.engine.archive(item.id);
    await f.engine.refresh(item.id);
    assert.equal(item.archivedAt, undefined, 'a new agent response returns an archived task to Inbox');
  } finally { await f.cleanup(); }
});

test('standalone wake retains the requester, freezes context, and waits for a late scope correction', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 100, idleMs: 500, maxMs: 1000 });
  const prior = { id: 'prior', epoch: Date.now() - 1000, speaker: 'Other speaker 2', text: 'Start a Pro trial without a credit card.' };
  const entries = [prior];
  const send = (text: string) => { const e = { id: crypto.randomUUID(), epoch: Date.now(), speaker: 'You', text }; entries.push(e); f.engine.receive({ id: 'call', title: 'Call', entries: [...entries], lastSpeechAt: e.epoch }, [e]); };
  let checks = 0;
  f.models.decide = async (_context, request) => { checks++; return request === 'You: Replicas.' ? { invoked: 0.14, complete: 0.2, action: 'none', destination: 'none' } : { invoked: 0.98, complete: 0.98, action: request.includes('No need') ? 'research' : 'implementation', destination: 'replicas' }; };
  try {
    send('Replicas.'); await delay(30); assert.equal(f.creates(), 0);
    send('Can you change our signup flow?'); await delay(45); assert.equal(f.creates(), 0);
    entries.shift(); // The watcher context can roll forward without losing the topic at the wake.
    send('No need to implement anything. Just research the Stripe code and make a plan.');
    await delay(50); assert.equal(f.creates(), 0);
    await delay(85); assert.equal(f.creates(), 1); assert.equal(checks, 3, 'settling reuses the decision for unchanged input');
    const created = f.engine.tasks[0];
    assert.equal(created.mode, 'research');
    assert.match(created.question, /^You: Replicas\. Can you change/);
    assert.match(created.question, /No need to implement anything/);
    assert.match(created.context, /Start a Pro trial without a credit card/);
  } finally { await f.cleanup(); }
});

test('other-speaker chatter neither inherits a wake nor delays the requester’s handoff', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 100, idleMs: 500, maxMs: 1000 });
  const entries: { id: string; epoch: number; speaker: string; text: string }[] = [];
  const send = (speaker: string, text: string) => { const e = { id: crypto.randomUUID(), epoch: Date.now(), speaker, text }; entries.push(e); f.engine.receive({ id: 'call', title: 'Call', entries: [...entries], lastSpeechAt: e.epoch }, [e]); };
  try {
    send('You', 'Replicas.'); await delay(25);
    send('Other speaker 2', 'Can you change signup?'); await delay(110); assert.equal(f.creates(), 0);
    send('You', 'Research how signup should work.'); await delay(55);
    send('Other speaker 2', 'Yes, that makes sense.'); await delay(75);
    assert.equal(f.creates(), 1);
    assert.equal(f.engine.tasks[0].question, 'You: Replicas. Research how signup should work.');
  } finally { await f.cleanup(); }
});

test('an expired bare wake cannot attach to a later unrelated command', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 40, idleMs: 80, maxMs: 200 });
  const entries = [{ id: 'wake', epoch: Date.now(), speaker: 'You', text: 'Replicas.' }];
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries, lastSpeechAt: Date.now() }, entries);
    await delay(110);
    const later = { id: 'later', epoch: Date.now(), speaker: 'You', text: 'Can you change signup?' }; entries.push(later);
    f.engine.receive({ id: 'call', title: 'Call', entries, lastSpeechAt: later.epoch }, [later]);
    await delay(70); assert.equal(f.creates(), 0);
    assert.ok(f.engine.diagnosticRuns.some(run => run.events.some(event => event.message.includes('Request expired'))));
  } finally { await f.cleanup(); }
});

test('pausing during the transcript settling period prevents a remote launch', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 100, idleMs: 500, maxMs: 1000 });
  const e = { id: 'wake', epoch: Date.now(), speaker: 'You', text: 'Replicas, implement the trial flow.' };
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries: [e], lastSpeechAt: e.epoch }, [e]);
    await delay(30); f.engine.updateSettings({ ...settings, enabled: false });
    await delay(120); assert.equal(f.creates(), 0);
  } finally { await f.cleanup(); }
});

test('request controls expose progress and Send now skips only the waiting timer', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 500, idleMs: 1000, maxMs: 2000 });
  const e = { id: 'send', epoch: Date.now(), speaker: 'You', text: 'Replicas, research the trial flow.' };
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries: [e], lastSpeechAt: e.epoch }, [e]);
    assert.equal(f.engine.snapshot().requests[0].phase, 'heard');
    await delay(35);
    const pending = f.engine.snapshot().requests[0];
    assert.equal(pending.phase, 'ready'); assert.ok(pending.sendAt! > Date.now()); assert.equal(f.creates(), 0);
    await f.engine.requestAction(pending.id, pending.revision, 'send');
    assert.equal(f.creates(), 1); assert.equal(f.engine.snapshot().requests.length, 0);
    await assert.rejects(f.engine.requestAction(pending.id, pending.revision, 'send'), /no longer pending/);
    assert.equal(f.creates(), 1);
  } finally { await f.cleanup(); }
});

test('Cancel while Jev is in flight prevents its late result from launching', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 100, idleMs: 1000, maxMs: 2000 });
  let release!: (d: Decision) => void;
  f.models.decide = () => new Promise<Decision>(resolve => { release = resolve; });
  const e = { id: 'cancel', epoch: Date.now(), speaker: 'You', text: 'Replicas, implement the trial flow.' };
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries: [e], lastSpeechAt: e.epoch }, [e]); await delay(30);
    const pending = f.engine.snapshot().requests[0]; assert.equal(pending.phase, 'checking');
    await f.engine.requestAction(pending.id, pending.revision, 'cancel');
    release({ turn: 'ready', invoked: 1, complete: 1, destination: 'replicas', action: 'implementation' });
    await delay(150); assert.equal(f.creates(), 0); assert.equal(f.engine.snapshot().requests.length, 0);
  } finally { await f.cleanup(); }
});

test('Send now refuses a stale preview and never bypasses Jev’s intent decision', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 200, idleMs: 1000, maxMs: 2000 });
  const first = { id: 'first', epoch: Date.now(), speaker: 'You', text: 'Replicas, implement a trial.' };
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries: [first], lastSpeechAt: first.epoch }, [first]); await delay(30);
    const old = f.engine.snapshot().requests[0];
    const correction = { id: 'second', epoch: Date.now(), speaker: 'You', text: 'Actually, do not do that.' };
    f.decisions.push({ turn: 'not_request', invoked: 0.1, complete: 1, action: 'none', destination: 'none' });
    f.engine.receive({ id: 'call', title: 'Call', entries: [first, correction], lastSpeechAt: correction.epoch }, [correction]);
    await assert.rejects(f.engine.requestAction(old.id, old.revision, 'send'), /More words arrived/);
    await f.engine.requestAction(old.id, 2, 'send');
    await delay(250); assert.equal(f.creates(), 0);
  } finally { await f.cleanup(); }
});

test('more speech during Send now resets the finish request and keeps the expanded preview', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 200, idleMs: 1000, maxMs: 2000 });
  const decision: Decision = { turn: 'ready', invoked: 1, complete: 1, destination: 'replicas', action: 'research' };
  let release!: (d: Decision) => void; let calls = 0;
  f.models.decide = async () => ++calls === 1 ? new Promise<Decision>(resolve => { release = resolve; }) : decision;
  const first = { id: 'first', epoch: Date.now(), speaker: 'You', text: 'Replicas, research trials.' };
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries: [first], lastSpeechAt: first.epoch }, [first]); await delay(30);
    const pending = f.engine.snapshot().requests[0]; await f.engine.requestAction(pending.id, 1, 'send');
    assert.equal(f.engine.snapshot().requests[0].finishing, true);
    const last = { id: 'last', epoch: Date.now(), speaker: 'You', text: 'Include Stripe, and do not implement anything.' };
    f.engine.receive({ id: 'call', title: 'Call', entries: [first, last], lastSpeechAt: last.epoch }, [last]);
    release(decision); await delay(50);
    assert.equal(f.creates(), 0); assert.equal(f.engine.snapshot().requests[0].finishing, false);
    assert.match(f.engine.snapshot().requests[0].text, /do not implement/);
    await delay(210); assert.equal(f.creates(), 1); assert.match(f.engine.tasks[0].question, /do not implement/);
  } finally { await f.cleanup(); }
});

test('collecting is retained despite a low invocation score, then the continuation can become ready', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 50, idleMs: 500, maxMs: 1000 });
  f.decisions.push({ turn: 'collecting', invoked: 0.4, complete: 0.1, action: 'none', destination: 'replicas' });
  const first = { id: 'first', epoch: Date.now(), speaker: 'You', text: 'Replicas, before you start I want you to' };
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries: [first], lastSpeechAt: first.epoch }, [first]); await delay(35);
    assert.equal(f.engine.snapshot().requests[0].phase, 'collecting');
    const last = { id: 'last', epoch: Date.now(), speaker: 'You', text: 'research the no-card trial.' };
    f.engine.receive({ id: 'call', title: 'Call', entries: [first, last], lastSpeechAt: last.epoch }, [last]);
    await delay(100); assert.equal(f.creates(), 1); assert.match(f.engine.tasks[0].question, /before you start/);
  } finally { await f.cleanup(); }
});

test('named speaker identity survives numeric ID changes without merging different people', () => {
  const raw = (id: string, speakerId: number, name: string) => JSON.stringify({ id, text: 'Replicas.', endEpochMs: Date.now(), speaker: { source: 'system', id: speakerId, name } }) + '\n';
  const entries = parseTranscript(raw('one', 1004, 'Jason Kovalenko') + raw('two', 1005, 'Jason Kovalenko') + raw('three', 1005, 'Another Person'));
  assert.equal(entries[0].speaker, 'Jason Kovalenko'); assert.equal(entries[0].speakerKey, entries[1].speakerKey);
  assert.notEqual(entries[1].speakerKey, entries[2].speakerKey);
});

test('an unfinished wake yields to another speaker’s full request without losing the original', async () => {
  const f = await setupEngine({ debounceMs: 10, settleMs: 70, idleMs: 500, maxMs: 1000 });
  const first = { id: 'wake', epoch: Date.now(), speaker: 'You', text: 'Replicas.' };
  try {
    f.engine.receive({ id: 'call', title: 'Call', entries: [first], lastSpeechAt: first.epoch }, [first]); await delay(30);
    const other = { id: 'other', epoch: Date.now(), speaker: 'Jason', text: 'Replicas, research Electron.' };
    f.engine.receive({ id: 'call', title: 'Call', entries: [first, other], lastSpeechAt: other.epoch }, [other]); await delay(100);
    assert.equal(f.creates(), 1); assert.equal(f.engine.tasks[0].question, 'Jason: Replicas, research Electron.');
    assert.equal(f.engine.tasks[0].title, 'research Electron.');
    assert.equal(f.engine.snapshot().requests[0].speaker, 'You'); assert.equal(f.engine.snapshot().requests[0].phase, 'heard');
  } finally { await f.cleanup(); }
});

test('a cancelled launch with a lost reply recovers and stops the original workspace after restart', async () => {
  const f = await setupEngine();
  let resumed: Engine | undefined;
  let creates = 0;
  let loseReply!: (error: Error) => void;
  f.replicas.create = () => { creates++; return new Promise((_, reject) => { loseReply = reject; }); };
  const interrupts: string[][] = [];
  try {
    const launching = f.engine.startManual('Check the active project.');
    const task = f.engine.tasks[0];
    await f.engine.cancel(task.id);
    assert.equal(f.store.tasks()[0].cancelRequested, true);
    loseReply(new Error('Lost create response'));
    await launching;
    f.engine.dispose();
    const client = {
      ...f.replicas,
      findByName: async (name: string) => {
        assert.equal(name, `sidekick-${task.id}`);
        return 'original-workspace';
      },
      wait: async () => ({ done: false, status: 'running', chats: [{ id: 'original-chat', processing: true }] }),
      interrupt: async (id: string, chat: string) => { interrupts.push([id, chat]); },
    };
    resumed = new Engine(settings, f.store, () => ({ gateway: true, replicas: true }), f.models, client);
    await resumed.refresh(task.id);
    await resumed.refresh(task.id);
    assert.deepEqual(interrupts, [['original-workspace', 'original-chat']]);
    assert.equal(f.store.tasks()[0].status, 'cancelled');
    assert.equal(f.store.tasks()[0].cancelRequested, false);
    assert.equal(creates, 1);
  } finally { resumed?.dispose(); await f.cleanup(); }
});

test('Wispr reads a correction and other tasks finish while one agent poll is waiting', async () => {
  const f = await setupEngine({ debounceMs: 60000, settleMs: 60000, idleMs: 120000, maxMs: 180000 });
  const root = await mkdtemp(join(tmpdir(), 'sidekick-monitor-'));
  const db = new DatabaseSync(join(root, 'flow.sqlite'));
  let release!: (state: Awaited<ReturnType<typeof f.replicas.wait>>) => void;
  const held = new Promise<Awaited<ReturnType<typeof f.replicas.wait>>>(resolve => { release = resolve; });
  let polling!: () => void;
  const started = new Promise<void>(resolve => { polling = resolve; });
  let waits = 0;
  let slowTick: Promise<void> | undefined;
  try {
    db.exec("CREATE TABLE Meetings(id TEXT,title TEXT,endedAt INTEGER,isDeleted INTEGER,isTourDemo INTEGER); INSERT INTO Meetings VALUES('meeting','Call',NULL,0,0)");
    const folder = join(root, 'meetings/meeting');
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'live.ndjson');
    await writeFile(file, '');
    f.engine.updateSettings({ ...settings, wisprDirectory: root });
    await f.engine.tick();
    await delay(20); // Wispr entries must be newer than the startup baseline.
    await appendFile(file, line('first', Date.now(), 'Replicas, research the change.'));
    const slow = { ...task(), status: 'researching' as const, replicaId: 'slow' };
    const fast = { ...task(), status: 'researching' as const, replicaId: 'fast' };
    f.engine.tasks.push(slow, fast);
    const normal = f.replicas.wait;
    f.engine.replicas.wait = async id => {
      if (id !== 'slow') return normal();
      waits++; polling();
      return held;
    };
    slowTick = f.engine.tick();
    await started;
    await appendFile(file, line('second', Date.now(), 'Include the migration too.'));
    await f.engine.tick();
    assert.match(f.engine.snapshot().requests[0].text, /Include the migration too/);
    assert.equal(f.engine.tasks.find(t => t.id === fast.id)?.status, 'ready');
    assert.equal(waits, 1);
  } finally {
    release({ done: false, status: 'running', chats: [] });
    await slowTick;
    db.close();
    await f.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('Refresh and Read to me share a pending summary for the same answer', async () => {
  const f = await setupEngine();
  const item = { ...task(), replicaId: 'replica', answer: result.answer, spokenAnswer: undefined };
  f.engine.tasks.push(item);
  let summaries = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let checking!: () => void;
  const started = new Promise<void>(resolve => { checking = resolve; });
  f.models.summarize = async () => {
    summaries++; checking();
    await pending;
    return { status: 'answer', spokenAnswer: result.spokenAnswer, sources: result.sources };
  };
  try {
    const refresh = f.engine.refresh(item.id);
    await started;
    const reading = f.engine.speak(item.id);
    finish();
    await Promise.all([refresh, reading]);
    assert.equal(summaries, 1);
    assert.equal(f.engine.playing, item.id);
    assert.equal(f.store.tasks()[0].status, 'speaking');
  } finally { finish(); await f.cleanup(); }
});
