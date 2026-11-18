export interface Settings {
  enabled: boolean;
  launchAtLogin: boolean;
  wisprDirectory: string;
  environmentId: string;
  environmentName: string;
  decisionModel: string;
  textModel: string;
  speechModel: string;
  voice: string;
  t3ProjectId?: string;
  t3ProjectName?: string;
}
export interface Entry {
  id: string;
  text: string;
  speaker: string;
  speakerKey?: string;
  epoch: number;
}
export interface Meeting {
  source?: 'dictation';
  id: string;
  title: string;
  lastSpeechAt: number;
  entries: Entry[];
}
export type TaskStatus = 'starting' | 'researching' | 'ready' | 'speaking' | 'delivered' | 'needs_attention' | 'failed' | 'cancelled';
export type AgentProgress =
  | { status: 'ready'; answer: string; error?: undefined }
  | { status: 'researching' | 'needs_attention' | 'failed' | 'cancelled'; answer?: string; error?: string };
export type TaskMode = 'research' | 'implementation';
export interface ResearchTask {
  destination?: 'replicas' | 't3';
  t3ThreadId?: string;
  t3EnvironmentId?: string;
  t3ProjectId?: string;
  mode?: TaskMode;
  id: string;
  meetingId: string;
  title: string;
  question: string;
  context: string;
  createdAt: number;
  status: TaskStatus;
  replicaId?: string;
  chatId?: string;
  workspaceName?: string;
  answer?: string;
  summaryStatus?: 'answer' | 'needs_input';
  spokenAnswer?: string;
  sources?: { title: string; url: string }[];
  error?: string;
  lastMessageAt?: number;
  cancelRequested?: boolean;
  archivedAt?: number;
}
export interface DiagnosticEvent {
  at: number;
  stage: string;
  message: string;
  status: 'info' | 'pending' | 'ok' | 'blocked' | 'error';
  durationMs?: number;
  data?: unknown;
}
export type RecordEvent = (stage: string, message: string, status: DiagnosticEvent['status'], data?: unknown, durationMs?: number) => void;
export interface DiagnosticRun {
  id: string;
  source: 'live' | 'dictation' | 'test' | 'manual' | 'resumed';
  startedAt: number;
  request: string;
  taskId?: string;
  events: DiagnosticEvent[];
}
export interface TranscriptRead {
  source?: 'dictation';
  meetingEndedAt?: number | null;
  at: number;
  file: string;
  modifiedAt: number;
  reason: string;
  parsedCount: number;
  freshIds: string[];
  entries: Entry[];
  rawTail?: string;
}
export interface WatcherDiagnostics {
  dictation?: { connected: boolean; message: string };
  startedAt: number;
  lastPollAt: number | null;
  lastPollCompletedAt: number | null;
  reads: TranscriptRead[];
}
export interface PendingRequest {
  id: string;
  revision: number;
  speaker: string;
  text: string;
  phase: 'heard' | 'collecting' | 'checking' | 'ready' | 'queued';
  mode?: TaskMode | 'cancel' | 'none';
  sendAt?: number;
  canSend: boolean;
  finishing: boolean;
}
export interface AppState {
  requests: PendingRequest[];
  settings: Settings;
  credentials: { gateway: boolean; replicas: boolean; t3?: boolean };
  meeting: { id: string; title: string; lastSpeechAt: number } | null;
  tasks: ResearchTask[];
  watcher: { connected: boolean; message: string };
  activity: string;
  diagnostics: { runs: DiagnosticRun[]; watcher: WatcherDiagnostics };
  detection: { request: string; message: string; at: number } | null;
  playing: string | null;
  ready: boolean;
}
export interface Decision { turn?: 'collecting' | 'ready' | 'not_request'; invoked: number; complete: number; destination: 'replicas' | 't3' | 'none'; action: TaskMode | 'cancel' | 'none' }
