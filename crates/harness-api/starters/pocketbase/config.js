// Where the PocketBase server lives. Monastery fills this in from Settings → Hosting when a
// PocketBase connection is configured; change it by hand otherwise.
export const POCKETBASE_URL = '{{POCKETBASE_URL}}';

// The collection this app reads and writes. Create it in the PocketBase admin UI with two
// text fields — `title` and `body` — and API rules that allow list / create / delete
// (empty rules = public; use auth rules for anything real).
export const COLLECTION = 'notes';
