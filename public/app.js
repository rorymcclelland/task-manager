// The browser side of the app: fetches tasks from the local server and draws
// the page. Plain JavaScript, no framework (see docs/DECISIONS.md, D1).
//
// The pattern throughout: keep the data in `state`, and after any change
// call `render()` to redraw from it. Simple to follow, and with a few hundred
// tasks redrawing everything is instant.
//
// All text from tasks goes into the page via `textContent`, never `innerHTML`,
// so a task titled "<script>…" shows up as text instead of running.

/** @typedef {'manual'|'claude'|'gemini'|'lunatask'|'local'} Source */

const SOURCE_LABELS = {
  manual: 'Manual',
  claude: 'Claude',
  gemini: 'Gemini',
  lunatask: 'Lunatask',
  local: 'Local',
};

/** @typedef {'do'|'schedule'|'delegate'|'eliminate'|'untriaged'} Placement */

// The matrix (Phase 2). The order here is the order they're drawn and the
// order j/k moves through them: "Do now" first, always (2.2).
const QUADRANTS = /** @type {const} */ ({
  do: { label: 'Do now', hint: 'Important · urgent', key: '1' },
  schedule: { label: 'Schedule', hint: 'Important · not urgent', key: '2' },
  delegate: { label: 'Delegate or fit in', hint: 'Not important · urgent', key: '3' },
  eliminate: { label: 'Drop or defer', hint: 'Not important · not urgent', key: '4' },
  untriaged: { label: 'Not placed yet', hint: 'Drag onto the matrix, or select and press 1–4', key: '0' },
});

/** @typedef {'matrix'|'day'|'ahead'|'list'|'review'} View */
/** The order `v` cycles through, matching the buttons. */
const VIEWS = /** @type {View[]} */ (['matrix', 'day', 'ahead', 'list']);

function viewFromHash() {
  const view = location.hash.slice(1);
  return /** @type {View} */ (VIEWS.includes(/** @type {View} */ (view)) && view !== 'matrix' ? view : 'matrix');
}

const state = {
  open: /** @type {any[]} */ ([]),
  closed: /** @type {any[]} */ ([]),
  duplicates: /** @type {any[]} */ ([]),
  /** Phase 3: each source's set-up and last sync, from /api/sync. */
  sync: /** @type {any[]} */ ([]),
  syncing: false,
  /** @type {any} */ matrix: null,
  /** Phase 4: the day shown in the Day view, and the next 14 days for Ahead
   *  (both from /api/agenda). */
  /** @type {any} */ dayAgenda: null,
  /** @type {any} */ ahead: null,
  /** @type {string | null} */ day: null,
  /** The matrix is the default view (2.2); #list, #day or #ahead in the
   *  address opens another. */
  /** @type {View} */ view: viewFromHash(),
  /** @type {Source | 'all'} */ filter: 'all',
  /** @type {string | null} */ selectedId: null,
  /** @type {string | null} */ editingId: null,
  loadedOnce: false,
  /** 5.2: the review queue from /api/review, and the review in progress. */
  /** @type {any} */ reviewQueue: null,
  /** @type {any} */ review: null,
  /** 5.3: when the page last failed to reach the server; null while it can. */
  /** @type {string | null} */ serverDownSince: null,
};

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// ---- Talking to the server -----------------------------------------------

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

/**
 * Fetch everything and redraw. 5.3: if the server can't be reached, say so
 * in a banner rather than keep showing a page that looks current.
 */
async function refresh() {
  try {
    await load();
    if (state.serverDownSince) {
      state.serverDownSince = null;
      render();
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error; // a real error from the server, not "unreachable"
    state.serverDownSince ??= new Date().toISOString();
    renderAlerts();
    throw error;
  }
}

async function load() {
  const [open, closed, duplicates, matrix, sync, dayAgenda, ahead, reviewQueue] = await Promise.all([
    api('GET', '/api/tasks?view=open'),
    api('GET', '/api/tasks?view=closed'),
    api('GET', '/api/duplicates'),
    api('GET', '/api/matrix'),
    api('GET', '/api/sync'),
    api('GET', `/api/agenda?days=1${state.day ? `&from=${state.day}` : ''}`),
    api('GET', '/api/agenda?days=14'),
    api('GET', '/api/review'),
  ]);
  Object.assign(state, { open, closed, duplicates, matrix, sync, dayAgenda, ahead, reviewQueue });
  state.day = dayAgenda.from;

  // 2.2: on first load, put the cursor on the top task in "Do now", so the
  // answer to "what now?" is already highlighted.
  if (!state.loadedOnce) {
    state.loadedOnce = true;
    if (state.view === 'matrix') state.selectedId = quadrant('do')?.tasks[0]?.id ?? null;
  }
  render();
}

/** One quadrant's data from the server's matrix. */
function quadrant(id) {
  return state.matrix?.quadrants.find((q) => q.id === id);
}

// ---- Drawing the page -------------------------------------------------------

function render() {
  const visible = visibleTasks();
  if (state.selectedId && !visible.some((t) => t.id === state.selectedId)) state.selectedId = null;

  const doNow = quadrant('do')?.tasks.length ?? 0;
  const idle = state.open.filter((t) => t.priority?.stale).length;
  $('count').textContent = `${state.open.length} open · ${doNow} to do now` + (idle ? ` · ${idle} idle` : '');
  renderAlerts();
  renderReviewButton();
  renderViewSwitch();
  renderFilters();
  renderSources();
  renderDuplicates();

  for (const view of [...VIEWS, 'review']) $(view).hidden = state.view !== view;
  // While reviewing, only the card (and any alert) is on screen.
  const reviewing = state.view === 'review';
  $('duplicates').hidden = reviewing || state.duplicates.length === 0;
  for (const id of ['closed', 'capture', 'capture-error', 'filters', 'sources']) $(id).hidden = reviewing;
  document.querySelector('.page')?.classList.toggle('is-wide', state.view === 'matrix' || state.view === 'day');
  $('empty').hidden = true;
  if (state.view === 'matrix') renderMatrix();
  if (state.view === 'day') renderDay();
  if (state.view === 'ahead') renderAhead();
  if (state.view === 'list') renderList(visible);
  if (state.view === 'review') renderReview();
  renderClosed();
}

/** Open tasks that pass the current source filter, in the order they appear
 *  on screen — so j/k always move to the task you'd expect. A merged task
 *  counts for every system it lives in, not just where it started. */
function visibleTasks() {
  if (state.view === 'review') {
    const task = currentReviewTask();
    return task ? [task] : [];
  }
  if (state.view === 'day' || state.view === 'ahead') {
    // These views show a task in several places (a task can be due one day
    // and planned for another), so j/k visit each one once, top to bottom.
    const byId = new Map(state.open.map((t) => [t.id, t]));
    const ids = (state.view === 'day' ? dayOrder() : aheadOrder()).map((t) => t.id);
    return [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean).filter(passesFilter);
  }
  const all = state.view === 'matrix' && state.matrix
    ? Object.keys(QUADRANTS).flatMap((id) => quadrant(id)?.tasks ?? [])
    : state.open;
  return all.filter(passesFilter);
}

function passesFilter(task) {
  return state.filter === 'all' || sourcesOf(task).includes(state.filter);
}

function renderViewSwitch() {
  for (const button of document.querySelectorAll('#view-switch button')) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-view') === state.view));
  }
}

function setView(view) {
  state.view = view;
  // A review is a session, not a place to come back to, so it gets no address.
  if (view !== 'review') history.replaceState(null, '', view === 'matrix' ? location.pathname : `#${view}`);
  render();
}

// ---- The matrix (2.1, 2.2, 2.5) ---------------------------------------------

function renderMatrix() {
  const container = $('matrix');
  if (!state.matrix) return;

  const untriaged = quadrant('untriaged').tasks.filter(passesFilter);
  const notice = el('p', { class: 'untriaged-notice' });
  if (untriaged.length > 0) {
    const jump = el('a', { href: '#untriaged' }, `${untriaged.length} not placed yet ↓`);
    jump.addEventListener('click', (event) => {
      event.preventDefault();
      $('untriaged').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    notice.append(jump);
  }

  const grid = el('div', { class: 'matrix' },
    el('div', { class: 'axis axis--corner' }),
    el('div', { class: 'axis axis--col' }, 'Urgent'),
    el('div', { class: 'axis axis--col' }, 'Not urgent'),
    el('div', { class: 'axis axis--row' }, 'Important'),
    quadrantSection('do'),
    quadrantSection('schedule'),
    el('div', { class: 'axis axis--row' }, 'Not important'),
    quadrantSection('delegate'),
    quadrantSection('eliminate'),
  );

  container.replaceChildren(notice, grid, quadrantSection('untriaged'));
}

function quadrantSection(id) {
  const data = quadrant(id);
  const tasks = data.tasks.filter(passesFilter);
  const info = QUADRANTS[id];

  const count = data.limit !== null ? `${data.tasks.length} / ${data.limit}` : String(tasks.length);
  const header = el('header', {},
    el('h2', {}, info.label),
    el('span', { class: 'q-count', title: data.limit !== null ? `Soft limit: ${data.limit}` : '' }, count),
    el('span', { class: 'q-hint' }, info.hint),
    el('kbd', { title: `Select a task and press ${info.key} to move it here` }, info.key),
  );

  const section = el('section', { class: 'quadrant', 'data-quadrant': id, 'aria-label': info.label }, header);
  if (id === 'untriaged') section.id = 'untriaged';
  if (data.overloaded) {
    section.classList.add('is-overloaded');
    // 2.5: say it plainly, with what to do about it.
    section.append(el('p', { class: 'overload', role: 'note' },
      `${data.tasks.length} tasks in "Do now" — over your limit of ${data.limit}. ` +
      'When everything is urgent and important, nothing is. Can any move to Schedule, be handed off, or be dropped?'));
  }

  if (tasks.length > 0) {
    section.append(el('ul', { class: 'list' }, ...tasks.map(taskRow)));
  } else {
    const empty = {
      do: 'Nothing urgent and important.',
      schedule: 'Nothing planned ahead.',
      delegate: 'Nothing here.',
      eliminate: 'Nothing here.',
      untriaged: 'Everything is placed.',
    }[id];
    section.append(el('p', { class: 'q-empty' }, state.filter === 'all' ? empty : 'Nothing here from this source.'));
  }

  if (id === 'untriaged' && data.tasks.length === 0 && state.open.length === 0) section.hidden = true;
  makeDropTarget(section, id);
  return section;
}

// ---- Drag and drop between quadrants (2.3) ---------------------------------

function makeDropTarget(section, placement) {
  section.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('application/x-task-id')) return;
    event.preventDefault(); // allows the drop
    section.classList.add('is-drop-target');
  });
  section.addEventListener('dragleave', (event) => {
    if (!section.contains(/** @type {Node} */ (event.relatedTarget))) section.classList.remove('is-drop-target');
  });
  section.addEventListener('drop', (event) => {
    event.preventDefault();
    section.classList.remove('is-drop-target');
    const id = event.dataTransfer?.getData('application/x-task-id');
    const task = id && state.open.find((t) => t.id === id);
    if (task) place(task, placement);
  });
}

function sourcesOf(task) {
  return [...new Set([task.origin.source, ...task.alsoIn.map((r) => r.source)])];
}

function renderFilters() {
  const nav = $('filters');
  nav.replaceChildren();
  const options = ['all', ...Object.keys(SOURCE_LABELS)];
  for (const option of options) {
    const count = option === 'all'
      ? state.open.length
      : state.open.filter((t) => sourcesOf(t).includes(option)).length;
    // Hide empty sources, but never hide the one currently selected.
    if (option !== 'all' && count === 0 && state.filter !== option) continue;

    const button = el('button', { type: 'button', 'aria-pressed': String(state.filter === option) },
      option === 'all' ? 'All' : SOURCE_LABELS[option]);
    // 5.3: a source whose sync is failing says so wherever its tasks are counted.
    if (option !== 'all' && unhealthySources().includes(option)) {
      button.classList.add('is-unhealthy');
      button.prepend(el('span', { class: 'warn-mark', 'aria-hidden': 'true' }, '⚠ '));
      button.setAttribute('title', `${SOURCE_LABELS[option]} isn't syncing — its tasks may be out of date`);
    }
    button.append(el('span', { class: 'n' }, String(count)));
    button.addEventListener('click', () => { state.filter = /** @type {any} */ (option); render(); });
    nav.append(button);
  }
}

// ---- Sources (Phase 3) -------------------------------------------------------

/** One chip per source in the summary line; set-up and warnings when opened. */
function renderSources() {
  const chips = $('sources-chips');
  const body = $('sources-body');
  chips.replaceChildren();
  body.replaceChildren();
  let problems = 0;

  for (const source of state.sync) {
    const run = source.lastRun;
    // 5.3: the server decides how healthy each source is (sync-runner.ts).
    const health = source.health;
    let text = { off: 'not set up', pending: 'not synced yet', ok: '', warn: '', error: '', stale: '' }[health];
    if (run && run.ok) text = `${timeOf(run.at)} · ${run.summary}`;
    if (run && !run.ok) text = `failed ${timeOf(run.at)}` + (source.failures > 1 ? ` (${source.failures} in a row)` : '');
    if (health === 'stale') text = source.lastSuccessAt ? `last worked ${timeOf(source.lastSuccessAt)}` : 'hasn\'t synced yet';
    if (health === 'error' || health === 'warn' || health === 'stale') problems++;

    chips.append(el('span', { class: 'source-chip', 'data-health': health, title: text },
      el('span', { class: 'dot' }), source.label));

    const detail = el('div', { class: 'source-detail', 'data-health': health },
      el('h3', {}, source.label, el('span', { class: 'source-state' }, text)),
      el('p', { class: 'source-setup' }, source.setup));
    if (source.problem) detail.append(el('p', { class: 'source-error' }, source.problem));
    else if (run?.error) detail.append(el('p', { class: 'source-error' }, run.error));
    if (run?.warnings.length) {
      detail.append(el('ul', { class: 'source-warnings' }, ...run.warnings.slice(0, 5).map((w) => el('li', {}, w))));
    }
    body.append(detail);
  }

  body.append(el('p', { class: 'source-setup' },
    'Claude and Gemini: ask the assistant to list what you agreed as a task block (one task per line, ' +
    'with the conversation link on the first line), then paste it into the box above — or save it as a ' +
    '.md file in the inbox folder. See README → Sources.'));

  const button = el('button', { type: 'button', class: 'sync-now' }, state.syncing ? 'Syncing…' : 'Sync now');
  if (state.syncing) button.setAttribute('disabled', '');
  button.addEventListener('click', (event) => {
    event.preventDefault(); // it sits inside <summary>: don't open/close the panel
    event.stopPropagation();
    syncNow();
  });
  chips.append(button);

  // Problems open the panel so they're seen, rather than sitting behind a click.
  if (problems > 0 && !$('sources').dataset.seen) {
    /** @type {HTMLDetailsElement} */ ($('sources')).open = true;
    $('sources').dataset.seen = 'yes';
  }
}

async function syncNow() {
  state.syncing = true;
  renderSources();
  try {
    const before = state.open.length;
    await api('POST', '/api/sync');
    await refresh();
    const added = state.open.length - before;
    const failed = state.sync.filter((s) => s.lastRun && !s.lastRun.ok).map((s) => s.label);
    showToast(failed.length
      ? `Sync finished, but ${failed.join(' and ')} failed — see Sources.`
      : `Synced. ${added > 0 ? `${added} more open task${added === 1 ? '' : 's'}.` : 'Nothing new.'}`, null);
  } finally {
    state.syncing = false;
    renderSources();
  }
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderList(tasks) {
  const list = $('list');
  list.replaceChildren(...tasks.map(taskRow));

  const empty = $('empty');
  empty.hidden = tasks.length > 0;
  empty.textContent = state.open.length === 0
    ? 'Nothing open. Add a task above — press n from anywhere.'
    : `No open tasks from ${SOURCE_LABELS[state.filter] ?? 'this source'}.`;
}

function taskRow(task) {
  const li = el('li', { class: 'task', 'data-id': task.id });
  if (task.id === state.selectedId) li.classList.add('is-selected');
  if ((state.view === 'matrix' || state.view === 'day') && state.editingId !== task.id) {
    li.setAttribute('draggable', 'true');
    li.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-task-id', task.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('is-dragging'));
  }

  const check = el('button', { type: 'button', class: 'check', title: 'Mark done (x)', 'aria-label': `Mark "${task.title}" done` });
  check.addEventListener('click', () => complete(task));

  const title = el('button', { type: 'button', class: 'title', title: 'Edit (e)' }, task.title);
  if (task.mirror?.placeholderTitle) {
    // Lunatask can't share names (they're encrypted). Make it obvious this
    // one is waiting to be named, and how.
    title.classList.add('is-placeholder');
    title.setAttribute('title', 'Lunatask keeps names encrypted, so it can\'t send this one. Open it in Lunatask (o), then name it here (e).');
  }
  title.addEventListener('click', () => toggleEdit(task.id));

  const meta = el('div', { class: 'meta' });
  // In the list view, show which quadrant each task is in; in the matrix
  // that's already obvious from where it sits.
  if (state.view === 'list' && task.priority) meta.append(quadrantChip(task.priority.placement));
  const due = dueChip(task);
  if (due) meta.append(due);
  // 5.1: untouched for too long.
  if (task.priority?.stale) meta.append(idleChip(task));
  // 4.2: when it's scheduled. Left out in Day/Ahead, where where it sits says so.
  const scheduled = state.view === 'matrix' || state.view === 'list' ? scheduledChip(task) : null;
  if (scheduled) meta.append(scheduled);
  meta.append(sourceBadge(task.origin));
  for (const ref of task.alsoIn) meta.append(sourceBadge(ref, 'also in '));
  // Phase 3: what the source system currently says about it.
  if (task.mirror) meta.append(el('span', { class: 'mirror-detail', title: task.mirror.detail }, mirrorWords(task)));
  if (task.notes) meta.append(el('span', { class: 'notes-preview', title: task.notes }, task.notes));

  const body = el('div', { class: 'body' }, title, meta);

  const edit = el('button', { type: 'button' }, 'Edit');
  edit.addEventListener('click', () => toggleEdit(task.id));
  const drop = el('button', { type: 'button', title: 'No longer needed (d)' }, 'Drop');
  drop.addEventListener('click', () => dropTask(task));
  const actions = el('div', { class: 'actions' }, edit, drop);

  li.append(check, body, actions);
  li.addEventListener('mousedown', () => { state.selectedId = task.id; markSelected(); });
  if (state.editingId === task.id) li.append(editPanel(task));
  return li;
}

/** The mirror detail without repeating the source name the badge already shows. */
function mirrorWords(task) {
  const prefix = `${SOURCE_LABELS[task.origin.source]}: `;
  return task.mirror.detail.startsWith(prefix) ? task.mirror.detail.slice(prefix.length) : task.mirror.detail;
}

function quadrantChip(placement) {
  return el('span', { class: 'q-chip', 'data-quadrant': placement }, QUADRANTS[placement].label);
}

/** 2.4: the due date in words, flagged when it's what's making the task urgent. */
function dueChip(task) {
  const days = task.priority?.dueInDays;
  if (days === null || days === undefined) return null;

  let text;
  if (days < -1) text = `Overdue ${-days} days`;
  else if (days === -1) text = 'Overdue since yesterday';
  else if (days === 0) text = 'Due today';
  else if (days === 1) text = 'Due tomorrow';
  else if (days < 7) text = `Due ${formatDate(task.dueDate, { weekday: 'long' })}`;
  else text = `Due ${formatDate(task.dueDate, { day: 'numeric', month: 'short' })}`;

  const chip = el('span', { class: 'due', title: `Due ${formatDate(task.dueDate, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}` }, text);
  if (days < 0) chip.classList.add('is-overdue');
  if (task.priority.urgencyReason === 'due-soon') {
    chip.classList.add('is-urgent');
    const window = state.matrix?.settings.urgentWithinDays ?? 3;
    chip.title += ` — counts as urgent because it's due within ${window} day${window === 1 ? '' : 's'}`;
  }
  return chip;
}

/** Format a YYYY-MM-DD date for display. Read as UTC so the day never shifts. */
function formatDate(date, options) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
}

/** 1.2: a coloured label for the source; a link straight to it when we have one. */
function sourceBadge(ref, prefix = '') {
  const label = prefix + SOURCE_LABELS[ref.source];
  if (ref.url) {
    const link = el('a', { class: 'badge', 'data-source': ref.source, href: ref.url, title: `Open in ${SOURCE_LABELS[ref.source]}` }, `${label} ↗`);
    // Web links open in a new tab. App links (lunatask://) hand straight over
    // to the app; a new tab would just be left blank.
    if (isWebLink(ref.url)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
    return link;
  }
  return el('span', { class: 'badge', 'data-source': ref.source }, label);
}

function isWebLink(url) {
  return /^https?:\/\//i.test(url);
}

function openLink(url) {
  if (isWebLink(url)) window.open(url, '_blank', 'noopener');
  else location.href = url; // lunatask:// — the browser passes it to the app
}

function editPanel(task) {
  const form = el('form', { class: 'edit' });

  const title = el('input', { name: 'title', value: task.title, required: '' });
  const notes = el('textarea', { name: 'notes' });
  notes.value = task.notes;

  const source = el('select', { name: 'source' });
  for (const [value, label] of Object.entries(SOURCE_LABELS)) {
    const option = el('option', { value }, label);
    if (value === task.origin.source) option.setAttribute('selected', '');
    source.append(option);
  }
  const url = el('input', { name: 'url', type: 'url', placeholder: 'https://…', value: task.origin.url ?? '' });

  // 2.1 / 2.4: the two Eisenhower answers, and the due date that can
  // override "not urgent".
  const important = triStateSelect('important', task.important);
  const urgent = triStateSelect('urgent', task.urgent);
  const dueDate = el('input', { name: 'dueDate', type: 'date', value: task.dueDate ?? '' });
  // 4.2: when you mean to do it — a day, and optionally a time and length.
  const scheduledDate = el('input', { name: 'scheduledDate', type: 'date', value: task.scheduledDate ?? '' });
  const slotStart = el('input', { name: 'slotStart', type: 'time', step: '300', value: task.slot?.start ?? '' });
  const slotMinutes = el('select', { name: 'slotMinutes' });
  const lengths = [15, 30, 45, 60, 90, 120, 180, 240];
  if (task.slot && !lengths.includes(task.slot.minutes)) lengths.push(task.slot.minutes);
  for (const m of lengths.sort((a, b) => a - b)) {
    const option = el('option', { value: String(m) }, duration(m));
    if (m === (task.slot?.minutes ?? DEFAULT_MINUTES)) option.setAttribute('selected', '');
    slotMinutes.append(option);
  }
  const urgencyNote = el('p', { class: 'hint' });
  if (task.priority?.urgencyReason === 'due-soon') {
    urgencyNote.textContent = 'Its due date is close, so it counts as urgent whatever you choose here.';
  }

  const mirrorNote = el('p', { class: 'hint' });
  if (task.mirror && task.origin.source === 'lunatask') {
    mirrorNote.textContent = (task.mirror.placeholderTitle
      ? 'Lunatask keeps task names encrypted, so it can\'t send this one\'s name. Open it in Lunatask, then type its name above — you only do this once. '
      : '') +
      'Kept in step with Lunatask: completing it there closes it here, and if Lunatask moves its scheduled date, that wins. ' +
      'Completing it here doesn\'t change Lunatask.';
  } else if (task.mirror && task.origin.source === 'local') {
    mirrorNote.textContent = `Found in ${task.mirror.detail}. Tick it or delete the line there and it closes here.`;
  }

  const error = el('p', { class: 'error', role: 'alert' });
  const cancel = el('button', { type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => toggleEdit(null));
  const save = el('button', { type: 'submit', class: 'primary' }, 'Save');

  form.append(
    el('label', {}, 'Title', title),
    el('label', {}, 'Notes', notes),
    el('div', { class: 'row' }, el('label', {}, 'Came from', source), el('label', {}, 'Link to it there', url)),
    el('div', { class: 'row row--3' },
      el('label', {}, 'Important?', important),
      el('label', {}, 'Urgent?', urgent),
      el('label', {}, 'Due', dueDate)),
    urgencyNote,
    el('div', { class: 'row row--3' },
      el('label', {}, 'Planned for', scheduledDate),
      el('label', {}, 'At (optional)', slotStart),
      el('label', {}, 'For', slotMinutes)),
    mirrorNote,
    error,
    el('div', { class: 'buttons' }, cancel, save),
  );

  // 1.5 (manual route): merge into any other open task, for duplicates the
  // automatic suggestions didn't catch.
  const others = state.open.filter((t) => t.id !== task.id);
  if (others.length > 0) {
    const target = el('select', { name: 'mergeInto' }, el('option', { value: '' }, 'Choose a task…'));
    for (const other of others) target.append(el('option', { value: other.id }, `${other.title} (${SOURCE_LABELS[other.origin.source]})`));
    const mergeButton = el('button', { type: 'button' }, 'Merge');
    mergeButton.addEventListener('click', async () => {
      if (!target.value) return;
      await run(() => merge(task, state.open.find((t) => t.id === target.value)), error);
    });
    form.append(el('div', { class: 'merge' }, el('label', {}, 'This is a duplicate of…', target), mergeButton));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await run(async () => {
      await api('PATCH', `/api/tasks/${task.id}`, {
        title: title.value,
        notes: notes.value,
        source: source.value,
        url: url.value || null,
        important: fromTriState(important.value),
        urgent: fromTriState(urgent.value),
        dueDate: dueDate.value || null,
        scheduledDate: scheduledDate.value || null,
        slot: scheduledDate.value && slotStart.value ? { start: slotStart.value.slice(0, 5), minutes: Number(slotMinutes.value) } : null,
      });
      state.editingId = null;
      await refresh();
    }, error);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleEdit(null);
  });

  // A placeholder name is there to be replaced: select it so typing does that.
  queueMicrotask(() => (task.mirror?.placeholderTitle ? title.select() : title.focus()));
  return form;
}

/** A Yes / No / Not decided select for a true/false/null field. */
function triStateSelect(name, value) {
  const select = el('select', { name });
  for (const [optionValue, label] of [['', 'Not decided'], ['yes', 'Yes'], ['no', 'No']]) {
    const option = el('option', { value: optionValue }, label);
    if (optionValue === toTriState(value)) option.setAttribute('selected', '');
    select.append(option);
  }
  return select;
}

function toTriState(value) {
  return value === true ? 'yes' : value === false ? 'no' : '';
}

function fromTriState(value) {
  return value === 'yes' ? true : value === 'no' ? false : null;
}

function renderDuplicates() {
  const section = $('duplicates');
  section.hidden = state.duplicates.length === 0;
  if (section.hidden) return;

  const n = state.duplicates.length;
  section.replaceChildren(el('h2', {}, `${n} possible duplicate${n === 1 ? '' : 's'}`));

  for (const { a, b } of state.duplicates) {
    const keepA = el('button', { type: 'button' }, 'Same task — keep left');
    keepA.addEventListener('click', () => merge(b, a));
    const keepB = el('button', { type: 'button' }, 'Same task — keep right');
    keepB.addEventListener('click', () => merge(a, b));
    const different = el('button', { type: 'button' }, 'Not the same');
    different.addEventListener('click', async () => {
      await api('POST', `/api/tasks/${a.id}/not-duplicate`, { otherId: b.id });
      await refresh();
    });

    section.append(el('div', { class: 'pair' },
      pairTask(a),
      pairTask(b),
      el('div', { class: 'pair-buttons' }, keepA, keepB, different),
    ));
  }
}

function pairTask(task) {
  const meta = el('div', { class: 'meta' }, sourceBadge(task.origin));
  if (task.notes) meta.append(el('span', { class: 'notes-preview', title: task.notes }, task.notes));
  return el('div', { class: 'pair-task' }, el('div', { class: 'title' }, task.title), meta);
}

function renderClosed() {
  const list = $('closed-list');
  list.replaceChildren(...state.closed.slice(0, 100).map((task) => {
    let status = { done: 'Done', dropped: 'Dropped', merged: 'Merged' }[task.status] ?? task.status;
    if (task.status === 'merged') {
      const into = [...state.open, ...state.closed].find((t) => t.id === task.mergedInto);
      status = into ? `Merged into "${into.title}"` : 'Merged';
    }
    const reopen = el('button', { type: 'button' }, task.status === 'merged' ? 'Unmerge' : 'Reopen');
    reopen.addEventListener('click', async () => { await api('POST', `/api/tasks/${task.id}/reopen`); await refresh(); });

    const meta = el('div', { class: 'meta' }, sourceBadge(task.origin), el('span', { class: 'status' }, status));
    return el('li', { class: 'task' },
      el('div', { class: 'body' }, el('span', { class: 'title' }, task.title), meta),
      el('div', { class: 'actions' }, reopen));
  }));
  $('closed').querySelector('summary').textContent = `Done, dropped and merged (${state.closed.length})`;
}

// ---- Time: the Day view (4.1, 4.2) --------------------------------------------
//
// Left: the day's calendar as a timeline, with tasks that have a time slot
// drawn on it in their quadrant's colour. Right: the open tasks still to fit
// in, in matrix order. Drag a task onto the timeline to give it a slot;
// drag it to "Some time this day" to schedule the day without a time.

/** Pixels per hour on the timeline. */
const HOUR_PX = 48;
/** Drops snap to this many minutes. */
const SNAP = 15;
/** A new slot's length, unless the task already has one. */
const DEFAULT_MINUTES = 30;

function renderDay() {
  const container = $('day');
  const agenda = state.dayAgenda;
  if (!agenda) return;
  const day = agenda.days[0];

  // Header: which day, how to move between days, and how much time is left.
  const prev = el('button', { type: 'button', title: 'Day before ([)', 'aria-label': 'Day before' }, '‹');
  prev.addEventListener('click', () => shiftDay(-1));
  const next = el('button', { type: 'button', title: 'Day after (])', 'aria-label': 'Day after' }, '›');
  next.addEventListener('click', () => shiftDay(1));
  const today = el('button', { type: 'button', title: 'Today (t)' }, 'Today');
  today.addEventListener('click', () => goToDay(state.ahead?.today ?? null));
  if (day.isToday) today.setAttribute('disabled', '');

  const header = el('header', { class: 'day-header' },
    el('div', { class: 'day-nav' }, prev, el('h2', {}, dayName(day.date, agenda.today, true)), next, today),
    el('p', { class: 'free' }, freeWords(day, agenda)));

  const notes = [];
  if (!agenda.calendars.length) {
    notes.push(el('p', { class: 'day-note' }, 'No calendar connected yet, so only scheduled tasks are shown. Add your calendar\'s private iCal address as CALENDAR_URLS in .env — see README → Calendar.'));
  }
  if (agenda.unsupportedRules) {
    notes.push(el('p', { class: 'day-note' }, `${agenda.unsupportedRules} repeating event${agenda.unsupportedRules === 1 ? ' uses' : 's use'} a repeat rule this app can't read, so only the first time is shown.`));
  }

  // A task on the timeline has no row to open its edit panel under, so it opens here.
  const editing = day.slotted.find((t) => t.id === state.editingId);
  if (editing) notes.push(el('div', { class: 'block-edit' }, el('h3', {}, editing.title), editPanel(editing)));

  container.replaceChildren(header, ...notes, el('div', { class: 'day-grid' }, dayPlan(day, agenda), toFitIn(day)));
  scrollTimelineOnce(day, agenda);
}

/** Tasks in the order the Day view draws them. */
function dayOrder() {
  const day = state.dayAgenda?.days[0];
  if (!day) return [];
  const onThisDay = new Set([...day.slotted, ...day.scheduled].map((t) => t.id));
  const fitIn = ['do', 'schedule', 'delegate', 'untriaged', 'eliminate'].flatMap((id) => (quadrant(id)?.tasks ?? []).filter((t) => !onThisDay.has(t.id)));
  return [...day.scheduled, ...day.due, ...day.slotted, ...fitIn];
}

/** Tasks in the order the Ahead view draws them. */
function aheadOrder() {
  const a = state.ahead;
  if (!a) return [];
  return [...a.overdue, ...a.missed, ...a.days.flatMap((d) => [...d.slotted, ...d.scheduled, ...d.due]), ...a.dueLater];
}

/** The left column: all-day events, "some time this day", due, then the timeline. */
function dayPlan(day, agenda) {
  const column = el('section', { class: 'day-plan', 'aria-label': 'Calendar' });

  const allDay = day.events.filter((e) => e.allDay);
  if (allDay.length) {
    column.append(el('ul', { class: 'all-day' }, ...allDay.map((e) =>
      el('li', { class: 'event-chip', 'data-busy': String(e.busy), title: eventTitle(e) }, e.title))));
  }

  // 4.2: scheduled for the day with no time — also a drop target.
  const loose = el('div', { class: 'loose' }, el('h3', {}, 'Some time this day'));
  if (day.scheduled.length) loose.append(el('ul', { class: 'list' }, ...day.scheduled.filter(passesFilter).map(taskRow)));
  else loose.append(el('p', { class: 'q-empty' }, 'Drop a task here to plan it for this day without a time.'));
  makeScheduleTarget(loose, () => ({ slot: null }));
  column.append(loose);

  if (day.due.length) {
    column.append(el('div', { class: 'loose loose--due' }, el('h3', {}, 'Due this day'),
      el('ul', { class: 'list' }, ...day.due.filter(passesFilter).map(taskRow))));
  }

  column.append(timeline(day, agenda));
  return column;
}

/** The hour-by-hour timeline for one day. */
function timeline(day, agenda) {
  const timed = day.events.filter((e) => !e.allDay);
  const workStart = minutes(agenda.dayHours.start);
  const workEnd = minutes(agenda.dayHours.end);
  // Show at least 07:00–20:00 and the working day, stretched to fit anything on it.
  const starts = [7 * 60, workStart, ...timed.map((e) => minutes(e.start)), ...day.slotted.map((t) => minutes(t.slot.start))];
  const ends = [20 * 60, workEnd, ...timed.map((e) => minutes(e.end)), ...day.slotted.map((t) => minutes(t.slot.start) + t.slot.minutes)];
  const first = Math.floor(Math.min(...starts) / 60);
  const last = Math.min(24, Math.ceil(Math.max(...ends) / 60));
  const y = (m) => ((m - first * 60) * HOUR_PX) / 60;

  const grid = el('div', { class: 'timeline', style: `height:${(last - first) * HOUR_PX}px` });
  grid.dataset.first = String(first);

  // Outside working hours is shaded, so free time reads at a glance.
  grid.append(el('div', { class: 'off-hours', style: `top:0;height:${Math.max(0, y(workStart))}px` }));
  grid.append(el('div', { class: 'off-hours', style: `top:${y(workEnd)}px;bottom:0` }));
  for (let h = first; h < last; h++) {
    grid.append(el('div', { class: 'hour', style: `top:${y(h * 60)}px` }, el('span', {}, `${String(h).padStart(2, '0')}:00`)));
  }

  // Events and slotted tasks share the space; overlapping ones sit side by side.
  const items = [
    ...timed.map((e) => ({ kind: 'event', data: e, start: minutes(e.start), end: Math.max(minutes(e.end), minutes(e.start) + SNAP) })),
    ...day.slotted.filter(passesFilter).map((t) => ({ kind: 'task', data: t, start: minutes(t.slot.start), end: minutes(t.slot.start) + t.slot.minutes })),
  ];
  for (const item of layOut(items)) {
    const style = `top:${y(item.start)}px;height:${Math.max(18, y(item.end) - y(item.start) - 2)}px;` +
      `left:calc(var(--gutter) + (100% - var(--gutter)) * ${item.lane / item.lanes});width:calc((100% - var(--gutter)) / ${item.lanes} - 3px)`;
    grid.append(item.kind === 'event' ? eventBlock(item.data, style) : taskBlock(item.data, style));
  }

  // Where we are in the day.
  if (day.isToday) {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    if (m >= first * 60 && m <= last * 60) grid.append(el('div', { class: 'now', style: `top:${y(m)}px`, title: 'Now' }));
  }

  const marker = el('div', { class: 'drop-marker', hidden: '' });
  grid.append(marker);
  makeTimelineTarget(grid, marker, first);
  return grid;
}

/**
 * Side-by-side lanes for overlapping items: each item takes the first lane
 * that's free when it starts, and every item in a run of overlaps shares
 * the same width.
 */
function layOut(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const placed = [];
  let cluster = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((i) => i.lane + 1));
    for (const item of cluster) placed.push({ ...item, lanes });
    cluster = [];
  };
  for (const item of sorted) {
    if (item.start >= clusterEnd && cluster.length) close();
    const laneEnds = [];
    for (const other of cluster) laneEnds[other.lane] = Math.max(laneEnds[other.lane] ?? 0, other.end);
    let lane = 0;
    while (laneEnds[lane] !== undefined && laneEnds[lane] > item.start) lane++;
    cluster.push({ ...item, lane });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) close();
  return placed;
}

function eventBlock(event, style) {
  const time = `${event.startsEarlier ? '…' : event.start}–${event.endsLater ? '…' : event.end}`;
  return el('div', { class: 'event', 'data-busy': String(event.busy), style, title: eventTitle(event) },
    el('span', { class: 'block-time' }, time), ' ', el('span', { class: 'block-title' }, event.title));
}

function eventTitle(event) {
  const when = event.allDay ? 'All day' : `${event.start}–${event.end}`;
  return [event.title, when, event.location, event.calendar, event.busy ? '' : 'Shown as free'].filter(Boolean).join(' · ');
}

/** A slotted task on the timeline: drag it to move, ✓ to finish, × to unslot. */
function taskBlock(task, style) {
  const end = addMinutes(task.slot.start, task.slot.minutes);
  const block = el('div', { class: 'block', 'data-id': task.id, 'data-quadrant': task.priority.placement, style, draggable: 'true',
    title: `${task.title} · ${task.slot.start}–${end} · ${QUADRANTS[task.priority.placement].label}` });
  if (task.id === state.selectedId) block.classList.add('is-selected');

  const check = el('button', { type: 'button', class: 'check', title: 'Mark done (x)', 'aria-label': `Mark "${task.title}" done` });
  check.addEventListener('click', (event) => { event.stopPropagation(); complete(task); });
  const unslot = el('button', { type: 'button', class: 'unslot', title: 'Take off the timeline (keeps it planned for this day)', 'aria-label': 'Remove time' }, '×');
  unslot.addEventListener('click', (event) => { event.stopPropagation(); schedule(task, { scheduledDate: task.scheduledDate, slot: null }); });

  block.append(check,
    el('span', { class: 'block-time' }, `${task.slot.start}–${end}`), ' ',
    el('span', { class: 'block-title' }, task.title),
    unslot);
  block.addEventListener('mousedown', () => { state.selectedId = task.id; markSelected(); });
  block.addEventListener('dblclick', () => toggleEdit(task.id));
  block.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('application/x-task-id', task.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    block.classList.add('is-dragging');
  });
  block.addEventListener('dragend', () => block.classList.remove('is-dragging'));
  return block;
}

/** The right column: open tasks not yet planned for this day, in matrix order. */
function toFitIn(day) {
  const onThisDay = new Set([...day.slotted, ...day.scheduled].map((t) => t.id));
  const column = el('section', { class: 'fit-in', 'aria-label': 'To fit in' },
    el('h3', {}, 'To fit in'),
    el('p', { class: 'hint' }, 'Drag onto the timeline to give it a time, or select and press s for the next free slot.'));

  const groups = ['do', 'schedule', 'delegate', 'untriaged', 'eliminate'];
  for (const id of groups) {
    const tasks = (quadrant(id)?.tasks ?? []).filter((t) => !onThisDay.has(t.id)).filter(passesFilter);
    if (!tasks.length) continue;
    const list = el('ul', { class: 'list' }, ...tasks.map(taskRow));
    // The bottom two are folded away: rarely what you'd plan a day around.
    if (id === 'untriaged' || id === 'eliminate') {
      column.append(el('details', { class: 'fit-group', 'data-quadrant': id },
        el('summary', {}, `${QUADRANTS[id].label} (${tasks.length})`), list));
    } else {
      column.append(el('div', { class: 'fit-group', 'data-quadrant': id }, el('h4', {}, QUADRANTS[id].label, el('span', { class: 'q-count' }, String(tasks.length))), list));
    }
  }
  if (column.querySelectorAll('.task').length === 0) column.append(el('p', { class: 'q-empty' }, 'Everything open is planned for this day.'));
  makeScheduleTarget(column, () => null); // dropping back here unschedules
  return column;
}

/** "3h 30m free · 11:00–14:00, 15:30–18:00" */
function freeWords(day, agenda) {
  if (!day.free) return 'This day is over.';
  const { minutes: m, gaps } = day.free;
  const hours = `${agenda.dayHours.start}–${agenda.dayHours.end}`;
  if (m === 0) return day.isToday ? `No free time left today (${hours}).` : `No free time between ${hours}.`;
  const list = gaps.slice(0, 4).map((g) => `${g.start}–${g.end}`).join(', ') + (gaps.length > 4 ? ' …' : '');
  return `${duration(m)} free${day.isToday ? ' for the rest of the day' : ''} (${hours})${list ? ` · ${list}` : ''}`;
}

/** Bring the working day into view the first time a day is drawn. */
let scrolledFor = null;
function scrollTimelineOnce(day, agenda) {
  if (scrolledFor === day.date) return;
  scrolledFor = day.date;
  const grid = $('day').querySelector('.timeline');
  if (!grid) return;
  const first = Number(grid.dataset.first);
  const target = day.isToday ? new Date().getHours() * 60 - 60 : minutes(agenda.dayHours.start);
  const top = grid.getBoundingClientRect().top + window.scrollY + ((Math.max(target, first * 60) - first * 60) * HOUR_PX) / 60 - 120;
  if (top > window.scrollY + window.innerHeight * 0.6) window.scrollTo({ top, behavior: 'smooth' });
}

function shiftDay(days) {
  if (!state.day) return;
  goToDay(addDays(state.day, days));
}

async function goToDay(date) {
  state.day = date;
  if (state.view !== 'day') setView('day');
  await refresh();
}

// ---- Drag to schedule (4.2) ----------------------------------------------------

/** Dropping on the timeline: a slot at the time under the pointer, snapped. */
function makeTimelineTarget(grid, marker, firstHour) {
  const minuteAt = (event) => {
    const rect = grid.getBoundingClientRect();
    const raw = firstHour * 60 + ((event.clientY - rect.top) * 60) / HOUR_PX;
    return Math.max(0, Math.round(raw / SNAP) * SNAP);
  };
  grid.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('application/x-task-id')) return;
    event.preventDefault();
    const m = minuteAt(event);
    marker.hidden = false;
    marker.style.top = `${((m - firstHour * 60) * HOUR_PX) / 60}px`;
    marker.textContent = toTime(m);
  });
  grid.addEventListener('dragleave', (event) => {
    if (!grid.contains(/** @type {Node} */ (event.relatedTarget))) marker.hidden = true;
  });
  grid.addEventListener('drop', (event) => {
    event.preventDefault();
    marker.hidden = true;
    const task = draggedTask(event);
    if (!task) return;
    const length = task.slot?.minutes ?? DEFAULT_MINUTES;
    const start = Math.min(minuteAt(event), 24 * 60 - length);
    schedule(task, { scheduledDate: state.day, slot: { start: toTime(start), minutes: length } });
  });
}

/** Any other drop area. `slotFor` returns the slot to set, or null to unschedule. */
function makeScheduleTarget(area, slotFor) {
  area.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('application/x-task-id')) return;
    event.preventDefault();
    area.classList.add('is-drop-target');
  });
  area.addEventListener('dragleave', (event) => {
    if (!area.contains(/** @type {Node} */ (event.relatedTarget))) area.classList.remove('is-drop-target');
  });
  area.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    area.classList.remove('is-drop-target');
    const task = draggedTask(event);
    if (!task) return;
    const target = slotFor();
    if (target === null) {
      if (task.scheduledDate === state.day) schedule(task, { scheduledDate: null, slot: null });
    } else {
      schedule(task, { scheduledDate: state.day, slot: target.slot });
    }
  });
}

function draggedTask(event) {
  const id = event.dataTransfer?.getData('application/x-task-id');
  return id ? state.open.find((t) => t.id === id) : null;
}

/** `s`: put the selected task in the first free gap long enough for it. */
function scheduleInNextGap(task) {
  const day = state.dayAgenda?.days[0];
  const length = task.slot?.minutes ?? DEFAULT_MINUTES;
  const gap = day?.free?.gaps.find((g) => minutes(g.end) - roundUp(minutes(g.start)) >= length);
  if (!gap) {
    showToast(`No free ${duration(length)} left ${dayName(state.day, state.dayAgenda.today).match(/^(Today|Tomorrow|Yesterday)$/) ? dayWord(state.day, state.dayAgenda.today) : `on ${dayName(state.day, state.dayAgenda.today)}`}. Drag it onto the timeline instead.`, null);
    return;
  }
  schedule(task, { scheduledDate: state.day, slot: { start: toTime(roundUp(minutes(gap.start))), minutes: length } });
}

// ---- Ahead: the next 14 days (4.3) -------------------------------------------------

function renderAhead() {
  const container = $('ahead');
  const agenda = state.ahead;
  if (!agenda) return;
  const parts = [];

  if (agenda.overdue.length) {
    parts.push(aheadSection('Overdue', 'is-overdue', agenda.overdue.filter(passesFilter).map((t) => withLabel(t, 'Due', dueWords(t)))));
  }
  if (agenda.missed.length) {
    parts.push(aheadSection('Planned for an earlier day, still open', 'is-missed',
      agenda.missed.filter(passesFilter).map((t) => withLabel(t, 'Was planned for', dayWord(t.scheduledDate, agenda.today)))));
  }

  // Days with nothing on them are folded into one line: "Nothing on Sat 17 – Sun 18".
  let emptyRun = [];
  const flushEmpty = () => {
    if (!emptyRun.length) return;
    const first = dayName(emptyRun[0].date, agenda.today);
    const last = dayName(emptyRun[emptyRun.length - 1].date, agenda.today);
    parts.push(el('p', { class: 'ahead-empty' }, emptyRun.length === 1 ? `Nothing on ${first}` : `Nothing on ${first} – ${last}`));
    emptyRun = [];
  };

  for (const day of agenda.days) {
    const rows = [
      ...day.events.map((e) => eventRow(e)),
      ...day.slotted.filter(passesFilter).map((t) => withLabel(t, 'At', `${t.slot.start}–${addMinutes(t.slot.start, t.slot.minutes)}`)),
      ...day.scheduled.filter(passesFilter).map((t) => withLabel(t, 'Planned', 'that day')),
      ...day.due.filter(passesFilter).map((t) => withLabel(t, 'Due', t.priority.dueInDays === 0 ? 'today' : 'that day')),
    ];
    if (rows.length === 0) { emptyRun.push(day); continue; }
    flushEmpty();

    const open = el('button', { type: 'button', class: 'day-link', title: 'Open this day' }, dayName(day.date, agenda.today, true));
    open.addEventListener('click', () => goToDay(day.date));
    const counts = [];
    const dueCount = day.due.length + [...day.scheduled, ...day.slotted].filter((t) => t.dueDate === day.date).length;
    if (dueCount) counts.push(`${dueCount} due`);
    if (day.free) counts.push(`${duration(day.free.minutes)} free`);
    parts.push(el('section', { class: 'ahead-day' + (day.isToday ? ' is-today' : '') },
      el('header', {}, open, el('span', { class: 'ahead-counts' }, counts.join(' · '))),
      el('ul', { class: 'list' }, ...rows)));
  }
  flushEmpty();

  if (agenda.dueLater.length) {
    parts.push(aheadSection('Due after that', '', agenda.dueLater.filter(passesFilter).map((t) =>
      withLabel(t, 'Due', formatDate(t.dueDate, { weekday: 'short', day: 'numeric', month: 'short' })))));
  }
  container.replaceChildren(...parts);
}

function aheadSection(title, className, rows) {
  if (!rows.length) return el('div');
  return el('section', { class: `ahead-day ${className}` }, el('header', {}, el('h3', {}, title, el('span', { class: 'q-count' }, String(rows.length)))), el('ul', { class: 'list' }, ...rows));
}

/** A normal task row with its quadrant and "At 14:00–15:00" / "Planned that day" in front. */
function withLabel(task, kind, text) {
  const row = taskRow(task);
  // Due rows already carry the due chip ("Overdue 2 days", "Due tomorrow"), so they get no second label.
  if (kind !== 'Due') row.querySelector('.meta')?.prepend(el('span', { class: 'when', 'data-kind': kind.toLowerCase().replace(/\s+/g, '-') }, `${kind} ${text}`));
  row.querySelector('.meta')?.prepend(quadrantChip(task.priority.placement));
  return row;
}

/** A calendar event in the Ahead list: muted, not a task. */
function eventRow(event) {
  const time = event.allDay ? 'All day' : `${event.startsEarlier ? '…' : event.start}–${event.endsLater ? '…' : event.end}`;
  return el('li', { class: 'event-row', 'data-busy': String(event.busy), title: eventTitle(event) },
    el('span', { class: 'event-time' }, time), el('span', { class: 'event-title' }, event.title),
    el('span', { class: 'event-cal' }, event.calendar));
}

// ---- Time helpers ---------------------------------------------------------------------

function minutes(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function toTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function addMinutes(time, m) {
  return toTime(Math.min(24 * 60, minutes(time) + m));
}

function roundUp(m) {
  return Math.ceil(m / SNAP) * SNAP;
}

/** 90 → "1h 30m" */
function duration(m) {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h ? (rest ? `${h}h ${rest}m` : `${h}h`) : `${rest}m`;
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "Today", "Tomorrow", "Yesterday", or "Fri 16 Oct". `long` adds the date to the first three. */
function dayName(date, today, long = false) {
  const full = formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' });
  const offset = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const word = { [-1]: 'Yesterday', 0: 'Today', 1: 'Tomorrow' }[offset];
  if (!word) return full;
  return long ? `${word} · ${full}` : word;
}

/** dayName for the middle of a sentence: "planned today", not "planned Today". */
function dayWord(date, today) {
  return dayName(date, today).replace(/^(Today|Tomorrow|Yesterday)$/, (word) => word.toLowerCase());
}

/** 4.2: "Planned Thu 14:00" in the matrix and list. */
function scheduledChip(task) {
  if (!task.scheduledDate) return null;
  const today = state.ahead?.today ?? state.matrix?.today;
  const when = dayWord(task.scheduledDate, today) + (task.slot ? ` ${task.slot.start}` : '');
  const chip = el('span', { class: 'when', 'data-kind': 'planned', title: 'Planned for' + (task.slot ? ` ${task.slot.start}–${addMinutes(task.slot.start, task.slot.minutes)} on` : '') + ` ${formatDate(task.scheduledDate, { weekday: 'long', day: 'numeric', month: 'long' })}` }, `Planned ${when}`);
  if (today && task.scheduledDate < today) chip.classList.add('is-missed');
  return chip;
}

// ---- Keeping it honest: alerts (5.3) -------------------------------------------

/** Which task sources (as the filter chips name them) have a sync problem. */
function unhealthySources() {
  const map = { lunatask: 'lunatask', local: 'local' }; // connectors whose tasks have their own source
  return state.sync
    .filter((s) => (s.health === 'error' || s.health === 'stale') && map[s.id])
    .map((s) => map[s.id]);
}

/**
 * The banner at the top: anything that means the list on screen can't be
 * trusted right now. Quiet when all is well — it only exists to be noticed.
 */
function renderAlerts() {
  const box = $('alerts');
  const alerts = [];

  if (state.serverDownSince) {
    alerts.push(el('div', { class: 'alert' },
      el('strong', {}, `Can't reach the app since ${timeOf(state.serverDownSince)}. `),
      'Is npm start still running? Nothing below has updated since then, and changes won\'t save until it\'s back.'));
  }

  for (const source of state.sync.filter((s) => s.health === 'error' || s.health === 'stale')) {
    const retry = el('button', { type: 'button' }, state.syncing ? 'Syncing…' : 'Sync now');
    if (state.syncing) retry.setAttribute('disabled', '');
    retry.addEventListener('click', () => syncNow());
    alerts.push(el('div', { class: 'alert' }, el('span', {}, source.problem), retry));
  }

  box.replaceChildren(...alerts);
  box.hidden = alerts.length === 0;
}

// ---- Keeping it honest: idle tasks (5.1) -----------------------------------------

function idleChip(task) {
  const days = task.priority.idleDays;
  const limit = task.priority.placement === 'do' ? state.matrix?.settings.doNowStaleAfterDays : state.matrix?.settings.staleAfterDays;
  return el('span', { class: 'idle', title: `You haven't touched this for ${days} days (the limit ${task.priority.placement === 'do' ? 'in Do now ' : ''}is ${limit}). Review it: still relevant, move it, or drop it.` },
    `Idle ${days} days`);
}

// ---- Keeping it honest: the review (5.2) ------------------------------------------
//
// A review is a queue of cards, fixed when it starts: one task each, with
// the reason it's there and the decisions that fit. Acting on a card moves
// to the next. Every action has the usual Undo. The queue doesn't reshuffle
// as you go — a task you've just placed doesn't jump to a new position.

/** What each reason says on its card: a heading and the question it asks. */
const REVIEW_COPY = {
  untriaged: { label: 'Not placed yet', also: 'not placed yet', ask: 'Where does it belong? Place it on the matrix, or drop it if it isn\'t real.' },
  unnamed: { label: 'Needs a name', also: 'needs a name', ask: 'Lunatask keeps names encrypted, so this one arrived without one. Open it in Lunatask, then type its name here.' },
  overdue: { label: 'Overdue', also: 'overdue', ask: 'Still needed? Give it a new due date, finish it, or drop it.' },
  missed: { label: 'Planned for a day that\'s gone', also: 'planned for a day that\'s gone', ask: 'Plan it again, take it off the plan, or decide it isn\'t happening.' },
  stale: { label: 'Idle', also: 'idle', ask: 'Nothing has happened to this for a while. Still relevant? Keep it, move it, or let it go.' },
  overload: { label: 'Do now is over its limit', also: '"Do now" is over its limit', ask: 'Does this really have to be done now? Move it to Schedule or Delegate if not.' },
};

function renderReviewButton() {
  const n = state.reviewQueue?.items.length ?? 0;
  $('review-count').textContent = String(n);
  $('review-button').classList.toggle('has-items', n > 0);
  $('review-button').setAttribute('aria-pressed', String(state.view === 'review'));
}

function startReview() {
  const items = state.reviewQueue?.items ?? [];
  state.review = {
    queue: items.map((i) => ({ id: i.task.id, reason: i.reason, reasons: i.reasons })),
    index: 0,
    tally: { placed: 0, kept: 0, done: 0, dropped: 0, rescheduled: 0, named: 0, skipped: 0 },
  };
  state.editingId = null;
  setView('review');
}

function finishReview() {
  state.review = null;
  state.editingId = null;
  setView('matrix');
}

/** The task on the current card, if it's still open. */
function currentReviewTask() {
  const item = state.review?.queue[state.review.index];
  return item ? state.open.find((t) => t.id === item.id) ?? null : null;
}

/** Move on, past any cards whose task has closed since the review started. */
function nextCard(tallyKey) {
  const review = state.review;
  if (!review) return;
  if (tallyKey) review.tally[tallyKey]++;
  review.index++;
  while (review.index < review.queue.length && !state.open.some((t) => t.id === review.queue[review.index].id)) review.index++;
  state.editingId = null;
  render();
}

function previousCard() {
  const review = state.review;
  if (!review || review.index === 0) return;
  review.index--;
  while (review.index > 0 && !state.open.some((t) => t.id === review.queue[review.index].id)) review.index--;
  state.editingId = null;
  render();
}

function renderReview() {
  const container = $('review');
  const review = state.review;
  if (!review) return finishReview();

  const total = review.queue.length;
  const finish = el('button', { type: 'button', title: 'Esc' }, review.index >= total ? 'Back to the matrix' : 'Stop here');
  finish.addEventListener('click', finishReview);
  const header = el('header', { class: 'review-header' },
    el('h2', {}, 'Review'),
    el('span', { class: 'review-progress' }, total ? `${Math.min(review.index + 1, total)} of ${total}` : ''),
    finish);
  const bar = el('div', { class: 'review-bar' }, el('span', { style: `width:${total ? (Math.min(review.index, total) / total) * 100 : 100}%` }));

  if (review.index >= total) {
    container.replaceChildren(header, bar, reviewSummary(review));
    return;
  }

  const item = review.queue[review.index];
  const task = currentReviewTask();
  if (!task) {
    // Closed since the review started — by a sync, or another tab. (Right
    // after you finish a card this shows for a moment before the next one.)
    const next = el('button', { type: 'button', class: 'primary' }, 'Next');
    next.addEventListener('click', () => nextCard(null));
    container.replaceChildren(header, bar, el('section', { class: 'review-card' },
      el('p', { class: 'review-ask' }, 'This one has been closed since the review started.'), el('div', { class: 'review-actions' }, next)));
    return;
  }
  container.replaceChildren(header, bar, reviewCard(task, item));
}

function reviewCard(task, item) {
  const copy = REVIEW_COPY[item.reason];
  const card = el('section', { class: 'review-card', 'data-reason': item.reason });

  // Heading: the reason, made specific to this task.
  let heading = copy.label;
  if (item.reason === 'overdue') {
    const days = -task.priority.dueInDays;
    heading = `Overdue by ${days} day${days === 1 ? '' : 's'}`;
  }
  if (item.reason === 'missed') heading = `Planned for ${dayName(task.scheduledDate, state.ahead?.today ?? state.matrix.today)}, not done`;
  if (item.reason === 'stale') heading = `Idle for ${task.priority.idleDays} days`;
  if (item.reason === 'overload') heading = `Do now is over its limit (${quadrant('do').tasks.length} / ${state.matrix.settings.doNowLimit})`;
  const others = item.reasons.filter((r) => r !== item.reason).map((r) => REVIEW_COPY[r].also);

  card.append(
    el('p', { class: 'review-reason' }, heading),
    el('p', { class: 'review-ask' }, copy.ask + (others.length ? ` (Also: ${others.join(', ')}.)` : '')),
  );

  // The task itself, as a normal row — so the source link, due date and
  // edit panel all work the way they do everywhere else.
  card.append(el('ul', { class: 'list' }, taskRow(task)));

  if (item.reason === 'unnamed') card.append(nameForm(task));

  // The decisions. Keys match the rest of the app where there's a match.
  const actions = el('div', { class: 'review-actions' });
  const button = (label, key, action, extraClass = '') => {
    const b = el('button', { type: 'button', class: extraClass, title: key ? `${label} (${key})` : label }, label);
    if (key) b.append(el('kbd', {}, key));
    b.addEventListener('click', action);
    actions.append(b);
  };

  const placeGroup = (current) => {
    for (const id of ['do', 'schedule', 'delegate', 'eliminate']) {
      if (id === current) continue;
      button(QUADRANTS[id].label, QUADRANTS[id].key, () => reviewDo('place', task, id));
    }
  };

  if (item.reason === 'overdue') {
    button('Due tomorrow', null, () => reviewDo('due', task, addDays(state.matrix.today, 1)));
    button('Due in a week', null, () => reviewDo('due', task, addDays(state.matrix.today, 7)));
    button('No due date', null, () => reviewDo('due', task, null));
  }
  if (item.reason === 'missed') {
    button('Plan for today', null, () => reviewDo('plan', task, state.matrix.today));
    button('Plan for tomorrow', null, () => reviewDo('plan', task, addDays(state.matrix.today, 1)));
    button('Unplan', null, () => reviewDo('plan', task, null));
  }
  if (item.reason !== 'unnamed') placeGroup(task.priority.placement === 'untriaged' ? null : task.priority.placement);
  if (item.reason !== 'untriaged' && item.reason !== 'unnamed') button('Still relevant', 'k', () => reviewDo('keep', task), 'primary');
  button('Done', 'x', () => reviewDo('done', task));
  button('Drop', 'd', () => reviewDo('drop', task), 'danger');
  button('Edit', 'e', () => toggleEdit(task.id));
  button('Skip', '→', () => nextCard('skipped'));
  card.append(actions);
  return card;
}

/** For unnamed Lunatask tasks: a name box right on the card. */
function nameForm(task) {
  const input = el('input', { type: 'text', placeholder: 'Its name in Lunatask… (press n to type here)', 'aria-label': 'Task name' });
  const save = el('button', { type: 'submit', class: 'primary' }, 'Save name');
  const form = el('form', { class: 'review-name' }, input, save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    await api('PATCH', `/api/tasks/${task.id}`, { title: input.value });
    showToast(`Named: ${input.value.trim()}`, () => api('PATCH', `/api/tasks/${task.id}`, { title: task.title }));
    await refresh();
    nextCard('named');
  });
  // Not focused automatically: the card's other keys (→, d, x) should keep
  // working until you choose to type. `n` puts the cursor here.
  return form;
}

/** Carry out one card's decision, then move to the next card. */
async function reviewDo(action, task, value) {
  try {
    if (action === 'place') { await place(task, value); nextCard('placed'); return; }
    if (action === 'done') { await complete(task); nextCard('done'); return; }
    if (action === 'drop') { await dropTask(task); nextCard('dropped'); return; }
    if (action === 'plan') {
      await schedule(task, { scheduledDate: value, slot: null });
      nextCard('rescheduled');
      return;
    }
    if (action === 'due') {
      const before = task.dueDate;
      await api('PATCH', `/api/tasks/${task.id}`, { dueDate: value });
      showToast(value ? `Now due ${dayWord(value, state.matrix.today)}: ${task.title}` : `No due date: ${task.title}`,
        () => api('PATCH', `/api/tasks/${task.id}`, { dueDate: before }));
      await refresh();
      nextCard('rescheduled');
      return;
    }
    if (action === 'keep') {
      const before = task.reviewedAt ?? null;
      await api('POST', `/api/tasks/${task.id}/keep`);
      showToast(`Kept as it is: ${task.title}`, () => api('POST', `/api/tasks/${task.id}/reviewed-at`, { reviewedAt: before }));
      await refresh();
      nextCard('kept');
    }
  } catch (error) {
    showToast(error.message, null);
  }
}

function reviewSummary(review) {
  const t = review.tally;
  const parts = [
    [t.placed, 'placed'], [t.named, 'named'], [t.rescheduled, 'given a new date'], [t.kept, 'kept as they are'],
    [t.done, 'done'], [t.dropped, 'dropped'], [t.skipped, 'skipped'],
  ].filter(([n]) => n > 0).map(([n, words]) => `${n} ${words}`);
  const remaining = state.reviewQueue?.items.length ?? 0;
  const back = el('button', { type: 'button', class: 'primary' }, 'Back to the matrix');
  back.addEventListener('click', finishReview);
  return el('section', { class: 'review-card review-done' },
    el('p', { class: 'review-reason' }, review.queue.length ? 'Review done' : 'Nothing to review'),
    el('p', { class: 'review-ask' }, review.queue.length
      ? `${parts.join(' · ') || 'Nothing changed'}.` + (remaining ? ` ${remaining} still need${remaining === 1 ? 's' : ''} a decision — skipped ones come back next time.` : ' Everything is placed, current and believable.')
      : 'Everything is placed, nothing is overdue or idle, and Do now is within its limit.'),
    el('div', { class: 'review-actions' }, back));
}

/** Keys while reviewing. Returns true if it handled the key. */
function reviewKey(event) {
  if (state.view !== 'review' || !state.review) return false;
  const task = currentReviewTask();
  if (event.key === 'Escape') { finishReview(); return true; }
  if (!task) return false;
  const item = state.review.queue[state.review.index];
  switch (event.key) {
    case 'ArrowRight': nextCard('skipped'); return true;
    case 'ArrowLeft': previousCard(); return true;
    case 'n': {
      const nameBox = /** @type {HTMLInputElement | null} */ ($('review').querySelector('.review-name input'));
      if (!nameBox) return false; // not a naming card: n adds a task as usual
      nameBox.focus();
      return true;
    }
    case 'k': if (item.reason !== 'untriaged' && item.reason !== 'unnamed') reviewDo('keep', task); return true;
    case 'x': reviewDo('done', task); return true;
    case 'd': reviewDo('drop', task); return true;
    case '1': case '2': case '3': case '4': {
      if (item.reason === 'unnamed') return true;
      const placement = Object.keys(QUADRANTS).find((id) => QUADRANTS[id].key === event.key);
      if (placement !== task.priority.placement) reviewDo('place', task, placement);
      return true;
    }
  }
  return false; // e, o and the rest work as usual
}

// ---- Actions --------------------------------------------------------------

const reopen = (task) => () => api('POST', `/api/tasks/${task.id}/reopen`);

async function complete(task) {
  await api('POST', `/api/tasks/${task.id}/complete`);
  // Lunatask is mirrored read-only (DECISIONS.md D8), so say so at the
  // moment it matters rather than let the two quietly disagree.
  const elsewhere = task.origin.source === 'lunatask' && task.mirror?.openInSource
    ? ' — tick it off in Lunatask too' : '';
  showToast(`Done: ${task.title}${elsewhere}`, reopen(task));
  await refresh();
}

async function dropTask(task) {
  await api('POST', `/api/tasks/${task.id}/drop`);
  showToast(`Dropped: ${task.title}`, reopen(task));
  await refresh();
}

async function merge(duplicate, keep) {
  await api('POST', `/api/tasks/${duplicate.id}/merge`, { intoId: keep.id });
  state.editingId = null;
  showToast(`Merged into: ${keep.title}`, reopen(duplicate));
  await refresh();
}

/** 2.3: move a task to a quadrant (or back to "not placed yet"). Undoable. */
async function place(task, placement) {
  if (task.priority?.placement === placement && placement !== 'untriaged') return;
  const before = { important: task.important, urgent: task.urgent };
  const placed = await api('POST', `/api/tasks/${task.id}/place`, { quadrant: placement });
  state.selectedId = task.id;

  const undo = () => api('PATCH', `/api/tasks/${task.id}`, before);
  if (placed.priority.placement !== placement) {
    // The due date overruled the move (2.4) — say why, rather than leave the
    // task apparently refusing to budge.
    showToast(`Stays in "${QUADRANTS[placed.priority.placement].label}": it's ${dueWords(placed)}. Change the due date to move it.`, undo);
  } else {
    showToast(`Moved to ${QUADRANTS[placement].label}: ${task.title}`, undo);
  }
  await refresh();
}

/** 4.2: give a task a day, a day and a time, or neither. Undoable. */
async function schedule(task, change) {
  const before = { scheduledDate: task.scheduledDate, slot: task.slot ?? null };
  try {
    await api('PATCH', `/api/tasks/${task.id}`, change);
  } catch (error) {
    showToast(error.message, null);
    return;
  }
  state.selectedId = task.id;
  const today = state.ahead?.today;
  let message;
  if (!change.scheduledDate) message = `No longer planned: ${task.title}`;
  else if (change.slot) message = `Planned ${dayWord(change.scheduledDate, today)} ${change.slot.start}–${addMinutes(change.slot.start, change.slot.minutes)}: ${task.title}`;
  else message = `Planned for ${dayWord(change.scheduledDate, today)}, no set time: ${task.title}`;
  // Read-only mirror (D8): say so, so the two don't quietly disagree.
  if (task.origin.source === 'lunatask' && task.mirror) message += ' — here only; Lunatask isn\'t changed';
  showToast(message, () => api('PATCH', `/api/tasks/${task.id}`, before));
  await refresh();
}

/** i / u: flip one answer. Not decided → yes → no → yes… */
async function toggle(task, field) {
  const before = task[field];
  const next = before === true ? false : true;
  const updated = await api('PATCH', `/api/tasks/${task.id}`, { [field]: next });
  const undo = () => api('PATCH', `/api/tasks/${task.id}`, { [field]: before });
  const word = field === 'important' ? 'important' : 'urgent';
  if (field === 'urgent' && next === false && updated.priority.urgencyReason === 'due-soon') {
    showToast(`Still urgent: it's ${dueWords(updated)}. Change the due date to change that.`, undo);
  } else {
    showToast(`${next ? 'Marked' : 'Marked not'} ${word}: ${task.title}`, undo);
  }
  await refresh();
}

function dueWords(task) {
  const days = task.priority.dueInDays;
  if (days < 0) return 'overdue';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}

function toggleEdit(id) {
  state.editingId = state.editingId === id ? null : id;
  if (id) state.selectedId = id;
  render();
}

/** Run an action, showing any error message in `errorElement`. */
async function run(action, errorElement) {
  try {
    errorElement.textContent = '';
    await action();
  } catch (error) {
    errorElement.textContent = error.message;
  }
}

// ---- Undo toast (so any action taken by mistake costs nothing) ------------

let toastTimer;
/** @type {(() => Promise<unknown>) | null} */
let undoAction = null;

/** `undo` may be null for messages that have nothing to undo. */
function showToast(message, undo) {
  undoAction = undo;
  $('toast-undo').hidden = !undo;
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

$('toast-undo').addEventListener('click', async () => {
  $('toast').hidden = true;
  const action = undoAction;
  undoAction = null;
  if (action) await action();
  await refresh();
});

// ---- Capture (1.3) ----------------------------------------------------------

$('capture').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('capture-input'));
  if (!input.value.trim()) return;
  await run(async () => {
    await api('POST', '/api/capture', { text: input.value });
    input.value = '';
    await refresh();
  }, $('capture-error'));
});

// 3.2 / 3.3: pasting several lines (say, a task list from a Claude or Gemini
// conversation) adds them all at once instead of squashing them into one
// title. Lines already here are skipped, so pasting twice is harmless.
$('capture-input').addEventListener('paste', async (event) => {
  const text = event.clipboardData?.getData('text') ?? '';
  if (!/\r?\n\s*\S/.test(text.trim())) return; // one line: paste as normal
  event.preventDefault();
  await run(async () => {
    const result = await api('POST', '/api/capture/block', { text });
    const n = result.created.length;
    const skipped = result.skipped ? ` (${result.skipped} already here)` : '';
    showToast(n ? `Added ${n} task${n === 1 ? '' : 's'}${skipped}` : `Nothing new${skipped}`, null);
    await refresh();
  }, $('capture-error'));
});

// ---- Keyboard ---------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const typing = target.matches('input, textarea, select');

  if (typing) {
    if (event.key === 'Escape') target.blur();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // Let Enter/Space activate whichever button or link has focus as normal.
  if (target.matches('button, a') && (event.key === 'Enter' || event.key === ' ')) return;
  // 5.2: the review has its own keys for the card in front of you.
  if (reviewKey(event)) { event.preventDefault(); return; }

  const visible = visibleTasks();
  const index = visible.findIndex((t) => t.id === state.selectedId);
  const selected = visible[index];

  switch (event.key) {
    case 'n':
    case '/':
      event.preventDefault();
      $('capture-input').focus();
      break;
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      select(visible[Math.min(index + 1, visible.length - 1)]);
      break;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      select(visible[Math.max(index - 1, 0)]);
      break;
    case 'x':
      if (selected) { selectNeighbour(visible, index); complete(selected); }
      break;
    case 'd':
      if (selected) { selectNeighbour(visible, index); dropTask(selected); }
      break;
    case 'e':
    case 'Enter':
      if (selected) { event.preventDefault(); toggleEdit(selected.id); }
      break;
    case 'o': {
      const link = selected && [selected.origin, ...selected.alsoIn].find((r) => r.url);
      if (link) openLink(link.url);
      break;
    }
    // 2.3: re-prioritise without touching the mouse.
    case '1':
    case '2':
    case '3':
    case '4':
    case '0': {
      const placement = /** @type {Placement} */ (Object.keys(QUADRANTS).find((id) => QUADRANTS[id].key === event.key));
      if (selected) place(selected, placement);
      break;
    }
    case 'i':
      if (selected) toggle(selected, 'important');
      break;
    case 'u':
      if (selected) toggle(selected, 'urgent');
      break;
    case 'v':
      setView(VIEWS[(VIEWS.indexOf(/** @type {any} */ (state.view)) + 1) % VIEWS.length]);
      break;
    case 'r':
      if (state.view !== 'review') startReview();
      break;
    // Phase 4.
    case 's':
      if (!selected) break;
      if (state.view === 'day') scheduleInNextGap(selected);
      else toggleEdit(selected.id); // the edit panel has the schedule fields
      break;
    case '[':
      if (state.view === 'day') shiftDay(-1);
      break;
    case ']':
      if (state.view === 'day') shiftDay(1);
      break;
    case 't':
      goToDay(state.ahead?.today ?? null);
      break;
  }
});

function select(task) {
  if (!task) return;
  state.selectedId = task.id;
  markSelected();
  document.querySelector(`[data-id="${task.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** After closing a task from the keyboard, keep the cursor where it was. */
function selectNeighbour(visible, index) {
  const next = visible[index + 1] ?? visible[index - 1];
  state.selectedId = next ? next.id : null;
}

function markSelected() {
  for (const row of document.querySelectorAll('.task[data-id], .block[data-id]')) {
    row.classList.toggle('is-selected', row.getAttribute('data-id') === state.selectedId);
  }
}

// ---- Tiny DOM helper ----------------------------------------------------------

/** Create an element with attributes and children (strings become text). */
function el(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  for (const child of children) element.append(child);
  return element;
}

// ---- Start --------------------------------------------------------------------

$('review-button').addEventListener('click', () => (state.view === 'review' ? finishReview() : startReview()));

for (const button of document.querySelectorAll('#view-switch button')) {
  button.addEventListener('click', () => setView(/** @type {any} */ (button.getAttribute('data-view'))));
}

// Back/forward, or a typed #day / #ahead in the address bar.
window.addEventListener('hashchange', () => { if (viewFromHash() !== state.view) setView(viewFromHash()); });

// Re-fetch when you come back to the tab, in case the file changed via sync.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// Background syncs (every 15 minutes by default) change the list while the
// page is open; look for that once a minute. Skipped while you're typing or
// editing, so a redraw never eats what you've typed.
setInterval(() => {
  const typing = document.activeElement?.matches('input, textarea, select');
  if (!document.hidden && !state.editingId && !typing && !state.syncing) refresh().catch(() => {});
}, 60_000);

// 5.3: while the server is unreachable, check every 10 seconds so the
// banner clears as soon as it's back.
setInterval(() => { if (state.serverDownSince && !document.hidden) refresh().catch(() => {}); }, 10_000);

refresh().catch((error) => {
  $('empty').hidden = false;
  $('empty').textContent = `Couldn't reach the task server: ${error.message}`;
});
