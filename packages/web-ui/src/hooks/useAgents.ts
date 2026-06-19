import { useMemo, useCallback } from 'react';
import { parseSSEStream } from '../lib/sse';

interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  description: string;
  icon: string; // emoji
}

interface AgentQuickAction {
  agentId: string;
  label: string;
  prompt: string;
}

const QUICK_ACTIONS: AgentQuickAction[] = [
  { agentId: 'reviewer', label: '🔍 Review', prompt: 'Review my latest changes for bugs, security issues, and anti-patterns.' },
  { agentId: 'architect', label: '🏗️ Plan', prompt: 'Analyze this project and recommend the best architecture, patterns, and structure.' },
  { agentId: 'tester', label: '🧪 Test', prompt: 'Write comprehensive unit and integration tests for the current module.' },
  { agentId: 'documenter', label: '📝 Docs', prompt: 'Generate documentation for this project: README, API docs, and inline comments.' },
  { agentId: 'coder', label: '💻 Implement', prompt: 'Implement the feature described in the latest conversation with clean, secure code.' },
  { agentId: 'deployer', label: '🚀 Deploy', prompt: 'Prepare this project for deployment: check configuration, generate Dockerfile if needed, and verify environment variables.' },
];

/** Agent profiles kept for UI display (icon, name). Actual execution goes through Hermes. */
const AGENT_PROFILES: AgentDefinition[] = [
  {
    id: 'architect',
    name: 'Architect',
    role: 'System Designer',
    description: 'Plans project structure, chooses patterns and technologies',
    icon: '🏗️',
  },
  {
    id: 'coder',
    name: 'Coder',
    role: 'Implementation',
    description: 'Writes and edits code files following established patterns',
    icon: '💻',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Code Review',
    description: 'Reviews code for bugs, security issues, and anti-patterns',
    icon: '🔍',
  },
  {
    id: 'tester',
    name: 'Tester',
    role: 'Quality Assurance',
    description: 'Writes unit, integration, and end-to-end tests',
    icon: '🧪',
  },
  {
    id: 'documenter',
    name: 'Documenter',
    role: 'Technical Writer',
    description: 'Generates README, API documentation, and inline docs',
    icon: '📝',
  },
  {
    id: 'deployer',
    name: 'Deployer',
    role: 'DevOps / Deployment',
    description: 'Deploys projects to self-hosted platforms (Dokploy, Coolify)',
    icon: '🚀',
  },
];

/** Quick-action prompts for the editor toolbar, tailored per agent role. */
const EDITOR_QUICK_PROMPTS: Record<string, (file: string, content: string) => string> = {
  reviewer: (file, content) => `Explain this code in detail:\n\nFile: ${file}\n\`\`\`\n${content}\n\`\`\``,
  coder: (file, content) => `Refactor this code for better patterns, readability, and performance:\n\nFile: ${file}\n\`\`\`\n${content}\n\`\`\``,
  tester: (file, content) => `Write comprehensive unit and integration tests for this code:\n\nFile: ${file}\n\`\`\`\n${content}\n\`\`\``,
};

export function useAgents() {
  const agents = useMemo(() => AGENT_PROFILES, []);

  const runAgent = useCallback(async (
    agentId: string,
    task: string,
    projectId: string,
    onChunk: (chunk: string, isReasoning: boolean) => void,
    signal?: AbortSignal,
  ): Promise<string> => {
    const agent = AGENT_PROFILES.find(a => a.id === agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    const res = await fetch('/api/hermes/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        project_id: projectId,
        agent_role: agent.role,
      }),
      signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Hermes agent run failed' }));
      throw new Error(err.error || 'Hermes agent run failed');
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    let fullContent = '';
    for await (const { eventType, data } of parseSSEStream(reader)) {
      fullContent += data;
      onChunk(fullContent, eventType === 'reasoning');
    }

    return fullContent;
  }, []);

  return {
    agents,
    quickActions: QUICK_ACTIONS,
    editorPrompts: EDITOR_QUICK_PROMPTS,
    getAgent: (id: string) => agents.find(a => a.id === id),
    runAgent,
  };
}
