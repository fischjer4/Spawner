import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentProgress, ResearchTask } from './types.js';
import { UserFacingError } from './errors.js';
import { taskPrompt } from './services.js';

const execute = promisify(execFile);
export class T3Error extends UserFacingError {}
export const t3ConnectionSchema = z.object({ token: z.string(), expiresAt: z.number(), environmentId: z.string() });
export type T3Connection = z.infer<typeof t3ConnectionSchema>;
const modelSchema = z.object({ instanceId: z.string(), model: z.string() }).passthrough();
const projectSchema = z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string(), defaultModelSelection: modelSchema.nullable() });
const turnSchema = z.object({ turnId: z.string(), state: z.enum(['running', 'interrupted', 'completed', 'error']), assistantMessageId: z.string().nullable() });
const threadSchema = z.object({
  id: z.string(), projectId: z.string(), modelSelection: modelSchema, updatedAt: z.string(),
  latestTurn: turnSchema.nullable(), hasPendingApprovals: z.boolean(), hasPendingUserInput: z.boolean(),
  backgroundLiveness: z.string().nullable().optional(),
  session: z.object({ status: z.string(), lastError: z.string().nullable() }).nullable(),
});
const shellSchema = z.object({ projects: z.array(projectSchema), threads: z.array(threadSchema) });
export type T3Project = z.infer<typeof projectSchema> & { modelSelection: z.infer<typeof modelSchema> | null };

// This is T3 Code's installed local API (verified against 0.0.45). Keep its
// discovery, authentication and wire formats here, away from the task lifecycle.
export class T3 {
  private connecting?: Promise<void>;
  constructor(
    private connection: () => T3Connection | undefined,
    private saveConnection: (value: T3Connection) => Promise<void>,
    private fetcher: typeof fetch = fetch,
    private home = join(homedir(), '.t3'),
  ) {}
  private async application(): Promise<string> {
    for (const directory of ['/Applications', join(homedir(), 'Applications')]) {
      for (const name of ['T3 Code (Alpha).app', 'T3 Code.app']) {
        const path = join(directory, name);
        try { await access(join(path, 'Contents/MacOS', basename(path, '.app'))); return path; } catch {}
      }
    }
    throw new T3Error('Install T3 Code in Applications to connect local agents.');
  }
  async open(): Promise<void> { await execute('/usr/bin/open', ['-a', await this.application()]); }
  private async origin(): Promise<string> {
    try {
      const runtime = JSON.parse(await readFile(join(this.home, 'userdata/server-runtime.json'), 'utf8'));
      const url = new URL(runtime.origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new T3Error();
      return url.origin;
    } catch { throw new T3Error('Open T3 Code on this Mac, then reconnect in Settings.'); }
  }
  private async descriptor(origin: string) {
    const response = await this.fetcher(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!response.ok) throw new T3Error('T3 Code is not responding. Open it and reconnect in Settings.');
    const descriptor = z.object({ environmentId: z.string(), orchestrationProtocolVersion: z.literal(1) }).safeParse(await response.json());
    if (!descriptor.success) throw new T3Error('This T3 Code version uses an unsupported API. Update the Sidekick integration.');
    return descriptor.data;
  }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectLocal();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async connectLocal(): Promise<void> {
    let origin: string;
    let descriptor: Awaited<ReturnType<T3['descriptor']>>;
    try { origin = await this.origin(); descriptor = await this.descriptor(origin); }
    catch {
      await execute('/usr/bin/open', ['-g', '-a', await this.application()]);
      for (let attempt = 0; ; attempt++) {
        try { origin = await this.origin(); descriptor = await this.descriptor(origin); break; }
        catch { if (attempt >= 9) throw new T3Error('T3 Code did not become ready. Open it and reconnect in Settings.'); await delay(500); }
      }
    }
    const current = this.connection();
    if (current && current.expiresAt > Date.now() + 60000 && current.environmentId === descriptor.environmentId) {
      const check = await this.fetcher(`${origin}/api/orchestration/shell`, { headers: { Authorization: `Bearer ${current.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (check.ok) return;
      if (check.status !== 401 && check.status !== 403) throw new T3Error(`T3 Code connection check failed (${check.status}).`);
    }
    const app = await this.application();
    let credential: string;
    try {
      const { stdout } = await execute(join(app, 'Contents/MacOS', basename(app, '.app')), [
        join(app, 'Contents/Resources/app.asar/apps/server/dist/bin.mjs'),
        'auth', 'pairing', 'create', '--base-dir', this.home, '--ttl', '5m', '--label', 'Sidekick', '--json',
      ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, maxBuffer: 65536 });
      credential = z.object({ credential: z.string() }).parse(JSON.parse(stdout)).credential;
    } catch { throw new T3Error('T3 Code could not authorize Sidekick. Check that the installed app supports local pairing.'); }
    const response = await this.fetcher(`${origin}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: credential,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: 'orchestration:read orchestration:operate', client_label: 'Sidekick', client_device_type: 'bot', client_os: 'macOS' }),
    });
    if (!response.ok) throw new T3Error(`T3 Code pairing failed (${response.status}). Reconnect in Settings.`);
    const auth = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await response.json());
    await this.saveConnection({ token: auth.access_token, expiresAt: Date.now() + auth.expires_in * 1000, environmentId: descriptor.environmentId });
  }
  private async request(path: string, environmentId?: string, command?: unknown): Promise<unknown> {
    const connection = this.connection();
    if (!connection || connection.expiresAt <= Date.now()) throw new T3Error('Reconnect T3 Code in Settings.');
    if (environmentId && environmentId !== connection.environmentId) throw new T3Error('This task belongs to a different T3 environment. Open its original T3 Code instance.');
    const origin = await this.origin();
    const descriptor = await this.descriptor(origin);
    if (descriptor.environmentId !== connection.environmentId) throw new T3Error('The local T3 environment changed. Reconnect in Settings.');
    let response: Response;
    try {
      response = await this.fetcher(`${origin}${path}`, { method: command ? 'POST' : 'GET', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        ...(command ? { body: JSON.stringify(command) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch { throw new T3Error('T3 Code did not confirm the request. Use Refresh to check the existing thread.'); }
    if (!response.ok) throw new T3Error(response.status === 404 ? 'The T3 thread was not found. Check T3 Code before starting another task.' : `T3 Code returned ${response.status}. ${response.status === 401 || response.status === 403 ? 'Reconnect in Settings.' : 'Use Refresh to check the existing thread.'}`);
    return response.json();
  }
  async projects(): Promise<T3Project[]> {
    const snapshot = shellSchema.parse(await this.request('/api/orchestration/shell'));
    return snapshot.projects.map(project => ({ ...project, modelSelection: project.defaultModelSelection ?? snapshot.threads.filter(t => t.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.modelSelection ?? null }));
  }
  async prepare(projectId: string): Promise<{ project: T3Project; environmentId: string }> {
    await this.connect();
    const project = (await this.projects()).find(project => project.id === projectId);
    if (!project) throw new T3Error('Choose a local T3 project in Settings.');
    if (!project.modelSelection) throw new T3Error('Choose a default model for this project in T3 Code, or start a thread there first.');
    return { project, environmentId: this.connection()!.environmentId };
  }
  async create(task: ResearchTask, project: T3Project): Promise<void> {
    const createdAt = new Date(task.createdAt).toISOString();
    // The HTTP API requires an explicit thread.create before thread.turn.start.
    // Keep both command IDs stable; never retry an ambiguous write automatically.
    await this.request('/api/orchestration/dispatch', task.t3EnvironmentId, {
      type: 'thread.create', commandId: `sidekick-create-${task.id}`, threadId: task.t3ThreadId,
      projectId: project.id, title: task.title, modelSelection: project.modelSelection,
      runtimeMode: 'approval-required', interactionMode: task.mode === 'implementation' ? 'default' : 'plan',
      branch: null, worktreePath: null, createdAt,
    });
    await this.request('/api/orchestration/dispatch', task.t3EnvironmentId, {
      type: 'thread.turn.start', commandId: task.id, threadId: task.t3ThreadId,
      message: { messageId: `sidekick-${task.id}`, role: 'user', text: taskPrompt(task), attachments: [] },
      modelSelection: project.modelSelection, runtimeMode: 'approval-required', interactionMode: task.mode === 'implementation' ? 'default' : 'plan', createdAt,
    });
  }

  async progress(task: ResearchTask): Promise<AgentProgress> {
    const snapshot = shellSchema.parse(await this.request('/api/orchestration/shell', task.t3EnvironmentId));
    const thread = snapshot.threads.find(t => t.id === task.t3ThreadId);
    if (!thread) return { status: 'needs_attention', error: 'The T3 thread was not found. Check T3 Code before starting another task.' };
    if (thread.latestTurn?.state === 'interrupted') return { status: 'cancelled' };
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) return { status: 'needs_attention', error: 'The agent needs your input. Open T3 Code to continue.' };
    if (thread.latestTurn?.state === 'error' || thread.session?.status === 'error') return { status: 'failed', error: 'The local agent failed. Open T3 Code for details.' };
    if (!thread.latestTurn && Date.now() - task.createdAt > 60000) return { status: 'needs_attention', error: 'The T3 thread exists, but no agent turn was confirmed. Open T3 Code to continue there.' };
    if (thread.latestTurn?.state !== 'completed' || thread.backgroundLiveness === 'working') return { status: 'researching' };
    const result = z.object({ thread: z.object({ messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string(), streaming: z.boolean(), turnId: z.string().nullable() })), proposedPlans: z.array(z.object({ turnId: z.string().nullable(), planMarkdown: z.string() })).optional() }) }).parse(await this.request(`/api/orchestration/threads/${encodeURIComponent(task.t3ThreadId!)}?turnLimit=1`, task.t3EnvironmentId));
    const message = result.thread.messages.find(m => m.id === thread.latestTurn?.assistantMessageId) ?? result.thread.messages.filter(m => m.role === 'assistant' && m.turnId === thread.latestTurn?.turnId && !m.streaming).at(-1);
    const answer = (message?.role === 'assistant' && !message.streaming ? message.text : '') || result.thread.proposedPlans?.find(p => p.turnId === thread.latestTurn?.turnId)?.planMarkdown || '';
    return answer.trim() ? { status: 'ready', answer } : { status: 'needs_attention', error: 'The agent stopped without a readable answer. Open T3 Code to review its plan or response.' };
  }
  async interrupt(task: ResearchTask): Promise<boolean> {
    const snapshot = shellSchema.parse(await this.request('/api/orchestration/shell', task.t3EnvironmentId));
    const thread = snapshot.threads.find(t => t.id === task.t3ThreadId);
    if (!thread) throw new T3Error('The T3 thread was not found. Open T3 Code to check cancellation.');
    if (thread.latestTurn && thread.latestTurn.state !== 'running') return true;
    if (!thread.latestTurn && Date.now() - task.createdAt > 60000) return true;
    if (thread.latestTurn) await this.request('/api/orchestration/dispatch', task.t3EnvironmentId, { type: 'thread.turn.interrupt', commandId: randomUUID(), threadId: task.t3ThreadId, turnId: thread.latestTurn.turnId, createdAt: new Date().toISOString() });
    return false;
  }
}
