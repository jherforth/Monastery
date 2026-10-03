// A notes app backed by PocketBase, loaded straight from a CDN — no npm, no build step.
import PocketBase from 'https://cdn.jsdelivr.net/npm/pocketbase/dist/pocketbase.es.mjs';
import { POCKETBASE_URL, COLLECTION } from './config.js';

const pb = new PocketBase(POCKETBASE_URL);
const notes = pb.collection(COLLECTION);

const form = document.getElementById('new-note');
const list = document.getElementById('notes');
const status = document.getElementById('status');
document.getElementById('pb-url').textContent = POCKETBASE_URL;

function showStatus(message) {
  status.textContent = message;
  status.hidden = !message;
}

// Turn PocketBase errors into something a person can act on.
function explain(error) {
  if (error?.status === 0) return `Can't reach PocketBase at ${POCKETBASE_URL}. Is it running, and does it allow this site's origin (CORS)?`;
  if (error?.status === 404) return `The "${COLLECTION}" collection doesn't exist yet — create it in the PocketBase admin UI (see config.js).`;
  if (error?.status === 403) return `PocketBase refused the request — check the "${COLLECTION}" collection's API rules.`;
  return error?.message || String(error);
}

function render(records) {
  list.replaceChildren(...records.map((note) => {
    const item = document.createElement('li');
    item.className = 'note';
    const title = document.createElement('h2');
    title.textContent = note.title;
    const body = document.createElement('p');
    body.textContent = note.body || '';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => removeNote(note.id));
    item.append(title, body, remove);
    return item;
  }));
  if (records.length === 0) showStatus('No notes yet — add the first one above.');
}

async function refresh() {
  try {
    showStatus('');
    render(await notes.getFullList());
  } catch (error) {
    showStatus(explain(error));
  }
}

async function removeNote(id) {
  try {
    await notes.delete(id);
    await refresh();
  } catch (error) {
    showStatus(explain(error));
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try {
    await notes.create({ title: data.title.trim(), body: data.body.trim() });
    form.reset();
    await refresh();
  } catch (error) {
    showStatus(explain(error));
  }
});

refresh();
