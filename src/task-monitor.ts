import type { ResearchTask } from './types.js';

export class TaskMonitor {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly lastPoll = new Map<string, number>();

  refresh(id: string, check: () => Promise<void>): Promise<void> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const result = Promise.resolve().then(check).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, result);
    return result;
  }

  async poll(tasks: ResearchTask[], refresh: (id: string) => Promise<void>): Promise<void> {
    const now = Date.now();
    const due = tasks.filter(task => task.status === 'researching'
      && !this.inFlight.has(task.id) && now - (this.lastPoll.get(task.id) ?? 0) >= 5000);
    for (const task of due) this.lastPoll.set(task.id, now);
    await Promise.all(due.map(task => refresh(task.id)));
  }

  forget(id: string): void { this.lastPoll.delete(id); }
}
