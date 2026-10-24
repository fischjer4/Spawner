import { randomUUID } from 'node:crypto';
import type { AppState, Entry, Meeting, ResearchTask, Settings, DiagnosticRun, DiagnosticEvent, Decision, PendingRequest } from './types.js';
import { T3Error, type T3 } from './t3.js';
import { Store } from './store.js';
import { conversation, hasWakeName, TranscriptWatcher } from './transcript.js';
import { ApiError, extractAnswer, Models, Replicas, taskPrompt, decisionRequest } from './services.js';

export const LIVE_REQUEST_TIMING = { debounceMs: 1500, settleMs: 15000, idleMs: 60000, maxMs: 180000 };
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
  return /^(?:(?:hey|hi|hello|okay|ok|so|um) )*(?:replicas?|sidekick|t3|t three|tee three)$/.test(words);
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
  private tickBusy = false;
  private refreshing = new Set<string>();
  private pollTimes = new Map<string, number>();
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
    public replicas: Pick<Replicas, 'create' | 'wait' | 'history' | 'interrupt' | 'findByName' | 'rename'>,
    private readonly requestTiming = LIVE_REQUEST_TIMING,
    public t3?: Pick<T3, 'prepare' | 'create' | 'progress' | 'interrupt'>,
  ) {
    this.tasks = store.tasks();
    for (const task of this.tasks) {
      if (task.status === 'speaking') { task.status = 'ready'; store.saveTask(task); }
      if (task.status === 'starting') {
        task.status = 'needs_attention';
        task.error = 'Sidekick restarted during launch. Refresh to check for the existing workspace before trying again.';
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
      this.record(run, 'Gate', `${blocked ?? 'Ignored during Sidekick voice playback.'} Jev not called; nothing sent to Replicas.`, 'blocked');
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
        this.record(run, 'Gate', 'No wake name found (Replicas, T3, or Sidekick). Jev not called; nothing sent to Replicas.', 'blocked');
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
        else this.activity = 'Choose which task to cancel in Sidekick.';
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
  async launch(task: ResearchTask): Promise<void> {
    if (task.destination === 't3') return this.launchT3(task);
    if (!this.credentials().replicas || !this.settings.environmentId) {
      task.status = 'needs_attention'; task.error = 'Connect Replicas and choose an environment in Settings.'; this.save(task); return;
    }
    task.workspaceName = `sidekick-${task.id}`;
    this.save(task);
    const run = this.diagnosticRuns.find(r => r.taskId === task.id) ?? this.beginRun('manual', task.question);
    run.taskId = task.id;
    const started = Date.now();
    const mode = task.mode ?? 'research';
    const message = taskPrompt(task);
    this.record(run, 'Replicas', `Sending ${mode} to Replicas with the original transcript`, 'pending', { name: task.workspaceName, environment_id: this.settings.environmentId, message, lifecycle_policy: 'sleep_when_done', plan_mode: mode !== 'implementation', mode });
    try {
      const replicaId = await this.replicas.create(task.workspaceName, this.settings.environmentId, message, mode);
      this.record(run, 'Replicas', 'Replicas confirmed the workspace', 'ok', { replicaId }, Date.now() - started);
      task.replicaId = replicaId;
      // Cancellation during create must still remember and stop the remote task.
      if (task.status === 'cancelled') { this.save(task); await this.cancel(task.id); return; }
      task.status = 'researching'; task.lastMessageAt = Date.now();
      this.activity = `${mode === 'implementation' ? 'Implementation' : 'Research'} started: ${task.title}`;
      this.onNotify(mode === 'implementation' ? 'Implementation started' : 'Research started', task.title, task.id);
    } catch (error) {
      this.record(run, 'Replicas', 'Send attempted, but launch was not confirmed. It may exist remotely; use Refresh, not a new launch.', 'error', { error: friendlyError(error) }, Date.now() - started);
      task.status = 'needs_attention';
      task.error = error instanceof ApiError && error.status < 500 ? error.message : 'Launch was not confirmed. Refresh checks for the existing workspace; Sidekick will not launch a duplicate.';
    }
    this.save(task);
    if (task.replicaId) await this.nameWorkspace(task, run);
  }
  private async launchT3(task: ResearchTask): Promise<void> {
    const run = this.diagnosticRuns.find(r => r.taskId === task.id) ?? this.beginRun('manual', task.question);
    run.taskId = task.id;
    try {
      if (!this.t3 || !this.credentials().t3 || !this.settings.t3ProjectId) throw new T3Error('Connect T3 Code and choose a local project in Settings.');
      const { project, environmentId } = await this.t3.prepare(this.settings.t3ProjectId);
      if (task.status === 'cancelled') return;
      task.t3ThreadId = task.id; task.t3EnvironmentId = environmentId; task.t3ProjectId = project.id;
      this.save(task);
      this.record(run, 'T3', 'Sending the original transcript to local T3 Code', 'pending', { threadId: task.t3ThreadId, project: project.title, model: project.modelSelection, message: taskPrompt(task) });
      await this.t3.create(task, project);
      this.record(run, 'T3', 'T3 Code accepted the local thread', 'ok', { threadId: task.t3ThreadId });
      if (task.cancelRequested) { await this.cancelT3(task); this.save(task); return; }
      task.status = 'researching'; task.error = undefined;
      this.activity = `Local task started: ${task.title}`;
      this.onNotify('Local T3 task started', task.title, task.id);
    } catch (error) {
      task.status = 'needs_attention';
      task.error = task.t3ThreadId ? 'T3 launch was not confirmed. Refresh checks the existing thread; Sidekick will not launch a duplicate.' : friendlyError(error);
      this.record(run, 'T3', task.error, 'error', { error: friendlyError(error) });
    }
    this.save(task);
  }
  private async refreshT3(task: ResearchTask): Promise<void> {
    if (!this.t3 || !task.t3ThreadId) return;
    if (task.cancelRequested) { await this.cancelT3(task); this.save(task); return; }
    const run = this.diagnosticRuns.find(r => r.taskId === task.id) ?? this.beginRun('resumed', task.question);
    run.taskId = task.id;
    const progress = await this.t3.progress(task);
    if (!this.tasks.includes(task) || task.status === 'cancelled' || task.cancelRequested) return;
    this.record(run, 'Research', `T3 Code: ${progress.status}`, progress.error ? 'blocked' : 'ok');
    if (progress.status !== 'ready' || !progress.answer) {
      const changed = task.status !== progress.status;
      task.status = progress.status; task.error = progress.error;
      if (changed && progress.status === 'needs_attention') this.onNotify('T3 needs your input', task.title, task.id);
      this.save(task); return;
    }
    const newAnswer = task.answer !== progress.answer;
    const alreadySummarized = !newAnswer && !!task.spokenAnswer;
    if (newAnswer) { task.archivedAt = undefined; task.spokenAnswer = undefined; task.sources = undefined; }
    task.answer = progress.answer; task.error = undefined;
    this.save(task);
    if (!alreadySummarized) await this.prepareSummary(task, run);
    else task.status = 'ready';
    if (!this.tasks.includes(task) || (task.status as string) === 'cancelled' || task.cancelRequested) return;
    if (newAnswer) this.onNotify(task.status === 'needs_attention' ? 'T3 needs your input' : 'Your local task update is ready', task.title, task.id);
    this.activity = `Local response ready: ${task.title}`;
    this.save(task);
  }
  private async cancelT3(task: ResearchTask): Promise<void> {
    try {
      if (!this.t3) throw new Error('T3 is not connected.');
      const stopped = await this.t3.interrupt(task);
      task.cancelRequested = !stopped;
      task.status = stopped ? 'cancelled' : 'researching';
      task.error = stopped ? undefined : 'Waiting for T3 Code to confirm cancellation…';
    } catch {
      task.status = 'needs_attention'; task.error = 'Could not confirm cancellation. Open T3 Code to stop the agent, or Refresh to retry.';
    }
  }
  private async nameWorkspace(task: ResearchTask, run: DiagnosticRun): Promise<void> {
    if (!task.replicaId || task.workspaceName !== `sidekick-${task.id}`) return;
    // Keep the unique recovery name until the remote ID is saved.
    // Replicas rejects whitespace in both create and rename requests.
    const name = task.title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'research';
    try {
      await this.replicas.rename(task.replicaId, name);
      task.workspaceName = name;
      this.save(task);
      this.record(run, 'Replicas', 'Named the Replicas workspace', 'ok', { replicaId: task.replicaId, name });
    } catch (error) {
      this.record(run, 'Replicas', 'Agent launched; naming failed. Refresh will retry naming.', 'error', { error: friendlyError(error) });
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
    if (this.tickBusy) return;
    this.tickBusy = true;
    try {
      await this.watcher.poll();
      const now = Date.now();
      if (this.candidate && this.expired(this.candidate) && !this.decisionAbort) await this.evaluateCandidate();
      this.advanceQueue();
      for (const task of this.tasks.filter(t => t.status === 'researching')) {
        if (now - (this.pollTimes.get(task.id) ?? 0) < 5000) continue;
        this.pollTimes.set(task.id, now);
        await this.refresh(task.id);
      }
    } finally { this.tickBusy = false; }
  }
  async refresh(id: string): Promise<void> {
    if (this.refreshing.has(id)) return;
    const task = this.task(id);
    this.refreshing.add(id);
    try {
      if (task.destination === 't3') { await this.refreshT3(task); return; }
      if (!task.replicaId && task.workspaceName) {
        task.replicaId = await this.replicas.findByName(task.workspaceName) ?? undefined;
        if (!task.replicaId) { task.error = 'No matching workspace was found among recent API tasks. Check Replicas before starting a new task.'; this.save(task); return; }
        task.status = 'researching'; task.error = undefined; this.save(task);
      }
      if (!task.replicaId) return;
      if (task.cancelRequested) { await this.cancel(id); return; }
      const run = this.diagnosticRuns.find(r => r.taskId === task.id) ?? this.beginRun('resumed', task.question);
      run.taskId = task.id;
      await this.nameWorkspace(task, run);
      const pollStarted = Date.now();
      this.record(run, 'Research', 'Checking Replicas progress', 'pending', { replicaId: task.replicaId });
      const state = await this.replicas.wait(task.replicaId);
      this.record(run, 'Research', state.done ? 'Replicas finished; retrieving the answer' : `Replicas status: ${state.status}`, 'ok', state, Date.now() - pollStarted);
      task.chatId = state.chats[0]?.id ?? task.chatId;
      if (task.status === 'cancelled') return;
      if (state.status === 'error') throw new Error('The Replicas workspace failed to start. Open Replicas for details.');
      if (!state.done) {
        // Pending approval/questions may leave the task waiting indefinitely; inspect periodically.
        if (Date.now() - (task.lastMessageAt ?? task.createdAt) > 60000) {
          const answer = extractAnswer(await this.replicas.history(task.replicaId, task.chatId));
          if (answer.pending) { task.status = 'needs_attention'; task.error = 'The agent has a question or approval waiting in Replicas.'; this.onNotify('Agent needs your input', task.title); }
          task.lastMessageAt = Date.now();
        }
        this.save(task); return;
      }
      const answer = extractAnswer(await this.replicas.history(task.replicaId, task.chatId));
      if (!this.tasks.includes(task) || ['cancelled'].includes(task.status)) return;
      const text = answer.result?.answer ?? answer.text;
      const newAnswer = task.answer !== text;
      if (newAnswer) task.archivedAt = undefined;
      const alreadySummarized = task.answer === text && !!task.spokenAnswer;
      task.answer = text;
      if (answer.failed) { task.status = 'failed'; task.error = 'The research agent reported a failed turn. Open Replicas for details.'; }
      else if (answer.pending || !text.trim()) {
        task.status = 'needs_attention'; task.error = answer.pending ? 'The agent has a question or approval waiting in Replicas.' : 'The agent stopped without a readable answer. Review its response in Replicas.';
      } else if (!alreadySummarized) {
        // Preserve the agent's exact answer, even if the separate summary call fails.
        task.spokenAnswer = undefined; task.sources = undefined; this.save(task);
        await this.prepareSummary(task, run);
        if (!this.tasks.includes(task) || ['cancelled'].includes(task.status)) return;
        this.record(run, 'Answer', task.error ?? 'Answer ready in Sidekick', task.error ? 'blocked' : 'ok', { taskId: task.id, sinceTaskCreatedMs: Date.now() - task.createdAt });
        this.activity = `Response ready: ${task.title}`;
        if (newAnswer) this.onNotify(task.status === 'needs_attention' ? 'Agent needs your input' : task.mode === 'implementation' ? 'Your task update is ready' : 'Your answer is ready', task.title, task.id);
      }
      this.save(task);
    } catch (error) { const run = this.diagnosticRuns.find(r => r.taskId === id); if (run) this.record(run, 'Research', friendlyError(error), 'error'); if (this.tasks.includes(task)) { task.error = friendlyError(error); this.save(task); } }
    finally { this.refreshing.delete(id); }
  }

  private async prepareSummary(task: ResearchTask, run: DiagnosticRun, signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    this.record(run, 'Summary', 'Preparing the answer for Sidekick', 'pending', { model: this.settings.textModel });
    try {
      const summary = await this.models.summarize(task.answer!, signal);
      if (signal?.aborted || !this.tasks.includes(task) || task.status === 'cancelled') return;
      task.spokenAnswer = summary.spokenAnswer; task.sources = summary.sources;
      task.status = summary.status === 'needs_input' ? 'needs_attention' : 'ready';
      task.error = summary.status === 'needs_input' ? `The agent needs your input. Continue in ${task.destination === 't3' ? 'T3 Code' : 'Replicas'}.` : undefined;
      this.record(run, 'Summary', 'Summary returned', 'ok', undefined, Date.now() - started);
    } catch (error) {
      if (signal?.aborted || !this.tasks.includes(task) || task.status === 'cancelled') return;
      task.status = 'ready';
      task.error = 'The full answer is ready. The spoken summary could not be prepared. Read to me or Refresh will try again.';
      this.record(run, 'Summary', friendlyError(error), 'error', { errorType: error instanceof Error ? error.name : 'Unknown' }, Date.now() - started);
    }
    this.save(task);
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
        const run = this.diagnosticRuns.find(r => r.taskId === id) ?? this.beginRun('manual', task.question);
        run.taskId = id;
        await this.prepareSummary(task, run, controller.signal);
        if (controller.signal.aborted) return;
        if (!task.spokenAnswer || task.status !== 'ready') { this.playing = null; this.activity = task.error ?? 'The spoken answer is not ready.'; this.onChange(); return; }
      }
      const audio = await this.models.speech(task.spokenAnswer, controller.signal);
      if (controller.signal.aborted) return;
      task.status = 'speaking'; this.lastSpeakingStarted = Date.now(); this.save(task);
      this.onPlay(id, audio);
    } catch (error) {
      if (!controller.signal.aborted) { task.error = friendlyError(error); this.save(task); }
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
    const previous = task.status;
    task.status = 'cancelled'; this.save(task);
    if (task.destination === 't3') {
      task.cancelRequested = true;
      if (task.t3ThreadId) await this.cancelT3(task);
      this.save(task); return;
    }
    if (!task.replicaId) return;
    try {
      const state = await this.replicas.wait(task.replicaId);
      if (state.status === 'preparing' && state.chats.length === 0) {
        task.status = 'researching'; task.cancelRequested = true; task.error = 'Stopping as soon as the workspace is ready…'; this.save(task); return;
      }
      for (const chat of state.chats) if (chat.processing) await this.replicas.interrupt(task.replicaId, chat.id);
      task.cancelRequested = false; task.error = undefined;
    } catch (error) { task.status = previous === 'starting' ? 'needs_attention' : previous; task.error = 'Could not confirm cancellation. Open Replicas to stop the agent.'; }
    this.save(task);
  }
  archive(id: string, archived = true): void {
    const task = this.task(id);
    if (['starting', 'researching', 'speaking'].includes(task.status) || this.playing === id) throw new Error('Wait for this task to finish before archiving it.');
    task.archivedAt = archived ? Date.now() : undefined;
    this.save(task);
  }
  remove(id: string): void { const task = this.task(id); if (['starting', 'researching', 'speaking'].includes(task.status)) throw new Error('Stop this task before removing it.'); if (this.playing === id) this.stopSpeech(); this.tasks = this.tasks.filter(t => t.id !== id); this.store.deleteTask(id); this.onChange(); }
  private task(id: string): ResearchTask { const task = this.tasks.find(t => t.id === id); if (!task) throw new Error('Task not found.'); return task; }
  private save(task: ResearchTask): void { this.store.saveTask(task); this.onChange(); }
  dispose(): void { this.generation++; this.candidate = undefined; this.queuedCandidates = []; clearTimeout(this.candidateTimer); this.decisionAbort?.abort(); this.stopSpeech(); }
}
export function friendlyError(error: unknown): string {
  if (error instanceof ApiError || error instanceof T3Error) return error.message;
  if (error instanceof Error) {
    if (/invalid schema|response_format/i.test(error.message)) return 'The selected model rejected the summary format. The full answer is still available.';
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'The request timed out. Try again when the connection is available.';
    // AI SDK errors can include provider request bodies; only expose safe, short messages.
    if (/key|auth|401/i.test(error.message)) return 'Check the service API key in Settings.';
    if (/billing|credit|402/i.test(error.message)) return 'The service needs available credits or billing setup.';
    if (/model|404/i.test(error.message)) return 'The selected model is unavailable. Check the model ID in Settings.';
  }
  return 'The service could not complete this request. Check the connection and try again.';
}

function requestTitle(request: string): string {
  return request.replace(/^(?:You|Speaker|Other speaker \d*):\s*/, '').replace(/^(?:Hey[, ]+)?(?:Replicas?|Sidekick|T\s*3|T(?:ee)? three)[,:.!]?\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Replicas task';
}
