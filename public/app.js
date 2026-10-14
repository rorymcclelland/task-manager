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

const state = {
  open: /** @type {any[]} */ ([]),
  closed: /** @type {any[]} */ ([]),
  duplicates: /** @type {any[]} */ ([]),
  /** @type {any} */ matrix: null,
  /** The matrix is the default view (2.2); #list in the address shows the plain list. */
  /** @type {'matrix' | 'list'} */ view: location.hash === '#list' ? 'list' : 'matrix',
  /** @type {Source | 'all'} */ filter: 'all',
  /** @type {string | null} */ selectedId: null,
  /** @type {string | null} */ editingId: null,
  loadedOnce: false,
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

async function refresh() {
  const [open, closed, duplicates, matrix] = await Promise.all([
    api('GET', '/api/tasks?view=open'),
    api('GET', '/api/tasks?view=closed'),
    api('GET', '/api/duplicates'),
    api('GET', '/api/matrix'),
  ]);
  Object.assign(state, { open, closed, duplicates, matrix });

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
  $('count').textContent = `${state.open.length} open · ${doNow} to do now`;
  renderViewSwitch();
  renderFilters();
  renderDuplicates();

  const matrixView = state.view === 'matrix';
  $('matrix').hidden = !matrixView;
  $('list').hidden = matrixView;
  document.querySelector('.page')?.classList.toggle('is-wide', matrixView);
  if (matrixView) {
    renderMatrix();
    $('empty').hidden = true;
  } else {
    renderList(visible);
  }
  renderClosed();
}

/** Open tasks that pass the current source filter, in the order they appear
 *  on screen — so j/k always move to the task you'd expect. A merged task
 *  counts for every system it lives in, not just where it started. */
function visibleTasks() {
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
  history.replaceState(null, '', view === 'list' ? '#list' : location.pathname);
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
    button.append(el('span', { class: 'n' }, String(count)));
    button.addEventListener('click', () => { state.filter = /** @type {any} */ (option); render(); });
    nav.append(button);
  }
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
  if (state.view === 'matrix' && state.editingId !== task.id) {
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
  title.addEventListener('click', () => toggleEdit(task.id));

  const meta = el('div', { class: 'meta' });
  // In the list view, show which quadrant each task is in; in the matrix
  // that's already obvious from where it sits.
  if (state.view === 'list' && task.priority) meta.append(quadrantChip(task.priority.placement));
  const due = dueChip(task);
  if (due) meta.append(due);
  meta.append(sourceBadge(task.origin));
  for (const ref of task.alsoIn) meta.append(sourceBadge(ref, 'also in '));
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
    return el('a', { class: 'badge', 'data-source': ref.source, href: ref.url, target: '_blank', rel: 'noopener noreferrer', title: `Open in ${SOURCE_LABELS[ref.source]}` }, `${label} ↗`);
  }
  return el('span', { class: 'badge', 'data-source': ref.source }, label);
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
  const urgencyNote = el('p', { class: 'hint' });
  if (task.priority?.urgencyReason === 'due-soon') {
    urgencyNote.textContent = 'Its due date is close, so it counts as urgent whatever you choose here.';
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
      });
      state.editingId = null;
      await refresh();
    }, error);
  });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleEdit(null);
  });

  queueMicrotask(() => title.focus());
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

// ---- Actions --------------------------------------------------------------

const reopen = (task) => () => api('POST', `/api/tasks/${task.id}/reopen`);

async function complete(task) {
  await api('POST', `/api/tasks/${task.id}/complete`);
  showToast(`Done: ${task.title}`, reopen(task));
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

function showToast(message, undo) {
  undoAction = undo;
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
      if (link) window.open(link.url, '_blank', 'noopener');
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
      setView(state.view === 'matrix' ? 'list' : 'matrix');
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
  for (const row of document.querySelectorAll('.task[data-id]')) {
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

for (const button of document.querySelectorAll('#view-switch button')) {
  button.addEventListener('click', () => setView(/** @type {any} */ (button.getAttribute('data-view'))));
}

// Re-fetch when you come back to the tab, in case the file changed via sync.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

refresh().catch((error) => {
  $('empty').hidden = false;
  $('empty').textContent = `Couldn't reach the task server: ${error.message}`;
});
