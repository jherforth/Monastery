export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return res.json();
};

/**
 * POST JSON to an API endpoint with standardized error handling.
 * Returns parsed JSON on success, throws with the server's error message on failure.
 */
export async function apiPost<T = unknown>(url: string, body: unknown, fallbackMsg: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: fallbackMsg }));
    throw new Error(err.error || fallbackMsg);
  }
  return res.json();
}

/**
 * DELETE request with standardized error handling.
 */
export async function apiDelete(url: string, fallbackMsg: string): Promise<void> {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: fallbackMsg }));
    throw new Error(err.error || fallbackMsg);
  }
}
