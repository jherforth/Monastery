import { useAgents } from '../hooks/useAgents';
import { Bot, ExternalLink, Clock } from 'lucide-react';

export function AgentsTab() {
  const { builtInAgents, externalAgents } = useAgents();

  return (
    <div className="px-3 py-2 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 px-1">
        <Bot size={14} className="text-monastery-lantern" />
        <span className="text-xs font-medium text-monastery-text-primary">
          {builtInAgents.length} built-in, {externalAgents.length} external
        </span>
      </div>

      {/* Built-in Agents */}
      <div>
        <div className="flex items-center gap-1.5 px-1 mb-2">
          <span className="text-[10px] font-medium text-monastery-text-muted uppercase tracking-wider">Built-in Agents</span>
          <span className="text-[10px] text-monastery-text-muted">({builtInAgents.length})</span>
        </div>
        <div className="space-y-1">
          {builtInAgents.map(agent => (
            <div
              key={agent.id}
              className="px-2 py-2 rounded-md hover:bg-monastery-dark-surface transition-colors group"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm flex-shrink-0">{agent.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-monastery-text-primary">{agent.name}</span>
                    <span className="text-[10px] text-monastery-text-muted">{agent.role}</span>
                  </div>
                  <p className="text-[11px] text-monastery-text-muted mt-0.5 leading-relaxed">
                    {agent.description}
                  </p>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    {agent.tools.slice(0, 3).map(tool => (
                      <span key={tool} className="text-[9px] text-monastery-text-muted bg-monastery-dark-tertiary px-1 py-0.5 rounded">
                        {tool}
                      </span>
                    ))}
                    {agent.tools.length > 3 && (
                      <span className="text-[9px] text-monastery-text-muted">
                        +{agent.tools.length - 3}
                      </span>
                    )}
                    <span className="text-[9px] text-monastery-text-muted ml-auto flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-monastery-text-muted" />
                      idle
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* External Agents */}
      <div className="border-t border-monastery-dark-border pt-3">
        <div className="flex items-center gap-1.5 px-1 mb-2">
          <ExternalLink size={10} className="text-monastery-text-muted" />
          <span className="text-[10px] font-medium text-monastery-text-muted uppercase tracking-wider">External Agents</span>
          <span className="text-[10px] text-monastery-text-muted">({externalAgents.length})</span>
        </div>
        <div className="space-y-1">
          {externalAgents.map(agent => (
            <div
              key={agent.id}
              className="px-2 py-2 rounded-md hover:bg-monastery-dark-surface transition-colors opacity-60"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm flex-shrink-0">{agent.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-monastery-text-primary">{agent.name}</span>
                    <span className="text-[10px] text-amber-400/70 flex items-center gap-1">
                      <Clock size={10} />
                      Coming soon
                    </span>
                  </div>
                  <p className="text-[11px] text-monastery-text-muted mt-0.5 leading-relaxed">
                    {agent.description}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Future note */}
      <div className="border-t border-monastery-dark-border pt-2">
        <p className="px-1 text-[10px] text-monastery-text-muted italic leading-relaxed">
          Dispatch agents from chat — coming in a future update. Agents will handle specialized coding tasks
          autonomously while the main conversation continues.
        </p>
      </div>
    </div>
  );
}
