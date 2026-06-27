/**
 * Skill registry — lazy-loaded expertise injected into the LLM system context only when relevant,
 * instead of stuffing every instruction into the base prompt. This generalizes the original
 * Pocketbase "toggle" so new domains (testing conventions, a framework, deploy notes, …) can be
 * added declaratively and stay out of context until they're actually needed (a token win, and the
 * local-first analog of SAW's frontmatter-triggered skills).
 *
 * Triggers:
 *  - 'toggle'  : user turns it on/off in the UI (state lives in App).
 *  - 'auto'    : always active when `available` is true.
 *  - 'keyword' : active when `match` tests true against the user's message.
 */

export interface SkillContext {
  /** Configured shared Pocketbase URL, if any. */
  pocketbaseUrl?: string;
  /** The user's current message (for 'keyword' triggers). */
  userMessage?: string;
}

export interface Skill {
  id: string;
  label: string;
  description: string;
  trigger: 'toggle' | 'auto' | 'keyword';
  /** For 'keyword' skills: matched against the user message. */
  match?: RegExp;
  /** Whether this skill can be active given the current context (e.g. Pocketbase configured). */
  available?: (ctx: SkillContext) => boolean;
  /** The instruction block injected when the skill is active. */
  instructions: (ctx: SkillContext) => string;
}

export const SKILLS: Skill[] = [
  {
    id: 'pocketbase',
    label: 'Pocketbase backend',
    description: 'Build the app against the configured shared Pocketbase (DB, auth, file storage).',
    trigger: 'toggle',
    available: (ctx) => !!ctx.pocketbaseUrl,
    instructions: (ctx) => {
      const pbUrl = (ctx.pocketbaseUrl || '').replace(/\/$/, '');
      return `BACKEND & DEPLOYMENT (Pocketbase):
- This project is deployed via Monastery's Self-Host Wizard: its Dockerfile is built and the app is served. The shared Pocketbase backend (database + auth + file storage) is at: ${pbUrl}
- Monastery injects \`POCKETBASE_URL=${pbUrl}\` into the deployed app as BOTH a build-time arg and a runtime env var.
- Use the official \`pocketbase\` JS SDK (\`npm i pocketbase\`). Initialize it from the env, with the URL above as a fallback:
  - Frontend (Vite/Angular/etc., baked at build time): \`new PocketBase(import.meta.env.VITE_POCKETBASE_URL || '${pbUrl}')\` (or framework-equivalent build-time env). If the framework only exposes prefixed vars (e.g. VITE_/NG_APP_), also reference \`${pbUrl}\` directly.
  - Backend (Node/Express, runtime): \`new PocketBase(process.env.POCKETBASE_URL || '${pbUrl}')\`.
- Common patterns: \`pb.collection('<name>').getList()\`, \`.create({...})\`, \`.update(id,{...})\`, \`.delete(id)\`; auth: \`pb.collection('users').authWithPassword(email, pass)\` / \`.create(...)\`.
- Collections/schema must already exist in the Pocketbase admin UI — the app cannot create collections at runtime, so handle missing-collection errors gracefully and document any collections you assume.
- The app (especially a browser frontend) must be able to REACH ${pbUrl} from where it runs; enable CORS in Pocketbase for the app's origin.`;
    },
  },
];

export const getSkill = (id: string) => SKILLS.find((s) => s.id === id);

/**
 * Resolve the instruction blocks for the active skills.
 * @param toggledIds   ids of 'toggle' skills the user has switched on
 * @param ctx          runtime context (pocketbase url, user message, …)
 */
export function buildSkillInstructions(toggledIds: string[], ctx: SkillContext): string[] {
  return SKILLS.filter((skill) => {
    if (skill.available && !skill.available(ctx)) return false;
    switch (skill.trigger) {
      case 'toggle':
        return toggledIds.includes(skill.id);
      case 'auto':
        return true;
      case 'keyword':
        return !!(skill.match && ctx.userMessage && skill.match.test(ctx.userMessage));
      default:
        return false;
    }
  }).map((skill) => skill.instructions(ctx));
}
