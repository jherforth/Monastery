/**
 * Run a command block the user clicked "Run" on — model output is never executed automatically.
 * Multi-line blocks run line by line (comments and `$ ` prompts stripped), stopping at the first
 * failure. Returns one chat note per command and whether anything actually ran (so the caller
 * can refresh the file tree and preview). The server refuses anything outside its allowlist.
 */
export async function runCommandBlock(projectId: string, block: string): Promise<{ notes: string[]; anyRan: boolean }> {
  const commands = block
    .split('\n')
    .map(l => l.trim().replace(/^\$\s+/, ''))
    .filter(l => l && !l.startsWith('#'));
  const notes: string[] = [];
  let anyRan = false;
  for (const cmd of commands) {
    let ok = false;
    try {
      const r = await fetch(`/api/projects/${projectId}/shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) {
        notes.push(`❌ \`${cmd}\` — ${d.error || `HTTP ${r.status}`}`);
      } else {
        anyRan = true;
        ok = !!d.success;
        const out = [d.output, d.stderr].filter(Boolean).join('\n').trim();
        const tail = out.length > 4000 ? `…${out.slice(-4000)}` : out;
        notes.push(`${ok ? '✅' : '❌'} \`${cmd}\` exited with code ${d.exit_code}` + (tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''));
      }
    } catch (e) {
      notes.push(`❌ \`${cmd}\` — ${String(e)}`);
    }
    if (!ok) break;
  }
  return { notes, anyRan };
}
