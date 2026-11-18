import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { T3, type T3Connection } from '../src/t3.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Settings } from '../src/types.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'sidekick-t3-'));
  await mkdir(join(home, 'userdata'));
  await writeFile(join(home, 'userdata/server-runtime.json'), JSON.stringify({ origin: 'http://127.0.0.1:3773' }));
  const connection: T3Connection = { token: 'private-test-token', expiresAt: Date.now() + 3600000, environmentId: 'local-env' };
  const modelSelection = { instanceId: 'codex', model: 'test-model', options: [{ key: 'reasoningEffort', value: 'high' }] };
  const project = { id: 'project', title: 'Local project', workspaceRoot: home, defaultModelSelection: modelSelection };
  const state = { environmentId: 'local-env', threads: [] as any[], commands: [] as any[], messages: [] as any[], plans: [] as any[], failStart: false, detailReads: 0 };
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://127.0.0.1:3773');
    assert.equal(init?.redirect, 'error');
    if (url.pathname === '/.well-known/t3/environment') return Response.json({ environmentId: state.environmentId, orchestrationProtocolVersion: 1 });
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${connection.token}`);
    if (url.pathname === '/api/orchestration/shell') return Response.json({ projects: [project], threads: state.threads });
    if (url.pathname.startsWith('/api/orchestration/threads/')) { state.detailReads++; return Response.json({ thread: { messages: state.messages, proposedPlans: state.plans } }); }
    if (url.pathname === '/api/orchestration/dispatch') {
      const command = JSON.parse(init!.body as string); state.commands.push(command);
      if (command.type === 'thread.create') state.threads.push({ id: command.threadId, projectId: project.id, modelSelection, updatedAt: new Date().toISOString(), latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false, session: null });
      if (command.type === 'thread.turn.start') {
        state.threads.at(-1).latestTurn = { turnId: 'turn-1', state: 'running', assistantMessageId: 'final' };
        if (state.failStart) throw new Error('Lost response after T3 accepted the turn');
      }
      if (command.type === 'thread.turn.interrupt') state.threads.find(t => t.id === command.threadId).latestTurn.state = 'interrupted';
      return Response.json({ sequence: 1 });
    }
    throw new Error('Unexpected endpoint');
  }) as typeof fetch;
  const client = new T3(() => connection, async () => {}, fetcher, home);
  const store = new Store(join(home, 'sidekick'));
  const settings: Settings = { enabled: true, launchAtLogin: false, wisprDirectory: '/missing', environmentId: '', environmentName: '', decisionModel: 'test', textModel: 'test', speechModel: 'test', voice: 'test', t3ProjectId: 'project', t3ProjectName: 'Local project' };
  let cloudCalls = 0, summaries = 0;
  const cloud = async (): Promise<any> => { cloudCalls++; throw new Error('Must not call Replicas'); };
  const engine = new Engine(settings, store, () => ({ gateway: true, replicas: false, t3: true }), {
    decide: async () => ({ turn: 'ready', invoked: 1, complete: 1, destination: 't3', action: 'research' }),
    summarize: async text => { summaries++; return { status: 'answer', spokenAnswer: text, sources: [] }; },
    speech: async () => ({ base64: '', mediaType: 'audio/wav' }),
  }, { create: cloud, wait: cloud, history: cloud, interrupt: cloud, rename: cloud, findByName: cloud }, { debounceMs: 1, settleMs: 0, idleMs: 10000, maxMs: 20000 }, client);
  const finish = () => {
    state.threads.at(-1).latestTurn.state = 'completed';
    state.messages = [{ id: 'commentary', role: 'assistant', text: 'Let me check.', streaming: false, turnId: 'turn-1' }, { id: 'tool', role: 'tool', text: 'Not an answer', streaming: false, turnId: 'turn-1' }, { id: 'final', role: 'assistant', text: 'Local task finished.', streaming: false, turnId: 'turn-1' }];
  };
  return { home, client, store, engine, state, connection, project, finish, cloudCalls: () => cloudCalls, summaries: () => summaries,
    cleanup: async () => { engine.dispose(); store.close(); await rm(home, { recursive: true, force: true }); } };
}

test('T3 dictation launches locally without Replicas credentials and preserves the original request', async () => {
  const f = await fixture();
  try {
    assert.equal(f.engine.ready, true);
    const entry = { id: randomUUID(), speaker: 'You', text: 'T three, investigate this local project. Do not change anything.', epoch: Date.now() };
    const meeting = { source: 'dictation' as const, id: 'dictation', title: 'Dictation', lastSpeechAt: entry.epoch, entries: [entry] };
    f.engine.receive(meeting, [entry]);
    for (let i = 0; i < 50 && f.state.commands.length < 2; i++) await delay(10);
    assert.equal(f.state.commands.length, 2);
    const [create, start] = f.state.commands;
    assert.equal(create.type, 'thread.create'); assert.equal(create.projectId, 'project');
    assert.equal(start.type, 'thread.turn.start'); assert.equal(start.interactionMode, 'plan');
    assert.equal(start.runtimeMode, 'approval-required'); assert.deepEqual(start.modelSelection, f.project.defaultModelSelection);
    assert.ok(start.message.text.includes(entry.text)); assert.ok(start.message.text.includes('continue this thread in T3 Code'));
    assert.equal(f.engine.tasks[0].destination, 't3'); assert.equal(f.engine.tasks[0].t3ThreadId, create.threadId);
    assert.equal(f.cloudCalls(), 0);
    f.engine.receive(meeting, [entry]); await delay(20); assert.equal(f.state.commands.length, 2);
    assert.ok(!JSON.stringify(f.engine.snapshot()).includes(f.connection.token));
  } finally { await f.cleanup(); }
});

test('T3 waits for completion, surfaces approvals, and summarizes only the final assistant answer', async () => {
  const f = await fixture();
  try {
    const id = await f.engine.startManual('Check the project.', 't3');
    f.state.messages = [{ id: 'final', role: 'assistant', text: 'Still working', streaming: false, turnId: 'turn-1' }];
    await f.engine.refresh(id); assert.equal(f.engine.tasks[0].status, 'researching'); assert.equal(f.state.detailReads, 0);
    f.state.threads[0].hasPendingApprovals = true;
    await f.engine.refresh(id); assert.equal(f.engine.tasks[0].status, 'needs_attention'); assert.match(f.engine.tasks[0].error!, /T3 Code/); assert.equal(f.summaries(), 0);
    f.state.threads[0].hasPendingApprovals = false; f.finish();
    await f.engine.refresh(id); await f.engine.refresh(id);
    assert.equal(f.engine.tasks[0].answer, 'Local task finished.'); assert.equal(f.engine.tasks[0].status, 'ready'); assert.equal(f.summaries(), 1); assert.equal(f.cloudCalls(), 0);
  } finally { await f.cleanup(); }
});

test('a lost T3 start response recovers the persisted thread without launching again', async () => {
  const f = await fixture();
  try {
    f.state.failStart = true;
    const id = await f.engine.startManual('Check the project.', 't3');
    assert.equal(f.engine.tasks[0].status, 'needs_attention'); assert.equal(f.store.tasks()[0].t3ThreadId, id);
    f.finish(); await f.engine.refresh(id);
    assert.equal(f.engine.tasks[0].status, 'ready'); assert.equal(f.state.commands.length, 2); assert.equal(f.cloudCalls(), 0);
  } finally { await f.cleanup(); }
});

test('T3 implementation uses default interaction mode and cancellation never touches Replicas', async () => {
  const f = await fixture();
  try {
    const task = { id: randomUUID(), destination: 't3' as const, mode: 'implementation' as const, meetingId: 'manual', title: 'Change', question: 'T3, fix it.', context: '', status: 'starting' as const, createdAt: Date.now() };
    f.engine.tasks.push(task); await f.engine.launch(task);
    assert.equal(f.state.commands[1].interactionMode, 'default'); assert.match(f.state.commands[1].message.text, /^Implementation:/);
    await f.engine.cancel(task.id); await f.engine.refresh(task.id);
    assert.equal(f.engine.tasks[0].status, 'cancelled'); assert.equal(f.engine.tasks[0].cancelRequested, false);
    assert.equal(f.state.commands[2].type, 'thread.turn.interrupt'); assert.equal(f.cloudCalls(), 0);
  } finally { await f.cleanup(); }
});

test('missing T3 configuration retains a T3 task without falling back to the cloud', async () => {
  const f = await fixture();
  try {
    f.engine.settings.t3ProjectId = '';
    await f.engine.startManual('Check the project.', 't3');
    assert.equal(f.engine.tasks[0].status, 'needs_attention'); assert.match(f.engine.tasks[0].error!, /choose a local project/);
    assert.equal(f.state.commands.length, 0); assert.equal(f.cloudCalls(), 0);
  } finally { await f.cleanup(); }
});

test('T3 refuses changed environments and nonlocal discovery before sending a token or command', async () => {
  const f = await fixture();
  try {
    f.state.environmentId = 'different-environment';
    await assert.rejects(() => f.client.projects(), /environment changed/);
    await writeFile(join(f.home, 'userdata/server-runtime.json'), JSON.stringify({ origin: 'https://example.com' }));
    await assert.rejects(() => f.client.projects(), /Open T3 Code/);
    assert.equal(f.state.commands.length, 0);
  } finally { await f.cleanup(); }
});

test('a completed T3 plan is readable when the agent supplied no final message', async () => {
  const f = await fixture();
  try {
    const id = await f.engine.startManual('Plan the change.', 't3');
    f.finish(); f.state.messages = []; f.state.plans = [{ turnId: 'turn-1', planMarkdown: 'A proposed plan, not completed work.' }];
    await f.engine.refresh(id); assert.equal(f.engine.tasks[0].answer, 'A proposed plan, not completed work.');
  } finally { await f.cleanup(); }
});

test('refreshing an unchanged T3 answer preserves its judgment, delivery, and archive state', async () => {
  const f = await fixture();
  const notifications: string[] = [];
  let summaries = 0;
  try {
    const id = await f.engine.startManual('Check the project.', 't3');
    f.engine.onNotify = title => { notifications.push(title); };
    f.engine.models.summarize = async text => ({
      status: ++summaries === 1 ? 'needs_input' : 'answer', spokenAnswer: text, sources: [],
    });
    f.finish();
    await f.engine.refresh(id);
    assert.equal(f.engine.tasks[0].status, 'needs_attention');
    await f.engine.refresh(id);
    assert.equal(f.store.tasks()[0].status, 'needs_attention');
    assert.match(f.store.tasks()[0].error!, /needs your input/);
    f.state.messages.at(-1).text = 'Here is the revised answer.';
    await f.engine.refresh(id);
    await f.engine.speak(id);
    await f.engine.refresh(id);
    assert.equal(f.engine.tasks[0].status, 'speaking');
    f.engine.playbackEnded(id);
    f.engine.archive(id);
    const archivedAt = f.engine.tasks[0].archivedAt;
    await f.engine.refresh(id);
    assert.equal(f.store.tasks()[0].status, 'delivered');
    assert.equal(f.store.tasks()[0].archivedAt, archivedAt);
    assert.equal(summaries, 2);
    assert.deepEqual(notifications, ['T3 needs your input', 'Your local task update is ready']);
  } finally { await f.cleanup(); }
});
