import { useMemo, useCallback } from 'react';
import { parseSSEStream } from '../lib/sse';

interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  icon: string; // emoji
  category: 'built-in' | 'external';
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

const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: 'architect',
    name: 'Architect',
    role: 'System Designer',
    description: 'Plans project structure, chooses patterns and technologies',
    systemPrompt: `You are an expert software architect. Analyze the project and provide:
- Recommended project structure and file organization
- Technology choices with rationale
- Design patterns to apply
- Component/module boundaries
- Data flow diagrams (described in text)
Be concise and actionable. Focus on self-hosted deployment considerations.`,
    tools: ['read_file', 'read_all_files', 'shell'],
    icon: '🏗️',
    category: 'built-in',
  },
  {
    id: 'coder',
    name: 'Coder',
    role: 'Implementation',
    description: 'Writes and edits code files following established patterns',
    systemPrompt: `You are an expert software developer. Write clean, well-documented code that:
- Follows the project's existing patterns and conventions
- Handles errors gracefully
- Is secure by default
- Includes appropriate logging
- Works in a self-hosted Docker environment
Use the file editing format: \`\`\`language:path/to/file`,
    tools: ['read_file', 'write_file', 'shell'],
    icon: '💻',
    category: 'built-in',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Code Review',
    description: 'Reviews code for bugs, security issues, and anti-patterns',
    systemPrompt: `You are an expert code reviewer. Examine the code and provide:
- Potential bugs and edge cases
- Security vulnerabilities
- Performance concerns
- Adherence to project patterns
- Suggestions for improvement (prioritized by severity)
Be specific — reference exact files and line ranges.`,
    tools: ['read_file', 'read_all_files', 'git_diff'],
    icon: '🔍',
    category: 'built-in',
  },
  {
    id: 'tester',
    name: 'Tester',
    role: 'Quality Assurance',
    description: 'Writes unit, integration, and end-to-end tests',
    systemPrompt: `You are an expert test engineer. Write comprehensive tests that:
- Cover happy paths and edge cases
- Use the project's existing test framework
- Are maintainable and readable
- Include setup/teardown as needed
- Test error handling paths
Generate test files using \`\`\`language:path/to/file.test.ext`,
    tools: ['read_file', 'write_file', 'shell'],
    icon: '🧪',
    category: 'built-in',
  },
  {
    id: 'documenter',
    name: 'Documenter',
    role: 'Technical Writer',
    description: 'Generates README, API documentation, and inline docs',
    systemPrompt: `You are an expert technical writer. Create documentation that:
- Is clear and accessible to new contributors
- Covers setup, configuration, and deployment
- Documents all public APIs with examples
- Includes troubleshooting guides
- Uses the project's documentation format
Focus on self-hosted deployment instructions.`,
    tools: ['read_file', 'read_all_files', 'write_file'],
    icon: '📝',
    category: 'built-in',
  },
  {
    id: 'deployer',
    name: 'Deployer',
    role: 'DevOps / Deployment',
    description: 'Deploys projects to self-hosted platforms (Dokploy, Coolify)',
    systemPrompt: `You are an expert DevOps engineer. Handle deployment by:
- Detecting the project framework and build requirements
- Generating appropriate Dockerfile or docker-compose.yml
- Configuring environment variables for production
- Setting up the deployment on the user's chosen platform
- Verifying the deployment succeeded
Use hosting service APIs when available.`,
    tools: ['read_file', 'read_all_files', 'write_file', 'shell', 'hosting_api'],
    icon: '🚀',
    category: 'built-in',
  },
];

const EXTERNAL_AGENTS: AgentDefinition[] = [
  {
    id: 'hermes',
    name: 'Hermes',
    role: 'External Agent Runner',
    description: 'Local AI agent framework — dispatch tasks to specialized sub-agents',
    systemPrompt: '',
    tools: [],
    icon: '🤖',
    category: 'external',
  },
  {
    id: 'openclaw',
    name: 'Open Claw',
    role: 'External Orchestrator',
    description: 'Multi-agent orchestration framework for complex task pipelines',
    systemPrompt: '',
    tools: [],
    icon: '🦞',
    category: 'external',
  },
];

export function useAgents() {
  const agents = useMemo(() => [...BUILT_IN_AGENTS, ...EXTERNAL_AGENTS], []);

  const runAgent = useCallback(async (
    agentId: string,
    task: string,
    projectId: string,
    onChunk: (chunk: string, isReasoning: boolean) => void,
    signal?: AbortSignal,
  ): Promise<string> => {
    const agent = BUILT_IN_AGENTS.find(a => a.id === agentId);
    if (!agent) throw new Error(`Agent '${agentId}' not found`);

    const res = await fetch('/api/agents/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_prompt: agent.systemPrompt,
        task,
        project_id: projectId,
      }),
      signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Agent run failed' }));
      throw new Error(err.error || 'Agent run failed');
    }

    // Stream the SSE response
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
    builtInAgents: BUILT_IN_AGENTS,
    externalAgents: EXTERNAL_AGENTS,
    quickActions: QUICK_ACTIONS,
    getAgent: (id: string) => agents.find(a => a.id === id),
    runAgent,
  };
}
