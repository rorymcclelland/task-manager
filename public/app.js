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

const state = {
  open: /** @type {any[]} */ ([]),
  closed: /** @type {any[]} */ ([]),
  duplicates: /** @type {any[]} */ ([]),
  /** @type {Source | 'all'} */ filter: 'all',
  /** @type {string | null} */ selectedId: null,
  /** @type {string | null} */ editingId: null,
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
  const [open, closed, duplicates] = await Promise.all([
    api('GET', '/api/tasks?view=open'),
    api('GET', '/api/tasks?view=closed'),
    api('GET', '/api/duplicates'),
  ]);
  Object.assign(state, { open, closed, duplicates });
  render();
}

// ---- Drawing the page -------------------------------------------------------

function render() {
  const visible = visibleTasks();
  if (state.selectedId && !visible.some((t) => t.id === state.selectedId)) state.selectedId = null;

  $('count').textContent = `${state.open.length} open`;
  renderFilters();
  renderDuplicates();
  renderList(visible);
  renderClosed();
}

/** Open tasks that pass the current source filter. A merged task counts for
 *  every system it lives in, not just where it started. */
function visibleTasks() {
  if (state.filter === 'all') return state.open;
  return state.open.filter((t) => sourcesOf(t).includes(state.filter));
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

  const check = el('button', { type: 'button', class: 'check', title: 'Mark done (x)', 'aria-label': `Mark "${task.title}" done` });
  check.addEventListener('click', () => complete(task));

  const title = el('button', { type: 'button', class: 'title', title: 'Edit (e)' }, task.title);
  title.addEventListener('click', () => toggleEdit(task.id));

  const meta = el('div', { class: 'meta' });
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

  const error = el('p', { class: 'error', role: 'alert' });
  const cancel = el('button', { type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => toggleEdit(null));
  const save = el('button', { type: 'submit', class: 'primary' }, 'Save');

  form.append(
    el('label', {}, 'Title', title),
    el('label', {}, 'Notes', notes),
    el('div', { class: 'row' }, el('label', {}, 'Came from', source), el('label', {}, 'Link to it there', url)),
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

async function complete(task) {
  await api('POST', `/api/tasks/${task.id}/complete`);
  showUndo(`Done: ${task.title}`, task.id);
  await refresh();
}

async function dropTask(task) {
  await api('POST', `/api/tasks/${task.id}/drop`);
  showUndo(`Dropped: ${task.title}`, task.id);
  await refresh();
}

async function merge(duplicate, keep) {
  await api('POST', `/api/tasks/${duplicate.id}/merge`, { intoId: keep.id });
  state.editingId = null;
  showUndo(`Merged into: ${keep.title}`, duplicate.id);
  await refresh();
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

// ---- Undo toast (so completing or dropping by mistake costs nothing) -----

let toastTimer;
let undoId = null;

function showUndo(message, taskId) {
  undoId = taskId;
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

$('toast-undo').addEventListener('click', async () => {
  $('toast').hidden = true;
  if (undoId) await api('POST', `/api/tasks/${undoId}/reopen`);
  undoId = null;
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
  for (const row of document.querySelectorAll('#list .task')) {
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

// Re-fetch when you come back to the tab, in case the file changed via sync.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

refresh().catch((error) => {
  $('empty').hidden = false;
  $('empty').textContent = `Couldn't reach the task server: ${error.message}`;
});
