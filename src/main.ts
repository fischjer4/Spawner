import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, Notification, shell, dialog, globalShortcut, powerMonitor, clipboard, nativeTheme } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createGateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { Models, Replicas, replicaLink } from './services.js';
import { T3, t3ConnectionSchema, type T3Connection } from './t3.js';
import type { Settings } from './types.js';

const smoke = process.argv.includes('--smoke-test');
if (process.env.SPAWNER_TEST_DATA && smoke) app.setPath('userData', process.env.SPAWNER_TEST_DATA);
app.setName('Spawner');
let window: BrowserWindow;
let tray: Tray;
let engine: Engine;
let t3: T3;
let store: Store;
let timer: NodeJS.Timeout;
let quitting = false;
let lastTrayStatus = '';
let broadcastTimer: NodeJS.Timeout | undefined;
const notifications = new Map<string, Notification>();
let secrets: { gateway: string; replicas: string; t3?: T3Connection } = { gateway: '', replicas: '' };
let secretProblem = '';
const defaults: Settings = {
  enabled: true, launchAtLogin: true,
  wisprDirectory: join(homedir(), 'Library/Application Support/Wispr Flow'),
  environmentId: '', environmentName: '', t3ProjectId: '', t3ProjectName: '', decisionModel: 'typesafe-ai/jev-1.14.0',
  textModel: 'google/gemini-2.5-flash', speechModel: 'google/gemini-3.8-flash-lite-tts', voice: 'Kore',
};
const settingsSchema = z.object({
  enabled: z.boolean().optional(), launchAtLogin: z.boolean().optional(),
  wisprDirectory: z.string().min(1).max(1000).optional(),
  environmentId: z.string().max(200).optional(), environmentName: z.string().max(200).optional(),
  t3ProjectId: z.string().max(200).optional(), t3ProjectName: z.string().max(200).optional(),
  decisionModel: z.string().min(1).max(200).optional(), textModel: z.string().min(1).max(200).optional(),
  speechModel: z.string().min(1).max(200).optional(), voice: z.string().min(1).max(200).optional(),
  gatewayKey: z.string().max(1000).optional(), replicasKey: z.string().max(1000).optional(),
}).strict();
const links: Record<string, string> = {
  gateway: 'https://vercel.com/dashboard/ai-gateway',
  replicas: 'https://app.replicas.dev',
};
function show() {
  if (smoke && !process.argv.includes('--design-preview')) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function showTask(id?: string) {
  show();
  window.webContents.send('state', engine.snapshot());
  window.webContents.send('task:show', id);
}
function bindNotification(notification: Notification, taskId?: string) {
  notifications.set(notification.id, notification);
  notification.on('click', () => showTask(taskId));
  notification.on('action', (event, index) => {
    showTask(taskId);
    if ((event.actionIndex ?? index) === 0 && taskId && engine.tasks.some(t => t.id === taskId)) {
      void engine.speak(taskId).catch(() => { engine.activity = 'Could not read the answer. Try Read to me in Spawner.'; broadcast(); });
    }
  });
  notification.on('close', () => notifications.delete(notification.id));
  notification.on('show', () => engine.notificationEvent(taskId, 'macOS accepted the notification. Banner visibility follows your notification and Focus settings.', 'ok'));
  notification.on('failed', (_event, error) => {
    notifications.delete(notification.id);
    engine.notificationEvent(taskId, `macOS could not show the notification: ${String(error).slice(0, 300)}. Check Spawner in System Settings → Notifications.`, 'error');
    engine.activity = 'Notifications could not be shown. Check Spawner in System Settings → Notifications.';
    broadcast();
  });
}
function notify(title: string, body: string, taskId?: string) {
  if (smoke) return;
  if (!Notification.isSupported()) { engine.notificationEvent(taskId, 'Desktop notifications are unavailable.', 'error'); return; }
  const task = engine.tasks.find(t => t.id === taskId);
  const canRead = !!task && !!(task.answer || task.spokenAnswer) && ['ready', 'delivered'].includes(task.status);
  const id = taskId ? `spawner-answer:${taskId}` : `spawner:${title}`;
  notifications.get(id)?.close();
  const notification = new Notification({ id, title, body, silent: true,
    ...(canRead ? { actions: [{ type: 'button' as const, text: 'Read to me' }, { type: 'button' as const, text: 'Read answer' }] } : {}),
  });
  bindNotification(notification, taskId);
  if (notifications.size > 100) { const oldest = notifications.values().next().value!; oldest.close(); notifications.delete(oldest.id); }
  engine.notificationEvent(taskId, 'Sending a macOS notification', 'pending');
  notification.show();
}
async function loadSecrets(): Promise<void> {
  const file = join(app.getPath('userData'), 'credentials.bin');
  if (!existsSync(file)) return;
  try {
    const decrypted = await safeStorage.decryptStringAsync(await readFile(file));
    secrets = z.object({ gateway: z.string(), replicas: z.string(), t3: t3ConnectionSchema.optional() }).parse(JSON.parse(decrypted.result));
  } catch { secretProblem = 'Credentials could not be unlocked. Reconnect them in Settings.'; }
}
async function saveSecrets(next: typeof secrets): Promise<void> {
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('macOS Keychain is unavailable. Your keys were not saved.');
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(next));
  const file = join(app.getPath('userData'), 'credentials.bin');
  await writeFile(file + '.tmp', encrypted, { mode: 0o600 });
  await rename(file + '.tmp', file);
  secrets = next; secretProblem = '';
}
function broadcast() {
  if (quitting || broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    if (!window.isDestroyed()) window.webContents.send('state', engine.snapshot());
    const count = engine.tasks.filter(t => t.status === 'researching').length;
    const pending = engine.snapshot().requests[0];
    const label = !engine.settings.enabled ? 'Paused' : pending ? ({ heard: 'Heard you', collecting: 'Collecting your request', checking: 'Understanding your request', ready: 'Request ready', queued: 'Request queued' })[pending.phase] : engine.watcher.meeting ? 'Listening' : 'Standing by';
    const key = `${label}:${count}:${engine.playing}`;
    if (key !== lastTrayStatus) {
      lastTrayStatus = key;
      tray.setToolTip(`Spawner · ${label}${count ? ` · ${count} working` : ''}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: `Spawner · ${label}`, enabled: false },
        { label: 'Open Spawner', click: show },
        { label: engine.settings.enabled ? 'Pause listening' : 'Resume listening', click: () => { engine.updateSettings({ ...engine.settings, enabled: !engine.settings.enabled }); } },
        { label: 'Stop speaking', accelerator: 'CommandOrControl+Shift+.', click: () => { engine.stopSpeech(); } },
        { type: 'separator' }, { label: 'Quit Spawner', click: () => app.quit() },
      ]));
    }
  }, 100);
}
function registerIPC() {
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unknown caller');
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : 'Something went wrong.' }; }
  });
  handle('state', () => engine.snapshot());
  handle('notifications:test', () => {
    const task = engine.tasks.find(t => ['ready', 'delivered'].includes(t.status) && (t.answer || t.spokenAnswer));
    notify('Spawner · test notification', task?.title ?? 'You’ll see a notification here when an agent’s response is ready.', task?.id);
  });
  handle('diagnostics:clear', () => engine.clearDiagnostics());
  handle('diagnostics:copy', () => {
    clipboard.writeText(JSON.stringify({ version: app.getVersion(), capturedAt: new Date().toISOString(), ...engine.snapshot().diagnostics }, null, 2));
  });
  handle('diagnostics:test', (input: unknown) => {
    const { context, request } = z.object({ context: z.string().max(18000), request: z.string().trim().min(3).max(6000) }).strict().parse(input);
    return engine.testJev(context, request);
  });
  handle('settings:save', async (input: unknown) => {
    const { gatewayKey, replicasKey, ...patch } = settingsSchema.parse(input);
    if (gatewayKey !== undefined || replicasKey !== undefined) await saveSecrets({ ...secrets, gateway: gatewayKey?.trim() ?? secrets.gateway, replicas: replicasKey?.trim() ?? secrets.replicas });
    const next = { ...engine.settings, ...patch };
    if (patch.wisprDirectory && !resolve(patch.wisprDirectory).startsWith('/')) throw new Error('Choose an absolute folder path.');
    engine.updateSettings(next);
    if (app.isPackaged && !smoke) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, args: ['--background'] });
    return engine.snapshot();
  });
  handle('environments', () => new Replicas(() => secrets.replicas).environments());
  handle('t3:connect', async () => {
    await t3.connect();
    const projects = await t3.projects();
    broadcast();
    return projects.map(({ id, title, workspaceRoot, modelSelection }) => ({ id, title, workspaceRoot, model: modelSelection?.model ?? null }));
  });
  handle('t3:disconnect', async () => {
    await saveSecrets({ ...secrets, t3: undefined });
    engine.updateSettings({ ...engine.settings, t3ProjectId: '', t3ProjectName: '' });
    return engine.snapshot();
  });
  handle('gateway:check', async () => {
    if (!secrets.gateway) throw new Error('Save your Gateway key first.');
    try {
      await createGateway({ apiKey: secrets.gateway }).getAvailableModels();
      const decision = await engine.models.decide('This is a connection test.', 'We are simply having a conversation. Nobody is requesting research.');
      return { connected: true, decision: decision.invoked };
    } catch { throw new Error('Gateway could not complete the Jev test. Check the key, model access, and available credits.'); }
  });
  handle('wispr:choose', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], defaultPath: engine.settings.wisprDirectory, title: 'Choose the Wispr Flow folder containing flow.sqlite and meetings' });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('request:action', async (id: unknown, revision: unknown, action: unknown) => {
    await engine.requestAction(z.string().uuid().parse(id), z.number().int().positive().parse(revision), z.enum(['send', 'cancel']).parse(action));
    return engine.snapshot();
  });
  handle('audio:stop', () => { engine.stopSpeech(); });
  handle('ask', (question: unknown, destination: unknown) => engine.startManual(z.string().trim().min(3).max(6000).parse(question), z.enum(['replicas', 't3']).default('replicas').parse(destination)));
  handle('task:action', async (id: unknown, action: unknown) => {
    const taskId = z.string().uuid().parse(id);
    switch (action) {
      case 'speak': return engine.speak(taskId);
      case 'cancel': return engine.cancel(taskId);
      case 'refresh': return engine.refresh(taskId);
      case 'remove': return engine.remove(taskId);
      case 'archive': return engine.archive(taskId);
      case 'restore': return engine.archive(taskId, false);
      case 'open': {
        const task = engine.tasks.find(task => task.id === taskId);
        if (task?.destination === 't3') return t3.open();
        if (!task?.replicaId) return openLink('replicas');
        return shell.openExternal(replicaLink(task.replicaId));
      }
      default: throw new Error('Unknown action');
    }
  });
  handle('open', (target: unknown) => openLink(z.string().max(3000).parse(target)));
  ipcMain.on('playback:ended', (event, id, error) => {
    if (event.sender !== window.webContents || typeof id !== 'string') return;
    engine.playbackEnded(id, typeof error === 'string' ? 'Audio playback failed. Check the output device and try again.' : undefined);
  });
}
async function openLink(target: string) {
  if (target === 'notification-settings') return shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
  const known = links[target];
  if (known) return shell.openExternal(known);
  if (target === 't3') return t3.open();
  if (target === 'data') return shell.openPath(app.getPath('userData'));
  const url = new URL(target);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web links can be opened.');
  return shell.openExternal(url.toString());
}

if (!app.requestSingleInstanceLock() && !smoke) app.quit();
else {
  app.on('second-instance', () => show());
  app.whenReady().then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
    store = new Store(app.getPath('userData'));
    await loadSecrets();
    const settings = store.settings(defaults);
    const models = new Models(() => secrets.gateway, () => engine.settings);
    t3 = new T3(() => secrets.t3, value => saveSecrets({ ...secrets, t3: value }));
    engine = new Engine(settings, store, () => ({ gateway: !!secrets.gateway, replicas: !!secrets.replicas, t3: !!secrets.t3 }), models, new Replicas(() => secrets.replicas), undefined, t3);
    if (secretProblem) engine.activity = secretProblem;
    nativeTheme.themeSource = 'light';
    window = new BrowserWindow({
      width: 940, height: 780, minWidth: 780, minHeight: 630, show: false,
      title: 'Spawner', titleBarStyle: 'hiddenInset', backgroundColor: '#ffffff',
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    const trayFile = app.isPackaged ? join(app.getAppPath(), 'renderer/tray.png') : resolve('renderer/tray.png');
    const icon = nativeImage.createFromPath(trayFile).resize({ width: 18, height: 18 }); icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.on('click', show);
    engine.onChange = broadcast;
    engine.onNotify = notify;
    engine.onPlay = (id, audio) => {
      window.webContents.send('audio:play', { id, ...audio });
      setTimeout(() => { if (engine.playing === id) engine.stopSpeech(); }, 120000).unref();
    };
    window.webContents.on('render-process-gone', () => { engine.stopSpeech(); engine.activity = 'The window stopped responding. Your tasks are saved; reopen Spawner.'; });
    engine.onStopAudio = () => window.webContents.send('audio:stop');
    registerIPC();
    await window.loadFile(join(app.getAppPath(), 'renderer/index.html'));
    app.on('activate', show);
    if (app.isPackaged && !smoke) {
      // Notification Center can be slow to respond; it must not delay the window.
      void Notification.getHistory().then(history => {
        for (const notification of history) {
          if (!notification.id.startsWith('spawner-answer:')) continue;
          const id = notification.id.slice('spawner-answer:'.length);
          if (!notifications.has(notification.id) && engine.tasks.some(t => t.id === id)) bindNotification(notification, id);
        }
      }).catch(() => engine.notificationEvent(undefined, 'Could not restore previous macOS notifications.', 'error'));
    }
    globalShortcut.register('CommandOrControl+Shift+.', () => { engine.stopSpeech(); });
    powerMonitor.on('suspend', () => { engine.stopSpeech(); });
    powerMonitor.on('lock-screen', () => { engine.stopSpeech(); });
    if (app.isPackaged && !smoke) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--background'] });
    if (!process.argv.includes('--background')) show();
    broadcast();
    timer = setInterval(() => { if (!smoke) void engine.tick().catch(() => { engine.activity = 'Could not update Wispr status. Retrying…'; broadcast(); }); }, 1500);
    if (smoke) {
      // A packaged-runtime smoke check: secure preload, real renderer, SQLite and native APIs.
      try {
        await engine.watcher.poll();
        const state = await window.webContents.executeJavaScript('window.spawner.state()');
        const probe = await window.webContents.executeJavaScript('({title: document.title, text: document.body.innerText, nodeExposed: typeof window.require !== "undefined"})');
        if (!state.ok || probe.nodeExposed || !probe.text.includes('Spawner')) throw new Error('Renderer smoke check failed');
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=connections]").click()');
        const connections = await window.webContents.executeJavaScript('document.getElementById("connections").classList.contains("active")');
        if (!connections) throw new Error('Connections navigation failed');
        const setup = await window.webContents.executeJavaScript('document.getElementById("connections").innerText');
        if (!setup.includes('Answers arrive quietly.') || /Loopback|Enable audio monitoring|Speak automatically/.test(setup)) throw new Error('Simplified setup check failed');
        await new Promise(resolve => setTimeout(resolve, 250));
        const shot = await window.webContents.capturePage();
        await writeFile('/tmp/spawner-smoke.png', shot.toPNG());
        // A labelled test fixture exercises diagnostics rendering and the no-launch test boundary.
        engine.models = { decide: async () => ({ invoked: 0.95, complete: 0.9, destination: 'replicas', action: 'research' }), speech: models.speech.bind(models), summarize: models.summarize.bind(models) };
        const smokeText = 'Replicas: could you go research that and come back to me with an answer?';
        engine.watcher.diagnostics.reads = [{ at: Date.now(), modifiedAt: Date.now() - 250, file: '/smoke-fixture/meetings/test/live.ndjson', reason: 'Smoke fixture: accepted one new entry.', parsedCount: 1, freshIds: ['smoke'], entries: [{ id: 'smoke', epoch: Date.now() - 5000, speaker: 'You', text: smokeText }] }];
        await engine.testJev('We are discussing Electron menu-bar apps.', smokeText);
        window.webContents.send('state', engine.snapshot());
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=diagnostics]").click()');
        await new Promise(resolve => setTimeout(resolve, 250));
        await writeFile('/tmp/spawner-diagnostics-overview.png', (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('document.querySelectorAll("#diagnostics details").forEach(d => d.open = true)');
        const diagnosticText = await window.webContents.executeJavaScript('document.getElementById("diagnostics").innerText');
        if (!diagnosticText.includes('Jev returned a decision') || !diagnosticText.includes('candidateUtterances') || !diagnosticText.includes('0.95') || !diagnosticText.includes('Not sent: this is a Jev-only test.')) throw new Error('Diagnostics rendering failed');
        if (engine.tasks.length) throw new Error('Jev-only smoke test unexpectedly created a task');
        await window.webContents.executeJavaScript('document.querySelectorAll("#diagnostics details").forEach(d => d.open = false)');
        await writeFile('/tmp/spawner-diagnostics-smoke.png', (await window.webContents.capturePage()).toPNG());
        const readTask = { id: '00000000-0000-4000-8000-000000000001', meetingId: 'smoke', title: 'Electron menu-bar support', question: 'Does Electron support menu-bar apps?', context: '', createdAt: Date.now(), status: 'ready' as const, answer: 'Yes. Electron supports macOS menu-bar apps.', error: 'The spoken summary could not be prepared.' };
        engine.tasks.push(readTask); store.saveTask(readTask);
        engine.models.summarize = async () => ({ status: 'answer', spokenAnswer: 'Yes. Electron supports macOS menu-bar apps.', sources: [] });
        engine.models.speech = async () => ({ base64: '', mediaType: 'audio/wav' });
        let readStarted = false;
        engine.onPlay = () => { readStarted = true; };
        showTask(readTask.id);
        await new Promise(resolve => setTimeout(resolve, 250));
        const canRead = await window.webContents.executeJavaScript('document.getElementById("task-00000000-0000-4000-8000-000000000001").innerText.includes("Read to me")');
        if (!canRead) throw new Error('Read button missing when summary is unavailable');
        await writeFile('/tmp/spawner-read-smoke.png', (await window.webContents.capturePage()).toPNG());
        const readResult = await window.webContents.executeJavaScript('window.spawner.action("00000000-0000-4000-8000-000000000001", "speak")');
        if (!readResult.ok || !readStarted) throw new Error('Read action did not prepare the missing summary');
        engine.playbackEnded(readTask.id);
        window.webContents.send('state', engine.snapshot());
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=preferences]").click(); document.querySelector("#task-detail .full-answer").open = false');
        readStarted = false;
        const readNotification = new Notification({ id: 'smoke-read-action' });
        bindNotification(readNotification, readTask.id);
        readNotification.emit('action', { actionIndex: 1 }, 1);
        await new Promise(resolve => setTimeout(resolve, 250));
        const opened = await window.webContents.executeJavaScript('!document.getElementById("task-overlay").classList.contains("hidden") && document.querySelector("#task-detail .full-answer").open');
        if (!opened || readStarted) throw new Error('Read answer must expand the answer without playing audio');
        engine.tasks[0]!.title = 'Electron menu-bar research';
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.querySelector("#task-detail .full-answer").open')) throw new Error('Expanded answer collapsed on state update');
        // A complete trace makes the transcript, exact window, and score inspectable together, without a remote launch.
        const traceAt = Date.now();
        const trace = { id: 'smoke-complete', source: 'live' as const, startedAt: traceAt - 12000, request: smokeText, taskId: readTask.id, events: [
          { at: traceAt - 12000, stage: 'Transcript', status: 'ok' as const, message: 'Received fresh speech', data: { entries: [{ id: 'smoke-line', speaker: 'You', epoch: traceAt - 13000, text: smokeText }], speechToReadMs: 1000 } },
          { at: traceAt - 10500, stage: 'Jev', status: 'pending' as const, message: 'Sent request to Jev', data: { state: { candidateUtterances: smokeText, previousConversation: 'Can an Electron app stay in the menu bar after its windows close?' } } },
          { at: traceAt - 10000, stage: 'Jev', status: 'ok' as const, message: 'Jev returned a decision', durationMs: 500, data: { decision: { invoked: 0.95, complete: 0.9, destination: 'replicas', action: 'research' } } },
          { at: traceAt - 10000, stage: 'Gate', status: 'ok' as const, message: 'Detection gates passed.' },
          { at: traceAt - 9000, stage: 'Replicas', status: 'pending' as const, message: 'Sending research to Replicas', data: { message: 'Research Electron menu-bar behavior using official documentation.' } },
          { at: traceAt - 8000, stage: 'Replicas', status: 'ok' as const, message: 'Replicas confirmed the workspace', durationMs: 1000, data: { replicaId: 'smoke-only' } },
          { at: traceAt, stage: 'Answer', status: 'ok' as const, message: 'Answer ready in Spawner', data: { sinceTaskCreatedMs: 12000 } },
        ] };
        engine.diagnosticRuns = [{ ...trace, source: 'dictation' }];
        window.webContents.send('state', engine.snapshot());
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=diagnostics]").click()');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.getElementById("diagnostic-flow").innerText.includes("Dictation") && document.getElementById("diagnostic-flow").innerText.includes("Transcript")')) throw new Error('Dictation source missing from diagnostics');
        await writeFile('/tmp/spawner-dictation-diagnostics.png', (await window.webContents.capturePage()).toPNG());
        engine.diagnosticRuns = [trace];
        window.webContents.send('state', engine.snapshot());
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=diagnostics]").click()');
        await new Promise(resolve => setTimeout(resolve, 100));
        const stages = await window.webContents.executeJavaScript('Array.from(document.querySelectorAll(".diagnostic-section-heading h2"), n => n.textContent).join(",")');
        if (stages !== 'Transcript Jev checked,Decision') throw new Error('Diagnostics is missing the transcript/window/score sequence');
        if (!await window.webContents.executeJavaScript('document.querySelector(".jev-request p").textContent === "Replicas: could you go research that and come back to me with an answer?" && document.querySelector(".trace-scores").innerText.includes("95%")')) throw new Error('Displayed score does not have its exact request window');
        await writeFile('/tmp/spawner-trace-complete.png', (await window.webContents.capturePage()).toPNG());
        // The primary transcript and result fit together at the app's minimum width.
        window.setSize(780, 630);
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!await window.webContents.executeJavaScript('document.querySelector(".diagnostic-outcome").getBoundingClientRect().bottom < window.innerHeight && document.querySelector("main").scrollWidth === document.querySelector("main").clientWidth')) throw new Error('Compact diagnostics overflows the minimum window');
        await writeFile('/tmp/spawner-diagnostics-compact-small.png', (await window.webContents.capturePage()).toPNG());
        window.setSize(940, 780);
        await window.webContents.executeJavaScript('document.querySelectorAll(".diagnostic-section")[1].scrollIntoView({block:"start"})');
        await writeFile('/tmp/spawner-trace-stages.png', (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('var picker = document.getElementById("diagnostic-selection"); picker.value = "smoke-complete"; picker.dispatchEvent(new Event("change"))');
        const resumed = { id: 'smoke-resumed', source: 'resumed' as const, startedAt: traceAt + 1, request: 'macOS notification', taskId: readTask.id, events: [] };
        engine.diagnosticRuns.unshift(resumed);
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.getElementById("diagnostic-selection").value === "smoke-complete" && document.getElementById("diagnostic-mode").textContent === "Earlier run" && document.querySelector(".trace-scores").innerText.includes("95%")')) throw new Error('Selected trace changed when newer activity arrived');
        await window.webContents.executeJavaScript('var picker = document.getElementById("diagnostic-selection"); picker.value = "latest"; picker.dispatchEvent(new Event("change"))');
        await window.webContents.executeJavaScript('var picker = document.getElementById("diagnostic-selection"); picker.value = "smoke-resumed"; picker.dispatchEvent(new Event("change"))');
        if (!await window.webContents.executeJavaScript('document.getElementById("diagnostic-flow").innerText.includes("Not recorded here")')) throw new Error('Resumed trace implies Jev was never called');
        await window.webContents.executeJavaScript('var picker = document.getElementById("diagnostic-selection"); picker.value = "latest"; picker.dispatchEvent(new Event("change"))');
        engine.diagnosticRuns = [{ ...trace, taskId: undefined, events: [...trace.events.slice(0, 4), { at: traceAt, stage: 'Jev', status: 'pending', message: 'Checking the updated request' }] }];
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.querySelectorAll(".diagnostic-section")[1].innerText.includes("Checking") && !document.querySelectorAll(".diagnostic-section")[1].innerText.includes("95%")')) throw new Error('Pending Jev check shows a stale decision');
        // Each score stays paired with its own exact input, even as the request grows.
        engine.diagnosticRuns = [{ ...trace, taskId: undefined, events: [
          { at: traceAt - 20000, stage: 'Transcript', status: 'ok', message: 'Wake name arrived', data: { entries: [{ id: 'wake', speaker: 'You', epoch: traceAt - 21000, text: 'Replicas.' }] } },
          { at: traceAt - 19000, stage: 'Jev', status: 'pending', message: 'First check', data: { state: { candidateUtterances: 'You: Replicas.' } } },
          { at: traceAt - 18500, stage: 'Jev', status: 'ok', message: 'First result', data: { decision: { invoked: 0.14, complete: 0.2, destination: 'replicas', action: 'none' } } },
          ...trace.events.slice(0, 4),
        ] }];
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript('var checkPicker = document.getElementById("jev-check-selection"); checkPicker.value = "1"; checkPicker.dispatchEvent(new Event("change"))');
        if (!await window.webContents.executeJavaScript('document.querySelector(".jev-request p").textContent === "You: Replicas." && document.querySelector(".trace-scores").innerText.includes("14%") && document.querySelector(".window-notice").innerText.includes("not in this check")')) throw new Error('Earlier Jev score was paired with the wrong window');
        await writeFile('/tmp/spawner-early-window.png', (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('var checkPicker = document.getElementById("jev-check-selection"); checkPicker.value = "latest"; checkPicker.dispatchEvent(new Event("change"))');
        engine.diagnosticRuns.unshift({ id: 'ordinary-speech', source: 'live', startedAt: Date.now(), request: 'Thanks, that sounds good.', events: [{ at: Date.now(), stage: 'Transcript', status: 'ok', message: 'Ordinary speech' }] });
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.querySelector(".jev-request p").textContent.includes("could you go research") && document.querySelector(".trace-scores").innerText.includes("95%")')) throw new Error('Ordinary speech replaced the latest Jev window');
        // A new request awaiting its first check must not display the last run's score.
        const collectingRun = { id: 'smoke-collecting', source: 'live' as const, startedAt: Date.now(), request: 'Jason: Replicas.', events: [] };
        engine.diagnosticRuns.unshift(collectingRun);
        const collectingState = engine.snapshot();
        collectingState.requests = [{ id: collectingRun.id, revision: 1, speaker: 'Jason', text: 'Replicas.', phase: 'heard', canSend: false, finishing: false }];
        window.webContents.send('state', collectingState);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.querySelector(".jev-request p").textContent === "Jason: Replicas." && !document.querySelector(".trace-scores") && document.getElementById("diagnostic-mode").textContent === "Latest run"')) throw new Error('New request displays the previous run or score');
        await window.webContents.executeJavaScript('var picker = document.getElementById("diagnostic-selection"); picker.value = "smoke-complete"; picker.dispatchEvent(new Event("change"))');
        if (!await window.webContents.executeJavaScript('document.getElementById("diagnostic-mode").textContent === "Earlier run" && !document.getElementById("diagnostic-latest").classList.contains("hidden")')) throw new Error('Earlier run is not clearly identified');
        await window.webContents.executeJavaScript('document.getElementById("diagnostic-latest").click()');
        if (!await window.webContents.executeJavaScript('document.querySelector(".jev-request p").textContent === "Jason: Replicas." && document.getElementById("diagnostic-selection").value === "latest"')) throw new Error('Back to latest did not restore the current request');
        engine.diagnosticRuns.shift();
        engine.tasks[0]!.mode = 'implementation';
        engine.tasks[0]!.status = 'researching';
        window.webContents.send('state', engine.snapshot());
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=activity]").click()');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.getElementById("tasks").innerText.includes("Implementing") && document.getElementById("tasks").innerText.includes("Implementation")')) throw new Error('Implementation task is labelled as research');
        await writeFile('/tmp/spawner-implementation-smoke.png', (await window.webContents.capturePage()).toPNG());
        engine.tasks[0]!.status = 'ready';
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.getElementById("tasks").innerText.includes("Ready to review")')) throw new Error('Implementation result not ready to review');
        // Archive preserves the answer and hides it from Inbox, with a working restore path.
        const archived = await window.webContents.executeJavaScript('window.spawner.action("00000000-0000-4000-8000-000000000001", "archive")');
        if (!archived.ok || !store.tasks()[0]?.archivedAt) throw new Error('Archive was not persisted');
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 120));
        if (await window.webContents.executeJavaScript('document.querySelectorAll(".task-row").length')) throw new Error('Archived task remained in Inbox');
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=history]").click()');
        if (!await window.webContents.executeJavaScript('document.querySelectorAll(".task-row").length === 1')) throw new Error('Archived task missing from History');
        await window.webContents.executeJavaScript('document.querySelector(".task-row").click()');
        if (!await window.webContents.executeJavaScript('document.querySelector("#task-detail .full-answer").open && document.querySelector(".app").inert')) throw new Error('History answer drawer failed');
        await new Promise(resolve => setTimeout(resolve, 300));
        await writeFile('/tmp/spawner-redesign-answer.png', (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('document.getElementById("close-task").click()');
        const restored = await window.webContents.executeJavaScript('window.spawner.action("00000000-0000-4000-8000-000000000001", "restore")');
        if (!restored.ok || store.tasks()[0]?.archivedAt) throw new Error('Restore failed');
        // Stale logs stay selectable without appearing as current speech.
        engine.diagnosticRuns = [{ ...trace, startedAt: Date.now() - 120000, events: trace.events.map(event => ({ ...event, at: Date.now() - 120000 })) }];
        engine.watcher.diagnostics.reads = [];
        window.webContents.send('state', engine.snapshot());
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=diagnostics]").click()');
        if (!await window.webContents.executeJavaScript('document.getElementById("diagnostic-mode").textContent === "Latest run" && document.getElementById("diagnostic-flow").innerText.includes("could you go research")')) throw new Error('Latest check must remain inspectable and labelled as a check');
        await new Promise(resolve => setTimeout(resolve, 300));
        await writeFile('/tmp/spawner-redesign-idle-diagnostics.png', (await window.webContents.capturePage()).toPNG());
        engine.diagnosticRuns = [];
        engine.watcher.diagnostics.reads = [{ at: Date.now(), modifiedAt: Date.now(), file: '/smoke/baseline.ndjson', reason: 'No fresh entries: already seen.', parsedCount: 1, freshIds: [], entries: [{ id: 'old-line', speaker: 'You', epoch: Date.now() - 120000, text: 'Old baseline transcript' }] }];
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.getElementById("diagnostic-flow").innerText.includes("Waiting for new speech") && !document.getElementById("diagnostic-flow").innerText.includes("Old baseline transcript")')) throw new Error('Startup baseline appeared as new transcript');
        engine.remove(readTask.id);
        engine.models = models;
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=activity]").click()');
        const paused = await window.webContents.executeJavaScript('window.spawner.saveSettings({enabled:false})');
        if (!paused.ok || paused.value.settings.enabled) throw new Error('Pause persistence failed');
        await window.webContents.executeJavaScript('window.spawner.saveSettings({enabled:true})');
        engine.tasks = [
          { ...readTask, id: '00000000-0000-4000-8000-000000000002', title: 'Add a notification bell', mode: 'implementation', status: 'researching', answer: undefined, error: undefined },
          { ...readTask, id: '00000000-0000-4000-8000-000000000003', title: 'Compare realtime voice models', mode: 'research', status: 'ready', error: undefined, spokenAnswer: 'Use a streaming speech model for live conversation. For Spawner’s short, on-demand summaries, the current text-to-speech setup is a better fit.', answer: '## Recommendation\nKeep the current on-demand speech flow. It fits the way Spawner is used during calls.\n\n- **Streaming voice** is useful for a continuous conversation.\n- **Text to speech** is simpler for a short answer after an agent finishes.\n\n### What changes next\nAdd a visible playback state and keep speech opt-in. The `Read to me` button should always be one click away.\n\nSee the [official documentation](https://example.com/docs) for the comparison.', replicaId: 'fixture' },
          { ...readTask, id: '00000000-0000-4000-8000-000000000004', title: 'Create the Linear issue for mobile feedback', mode: 'implementation', status: 'needs_attention', answer: undefined, error: 'The agent needs to know which project should own the issue.', replicaId: 'fixture' },
        ];
        secrets.gateway = 'smoke-fixture'; secrets.replicas = 'smoke-fixture';
        engine.settings.environmentId = 'fixture'; engine.settings.environmentName = 'Stanza';
        window.webContents.send('state', engine.snapshot());
        await window.webContents.executeJavaScript('document.querySelector("[data-tab=activity]").click()');
        await new Promise(resolve => setTimeout(resolve, 300));
        await writeFile('/tmp/spawner-redesign-inbox.png', (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('Array.from(document.querySelectorAll("[data-task]")).find(row => row.dataset.task === "00000000-0000-4000-8000-000000000003").click()');
        await new Promise(resolve => setTimeout(resolve, 300));
        await writeFile('/tmp/spawner-redesign-rich-answer.png', (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('document.getElementById("close-task").click()');
        window.setSize(780, 630);
        await new Promise(resolve => setTimeout(resolve, 300));
        if (await window.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth')) throw new Error('Layout overflows minimum window width');
        await writeFile('/tmp/spawner-redesign-compact.png', (await window.webContents.capturePage()).toPNG());
        // User controls go through the real preload/IPC and engine. Only the model
        // and remote agent are fixture substitutes in this renderer smoke check.
        window.setSize(940, 780);
        const oldModels = engine.models, oldReplicas = engine.replicas;
        let captureCreates = 0;
        engine.models = { decide: async (_context, text) => ({ turn: text.trim().endsWith('Replicas.') ? 'collecting' : 'ready', invoked: 0.98, complete: 0.95, destination: 'replicas', action: 'research' }), speech: oldModels.speech.bind(oldModels), summarize: oldModels.summarize.bind(oldModels) };
        engine.replicas = { create: async () => { captureCreates++; return 'capture-fixture'; }, rename: async () => {}, wait: async () => ({ done: false, status: 'running', chats: [] }), history: async () => [], interrupt: async () => {}, findByName: async () => null };
        const wake = { id: 'capture-wake', speaker: 'Jason', epoch: Date.now(), text: 'Replicas.' };
        const captureMeeting = { id: 'capture-call', title: 'Fixture call', lastSpeechAt: wake.epoch, entries: [wake] };
        engine.receive(captureMeeting, [wake]);
        window.webContents.send('state', engine.snapshot());
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await window.webContents.executeJavaScript('document.querySelector(".request-status").textContent === "Heard you" && document.querySelector("[data-request-action=send]").disabled')) throw new Error('Bare wake UI must wait for instructions');
        const request = { id: 'capture-request', speaker: 'Jason', epoch: Date.now(), text: 'Research our Stripe code and make a plan for a no-card Pro trial. Do not implement anything.' };
        captureMeeting.entries.push(request); engine.receive(captureMeeting, [request]);
        await new Promise(resolve => setTimeout(resolve, 1800));
        if (!await window.webContents.executeJavaScript('document.querySelector(".request-status").textContent === "Ready to send" && document.querySelector(".request-transcript").textContent.includes("Do not implement anything") && !document.querySelector("[data-request-action=send]").disabled')) throw new Error('Ready request preview failed');
        await new Promise(resolve => setTimeout(resolve, 300));
        await writeFile('/tmp/spawner-request-ready.png', (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('document.querySelector("[data-request-action=send]").click()');
        await new Promise(resolve => setTimeout(resolve, 200));
        if (captureCreates !== 1 || engine.snapshot().requests.length) throw new Error('Send now UI did not create exactly one handoff');
        const capturedTask = engine.tasks.find(task => task.replicaId === 'capture-fixture')!;
        await engine.cancel(capturedTask.id); engine.remove(capturedTask.id);
        const cancelEntry = { ...request, id: 'capture-cancel', text: 'Replicas, research Electron.', epoch: Date.now() };
        engine.receive({ ...captureMeeting, entries: [cancelEntry] }, [cancelEntry]);
        await new Promise(resolve => setTimeout(resolve, 150));
        await window.webContents.executeJavaScript('document.querySelector("[data-request-action=cancel]").click()');
        await new Promise(resolve => setTimeout(resolve, 1700));
        if (captureCreates !== 1 || engine.snapshot().requests.length || !await window.webContents.executeJavaScript('document.getElementById("request-capture").classList.contains("hidden")')) throw new Error('Cancel UI left a pending or launched request');
        engine.models = oldModels; engine.replicas = oldReplicas;
        if (process.argv.includes('--design-preview')) return;
        console.log(JSON.stringify({ smoke: 'passed', node: process.versions.node, electron: process.versions.electron, watcher: state.value.watcher, screenshot: '/tmp/spawner-smoke.png' }));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    }
  }).catch(error => { console.error('Spawner startup failed:', error); app.exit(1); });
}
app.on('before-quit', () => {
  quitting = true; clearInterval(timer); clearTimeout(broadcastTimer);
  engine?.dispose(); globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => { /* Menu-bar app stays alive. */ });
