/**
 * Minimal line diff for the in-chat file-change cards. Not a full Myers implementation:
 * common prefix/suffix are stripped first, the middle is LCS-diffed when small enough,
 * and very large middles fall back to a coarse "replaced block" so the UI never hangs
 * on a 10k-line file.
 */

export type DiffLine =
  | { type: 'context' | 'add' | 'del'; text: string }
  | { type: 'skip'; count: number };

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the rendered line list was capped (the change is bigger than shown). */
  truncated: boolean;
}

const LCS_CELL_LIMIT = 250_000; // a.length * b.length above this → coarse fallback
const MAX_RENDER_LINES = 400;
const CONTEXT_LINES = 2;

/** Raw edit script: full lists of context/add/del lines (no hunking). */
function editScript(before: string[], after: string[]): DiffLine[] {
  // Strip common prefix
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  // Strip common suffix (not overlapping the prefix)
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }

  const midB = before.slice(start, endB);
  const midA = after.slice(start, endA);

  const middle: DiffLine[] = [];
  if (midB.length * midA.length > LCS_CELL_LIMIT) {
    // Coarse fallback: whole middle replaced.
    midB.forEach(text => middle.push({ type: 'del', text }));
    midA.forEach(text => middle.push({ type: 'add', text }));
  } else if (midB.length || midA.length) {
    // LCS table over the trimmed middle.
    const n = midB.length, m = midA.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = midB[i] === midA[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midB[i] === midA[j]) { middle.push({ type: 'context', text: midB[i] }); i++; j++; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { middle.push({ type: 'del', text: midB[i] }); i++; }
      else { middle.push({ type: 'add', text: midA[j] }); j++; }
    }
    while (i < n) { middle.push({ type: 'del', text: midB[i] }); i++; }
    while (j < m) { middle.push({ type: 'add', text: midA[j] }); j++; }
  }

  return [
    ...before.slice(0, start).map(text => ({ type: 'context' as const, text })),
    ...middle,
    ...before.slice(endB).map(text => ({ type: 'context' as const, text })),
  ];
}

/** Collapse long context runs into {type:'skip'} rows, keeping CONTEXT_LINES around changes. */
function hunk(script: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: string[] = [];
  const flushRun = (isEnd: boolean, isStart: boolean) => {
    const keepHead = isStart ? 0 : CONTEXT_LINES;
    const keepTail = isEnd ? 0 : CONTEXT_LINES;
    if (run.length <= keepHead + keepTail + 1) {
      run.forEach(text => out.push({ type: 'context', text }));
    } else {
      run.slice(0, keepHead).forEach(text => out.push({ type: 'context', text }));
      out.push({ type: 'skip', count: run.length - keepHead - keepTail });
      run.slice(run.length - keepTail).forEach(text => out.push({ type: 'context', text }));
    }
    run = [];
  };
  let seenChange = false;
  for (const line of script) {
    if (line.type === 'context') {
      run.push(line.text);
    } else {
      flushRun(false, !seenChange);
      seenChange = true;
      out.push(line);
    }
  }
  flushRun(true, !seenChange);
  return out;
}

export function diffLines(beforeText: string, afterText: string): DiffResult {
  const before = beforeText === '' ? [] : beforeText.split('\n');
  const after = afterText === '' ? [] : afterText.split('\n');
  const script = editScript(before, after);
  const added = script.filter(l => l.type === 'add').length;
  const removed = script.filter(l => l.type === 'del').length;
  let lines = hunk(script);
  let truncated = false;
  if (lines.length > MAX_RENDER_LINES) {
    lines = lines.slice(0, MAX_RENDER_LINES);
    truncated = true;
  }
  return { lines, added, removed, truncated };
}
