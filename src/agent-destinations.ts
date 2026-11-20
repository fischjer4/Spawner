import { ApiError, extractAnswer, taskPrompt, type Replicas } from './services.js';
import { T3Error, type T3 } from './t3.js';
import type { AgentProgress, AppState, ResearchTask, Settings, RecordEvent } from './types.js';
import { friendlyError, UserFacingError } from './errors.js';

export type CloudClient = Pick<Replicas, 'create' | 'wait' | 'history' | 'interrupt' | 'findByName' | 'rename'>;
export type LocalClient = Pick<T3, 'prepare' | 'create' | 'progress' | 'interrupt'>;

interface TaskContext {
  task: ResearchTask;
  settings: Settings;
  credentials: AppState['credentials'];
  checkpoint: () => void;
  record: RecordEvent;
}

type StopResult = { stopped: true } | { stopped: false; message: string };

export interface AgentDestination {
  launch(): Promise<void>;
  progress(): Promise<AgentProgress | undefined>;
  stop(): Promise<StopResult>;
}

export class ReplicasDestination implements AgentDestination {
  constructor(private client: CloudClient, private context: TaskContext) {}

  async launch(): Promise<void> {
    const { task, settings, credentials, checkpoint, record } = this.context;
    if (!credentials.replicas || !settings.environmentId) throw new UserFacingError('Connect Replicas and choose an environment in Settings.');
    const mode = task.mode ?? 'research';
    const message = taskPrompt(task);
    const name = `spawner-${task.id}`;
    task.workspaceName = name;
    checkpoint();
    const started = Date.now();
    record('Replicas', `Sending ${mode} to Replicas with the original transcript`, 'pending',
      { name, environment_id: settings.environmentId, message, lifecycle_policy: 'sleep_when_done', plan_mode: mode !== 'implementation', mode });
    try {
      task.replicaId = await this.client.create(name, settings.environmentId, message, mode);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw error;
      throw new UserFacingError('Launch was not confirmed. Refresh checks for the existing workspace; Spawner will not launch a duplicate.', { cause: error });
    }
    task.lastMessageAt = Date.now();
    checkpoint();
    record('Replicas', 'Replicas confirmed the workspace', 'ok', { replicaId: task.replicaId }, Date.now() - started);
    if (!task.cancelRequested) await this.nameWorkspace(task.replicaId);
  }

  private async locate(): Promise<string | undefined> {
    const { task, checkpoint } = this.context;
    if (!task.replicaId && task.workspaceName) {
      const id = await this.client.findByName(task.workspaceName);
      if (!id) throw new UserFacingError('No matching workspace was found among recent API tasks. Check Replicas before starting a new task.');
      task.replicaId = id;
      checkpoint();
    }
    return task.replicaId;
  }

  private async nameWorkspace(id: string): Promise<void> {
    const { task, record, checkpoint } = this.context;
    if (task.workspaceName !== `spawner-${task.id}`) return;
    const name = task.title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'research';
    try {
      await this.client.rename(id, name);
      task.workspaceName = name;
      checkpoint();
      record('Replicas', 'Named the Replicas workspace', 'ok', { replicaId: id, name });
    } catch (error) {
      record('Replicas', 'Agent launched; naming failed. Refresh will retry naming.', 'error', { error: friendlyError(error) });
    }
  }

  async progress(): Promise<AgentProgress | undefined> {
    const { task, checkpoint, record } = this.context;
    const id = await this.locate();
    if (!id) return;
    await this.nameWorkspace(id);
    const started = Date.now();
    record('Research', 'Checking Replicas progress', 'pending', { replicaId: id });
    const state = await this.client.wait(id);
    record('Research', state.done ? 'Replicas finished; retrieving the answer' : `Replicas status: ${state.status}`, 'ok', state, Date.now() - started);
    task.chatId = state.chats[0]?.id ?? task.chatId;
    if (state.status === 'error') return { status: 'failed', error: 'The Replicas workspace failed to start. Open Replicas for details.' };
    const pendingMessage = 'The agent has a question or approval waiting in Replicas.';
    if (!state.done) {
      if (Date.now() - (task.lastMessageAt ?? task.createdAt) > 60000 || task.status === 'needs_attention') {
        const answer = extractAnswer(await this.client.history(id, task.chatId));
        task.lastMessageAt = Date.now();
        checkpoint();
        if (answer.pending) return { status: 'needs_attention', error: pendingMessage };
      }
      return { status: 'researching' };
    }
    const result = extractAnswer(await this.client.history(id, task.chatId));
    const answer = result.result?.answer ?? result.text;
    if (result.failed) return { status: 'failed', answer, error: 'The research agent reported a failed turn. Open Replicas for details.' };
    if (result.pending || !answer.trim()) return { status: 'needs_attention', answer, error: result.pending ? pendingMessage : 'The agent stopped without a readable answer. Review its response in Replicas.' };
    return { status: 'ready', answer };
  }

  async stop(): Promise<StopResult> {
    const id = await this.locate();
    if (!id) return { stopped: true };
    const state = await this.client.wait(id);
    if (state.status === 'preparing' && !state.chats.length) return { stopped: false, message: 'Stopping as soon as the workspace is ready…' };
    for (const chat of state.chats) if (chat.processing) await this.client.interrupt(id, chat.id);
    return { stopped: true };
  }
}

export class T3Destination implements AgentDestination {
  constructor(private client: LocalClient | undefined, private context: TaskContext) {}

  async launch(): Promise<void> {
    const { task, settings, credentials, checkpoint, record } = this.context;
    if (!this.client || !credentials.t3 || !settings.t3ProjectId) throw new T3Error('Connect T3 Code and choose a local project in Settings.');
    const { project, environmentId } = await this.client.prepare(settings.t3ProjectId);
    if (task.cancelRequested) return;
    task.t3ThreadId = task.id;
    task.t3EnvironmentId = environmentId;
    task.t3ProjectId = project.id;
    checkpoint();
    record('T3', 'Sending the original transcript to local T3 Code', 'pending', { threadId: task.t3ThreadId, project: project.title, model: project.modelSelection, message: taskPrompt(task) });
    try {
      await this.client.create(task, project);
    } catch (error) {
      const message = 'T3 launch was not confirmed. Refresh checks the existing thread; Spawner will not launch a duplicate.';
      throw new T3Error(message, { cause: error });
    }
    record('T3', 'T3 Code accepted the local thread', 'ok', { threadId: task.t3ThreadId });
  }

  async progress(): Promise<AgentProgress | undefined> {
    const { task, record } = this.context;
    if (!task.t3ThreadId) return;
    if (!this.client) throw new T3Error('Reconnect T3 Code in Settings.');
    const progress = await this.client.progress(task);
    record('Research', `T3 Code: ${progress.status}`, progress.error ? 'blocked' : 'ok');
    return progress;
  }

  async stop(): Promise<StopResult> {
    const { task } = this.context;
    if (!task.t3ThreadId) return { stopped: true };
    if (!this.client) throw new T3Error('Reconnect T3 Code in Settings.');
    return await this.client.interrupt(task) ? { stopped: true } : { stopped: false, message: 'Waiting for T3 Code to confirm cancellation…' };
  }
}
