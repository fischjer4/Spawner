import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Entry, Meeting, WatcherDiagnostics, TranscriptRead } from './types.js';

export function parseTranscript(text: string): Entry[] {
  const entries = new Map<string, Entry>();
  // Ignore a partially written final line. Wispr terminates committed entries with a newline.
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      if (typeof raw.id !== 'string' || typeof raw.text !== 'string' || !raw.text.trim()) continue;
      const epoch = Number(raw.endEpochMs ?? raw.startEpochMs ?? raw.epochMs);
      if (!Number.isFinite(epoch)) continue;
      const source = raw.speaker?.source;
      const name = typeof raw.speaker?.name === 'string' ? raw.speaker.name.trim() : '';
      const speakerKey = source === 'mic' ? 'mic' : `system:${name ? 'name:' + name.toLowerCase() : 'id:' + (raw.speaker?.id ?? 'unknown')}`;
      const speaker = source === 'mic' ? 'You' : source === 'system' ? name || `Other speaker ${raw.speaker.id ?? ''}`.trim() : 'Speaker';
      entries.set(raw.id, { id: raw.id, text: raw.text, epoch, speaker, speakerKey });
    } catch { /* A malformed entry must not block the next valid line. */ }
  }
  return [...entries.values()].sort((a, b) => a.epoch - b.epoch);
}

export function isFresh(entry: Entry, now: number, since: number): boolean {
  return entry.epoch > since && entry.epoch > now - 60_000 && entry.epoch < now + 5_000;
}

export class TranscriptWatcher {
  meeting: Meeting | null = null;
  status = { connected: false, message: 'Looking for Wispr Flow…' };
  private files = new Map<string, { mtime: number; ids: Set<string> }>();
  private startedAt: number;
  diagnostics: WatcherDiagnostics;
  private busy = false;
  private baseline = false;
  private activeFile?: string;
  private dictationBaseline = false;
  private dictations = new Map<string, string>();
  private emittedDictations = new Set<string>();
  constructor(
    public directory: string,
    private onEntries: (meeting: Meeting, entries: Entry[]) => void,
    private onChange: () => void,
    private now = Date.now,
  ) { this.startedAt = now(); this.diagnostics = { startedAt: this.startedAt, lastPollAt: null, lastPollCompletedAt: null, reads: [] }; }

  private info(id: string): { title: string; endedAt: number | null; isDeleted: number; isTourDemo: number } | null {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(this.directory, 'flow.sqlite'), { readOnly: true });
      return db.prepare('SELECT title, endedAt, isDeleted, isTourDemo FROM Meetings WHERE id = ?').get(id) as ReturnType<TranscriptWatcher['info']>;
    } catch { return null; }
    finally { db?.close(); }
  }

  private pollDictation(): void {
    const file = join(this.directory, 'flow.sqlite');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      // Only text and completion metadata: never read audio, screenshots, or textbox contents.
      const rows = db.prepare('SELECT transcriptEntityId AS id, asrText, formattedText, timestamp, status, platform, isArchived FROM History ORDER BY rowid DESC LIMIT 100').all() as unknown as {
        id: string; asrText: string | null; formattedText: string | null; timestamp: string; status: string; platform: string | null; isArchived: number;
      }[];
      const now = this.now();
      this.diagnostics.dictation = { connected: true, message: 'Dictation ready · waiting for completed speech' };
      if (!this.dictationBaseline) {
        for (const row of rows) this.emittedDictations.add(row.id);
        this.dictationBaseline = true;
      }
      for (const row of rows.reverse()) {
        if (this.emittedDictations.has(row.id)) continue;
        // Wispr timestamps the beginning of dictation; allow time for a longer utterance.
        const epoch = Date.parse(row.timestamp.replace(' ', 'T').replace(/ ([+-]\d\d:\d\d)$/, '$1'));
        if (!Number.isFinite(epoch) || epoch <= this.startedAt || epoch < now - 15 * 60_000 || epoch > now + 5000 || row.platform !== 'desktop' || row.isArchived) continue;
        const text = (row.asrText?.trim() || row.formattedText?.trim() || '');
        const signature = JSON.stringify([row.status, text]);
        if (this.dictations.get(row.id) === signature) continue;
        this.dictations.set(row.id, signature);
        const completed = row.status === 'formatted' && !!text;
        const entry = { id: row.id, text, epoch, speaker: 'You' };
        const read: TranscriptRead = { source: 'dictation', at: now, file, modifiedAt: now, parsedCount: text ? 1 : 0, freshIds: completed ? [row.id] : [], entries: text ? [entry] : [], reason: completed ? 'Accepted completed Wispr dictation.' : `Waiting for completed dictation (Wispr status: ${row.status}).` };
        this.diagnostics.reads = [read, ...this.diagnostics.reads].slice(0, 8);
        if (!completed) continue;
        this.emittedDictations.add(row.id);
        this.onEntries({ source: 'dictation', id: `dictation:${row.id}`, title: 'Wispr dictation', lastSpeechAt: epoch, entries: [entry] }, [entry]);
      }
      // Keep only the current history window; startup time and task claims also prevent replay.
      const ids = new Set(rows.map(row => row.id));
      for (const id of this.dictations.keys()) if (!ids.has(id)) this.dictations.delete(id);
      for (const id of this.emittedDictations) if (!ids.has(id)) this.emittedDictations.delete(id);
    } catch {
      this.diagnostics.dictation = { connected: false, message: 'Dictation history unavailable · check Wispr local history and folder access' };
    } finally { db?.close(); }
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.diagnostics.lastPollAt = this.now();
    try {
      this.pollDictation();
      const now = this.now();
      const folder = join(this.directory, 'meetings');
      const dirs = await readdir(folder, { withFileTypes: true });
      this.status = { connected: true, message: this.diagnostics.dictation?.connected ? 'Watching Wispr meetings and dictation' : 'Watching Wispr meetings · dictation history unavailable' };
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const file = join(folder, dir.name, 'live.ndjson');
        const metadata = await stat(file).catch(() => null);
        if (!metadata) continue;
        const previous = this.files.get(file);
        if (previous?.mtime === metadata.mtimeMs) continue;
        // Keep a bounded inspection trail, including the reasons a changed file was skipped.
        const read: TranscriptRead = { at: now, file, modifiedAt: metadata.mtimeMs, reason: '', parsedCount: 0, freshIds: [], entries: [] };
        const remember = (reason: string) => {
          read.reason = reason;
          this.diagnostics.reads = [read, ...this.diagnostics.reads].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 8);
        };
        if (metadata.size > 25 * 1024 * 1024) {
          this.files.set(file, { mtime: metadata.mtimeMs, ids: new Set() });
          remember('Skipped: transcript file exceeds 25 MB.'); continue;
        }
        if (metadata.mtimeMs < now - 60_000) {
          this.files.set(file, { mtime: metadata.mtimeMs, ids: new Set() });
          remember('Not read: file has not changed in the last 60 seconds.'); continue;
        }
        const raw = await readFile(file, 'utf8');
        const entries = parseTranscript(raw);
        read.parsedCount = entries.length; read.entries = entries.slice(-80);
        if (!entries.length) read.rawTail = raw.slice(-12000);
        this.files.set(file, { mtime: metadata.mtimeMs, ids: new Set(entries.map(e => e.id)) });
        // On restart we inspect existing text but never replay earlier commands.
        if (!this.baseline) { remember('Startup baseline: existing text displayed, not replayed. Speak again after Sidekick starts.'); continue; }
        const info = this.info(dir.name);
        if (!info || info.isDeleted || info.isTourDemo) { remember(!info ? 'Skipped: meeting metadata could not be read from flow.sqlite.' : 'Skipped: deleted or demo meeting.'); continue; }
        const fresh = entries.filter(e => !previous?.ids.has(e.id) && isFresh(e, now, this.startedAt));
        // Wispr can retain endedAt across resumed recording and set it before a final flush.
        // Fresh, unseen speech after our startup baseline is the ingestion signal.
        read.meetingEndedAt = info.endedAt;
        if (!fresh.length) { remember(`No fresh entries: ${entries.filter(e => previous?.ids.has(e.id)).length} already seen; remaining entries are outside the time window, or no complete timestamped lines were parsed.`); continue; }
        read.freshIds = fresh.map(e => e.id);
        remember(`Accepted ${fresh.length} new transcript ${fresh.length === 1 ? 'entry' : 'entries'}.${info.endedAt ? ' Wispr has an ended marker; accepted because the speech is new and recent.' : ''}`);
        this.meeting = {
          id: dir.name,
          title: info.title || 'Current Wispr meeting',
          lastSpeechAt: Math.max(...fresh.map(e => e.epoch)),
          entries: entries.filter(e => e.epoch > now - 5 * 60_000),
        };
        this.activeFile = file;
        this.onEntries(this.meeting, fresh);
      }
      this.baseline = true;
      if (this.meeting) {
        const info = this.info(this.meeting.id);
        const exists = this.activeFile ? await stat(this.activeFile).catch(() => null) : null;
        if (!info || info.isDeleted || info.isTourDemo || !exists || now - this.meeting.lastSpeechAt > 5 * 60_000) this.meeting = null;
      }
      if (this.meeting) this.status.message = 'Following recent meeting speech';
    } catch (error) {
      this.status = this.diagnostics.dictation?.connected ? { connected: true, message: 'Watching Wispr dictation · no meeting transcript available' } : { connected: false, message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Wispr folder not found. Check its location in Preferences.' : 'Could not read Wispr transcripts. Check file access.' };
      this.meeting = null;
    } finally { this.busy = false; this.diagnostics.lastPollCompletedAt = this.now(); this.onChange(); }
  }
}

export function hasWakeName(text: string): boolean {
  return /\b(?:replicas?|t\s*(?:3|three)|tee\s*three|sidekick)\b/i.test(text);
}
export function conversation(entries: Entry[]): string {
  const turns: { speaker: string; text: string }[] = [];
  for (const entry of entries) {
    const previous = turns.at(-1);
    if (previous?.speaker === entry.speaker) previous.text += ` ${entry.text.trim()}`;
    else turns.push({ speaker: entry.speaker, text: entry.text.trim() });
  }
  return turns.map(turn => `${turn.speaker}: ${turn.text}`).join('\n');
}
