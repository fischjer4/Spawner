import { randomUUID } from 'node:crypto';
import type { AppState, Entry, Meeting, ResearchTask, Settings, DiagnosticRun, DiagnosticEvent, Decision, PendingRequest, RecordEvent } from './types.js';
import { friendlyError } from './errors.js';
import { Store } from './store.js';
import { conversation, hasWakeName, TranscriptWatcher } from './transcript.js';
import { Models, decisionRequest } from './services.js';
import { FinishedAnswers, replaceAnswer } from './answers.js';
import { ReplicasDestination, T3Destination, type AgentDestination, type CloudClient, type LocalClient } from './agent-destinations.js';
import { TaskMonitor } from './task-monitor.js';

export const LIVE_REQUEST_TIMING = { debounceMs: 1500, settleMs: 4000, idleMs: 60000, maxMs: 180000 };
interface Candidate {
  meeting: Meeting;
  entries: Entry[];
  id: string;
  speaker: string;
  context: string;
  startedAt: number;
  lastReceivedAt: number;
  run: DiagnosticRun;
  phase: PendingRequest['phase'];
  sendAt?: number;
  manualReadyCount?: number;
  checked?: { entryCount: number; decision: Decision };
}
function addressOnly(candidate: Candidate): boolean {
  const words = candidate.entries.map(entry => entry.text).join(' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return /^(?:(?:hey|hi|hello|okay|ok|so|um) )*(?:replicas?|spawner|t3|t three|tee three)$/.test(words);
}

// Only an explicit closing instruction shortens the meeting fallback. A period or
// committed Wispr segment does not mean the speaker has finished their request.
function explicitFinish(candidate: Candidate): boolean {
  const text = candidate.entries.map(entry => entry.text).join(' ').trim();
  return /\b(?:that['’]s all|that is all|that['’]s the (?:whole )?request|you can start now|go ahead and (?:start|send it)|send (?:it|that) now)[.!]?$/i.test(text);
}

export class Engine {
  tasks: ResearchTask[];
  activity = 'Ready for your next meeting or Wispr dictation.';
  detection: AppState['detection'] = null;
  playing: string | null = null;
  diagnosticRuns: DiagnosticRun[] = [];
  private testing = false;
  watcher: TranscriptWatcher;
  private candidate?: Candidate;
  private queuedCandidates: Candidate[] = [];
  private candidateTimer?: NodeJS.Timeout;
  private decisionAbort?: AbortController;
  private speechAbort?: AbortController;
  private readonly monitor = new TaskMonitor();
  private readonly answers = new FinishedAnswers();
  private launching = new Set<string>();
  private stopping = new Map<string, Promise<void>>();
  private disposed = false;
  private lastSpeakingStarted = 0;
  private speechIntervals: { start: number; end: number }[] = [];
  private generation = 0;
  onChange = () => {};
  onNotify = (_title: string, _body: string, _taskId?: string) => {};
  onPlay = (_id: string, _audio: { base64: string; mediaType: string }) => {};
  onStopAudio = () => {};
  constructor(
    public settings: Settings,
    private store: Store,
    private credentials: () => AppState['credentials'],
    public models: Pick<Models, 'decide' | 'speech' | 'summarize'>,
    public replicas: CloudClient,
    private readonly requestTiming = LIVE_REQUEST_TIMING,
    private t3?: LocalClient,
  ) {
    this.tasks = store.tasks();
    for (const task of this.tasks) {
      if (task.status === 'speaking') { task.status = 'ready'; store.saveTask(task); }
      if (task.status === 'starting') {
        task.status = 'needs_attention';
        task.error = 'Spawner restarted during launch. Refresh to check for the existing workspace before trying again.';
        store.saveTask(task);
      }
    }
    this.watcher = this.newWatcher();
  }
  private beginRun(source: DiagnosticRun['source'], request: string): DiagnosticRun {
    const run: DiagnosticRun = { id: randomUUID(), source, startedAt: Date.now(), request, events: [] };
    this.diagnosticRuns = [run, ...this.diagnosticRuns].slice(0, 30);
    return run;
  }
  private record(run: DiagnosticRun, stage: string, message: string, status: DiagnosticEvent['status'] = 'info', data?: unknown, durationMs?: number): void {
    if (!this.diagnosticRuns.includes(run)) this.diagnosticRuns = [run, ...this.diagnosticRuns].slice(0, 30);
    run.events.push({ at: Date.now(), stage, message, status, data, durationMs });
    if (run.events.length > 60) {
      // Progress polling must not push the original Jev input and Replicas handoff out of view.
      const progress = run.events.findIndex(event => event.stage === 'Research');
      run.events.splice(progress >= 0 ? progress : 1, 1);
    }
    this.onChange();
  }
  clearDiagnostics(): void { this.diagnosticRuns = []; this.watcher.diagnostics.reads = []; this.onChange(); }
  notificationEvent(taskId: string | undefined, message: string, status: DiagnosticEvent['status']): void {
    const run = (taskId ? this.diagnosticRuns.find(r => r.taskId === taskId) : undefined) ?? this.beginRun('resumed', 'macOS notification');
    run.taskId = taskId;
    this.record(run, 'Notification', message, status);
  }
  private async checkDecision(run: DiagnosticRun, context: string, request: string, signal?: AbortSignal) {
    const started = Date.now();
    this.record(run, 'Jev', 'Sent request to Jev', 'pending', { model: this.settings.decisionModel, ...decisionRequest(context, request), maxRetries: 1, timeoutMs: 15000 });
    let answers: unknown;
    try {
      const decision = await this.models.decide(context, request, signal, value => { answers = value; });
      this.record(run, 'Jev', 'Jev returned a decision', 'ok', { decision, answers }, Date.now() - started);
      return decision;
    } catch (error) {
      this.record(run, 'Jev', signal?.aborted ? 'Jev check stopped because the pending request was cancelled or listening/settings changed.' : friendlyError(error), 'error', undefined, Date.now() - started);
      throw error;
    }
  }
  async testJev(context: string, request: string): Promise<void> {
    if (this.testing) throw new Error('A Jev test is already running.');
    this.testing = true;
    const run = this.beginRun('test', request);
    this.record(run, 'Test', 'Manual Jev test. Replicas will not be called.');
    try {
      const decision = await this.checkDecision(run, context, request);
      const passes = (!decision.turn || decision.turn === 'ready') && decision.invoked >= 0.8 && decision.complete >= 0.7 && decision.action !== 'none' && decision.destination !== 'none';
      this.record(run, 'Gate', passes ? `Detection gates passed: ${decision.action} for ${decision.destination}.` : 'Detection gates did not pass.', passes ? 'ok' : 'blocked', { invocationThreshold: 0.8, completenessThreshold: 0.7 });
      this.record(run, 'Replicas', 'Not sent: this is a Jev-only test.', 'blocked');
    } catch { this.record(run, 'Replicas', 'Not sent: Jev test failed.', 'blocked'); }
    finally { this.testing = false; this.onChange(); }
  }
  private newWatcher(): TranscriptWatcher { return new TranscriptWatcher(this.settings.wisprDirectory, (m, e) => this.receive(m, e), () => this.onChange()); }
  get ready(): boolean { const c = this.credentials(); return c.gateway && ((c.replicas && !!this.settings.environmentId) || (!!c.t3 && !!this.settings.t3ProjectId)); }
  snapshot(): AppState {
    const meeting = this.watcher.meeting;
    return { requests: this.pendingRequests(), settings: this.settings, credentials: this.credentials(), meeting: meeting ? { id: meeting.id, title: meeting.title, lastSpeechAt: meeting.lastSpeechAt } : null, tasks: this.tasks.map(t => ({ ...t, context: '' })), watcher: this.watcher.status, activity: this.activity, detection: this.detection, diagnostics: { runs: this.diagnosticRuns, watcher: this.watcher.diagnostics }, playing: this.playing, ready: this.ready };
  }
  private pendingRequests(): PendingRequest[] {
    return [this.candidate, ...this.queuedCandidates].filter((item): item is Candidate => !!item && !this.expired(item)).map(candidate => ({
      id: candidate.run.id, revision: candidate.entries.length, speaker: candidate.entries[0].speaker,
      text: conversation(candidate.entries), phase: candidate === this.candidate ? candidate.phase : 'queued',
      mode: candidate.checked?.decision.action, sendAt: candidate.sendAt,
      canSend: candidate === this.candidate && !addressOnly(candidate),
      finishing: candidate.manualReadyCount === candidate.entries.length,
    }));
  }
  async requestAction(id: string, revision: number, action: 'send' | 'cancel'): Promise<void> {
    const candidate = [this.candidate, ...this.queuedCandidates].find(item => item?.run.id === id);
    if (!candidate || this.expired(candidate)) throw new Error('That request is no longer pending.');
    if (action === 'cancel') {
      if (this.candidate === candidate) this.decisionAbort?.abort();
      this.forget(candidate, 'You cancelled this request. Nothing sent to Replicas.');
      this.store.claim(candidate.id);
      this.advanceQueue(); this.onChange(); return;
    }
    if (!this.settings.enabled || !this.ready) throw new Error('Resume listening and connect your tools first.');
    if (candidate !== this.candidate) throw new Error('This request is queued behind another request.');
    if (revision !== candidate.entries.length) throw new Error('More words arrived. Review the updated request and choose Send now again.');
    if (addressOnly(candidate)) throw new Error('Say what you want Replicas to do first.');
    candidate.manualReadyCount = revision;
    this.record(candidate.run, 'Gate', 'You chose Send now. Checking the current request before handoff.', 'pending');
    clearTimeout(this.candidateTimer);
    await this.evaluateCandidate();
  }
  updateSettings(settings: Settings): void {
    if (settings.wisprDirectory !== this.settings.wisprDirectory) {
      this.settings = settings;
      this.watcher = this.newWatcher();
    } else this.settings = settings;
    this.generation++;
    if (this.candidate) this.record(this.candidate.run, 'Gate', 'Pending request cleared because listening or settings changed. Nothing sent to Replicas.', 'blocked');
    this.candidate = undefined;
    for (const candidate of this.queuedCandidates) this.record(candidate.run, 'Gate', 'Queued request cleared because listening or settings changed. Nothing sent to Replicas.', 'blocked');
    this.queuedCandidates = [];
    clearTimeout(this.candidateTimer);
    this.decisionAbort?.abort();
    if (!settings.enabled) { this.stopSpeech(); this.activity = 'Paused. Research already running can still finish.'; }
    this.store.saveSettings(settings);
    this.onChange();
  }
  private expired(candidate: Candidate): boolean {
    return candidate.meeting.source !== 'dictation' && (Date.now() - candidate.startedAt >= this.requestTiming.maxMs || Date.now() - candidate.lastReceivedAt >= this.requestTiming.idleMs);
  }
  private forget(candidate: Candidate, message: string): void {
    this.record(candidate.run, 'Gate', message, 'blocked');
    if (this.candidate === candidate) { this.candidate = undefined; clearTimeout(this.candidateTimer); }
    this.queuedCandidates = this.queuedCandidates.filter(item => item !== candidate);
    this.activity = message;
    this.detection = { request: conversation(candidate.entries), message, at: Date.now() };
  }
  private waitForContinuation(candidate: Candidate): void {
    clearTimeout(this.candidateTimer);
    const remaining = Math.min(candidate.startedAt + this.requestTiming.maxMs, candidate.lastReceivedAt + this.requestTiming.idleMs) - Date.now();
    this.candidateTimer = setTimeout(() => void this.evaluateCandidate(), Math.max(1, remaining));
  }
  receive(meeting: Meeting, entries: Entry[]): void {
    const blocked = !this.settings.enabled ? 'Listening is paused.' : !this.ready ? 'Setup is incomplete: connect Gateway and choose a Replicas environment or local T3 project.' : null;
    const fresh = entries.filter(e => !this.speechIntervals.some(i => e.epoch >= i.start - 1000 && e.epoch <= i.end + 2000) && !(this.playing && e.epoch >= this.lastSpeakingStarted - 1000));
    if (blocked || !fresh.length) {
      const run = this.beginRun(meeting.source === 'dictation' ? 'dictation' : 'live', conversation(entries));
      this.record(run, 'Transcript', 'Received transcript from Wispr', 'ok', { meetingId: meeting.id, entries });
      this.record(run, 'Gate', `${blocked ?? 'Ignored during Spawner voice playback.'} Jev not called; nothing sent to Replicas.`, 'blocked');
      return;
    }
    // A speaker's continuation belongs to their own request. Another participant's
    // chatter must neither inherit a bare wake name nor postpone a completed request.
    const speakers = new Map<string, Entry[]>();
    for (const entry of fresh) { const key = entry.speakerKey ?? entry.speaker; speakers.set(key, [...(speakers.get(key) ?? []), entry]); }
    for (const [speaker, spoken] of speakers) {
      let existing = [this.candidate, ...this.queuedCandidates].find(item => item?.meeting.id === meeting.id && item.speaker === speaker);
      if (existing && this.expired(existing)) { this.forget(existing, 'Request expired after a long pause. Nothing sent to Replicas; say the assistant name again.'); existing = undefined; }
      const wake = spoken.find(entry => hasWakeName(entry.text));
      const run = existing?.run ?? this.beginRun(meeting.source === 'dictation' ? 'dictation' : 'live', conversation(spoken));
      this.record(run, 'Transcript', `Received ${meeting.source === 'dictation' ? 'completed dictation' : `${spoken.length} fresh ${spoken.length === 1 ? 'entry' : 'entries'}`} from Wispr`, 'ok', { source: meeting.source ?? 'meeting', meetingId: meeting.id, entries: spoken, speechToReadMs: Date.now() - Math.max(...spoken.map(e => e.epoch)) });
      if (!existing && !wake) {
        this.record(run, 'Gate', 'No wake name found (Replicas, T3, or Spawner). Jev not called; nothing sent to Replicas.', 'blocked');
        continue;
      }
      const candidate: Candidate = existing ?? {
        meeting, speaker, phase: 'heard', entries: spoken.slice(spoken.indexOf(wake!)),
        context: meeting.source === 'dictation' ? '' : conversation(meeting.entries.filter(entry => entry.id !== wake!.id && entry.epoch <= wake!.epoch && !spoken.slice(spoken.indexOf(wake!)).some(item => item.id === entry.id))),
        id: `${meeting.id}:${wake!.id}`, startedAt: Date.now(), lastReceivedAt: Date.now(), run,
      };
      if (existing) {
        candidate.meeting = meeting;
        const ids = new Set(candidate.entries.map(entry => entry.id));
        const additions = spoken.filter(entry => !ids.has(entry.id));
        if (!additions.length) continue;
        candidate.entries.push(...additions);
        candidate.lastReceivedAt = Date.now();
        candidate.checked = undefined;
        candidate.phase = 'collecting'; candidate.sendAt = undefined; candidate.manualReadyCount = undefined;
      }
      run.request = conversation(candidate.entries);
      if (run.request.length > 18000) { this.forget(candidate, 'Request is too long to send intact. Nothing sent to Replicas; please give a shorter request.'); continue; }
      // An unfinished wake should not block another participant's complete request.
      if (candidate !== this.candidate && this.candidate && !this.decisionAbort && (addressOnly(this.candidate) || (this.candidate.phase === 'collecting' && !!this.candidate.checked))) {
        this.queuedCandidates = this.queuedCandidates.filter(item => item !== candidate);
        this.queuedCandidates.push(this.candidate);
        this.candidate = undefined; clearTimeout(this.candidateTimer);
      }
      if (candidate !== this.candidate && (this.candidate || this.decisionAbort)) {
        if (!existing) this.queuedCandidates.push(candidate);
        this.record(run, 'Gate', 'Queued behind the current request. Speaker and dictation context stay separate.', 'pending');
        continue;
      }
      this.candidate = candidate;
      this.record(run, 'Gate', meeting.source === 'dictation' ? 'Completed dictation received. Checking the request with Jev.' : 'Collecting this speaker’s request. Jev checks after a short pause; handoff waits for transcript updates to settle.', 'pending');
      clearTimeout(this.candidateTimer);
      this.activity = meeting.source === 'dictation' ? 'Checking your dictation…' : 'Listening to the rest of the request…';
      this.detection = { request: run.request, message: this.activity, at: Date.now() };
      this.candidateTimer = setTimeout(() => void this.evaluateCandidate(), meeting.source === 'dictation' ? 0 : this.requestTiming.debounceMs);
    }
    this.advanceQueue();
    this.onChange();
  }
  private advanceQueue(): void {
    if (this.candidate || this.decisionAbort || !this.settings.enabled) return;
    this.candidate = this.queuedCandidates.shift();
    if (!this.candidate) return;
    this.candidateTimer = setTimeout(() => void this.evaluateCandidate(), 0);
  }
  private async evaluateCandidate(): Promise<void> {
    const candidate = this.candidate;
    if (!candidate || !this.settings.enabled) return;
    if (this.decisionAbort) { this.record(candidate.run, 'Gate', 'Waiting for the previous request to finish processing before calling Jev.', 'pending'); return; }
    if (this.expired(candidate)) { this.forget(candidate, 'Request expired after a long pause or the three-minute limit. Nothing sent to Replicas; say the assistant name again.'); this.advanceQueue(); this.onChange(); return; }
    const entryCount = candidate.entries.length;
    const request = conversation(candidate.entries);
    const context = candidate.context;
    const generation = this.generation;
    const controller = new AbortController();
    this.decisionAbort = controller;
    candidate.phase = 'checking'; candidate.sendAt = undefined;
    this.activity = 'Checking the request…';
    this.detection = { request, message: this.activity, at: Date.now() }; this.onChange();
    try {
      const decision = candidate.checked?.entryCount === entryCount ? candidate.checked.decision : await this.checkDecision(candidate.run, context, request, controller.signal);
      if (generation !== this.generation || controller.signal.aborted || this.candidate !== candidate) { this.record(candidate.run, 'Gate', 'Decision ignored because listening, settings, or the pending request changed. Not sent to Replicas.', 'blocked'); return; }
      if (candidate.entries.length !== entryCount) {
        this.record(candidate.run, 'Gate', 'More transcript arrived while Jev was running. Rechecking the expanded request.', 'pending');
        this.candidateTimer = setTimeout(() => void this.evaluateCandidate(), this.requestTiming.debounceMs); return;
      }
      candidate.checked = { entryCount, decision };
      if (candidate.meeting.source !== 'dictation' && addressOnly(candidate)) {
        this.record(candidate.run, 'Gate', 'Only the assistant name has arrived. Keeping it for this speaker’s next transcript entry; no agent launched.', 'pending', { idleTimeoutMs: this.requestTiming.idleMs, maximumRequestMs: this.requestTiming.maxMs });
        candidate.phase = 'heard';
        this.activity = 'Heard the assistant name. Waiting for your request…';
        this.detection = { request, message: this.activity, at: Date.now() };
        this.waitForContinuation(candidate);
        return;
      }
      if (decision.turn === 'collecting' && candidate.meeting.source !== 'dictation') {
        candidate.phase = 'collecting'; candidate.manualReadyCount = undefined;
        this.record(candidate.run, 'Gate', 'Jev is collecting an unfinished request. Waiting for the rest of the instructions.', 'pending', decision);
        this.activity = 'Collecting your request…';
        this.detection = { request, message: this.activity, at: Date.now() };
        this.waitForContinuation(candidate); return;
      }
      if (decision.turn === 'not_request' || decision.invoked < 0.8 || decision.action === 'none' || decision.destination === 'none') {
        this.record(candidate.run, 'Gate', decision.turn === 'not_request' ? 'Jev classified this as not a present request. Nothing sent to Replicas.' : 'Rejected: invocation below 0.8, or no action/assistant was selected. Not sent to Replicas.', 'blocked', decision);
        this.candidate = undefined;
        this.activity = decision.turn === 'not_request' ? 'Not a request. Nothing sent to Replicas.' : `Jev did not confirm a request to do work (${Math.round(decision.invoked * 100)}% request score). Nothing sent to Replicas.`;
        this.detection = { request, message: this.activity, at: Date.now() }; return;
      }
      if (decision.turn === 'collecting' || decision.complete < 0.7) {
        candidate.phase = 'collecting'; candidate.manualReadyCount = undefined;
        const dictation = candidate.meeting.source === 'dictation';
        this.record(candidate.run, 'Gate', dictation ? 'Dictation did not include enough context (completeness below 0.7). Nothing sent to Replicas; dictate the full question again.' : 'Completeness below 0.7. Waiting for more transcript; nothing sent to Replicas yet.', 'blocked', decision);
        if (dictation) this.candidate = undefined;
        this.activity = dictation ? 'Please dictate the full question, including what you want researched.' : 'Waiting for the rest of the question…';
        this.detection = { request, message: this.activity, at: Date.now() };
        if (!dictation) this.waitForContinuation(candidate);
        return;
      }
      const finishSignal = explicitFinish(candidate);
      const settlingMs = finishSignal ? Math.min(2500, this.requestTiming.settleMs) : this.requestTiming.settleMs;
      const sendAt = candidate.lastReceivedAt + settlingMs;
      const settleRemaining = candidate.manualReadyCount === entryCount ? 0 : sendAt - Date.now();
      if (candidate.meeting.source !== 'dictation' && decision.action !== 'cancel' && settleRemaining > 0) {
        candidate.phase = 'ready'; candidate.sendAt = sendAt;
        this.record(candidate.run, 'Gate', finishSignal ? 'Explicit finish heard. Sending after a short grace period.' : 'Request ready. Waiting for delayed transcript updates; Send now skips this wait.', 'pending', { settleWindowMs: settlingMs, remainingMs: settleRemaining, lastReceivedAt: candidate.lastReceivedAt, finishSignal });
        this.activity = 'Request recognized. Waiting for the rest of your transcript…';
        this.detection = { request, message: this.activity, at: Date.now() };
        clearTimeout(this.candidateTimer);
        this.candidateTimer = setTimeout(() => void this.evaluateCandidate(), settleRemaining);
        return;
      }
      this.candidate = undefined;
      if (!this.store.claim(candidate.id)) { this.record(candidate.run, 'Gate', 'Request already handled. Duplicate not sent to Replicas.', 'blocked'); return; }
      this.record(candidate.run, 'Gate', 'Detection gates passed.', 'ok', decision);
      this.detection = { request, message: decision.action === 'cancel' ? 'Cancellation request recognized.' : `${decision.action === 'implementation' ? 'Implementation' : 'Research'} request recognized.`, at: Date.now() };
      if (decision.action === 'cancel') {
        this.record(candidate.run, decision.destination === 't3' ? 'T3' : 'Replicas', 'Cancellation requested; no new research will be launched.');
        const running = this.tasks.filter(t => t.meetingId === candidate.meeting.id && (t.destination ?? 'replicas') === decision.destination && ['starting', 'researching', 'needs_attention'].includes(t.status));
        if (running.length === 1) { await this.cancel(running[0].id); this.activity = 'Cancellation requested. Check the task for its status.'; }
        else this.activity = 'Choose which task to cancel in Spawner.';
        this.record(candidate.run, decision.destination === 't3' ? 'T3' : 'Replicas', this.activity, running.length === 1 ? 'ok' : 'blocked');
        this.detection = { request, message: this.activity, at: Date.now() };
        return;
      }
      const task: ResearchTask = { destination: decision.destination, id: randomUUID(), meetingId: candidate.meeting.id, title: requestTitle(candidate.entries.map(entry => entry.text).join(' ')), mode: decision.action, question: request, context, createdAt: Date.now(), status: 'starting' };
      candidate.run.taskId = task.id;
      this.tasks.unshift(task); this.save(task);
      if (this.tasks.filter(t => ['starting', 'researching'].includes(t.status)).length > 3) {
        task.status = 'needs_attention'; this.record(candidate.run, 'Replicas', 'Not sent: three tasks already running.', 'blocked'); task.error = 'Three tasks are already running. Start this one after a task finishes.'; this.save(task); return;
      }
      await this.launch(task);
    } catch (error) {
      if (!controller.signal.aborted) { this.activity = friendlyError(error); this.detection = { request, message: this.activity, at: Date.now() }; this.onNotify('Could not check the request', this.activity); this.candidate = undefined; }
    } finally {
      this.decisionAbort = undefined;
      this.advanceQueue();
      // A new candidate's debounce may have fired while this request was launching.
      // Re-arm that candidate instead of silently leaving it without a timer.
      if (this.settings.enabled && this.candidate && (this.candidate !== candidate || this.candidate.entries.length !== entryCount)) {
        clearTimeout(this.candidateTimer);
        this.candidateTimer = setTimeout(() => void this.evaluateCandidate(), this.candidate.meeting.source === 'dictation' ? 0 : this.requestTiming.debounceMs);
      }
      this.onChange();
    }
  }
  private taskRun(task: ResearchTask, source: 'manual' | 'resumed'): DiagnosticRun {
    const run = this.diagnosticRuns.find(r => r.taskId === task.id) ?? this.beginRun(source, task.question);
    run.taskId = task.id;
    return run;
  }

  private recorder(run: DiagnosticRun): RecordEvent {
    return (...args) => this.record(run, ...args);
  }

  private destination(task: ResearchTask, run: DiagnosticRun): AgentDestination {
    const context = {
      task, settings: this.settings, credentials: this.credentials(), record: this.recorder(run),
      checkpoint: () => this.save(task),
    };
    return task.destination === 't3'
      ? new T3Destination(this.t3, context)
      : new ReplicasDestination(this.replicas, context);
  }

  async launch(task: ResearchTask): Promise<void> {
    if (this.launching.has(task.id) || task.status !== 'starting') return;
    this.launching.add(task.id);
    const run = this.taskRun(task, 'manual');
    const destination = this.destination(task, run);
    const started = Date.now();
    try {
      await destination.launch();
      if (task.cancelRequested) {
        await this.confirmStop(task, destination);
        return;
      }
      task.status = 'researching';
      task.error = undefined;
      const label = task.mode === 'implementation' ? 'Implementation' : 'Research';
      const local = task.destination === 't3';
      this.activity = `${local ? 'Local task' : label} started: ${task.title}`;
      this.onNotify(local ? 'Local T3 task started' : `${label} started`, task.title, task.id);
    } catch (error) {
      task.status = 'needs_attention';
      task.error = friendlyError(error);
      // Keep an outstanding stop request even if creation was never confirmed.
      if (task.cancelRequested) task.error += ' Refresh to check cancellation.';
      this.record(run, task.destination === 't3' ? 'T3' : 'Replicas', task.error, 'error',
        { error: friendlyError(error instanceof Error && error.cause ? error.cause : error) }, Date.now() - started);
    } finally {
      this.launching.delete(task.id);
      this.save(task);
    }
  }
  async startManual(question: string, destination: 'replicas' | 't3' = 'replicas'): Promise<string> {
    if (!this.credentials().gateway) throw new Error('Connect AI Gateway in Settings first.');
    if (this.tasks.filter(t => ['starting', 'researching'].includes(t.status)).length >= 3) throw new Error('Three tasks are already running.');
    const task: ResearchTask = { destination, id: randomUUID(), meetingId: this.watcher.meeting?.id ?? 'manual', title: requestTitle(question), mode: 'research', question, context: this.watcher.meeting ? conversation(this.watcher.meeting.entries) : '', status: 'starting', createdAt: Date.now() };
    this.tasks.unshift(task); this.save(task);
    await this.launch(task);
    return task.id;
  }
  async tick(): Promise<void> {
    await this.watcher.poll();
    if (this.candidate && this.expired(this.candidate) && !this.decisionAbort) await this.evaluateCandidate();
    this.advanceQueue();
    await this.monitor.poll(this.tasks, id => this.refresh(id));
  }

  refresh(id: string): Promise<void> {
    return this.monitor.refresh(id, async () => {
      const task = this.task(id);
      if (this.launching.has(id) || (task.status === 'cancelled' && !task.cancelRequested)) return;
      const run = this.taskRun(task, 'resumed');
      const destination = this.destination(task, run);
      if (task.cancelRequested) return this.confirmStop(task, destination);
      try {
        const progress = await destination.progress();
        if (!progress || !this.active(task)) return;
        const local = task.destination === 't3';
        if (this.playing === id && (progress.status !== 'ready' || task.answer !== progress.answer)) this.stopSpeech();
        if (progress.status === 'ready') {
          const changed = await this.answers.accept(task, progress.answer, this.answerContext(task, run));
          if (changed && this.active(task)) {
            this.activity = `${local ? 'Local response' : 'Response'} ready: ${task.title}`;
            const title = task.status === 'needs_attention' ? (local ? 'T3 needs your input' : 'Agent needs your input')
              : local ? 'Your local task update is ready' : task.mode === 'implementation' ? 'Your task update is ready' : 'Your answer is ready';
            this.onNotify(title, task.title, task.id);
            this.onChange();
          }
          return;
        }
        const changed = task.status !== progress.status;
        if (progress.answer !== undefined) replaceAnswer(task, progress.answer);
        task.status = progress.status;
        task.error = progress.error;
        this.save(task);
        if (changed && progress.status === 'needs_attention') this.onNotify(local ? 'T3 needs your input' : 'Agent needs your input', task.title, task.id);
      } catch (error) {
        this.record(run, 'Research', friendlyError(error), 'error');
        if (this.active(task)) { task.error = friendlyError(error); this.save(task); }
      }
    });
  }

  private active(task: ResearchTask): boolean {
    return !this.disposed && this.tasks.includes(task) && task.status !== 'cancelled' && !task.cancelRequested;
  }

  private answerContext(task: ResearchTask, run: DiagnosticRun) {
    return {
      save: () => this.save(task), active: () => this.active(task), record: this.recorder(run),
      summarize: this.models.summarize.bind(this.models), model: this.settings.textModel,
    };
  }

  async speak(id: string): Promise<void> {
    const task = this.task(id);
    if (this.playing || !(task.spokenAnswer || task.answer) || !['ready', 'delivered'].includes(task.status)) return;
    this.playing = id;
    this.lastSpeakingStarted = Number.POSITIVE_INFINITY;
    const controller = new AbortController(); this.speechAbort = controller;
    this.activity = 'Preparing the spoken answer…'; this.onChange();
    try {
      if (!task.spokenAnswer) {
        const run = this.taskRun(task, 'manual');
        await this.answers.prepareSummary(task, this.answerContext(task, run), controller.signal);
        if (controller.signal.aborted) return;
        if (!task.spokenAnswer || task.status !== 'ready') { this.playing = null; this.activity = task.error ?? 'The spoken answer is not ready.'; this.onChange(); return; }
      }
      const audio = await this.models.speech(task.spokenAnswer, controller.signal);
      if (controller.signal.aborted) return;
      task.status = 'speaking'; this.lastSpeakingStarted = Date.now(); this.save(task);
      this.onPlay(id, audio);
    } catch (error) {
      if (controller.signal.aborted) return;
      task.error = friendlyError(error); this.save(task);
      this.playing = null; this.onChange();
    }
  }
  playbackEnded(id: string, error?: string): void {
    if (this.playing !== id) return;
    if (Number.isFinite(this.lastSpeakingStarted)) this.speechIntervals.push({ start: this.lastSpeakingStarted, end: Date.now() });
    this.speechIntervals = this.speechIntervals.slice(-20);
    const task = this.tasks.find(t => t.id === id);
    if (task) { task.status = error ? 'ready' : 'delivered'; task.error = error; this.save(task); }
    this.playing = null; this.speechAbort = undefined;
    this.activity = error ?? 'Finished reading. Still listening.'; this.onChange();
  }
  stopSpeech(): void {
    this.speechAbort?.abort(); this.onStopAudio();
    if (this.playing) this.playbackEnded(this.playing, 'Playback stopped. Choose Read to me when you’re ready.');
  }
  async cancel(id: string): Promise<void> {
    const task = this.task(id);
    if (this.playing === id) this.stopSpeech();
    if (task.status === 'cancelled' && !task.cancelRequested) return;
    task.cancelRequested = true;
    task.error = 'Cancellation requested…';
    this.save(task);
    // The launch owns its checkpoint until a remote locator or an error arrives.
    if (this.launching.has(id)) return;
    await this.confirmStop(task, this.destination(task, this.taskRun(task, 'resumed')));
  }

  private confirmStop(task: ResearchTask, destination: AgentDestination): Promise<void> {
    const running = this.stopping.get(task.id);
    if (running) return running;
    const attempt = destination.stop().then(result => {
      task.cancelRequested = !result.stopped;
      task.status = result.stopped ? 'cancelled' : 'researching';
      task.error = result.stopped ? undefined : result.message;
    }).catch(() => {
      const name = task.destination === 't3' ? 'T3 Code' : 'Replicas';
      task.status = 'needs_attention';
      task.error = `Could not confirm cancellation. Open ${name} to stop the agent, or Refresh to retry.`;
    }).finally(() => {
      this.stopping.delete(task.id);
      this.save(task);
    });
    this.stopping.set(task.id, attempt);
    return attempt;
  }
  archive(id: string, archived = true): void {
    const task = this.task(id);
    if (task.cancelRequested || ['starting', 'researching', 'speaking'].includes(task.status) || this.playing === id) throw new Error('Wait for this task to finish before archiving it.');
    task.archivedAt = archived ? Date.now() : undefined;
    this.save(task);
  }
  remove(id: string): void { const task = this.task(id); if (task.cancelRequested || ['starting', 'researching', 'speaking'].includes(task.status)) throw new Error('Stop this task before removing it.'); if (this.playing === id) this.stopSpeech(); this.tasks = this.tasks.filter(t => t.id !== id); this.monitor.forget(id); this.store.deleteTask(id); this.onChange(); }
  private task(id: string): ResearchTask { const task = this.tasks.find(t => t.id === id); if (!task) throw new Error('Task not found.'); return task; }
  private save(task: ResearchTask): void { if (!this.disposed && this.tasks.includes(task)) { this.store.saveTask(task); this.onChange(); } }
  dispose(): void { this.generation++; this.candidate = undefined; this.queuedCandidates = []; clearTimeout(this.candidateTimer); this.decisionAbort?.abort(); this.stopSpeech(); this.disposed = true; }
}

function requestTitle(request: string): string {
  return request.replace(/^(?:You|Speaker|Other speaker \d*):\s*/, '').replace(/^(?:Hey[, ]+)?(?:Replicas?|Spawner|T\s*3|T(?:ee)? three)[,:.!]?\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Replicas task';
}
