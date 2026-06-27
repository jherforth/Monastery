/**
 * Task templates — starter `spec.md` skeletons per work type. A task is still a user-created unit
 * of work; a template just seeds the spec with type-specific Acceptance Criteria / Definition of
 * Done prompts so the Plan stage starts from the right shape. Templates can optionally suggest a
 * skill to enable (only where it genuinely applies — generic types suggest none).
 */

export interface TaskTemplateContext {
  pocketbaseConfigured: boolean;
}

export interface TaskTemplate {
  id: string;
  label: string;
  icon: string;
  description: string;
  /** When present, the template is only offered if this returns true. */
  available?: (ctx: TaskTemplateContext) => boolean;
  /** Skill ids to auto-enable when a task is created from this template. */
  suggestedSkills?: string[];
  /** Render the spec.md markdown for a new task with this title. */
  spec: (title: string) => string;
}

const base = (title: string, body: string) => `# ${title}\n\n${body}`;

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'feature',
    label: 'Feature',
    icon: '✨',
    description: 'Build a new capability.',
    spec: (t) => base(t, `## Goal

_As a <user>, I want <capability> so that <benefit>._

## Acceptance Criteria

- [ ] <observable behavior 1>
- [ ] <observable behavior 2>

## Definition of Done

- [ ] Build passes
- [ ] Tests cover the new behavior
- [ ] No regressions in related areas

## Affected Files

-

## Approach

_Outline the implementation before writing code._
`),
  },
  {
    id: 'bugfix',
    label: 'Bug fix',
    icon: '🐛',
    description: 'Diagnose and fix a defect.',
    spec: (t) => base(t, `## Goal

_What is broken, and what is the correct behavior?_

## Reproduction

1.
2.
3.

**Expected:**
**Actual:**

## Root Cause

_Identify the underlying cause before fixing (don't just patch the symptom)._

## Acceptance Criteria

- [ ] The reproduction steps no longer trigger the bug
- [ ] Correct behavior verified

## Definition of Done

- [ ] Fix applied at the root cause
- [ ] **Regression test** added that fails before the fix and passes after
- [ ] Build/tests pass

## Affected Files

-

## Approach

_How will you fix it?_
`),
  },
  {
    id: 'refactor',
    label: 'Refactor',
    icon: '🧹',
    description: 'Improve structure without changing behavior.',
    spec: (t) => base(t, `## Goal

_What are we improving (readability, structure, performance) and why?_

## Invariant

- **No behavior change.** External behavior and public APIs stay identical.

## Acceptance Criteria

- [ ] Behavior is unchanged (same inputs → same outputs)
- [ ] The targeted smell/duplication is removed

## Definition of Done

- [ ] Existing tests still pass (add characterization tests first if coverage is thin)
- [ ] Build passes
- [ ] No public API changes (or they are documented)

## Affected Files

-

## Approach

_Plan the refactor in safe, reviewable steps._
`),
  },
  {
    id: 'tests',
    label: 'Add tests',
    icon: '🧪',
    description: 'Increase test coverage.',
    spec: (t) => base(t, `## Goal

_What code needs coverage, and why now?_

## What to Cover

- [ ] Happy path
- [ ] Edge cases:
- [ ] Error/failure handling

## Acceptance Criteria

- [ ] New tests fail when the behavior is broken (verify by temporarily breaking it)
- [ ] Meaningful assertions (not just "it runs")

## Definition of Done

- [ ] Tests pass
- [ ] Coverage of the target module is meaningfully improved

## Affected Files

-

## Approach

_Which framework, where the tests live, fixtures needed._
`),
  },
  {
    id: 'endpoint',
    label: 'New API endpoint',
    icon: '🔌',
    description: 'Add a backend route.',
    spec: (t) => base(t, `## Goal

_What does this endpoint do?_

## Contract

- **Method + Route:** \`GET/POST /...\`
- **Request:**
- **Response:**
- **Auth:**

## Acceptance Criteria

- [ ] Returns the expected response for valid input
- [ ] Validates input and returns clear errors for bad input
- [ ] Auth/permission enforced
- [ ] Error cases handled (not found, conflict, upstream failure)

## Definition of Done

- [ ] Route registered and reachable
- [ ] Tests for success + validation + error paths
- [ ] Build passes

## Affected Files

-

## Approach

_Handler, data access, wiring._
`),
  },
  {
    id: 'component',
    label: 'New UI component',
    icon: '🧩',
    description: 'Add a frontend component.',
    spec: (t) => base(t, `## Goal

_What does this component do and where is it used?_

## API (props)

-

## States

- [ ] Default
- [ ] Loading
- [ ] Empty
- [ ] Error

## Acceptance Criteria

- [ ] Renders correctly for each state above
- [ ] Accessible (keyboard, labels/aria, focus)
- [ ] Matches existing styling conventions

## Definition of Done

- [ ] Component implemented and used in its target location
- [ ] Build passes

## Affected Files

-

## Approach

_Composition, state, styling._
`),
  },
  {
    id: 'pocketbase-crud',
    label: 'Pocketbase CRUD',
    icon: '🗄️',
    description: 'A data-backed feature on the configured Pocketbase.',
    available: (ctx) => ctx.pocketbaseConfigured,
    suggestedSkills: ['pocketbase'],
    spec: (t) => base(t, `## Goal

_What data does the app manage, and what can the user do with it (create/read/update/delete)?_

## Collection(s)

- **Name:**
- **Fields:**
- _Reminder: collections must already exist in the Pocketbase admin UI._

## Acceptance Criteria

- [ ] List shows records from the collection
- [ ] Create / update / delete work and reflect in the UI
- [ ] Auth-gated where appropriate
- [ ] Missing-collection / network errors handled gracefully

## Definition of Done

- [ ] Uses the \`pocketbase\` SDK with \`POCKETBASE_URL\`
- [ ] Build passes
- [ ] CORS noted for the app origin

## Affected Files

-

## Approach

_SDK init, data access, UI wiring._
`),
  },
];

export function availableTemplates(ctx: TaskTemplateContext): TaskTemplate[] {
  return TASK_TEMPLATES.filter((t) => !t.available || t.available(ctx));
}

export const getTemplate = (id: string) => TASK_TEMPLATES.find((t) => t.id === id);
