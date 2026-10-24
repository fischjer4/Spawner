const api = window.sidekick;
const $ = id => document.getElementById(id);
let state;
let tab = 'activity';
let taskSignature = '';
let diagnosticSignature = '';
let selectedDiagnostic = 'latest';
let selectedJevCheck = 'latest';
let selectedCheckRun;
let selectedTaskId = null;
let drawerReturnFocus = null;
let drawerCloseTimer;
const expandedAnswers = new Map();
const openDiagnostics = new Set();
let preferencesLoaded = false;
let t3Projects = [];
const requestNodes = new Map();
let audio;
let audioId;
let playbackTimeout;
let toastTimeout;

function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error' : ''}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $('toast').classList.add('hidden'), error ? 9000 : 4500);
}
async function call(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function busy(button, fn) {
  const previous = button.textContent;
  button.disabled = true; button.textContent = 'Working…';
  try { return await fn(); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; if (button.textContent === 'Working…') button.textContent = previous; }
}
function go(next) {
  if (next === 'settings') next = 'connections';
  closeTask();
  tab = next;
  if (next !== 'activity') $('ask-form').classList.add('hidden');
  const settingsPage = ['connections', 'preferences'].includes(next);
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === (next === 'history' ? 'activity' : next)));
  document.querySelectorAll('[data-tab]').forEach(b => {
    const selected = b.dataset.tab === next || (b.dataset.tab === 'settings' && settingsPage);
    b.classList.toggle('selected', selected);
    if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', String(selected));
    else if (selected) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('settings-tabs').classList.toggle('hidden', !settingsPage);
  $('page-title').textContent = settingsPage ? 'Settings' : ({ activity: 'Inbox', history: 'History', diagnostics: 'Diagnostics' })[next];
  document.querySelector('main').scrollTop = 0;
  if (state) renderTasks();
  if (next === 'diagnostics' && state) renderDiagnostics();
  if (next === 'preferences') loadPreferences();
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function actionButton(label, fn, className = 'text-button') {
  const b = element('button', className, label);
  b.type = 'button'; b.onclick = () => busy(b, fn);
  return b;
}
function statusLabel(task) {
  if (task.cancelRequested) return 'Stopping';
  return ({ starting: 'Starting', researching: task.mode === 'implementation' ? 'Implementing' : 'Researching', ready: task.mode === 'implementation' ? 'Ready to review' : 'Answer ready', speaking: 'Speaking', delivered: 'Read aloud', needs_attention: 'Needs attention', failed: 'Could not finish', cancelled: 'Cancelled' })[task.status];
}
const activeStatuses = ['starting', 'researching', 'speaking'];
function isArchived(task) { return !!task.archivedAt && !activeStatuses.includes(task.status); }
function taskDate(task) {
  const date = new Date(task.createdAt);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function renderTasks() {
  const signature = JSON.stringify([state.tasks, state.playing, tab, !!state.requests?.length]);
  if (signature === taskSignature) return;
  taskSignature = signature;
  const history = tab === 'history';
  $('setup-banner').classList.toggle('hidden', state.ready || history);
  const tasks = state.tasks.filter(task => history ? isArchived(task) : !isArchived(task));
  const inbox = state.tasks.filter(task => !isArchived(task));
  $('task-count').textContent = inbox.length || '';
  $('inbox-heading').textContent = history ? 'History' : 'Inbox';
  $('inbox-description').textContent = history ? 'Finished work, here when you need it.' : 'In progress and ready for your review.';
  $('archive-completed').classList.toggle('hidden', history || !inbox.some(task => ['ready', 'delivered', 'cancelled'].includes(task.status)));
  $('empty').classList.toggle('hidden', tasks.length > 0 || (!history && !!state.requests?.length));
  $('empty-title').textContent = history ? 'No archived tasks yet.' : 'Nothing needs your attention.';
  $('empty-description').textContent = history ? 'Archive a finished task to keep it here.' : 'Ask Replicas or T3 to research or build something. We’ll let you know when it’s ready.';
  $('voice-examples').classList.toggle('hidden', history);
  $('inbox-footer').classList.toggle('hidden', history);
  $('detection').classList.toggle('hidden', history || !!state.requests?.length || !state.detection || Date.now() - state.detection.at > 30000);
  const groups = history
    ? [['Archived', tasks]]
    : [['In progress', tasks.filter(t => activeStatuses.includes(t.status))], ['Needs attention', tasks.filter(t => ['needs_attention', 'failed'].includes(t.status))], ['Ready to review', tasks.filter(t => ['ready', 'delivered'].includes(t.status))], ['Cancelled', tasks.filter(t => t.status === 'cancelled')]];
  const root = $('tasks');
  const focusedTask = document.activeElement?.dataset?.task;
  root.replaceChildren();
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const section = element('section', 'task-group');
    const heading = element('h2', 'group-heading', label);
    heading.append(element('span', '', String(items.length)));
    const list = element('div', 'task-list');
    for (const task of items) {
      const row = element('button', 'task-row');
      row.dataset.task = task.id;
      row.onclick = () => revealTask(task.id);
      row.setAttribute('aria-label', `${task.title}, ${statusLabel(task)}`);
      const running = activeStatuses.includes(task.status);
      const attention = ['needs_attention', 'failed'].includes(task.status);
      row.append(element('span', `task-glyph${running ? ' running' : attention ? ' attention' : history ? ' archived' : ''}`, running ? '' : attention ? '!' : task.status === 'cancelled' ? '−' : '✓'));
      const copy = element('span', 'task-row-copy');
      copy.append(element('span', 'task-row-title', task.title), element('span', 'task-row-meta', `${task.mode === 'implementation' ? 'Implementation' : 'Research'} · ${statusLabel(task)}`));
      const time = element('time', '', taskDate(task));
      time.dateTime = new Date(task.createdAt).toISOString();
      row.append(copy, time, element('span', 'task-chevron', '›'));
      list.append(row);
    }
    section.append(heading, list); root.append(section);
  }
  if (focusedTask) [...root.querySelectorAll('[data-task]')].find(row => row.dataset.task === focusedTask)?.focus({ preventScroll: true });
  if (selectedTaskId) renderTaskDetail();
}
// Build a small, safe Markdown subset using DOM nodes. Agent text never becomes HTML.
function inlineText(parent, text) {
  const pattern = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    const token = match[0];
    if (token.startsWith('**')) parent.append(element('strong', '', token.slice(2, -2)));
    else if (token.startsWith('`')) parent.append(element('code', '', token.slice(1, -1)));
    else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      parent.append(actionButton(link[1], () => call(api.open(link[2])), 'inline-link'));
    }
    start = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}
function answerBody(text) {
  const root = element('div', 'answer-body');
  let paragraph = [], list = null, code = null;
  const flush = () => { if (paragraph.length) { const p = element('p'); inlineText(p, paragraph.join('\n')); root.append(p); paragraph = []; } };
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { flush(); list = null; if (code) code = null; else { const pre = element('pre'); code = element('code'); pre.append(code); root.append(pre); } continue; }
    if (code) { code.append(document.createTextNode(line + '\n')); continue; }
    if (!line.trim()) { flush(); list = null; continue; }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
    if (heading) { flush(); list = null; const h = element('h3'); inlineText(h, heading[1]); root.append(h); }
    else if (item) { flush(); const kind = /^\s*\d/.test(line) ? 'OL' : 'UL'; if (!list || list.tagName !== kind) { list = element(kind.toLowerCase()); root.append(list); } const li = element('li'); inlineText(li, item[1]); list.append(li); }
    else { list = null; paragraph.push(line); }
  }
  flush(); return root;
}
function renderTaskDetail() {
  const task = state.tasks.find(item => item.id === selectedTaskId);
  if (!task) { closeTask(); return; }
  const root = $('task-detail');
  const scrollTop = root.scrollTop;
  const focusedLabel = root.contains(document.activeElement) ? document.activeElement.textContent : null;
  const originalOpen = root.querySelector('.original-request')?.open;
  root.replaceChildren();
  const toolbar = element('div', 'drawer-toolbar');
  toolbar.append(element('span', '', isArchived(task) ? 'History' : 'Inbox'), element('span', '', '/'), element('span', '', task.mode === 'implementation' ? 'Implementation' : 'Research'));
  const close = element('button', 'icon-button', '×'); close.id = 'close-task'; close.setAttribute('aria-label', 'Close task'); close.onclick = closeTask;
  toolbar.append(close); root.append(toolbar);
  const card = element('article', 'task'); card.id = `task-${task.id}`;
  card.append(element('h2', '', task.title));
  const meta = element('div', 'task-meta');
  meta.append(element('span', `task-status${['failed', 'needs_attention'].includes(task.status) ? ' error' : ''}`, statusLabel(task)), element('span', '', `${taskDate(task)} · ${task.destination === 't3' ? 'T3 Code · local' : 'Replicas'} ${task.mode === 'implementation' ? 'implementation' : 'research'}`));
  card.append(meta);
  const actions = element('div', 'task-actions');
  if ((task.spokenAnswer || task.answer) && ['ready', 'delivered'].includes(task.status)) {
    const read = actionButton(state.playing === task.id ? 'Preparing…' : '▶ Read to me', () => call(api.action(task.id, 'speak')), 'primary compact');
    read.disabled = !!state.playing; actions.append(read);
  }
  if (['starting', 'researching'].includes(task.status) || (task.destination === 't3' && task.t3ThreadId && task.status === 'needs_attention')) actions.append(actionButton('Cancel task', () => call(api.action(task.id, 'cancel')), 'secondary compact'));
  if (task.status === 'speaking') actions.append(actionButton('Stop speaking', () => call(api.stop()), 'secondary compact'));
  if (task.destination === 't3') actions.append(actionButton('Open T3 Code ↗', () => call(api.action(task.id, 'open'))));
  else if (task.replicaId || task.workspaceName) actions.append(actionButton('Continue in Replicas ↗', () => call(api.action(task.id, 'open'))));
  if (['needs_attention', 'failed', 'researching'].includes(task.status) || task.error) actions.append(actionButton('Refresh', () => call(api.action(task.id, 'refresh'))));
  if (!activeStatuses.includes(task.status)) actions.append(actionButton(isArchived(task) ? 'Move to Inbox' : 'Archive', async () => { await call(api.action(task.id, isArchived(task) ? 'restore' : 'archive')); closeTask(); toast(isArchived(task) ? 'Moved to Inbox.' : 'Archived. You can find it in History.'); }, 'text-button muted'));
  card.append(actions);
  if (task.error) card.append(element('p', 'task-error', task.error));
  if (task.spokenAnswer) card.append(element('p', 'answer-label', 'SUMMARY'), element('p', 'task-answer', task.spokenAnswer));
  if (task.answer) {
    const details = element('details', 'full-answer');
    details.open = expandedAnswers.get(task.id) ?? true;
    details.ontoggle = () => expandedAnswers.set(task.id, details.open);
    details.append(element('summary', '', 'Full answer'), answerBody(task.answer));
    if (task.sources?.length) {
      const sources = element('div', 'sources');
      for (const source of task.sources) sources.append(actionButton(`${source.title} ↗`, () => call(api.open(source.url))));
      details.append(sources);
    }
    card.append(details);
  } else if (['starting', 'researching'].includes(task.status)) card.append(element('p', 'task-answer', 'Your agent is working. You can close this panel—we’ll notify you when it’s ready.'));
  const request = element('details', 'original-request');
  request.open = originalOpen ?? false;
  request.append(element('summary', '', 'Original request'), element('p', 'request-text', task.question));
  card.append(request); root.append(card); root.scrollTop = scrollTop;
  if (focusedLabel) ([...root.querySelectorAll('button, summary')].find(node => node.textContent === focusedLabel) || close).focus({ preventScroll: true });
}
function closeTask() {
  const wasOpen = selectedTaskId;
  selectedTaskId = null;
  if (wasOpen) {
    $('task-overlay').classList.add('closing');
    clearTimeout(drawerCloseTimer);
    drawerCloseTimer = setTimeout(() => { $('task-overlay').classList.add('hidden'); $('task-overlay').classList.remove('closing'); }, 140);
  }
  document.querySelector('.app').inert = false;
  if (wasOpen) {
    if (drawerReturnFocus?.isConnected) drawerReturnFocus.focus({ preventScroll: true });
    else document.querySelector('[data-tab="' + tab + '"]')?.focus({ preventScroll: true });
  }
}
function clockTime(at) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function elapsed(ms) { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }
function detailBlock(key, title, value, defaultOpen = false) {
  const details = element('details', 'diagnostic-detail');
  details.open = openDiagnostics.has(key) || defaultOpen;
  details.ontoggle = () => { if (details.open) openDiagnostics.add(key); else openDiagnostics.delete(key); };
  details.append(element('summary', '', title), element('pre', '', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  return details;
}
function renderDiagnostics() {
  const { watcher, runs } = state.diagnostics;
  const requestIds = new Set((state.requests || []).map(request => request.id));
  const visibleRuns = runs.filter(run => run.taskId || requestIds.has(run.id) || run.events.some(event => event.stage === 'Jev'));
  const latestRun = visibleRuns.find(run => run.source !== 'resumed') || visibleRuns[0];
  const freshRead = watcher.reads.find(read => read.at > Date.now() - 60000 && (read.freshIds.length || (read.reason.startsWith('Skipped:') && read.entries.some(entry => entry.epoch > Date.now() - 60000))));
  $('diagnostic-health').textContent = !state.settings.enabled ? 'Listening paused' : !state.ready ? 'Setup incomplete' : (state.watcher.connected || watcher.dictation?.connected) ? 'Watching Wispr' : 'Transcript unavailable';
  $('diagnostic-poll').textContent = watcher.lastPollCompletedAt ? `Last read ${clockTime(watcher.lastPollCompletedAt)}` : 'Waiting for the first read';
  if (!visibleRuns.some(run => run.id === selectedDiagnostic)) selectedDiagnostic = 'latest';
  const run = selectedDiagnostic === 'latest' ? latestRun : visibleRuns.find(item => item.id === selectedDiagnostic);
  if (selectedCheckRun !== run?.id) { selectedJevCheck = 'latest'; selectedCheckRun = run?.id; }
  const signature = JSON.stringify([runs, watcher.reads, selectedDiagnostic, selectedJevCheck, state.tasks, state.requests, freshRead?.at]);
  if (signature === diagnosticSignature) return;
  diagnosticSignature = signature;
  const historical = selectedDiagnostic !== 'latest';
  $('diagnostic-mode').textContent = historical ? 'Earlier run' : 'Latest run';
  $('diagnostic-latest').classList.toggle('hidden', !historical && selectedJevCheck === 'latest');
  const options = [new Option('Run history', 'latest')];
  for (const item of visibleRuns) options.push(new Option(`${clockTime(item.startedAt)} · ${item.source === 'test' ? 'Test · ' : ''}${item.request.replace(/\s+/g, ' ').slice(0, 70)}`, item.id));
  $('diagnostic-selection').replaceChildren(...options);
  $('diagnostic-selection').value = selectedDiagnostic;
  $('diagnostic-selection').classList.toggle('hidden', !visibleRuns.length);
  const read = !run ? freshRead : undefined;
  const events = run?.events ?? [];
  const checks = events.map((event, index) => ({ event, index })).filter(({ event }) => event.stage === 'Jev' && event.status === 'pending');
  const lastStart = selectedJevCheck === 'latest' ? checks.at(-1)?.index ?? -1 : checks.find(({ index }) => String(index) === selectedJevCheck)?.index ?? checks.at(-1)?.index ?? -1;
  const nextStart = checks.find(({ index }) => index > lastStart)?.index ?? events.length;
  const checkEvents = events.slice(Math.max(0, lastStart), nextStart);
  const sent = events[lastStart];
  const returned = checkEvents.findLast(event => event.stage === 'Jev' && event.status === 'ok');
  const modelError = checkEvents.findLast(event => event.stage === 'Jev' && event.status === 'error');
  const decision = returned?.data?.decision;
  const gate = checkEvents.findLast(event => event.stage === 'Gate');
  const task = state.tasks.find(item => item.id === run?.taskId);
  const provider = task?.destination === 't3' || decision?.destination === 't3' ? 'T3 Code' : 'Replicas';
  const confirmed = events.find(event => ['Replicas', 'T3'].includes(event.stage) && event.status === 'ok' && (event.data?.replicaId || event.data?.threadId));
  const handoff = events.find(event => ['Replicas', 'T3'].includes(event.stage) && event.status === 'pending' && event.data?.message);
  const replicaId = task?.replicaId || confirmed?.data?.replicaId || confirmed?.data?.threadId;
  const request = sent?.data?.state?.candidateUtterances;
  const context = sent?.data?.state?.previousConversation;
  const transcriptEvents = events.filter(event => event.stage === 'Transcript');
  const source = run?.source === 'dictation' || read?.source === 'dictation' ? 'Dictation' : run?.source === 'test' ? 'Typed test' : run?.source === 'manual' ? 'Typed request' : run?.source === 'resumed' ? 'Restored task' : 'Wispr meeting';
  const root = $('diagnostic-flow'); root.replaceChildren();
  const meta = element('div', 'run-meta');
  if (run) {
    const date = new Date(run.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
    meta.append(element('span', '', `${source} · ${date}, ${clockTime(run.startedAt)}`));
    meta.append(element('span', 'run-scope', historical ? 'Viewing history' : 'Updates with each new request'));
  } else meta.append(element('span', '', 'No run yet this session'));
  root.append(meta);
  const section = (title, caption) => {
    const node = element('section', 'diagnostic-section');
    const head = element('div', 'diagnostic-section-heading');
    head.append(element('h2', '', title), element('span', '', caption)); node.append(head); root.append(node); return node;
  };
  const checkNumber = checks.findIndex(check => check.index === lastStart) + 1;
  const inputSection = section(sent ? 'Transcript Jev checked' : 'Transcript · not checked yet', sent ? `${checks.length === 1 ? 'Checked' : `${selectedJevCheck === 'latest' ? 'Latest check' : 'Earlier check'} ${checkNumber} of ${checks.length}`} · ${clockTime(sent.at)}` : run ? 'No Jev check recorded' : 'Waiting for new speech');
  if (checks.length > 1) {
    const picker = element('select', 'check-picker'); picker.id = 'jev-check-selection'; picker.setAttribute('aria-label', 'Jev check within this run');
    picker.append(new Option(`Latest check (${checks.length})`, 'latest'));
    for (const [number, check] of checks.entries()) picker.append(new Option(`Check ${number + 1} · ${clockTime(check.event.at)}`, String(check.index)));
    picker.value = selectedJevCheck;
    picker.onchange = () => { selectedJevCheck = picker.value; renderDiagnostics(); };
    inputSection.querySelector('.diagnostic-section-heading').append(picker);
  }
  const candidate = element('div', 'jev-request');
  const freshText = read?.entries.filter(entry => read.freshIds.includes(entry.id)).map(entry => `${entry.speaker}: ${entry.text.trim()}`).join('\n');
  candidate.append(element('p', '', sent ? request || 'No input was recorded for this check.' : run?.request || freshText || 'Waiting for new speech. Say “Replicas” or “T3” followed by your request.'));
  inputSection.append(candidate);
  if (context) {
    const earlier = element('details', 'jev-context');
    earlier.open = openDiagnostics.has(`${run.id}:window-context`);
    earlier.ontoggle = () => { if (earlier.open) openDiagnostics.add(`${run.id}:window-context`); else openDiagnostics.delete(`${run.id}:window-context`); };
    earlier.append(element('summary', '', `Earlier conversation included · ${context.split(/\s+/).filter(Boolean).length} words`), element('p', '', context));
    inputSection.append(earlier);
  }
  const newEntries = transcriptEvents.filter(event => sent && event.at > sent.at).flatMap(event => event.data?.entries ?? []);
  if (newEntries.length) {
    const later = element('details', 'window-notice');
    later.append(element('summary', '', `${newEntries.length} newer transcript ${newEntries.length === 1 ? 'line' : 'lines'} not in this check`), element('p', '', newEntries.map(entry => `${entry.speaker}: ${entry.text.trim()}`).join('\n')));
    inputSection.append(later);
  }
  if (!sent && run) inputSection.append(element('p', 'trace-note', run.source === 'resumed' ? 'Not recorded here. This task started before the current session.' : run.source === 'manual' ? 'Typed requests go directly to the selected assistant without a Jev check.' : 'Collecting the request. Jev has not checked this text yet.'));
  if (read) inputSection.append(element('p', 'trace-note', read.reason));

  if (run) {
    const scoreSection = section('Decision', returned ? `Jev · ${elapsed(returned.durationMs ?? returned.at - (sent?.at ?? returned.at))}` : modelError ? 'Check failed' : sent ? 'Checking…' : 'Not scored');
    if (decision) {
      const scores = element('div', 'trace-scores');
      for (const [label, value, threshold] of [['Intent', decision.invoked, 0.8], ['Complete', decision.complete, 0.7]]) {
        const score = element('div', value >= threshold ? 'trace-score pass' : 'trace-score');
        score.title = `${label === 'Intent' ? 'Asked the assistant to act' : 'Enough information to start'}: ${value.toFixed(2)}; threshold ${threshold.toFixed(2)}`;
        score.append(element('span', '', label), element('strong', '', `${Math.round(value * 100)}%`), element('small', '', `needs ${Math.round(threshold * 100)}%`)); scores.append(score);
      }
      const action = element('div', 'trace-score trace-route');
      action.append(element('strong', 'trace-action', decision.action === 'none' ? 'No request' : decision.action), element('small', '', decision.turn === 'collecting' ? 'Still collecting' : decision.turn === 'not_request' ? 'Not a request' : decision.destination === 'none' ? 'No assistant selected' : `→ ${decision.destination === 'replicas' ? 'Replicas' : decision.destination}`)); scores.append(action);
      scoreSection.append(scores);
    } else scoreSection.append(element('p', 'trace-note', modelError?.message || (sent ? 'Waiting for Jev’s response.' : 'No score until Jev checks this request.')));
    const outcome = replicaId ? (task?.answer ? 'Answer received' : `Sent to ${provider}`) : handoff ? 'Sending · awaiting confirmation' : run.source === 'test' ? 'Test only · not sent' : `Not sent to ${provider}`;
    const result = element('div', `diagnostic-outcome${replicaId ? ' sent' : ''}`);
    result.append(element('strong', '', outcome));
    const explanation = replicaId ? (confirmed ? `${elapsed(confirmed.at - run.startedAt)} from receipt to handoff` : 'Workspace confirmed') : gate?.message || 'Waiting for a complete request.';
    result.append(element('p', '', selectedJevCheck !== 'latest' ? `Current run outcome. At this check: ${gate?.message || 'No handoff decision recorded.'}` : explanation));
    if (task?.answer) result.append(actionButton('Open answer ↗', () => revealTask(task.id)));
    scoreSection.append(result);
  }
  if (events.length) {
    const technical = element('details', 'trace-events');
    technical.open = openDiagnostics.has(`${run.id}:events`);
    technical.ontoggle = () => { if (technical.open) openDiagnostics.add(`${run.id}:events`); else openDiagnostics.delete(`${run.id}:events`); };
    technical.append(element('summary', '', 'Run details'));
    for (const [index, event] of events.entries()) {
      const block = element('div', 'technical-event');
      block.append(element('p', '', `${clockTime(event.at)} · ${event.stage} · ${event.message}`));
      if (event.data !== undefined) block.append(detailBlock(`${run.id}:${event.at}:${index}`, 'Exact data', event.data));
      technical.append(block);
    }
    root.append(technical);
  }
  const reads = $('diagnostic-reads'); reads.replaceChildren();
  if (watcher.reads.length) reads.append(detailBlock('watcher-reads', `Wispr file reads · ${watcher.reads.length}`, watcher.reads));
}

function renderRequests() {
  const requests = state.requests || [];
  const root = $('request-capture');
  root.classList.toggle('hidden', !requests.length);
  for (const [id, node] of requestNodes) if (!requests.some(request => request.id === id)) { node.remove(); requestNodes.delete(id); }
  for (const request of requests) {
    let node = requestNodes.get(request.id);
    if (!node) {
      node = element('article', 'request-card'); node.dataset.requestId = request.id;
      const head = element('div', 'request-heading');
      const status = element('strong', 'request-status'); status.setAttribute('role', 'status');
      head.append(element('span', 'request-indicator'), status, element('span', 'request-speaker'));
      const transcript = element('p', 'request-transcript'); transcript.tabIndex = 0;
      const footer = element('div', 'request-footer');
      footer.append(element('span', 'request-hint'));
      const controls = element('div', 'request-controls');
      for (const [action, label] of [['cancel', 'Cancel'], ['send', 'Send now']]) {
        const button = element('button', action === 'send' ? 'primary compact' : 'text-button', label);
        button.type = 'button'; button.dataset.requestAction = action;
        button.onclick = async () => {
          button.disabled = true; node.dataset.busy = action;
          try { render(await call(api.requestAction(request.id, Number(node.dataset.revision), action))); }
          catch (error) { toast(error.message, true); }
          finally { delete node.dataset.busy; renderRequests(); }
        };
        controls.append(button);
      }
      footer.append(controls); node.append(head, transcript, footer); root.append(node); requestNodes.set(request.id, node);
    }
    node.dataset.phase = request.phase; node.dataset.revision = request.revision;
    const title = request.finishing ? 'Finishing your request' : ({ heard: 'Heard you', collecting: 'Collecting your request', checking: 'Understanding your request', ready: 'Ready to send', queued: 'Request queued' })[request.phase];
    const status = node.querySelector('.request-status'); if (status.textContent !== title) status.textContent = title;
    node.querySelector('.request-speaker').textContent = request.speaker;
    const transcript = node.querySelector('.request-transcript');
    if (transcript.textContent !== request.text) {
      const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24;
      transcript.textContent = request.text; if (atBottom) transcript.scrollTop = transcript.scrollHeight;
    }
    const mode = request.mode === 'implementation' ? 'implementation' : 'research';
    node.querySelector('.request-hint').textContent = request.finishing ? 'Checking the current words before sending…' : request.phase === 'ready' && request.sendAt ? `Starting ${mode} in ${Math.max(0, Math.ceil((request.sendAt - Date.now()) / 1000))}s. More words extend the wait.` : ({ heard: 'Say what you’d like the agent to do.', collecting: 'Keep talking. Your words stay together.', checking: 'Checking intent and scope…', queued: 'Your request is saved while another one finishes.' })[request.phase] || 'Preparing the handoff…';
    node.querySelector('[data-request-action="send"]').disabled = !request.canSend || request.finishing || !!node.dataset.busy;
    node.querySelector('[data-request-action="cancel"]').disabled = !!node.dataset.busy;
  }
}
setInterval(() => { if (state?.requests?.length) renderRequests(); }, 250);

function render(next) {
  state = next;
  renderLiveState();
  renderRequests();
  $('setup-banner').classList.toggle('hidden', state.ready || tab === 'history');
  $('setup-dot').classList.toggle('hidden', state.ready);
  $('sidebar-environment').textContent = state.settings.environmentName || state.settings.t3ProjectName || 'Choose a workspace';
  $('sidebar-environment-kind').textContent = state.settings.environmentName ? 'Replicas environment' : state.settings.t3ProjectName ? 'Local T3 project' : 'Agent workspace';
  document.querySelector('.environment-avatar').textContent = (state.settings.environmentName || 'S').slice(0, 1).toUpperCase();
  $('gateway-status').textContent = state.credentials.gateway ? 'Key saved' : 'Not connected';
  $('gateway-status').classList.toggle('connected', state.credentials.gateway);
  $('replicas-status').textContent = state.credentials.replicas ? 'Key saved' : 'Not connected';
  $('replicas-status').classList.toggle('connected', state.credentials.replicas);
  if (state.settings.environmentId && ![...$('environment').options].some(o => o.value === state.settings.environmentId)) {
    $('environment').append(new Option(state.settings.environmentName || 'Selected environment', state.settings.environmentId));
    $('environment').value = state.settings.environmentId;
  }
  $('t3-status').textContent = state.credentials.t3 ? 'Connected' : 'Not connected';
  $('t3-status').classList.toggle('connected', !!state.credentials.t3);
  if (state.settings.t3ProjectId && ![...$('t3-project').options].some(o => o.value === state.settings.t3ProjectId)) $('t3-project').append(new Option(state.settings.t3ProjectName || 'Selected project', state.settings.t3ProjectId));
  $('t3-project').value = state.settings.t3ProjectId || '';
  $('wispr-status').textContent = state.watcher.message;
  if (!preferencesLoaded) loadPreferences();
  renderTasks();
  if (tab === 'diagnostics') renderDiagnostics();
  $('playback').classList.toggle('hidden', !state.playing && !audioId);
  $('playback-label').textContent = state.playing && !audioId ? 'Preparing the answer…' : 'Reading to you';
}
function renderLiveState() {
  if (!state) return;
  const connected = state.watcher.connected || state.diagnostics.watcher.dictation?.connected;
  const listening = state.settings.enabled && state.ready && connected;
  const freshMeeting = state.meeting && Date.now() - state.meeting.lastSpeechAt < 60000;
  $('status-pill').className = `status-pill${listening ? ' live' : ''}`;
  $('status-pill').querySelector('span').textContent = !state.settings.enabled ? 'Paused' : !state.ready ? 'Setup needed' : !connected ? 'Wispr unavailable' : freshMeeting ? 'Receiving speech' : 'Listening';
  $('pause').textContent = state.settings.enabled ? 'Pause' : 'Resume';
  $('pause').setAttribute('aria-label', state.settings.enabled ? 'Pause listening' : 'Resume listening');
  $('activity-message').textContent = !state.settings.enabled ? 'Listening paused. Running agents will keep working.' : !state.ready ? 'Connect your tools in Settings to start.' : !connected ? state.watcher.message : 'New requests arrive through Wispr. Answers arrive here.';
  const freshDetection = state.detection && Date.now() - state.detection.at < 30000 && state.settings.enabled;
  $('detection').classList.toggle('hidden', !freshDetection || tab === 'history' || !!state.requests?.length);
  $('detection-message').textContent = freshDetection ? state.detection.message : '';
  $('detection-request').textContent = freshDetection ? state.detection.request.slice(0, 350) : '';
}
setInterval(() => { renderLiveState(); if (tab === 'diagnostics' && state) renderDiagnostics(); }, 2000);
function loadPreferences() {
  if (!state) return;
  $('login').checked = state.settings.launchAtLogin;
  $('listening').checked = state.settings.enabled;
  $('wispr-path').value = state.settings.wisprDirectory;
  $('decision-model').value = state.settings.decisionModel;
  $('text-model').value = state.settings.textModel;
  $('speech-model').value = state.settings.speechModel;
  $('voice').value = state.settings.voice;
  preferencesLoaded = true;
}
async function save(patch) { render(await call(api.saveSettings(patch))); }
async function environments() {
  const list = await call(api.environments());
  $('environment').replaceChildren(new Option('Choose an agent environment…', ''));
  for (const environment of list) $('environment').append(new Option(environment.name, environment.id));
  $('environment').value = state.settings.environmentId;
  if (!list.length) toast('No environments are available. Create one in Replicas first.', true);
}

document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => go(b.dataset.tab));
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => busy(b, () => call(api.open(b.dataset.open))));
$('copy-diagnostics').onclick = () => busy($('copy-diagnostics'), async () => { await call(api.copyDiagnostics()); toast('Diagnostics copied, including transcript text and prompts.'); });
$('diagnostic-selection').onchange = () => { selectedDiagnostic = $('diagnostic-selection').value; selectedJevCheck = 'latest'; renderDiagnostics(); };
$('diagnostic-latest').onclick = () => { selectedDiagnostic = 'latest'; selectedJevCheck = 'latest'; renderDiagnostics(); };
$('clear-diagnostics').onclick = () => busy($('clear-diagnostics'), () => call(api.clearDiagnostics()));
$('diagnostic-test-form').onsubmit = event => { event.preventDefault(); busy(event.submitter, () => call(api.testJev({ context: $('diagnostic-context').value, request: $('diagnostic-request').value }))); };
$('pause').onclick = () => busy($('pause'), () => save({ enabled: !state.settings.enabled }));
$('ask-toggle').onclick = () => { go('activity'); $('ask-form').classList.remove('hidden'); $('question').focus(); };
$('ask-close').onclick = () => { $('ask-form').classList.add('hidden'); $('ask-toggle').focus(); };
$('drawer-backdrop').onclick = closeTask;
$('archive-completed').onclick = () => busy($('archive-completed'), async () => {
  const tasks = state.tasks.filter(task => !isArchived(task) && ['ready', 'delivered', 'cancelled'].includes(task.status));
  for (const task of tasks) await call(api.action(task.id, 'archive'));
  toast(`${tasks.length} finished ${tasks.length === 1 ? 'task' : 'tasks'} moved to History.`);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (selectedTaskId) closeTask(); else { $('ask-form').classList.add('hidden'); $('ask-toggle').focus(); } }
  if (selectedTaskId && event.key === 'Tab') {
    const nodes = [...$('task-detail').querySelectorAll('button:not(:disabled), summary, [tabindex="0"]')].filter(node => node.getClientRects().length);
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === $('task-detail'))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (event.key.toLowerCase() === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey && !selectedTaskId && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { event.preventDefault(); $('ask-toggle').click(); }
});
$('ask-form').onsubmit = event => { event.preventDefault(); busy(event.submitter, async () => { await call(api.ask($('question').value, $('ask-destination').value)); $('question').value = ''; $('ask-form').classList.add('hidden'); }); };
$('gateway-form').onsubmit = event => { event.preventDefault(); busy(event.submitter, async () => { const key = $('gateway-key').value.trim(); if (!key) throw new Error('Paste a Gateway key first.'); await save({ gatewayKey: key }); $('gateway-key').value = ''; toast('Gateway key saved securely. Test the Jev connection next.'); }); };
$('replicas-form').onsubmit = event => { event.preventDefault(); busy(event.submitter, async () => { const key = $('replicas-key').value.trim(); if (!key) throw new Error('Paste a Replicas key first.'); await save({ replicasKey: key }); $('replicas-key').value = ''; await environments(); toast('Replicas connected. Choose your agent environment.'); }); };
$('t3-connect').onclick = () => busy($('t3-connect'), async () => {
  t3Projects = await call(api.connectT3());
  $('t3-project').replaceChildren(new Option('Choose a local project…', ''));
  for (const project of t3Projects) $('t3-project').append(new Option(`${project.title} · ${project.workspaceRoot}`, project.id));
  render(await call(api.state()));
  toast('T3 Code connected. Choose the project for local requests.');
});
$('t3-project').onchange = () => {
  const project = t3Projects.find(p => p.id === $('t3-project').value);
  save({ t3ProjectId: project?.id || '', t3ProjectName: project?.title || '' }).then(() => {
    $('t3-model').textContent = project ? `${project.model || 'Set a default model in T3 Code'}. Approvals and follow-up questions appear in T3 Code.` : 'Choose a project for local requests.';
  }).catch(e => toast(e.message, true));
};
$('t3-disconnect').onclick = () => busy($('t3-disconnect'), async () => { render(await call(api.disconnectT3())); $('t3-project').replaceChildren(new Option('Connect T3 Code to choose', '')); });
$('gateway-check').onclick = () => busy($('gateway-check'), async () => { await call(api.checkGateway()); toast('Jev responded successfully through AI Gateway.'); });
$('gateway-disconnect').onclick = () => busy($('gateway-disconnect'), () => save({ gatewayKey: '' }));
$('replicas-disconnect').onclick = () => busy($('replicas-disconnect'), () => save({ replicasKey: '', environmentId: '', environmentName: '' }));
$('load-environments').onclick = () => busy($('load-environments'), environments);
$('environment').onchange = () => save({ environmentId: $('environment').value, environmentName: $('environment').selectedOptions[0]?.textContent || '' }).catch(e => toast(e.message, true));
$('login').onchange = () => save({ launchAtLogin: $('login').checked }).catch(e => toast(e.message, true));
$('listening').onchange = () => save({ enabled: $('listening').checked }).catch(e => toast(e.message, true));
$('choose-wispr').onclick = () => busy($('choose-wispr'), async () => { const folder = await call(api.chooseWispr()); if (folder) { await save({ wisprDirectory: folder }); loadPreferences(); } });
$('models-form').onsubmit = event => { event.preventDefault(); busy(event.submitter, async () => { await save({ decisionModel: $('decision-model').value.trim(), textModel: $('text-model').value.trim(), speechModel: $('speech-model').value.trim(), voice: $('voice').value.trim() }); toast('Preferences saved.'); }); };
$('stop-audio').onclick = () => call(api.stop()).catch(e => toast(e.message, true));
$('test-notification').onclick = () => busy($('test-notification'), async () => { await call(api.testNotification()); toast('Test sent. Check the macOS banner or Notification Center.'); });

function stopAudio(report = false) {
  if (!audioId) return;
  const id = audioId; audioId = null;
  clearTimeout(playbackTimeout);
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = undefined; }
  if (report) api.playbackEnded(id, 'Playback stopped.');
  $('playback').classList.add('hidden');
}
api.onPlay(async data => {
  stopAudio(true);
  audioId = data.id;
  audio = new Audio(`data:${data.mediaType};base64,${data.base64}`);
  $('playback').classList.remove('hidden');
  $('playback-label').textContent = 'Reading to you';
  const finish = error => { if (audioId !== data.id) return; const id = audioId; stopAudio(); api.playbackEnded(id, error); };
  audio.onended = () => finish();
  audio.onerror = () => finish('Could not play the generated audio.');
  playbackTimeout = setTimeout(() => finish('Playback timed out.'), 120000);
  try { await audio.play(); } catch { finish('Playback could not start.'); }
});
api.onStop(() => stopAudio(true));
api.onState(render);
function revealTask(id) {
  if (!state?.tasks.some(task => task.id === id)) { go('activity'); return; }
  clearTimeout(drawerCloseTimer);
  $('task-overlay').classList.remove('closing');
  drawerReturnFocus = document.activeElement;
  selectedTaskId = id;
  expandedAnswers.set(id, true);
  renderTaskDetail();
  $('task-detail').scrollTop = 0;
  $('task-overlay').classList.remove('hidden');
  document.querySelector('.app').inert = true;
  $('close-task').focus({ preventScroll: true });
}
api.onShowTask(revealTask);
call(api.state()).then(render).catch(e => toast(e.message, true));
