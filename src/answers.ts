import type { Models } from './services.js';
import type { ResearchTask, RecordEvent } from './types.js';
import { friendlyError } from './errors.js';

interface AnswerContext {
  save: () => void;
  active: () => boolean;
  record: RecordEvent;
  summarize: Models['summarize'];
  model: string;
}

export function replaceAnswer(task: ResearchTask, text: string): boolean {
  if (task.answer === text) return false;
  task.answer = text;
  task.archivedAt = undefined;
  task.spokenAnswer = undefined;
  task.sources = undefined;
  task.summaryStatus = undefined;
  task.error = undefined;
  return true;
}

export class FinishedAnswers {
  private pending = new WeakMap<ResearchTask, { answer: string; done: Promise<void>; signal?: AbortSignal }>();

  // A completed answer may arrive repeatedly through polling or a manual refresh.
  async accept(task: ResearchTask, text: string, context: AnswerContext): Promise<boolean> {
    const changed = replaceAnswer(task, text);
    if (task.spokenAnswer) {
      // Older records have no separate summary judgment. Preserve the visible
      // attention state until the agent supplies a different answer.
      if (task.status !== 'delivered' && task.status !== 'speaking') {
        const needsInput = task.summaryStatus === 'needs_input' || (!task.summaryStatus && task.status === 'needs_attention');
        task.status = needsInput ? 'needs_attention' : 'ready';
        task.error = needsInput ? inputMessage(task) : undefined;
      }
      context.save();
      return false;
    }
    context.save();
    await this.prepareSummary(task, context);
    if (!context.active()) return false;
    context.record('Answer', task.error ?? 'Answer ready in Sidekick', task.error ? 'blocked' : 'ok',
      { taskId: task.id, sinceTaskCreatedMs: Date.now() - task.createdAt });
    return changed;
  }

  async prepareSummary(task: ResearchTask, context: AnswerContext, signal?: AbortSignal): Promise<void> {
    const answer = task.answer;
    if (!answer || signal?.aborted || !context.active()) return;
    const pending = this.pending.get(task);
    if (pending?.answer === answer && !pending.signal?.aborted) {
      await pending.done;
      // A reader may stop playback while a refresh is sharing its summary.
      if (pending.signal?.aborted && !signal?.aborted && context.active() && task.answer === answer) {
        await this.prepareSummary(task, context, signal);
      }
      return;
    }
    const done = summarize(task, answer, context, signal);
    this.pending.set(task, { answer, done, signal });
    try { await done; }
    finally { if (this.pending.get(task)?.done === done) this.pending.delete(task); }
  }
}

function inputMessage(task: ResearchTask): string {
  return `The agent needs your input. Continue in ${task.destination === 't3' ? 'T3 Code' : 'Replicas'}.`;
}

async function summarize(task: ResearchTask, answer: string, context: AnswerContext, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  const current = () => !signal?.aborted && context.active() && task.answer === answer;
  context.record('Summary', 'Preparing the answer for Sidekick', 'pending', { model: context.model });
  try {
    const summary = await context.summarize(answer, signal);
    if (!current()) return;
    task.summaryStatus = summary.status;
    task.spokenAnswer = summary.spokenAnswer;
    task.sources = summary.sources;
    task.status = summary.status === 'needs_input' ? 'needs_attention' : 'ready';
    task.error = summary.status === 'needs_input' ? inputMessage(task) : undefined;
    context.record('Summary', 'Summary returned', 'ok', undefined, Date.now() - started);
  } catch (error) {
    if (!current()) return;
    task.status = 'ready';
    task.error = 'The full answer is ready. The spoken summary could not be prepared. Read to me or Refresh will try again.';
    context.record('Summary', friendlyError(error), 'error', { errorType: error instanceof Error ? error.name : 'Unknown' }, Date.now() - started);
  }
  context.save();
}
