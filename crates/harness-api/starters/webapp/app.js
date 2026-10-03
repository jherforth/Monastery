// A tiny to-do app with no build step: state lives in localStorage, and the
// whole list re-renders from that state after every change.
const STORAGE_KEY = 'tasks.v1';

/** @type {{ id: string, title: string, done: boolean }[]} */
let tasks = load();
let filter = 'all';

const form = document.getElementById('new-task');
const input = document.getElementById('task-input');
const list = document.getElementById('task-list');
const template = document.getElementById('task-template');
const count = document.getElementById('count');
const clearDone = document.getElementById('clear-done');
const filterButtons = document.querySelectorAll('[data-filter]');

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function render() {
  const visible = tasks.filter((t) => filter === 'all' || (filter === 'done' ? t.done : !t.done));
  list.replaceChildren(...visible.map((task) => {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = task.id;
    item.classList.toggle('is-done', task.done);
    item.querySelector('.task__toggle').checked = task.done;
    item.querySelector('.task__title').textContent = task.title;
    return item;
  }));

  const remaining = tasks.filter((t) => !t.done).length;
  count.textContent = `${remaining} ${remaining === 1 ? 'task' : 'tasks'} left`;
  clearDone.hidden = !tasks.some((t) => t.done);
  filterButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
}

function update(next) {
  tasks = next;
  save();
  render();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  update([...tasks, { id: crypto.randomUUID(), title, done: false }]);
  form.reset();
  input.focus();
});

list.addEventListener('change', (event) => {
  if (!event.target.matches('.task__toggle')) return;
  const id = event.target.closest('.task').dataset.id;
  update(tasks.map((t) => (t.id === id ? { ...t, done: event.target.checked } : t)));
});

list.addEventListener('click', (event) => {
  if (!event.target.matches('.task__delete')) return;
  const id = event.target.closest('.task').dataset.id;
  update(tasks.filter((t) => t.id !== id));
});

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    render();
  });
});

clearDone.addEventListener('click', () => update(tasks.filter((t) => !t.done)));

render();
