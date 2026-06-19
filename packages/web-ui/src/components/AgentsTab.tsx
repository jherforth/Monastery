import { useAgents } from '../hooks/useAgents';
import { useHermesAgent } from '../hooks/useHermesAgent';
import { Bot, Wifi, WifiOff, Settings, ExternalLink, ChevronRight } from 'lucide-react';

export function AgentsTab() {
  const { agents } = useAgents();
  const { connections, defaultConnection, isLoading } = useHermesAgent();
  const hermesConnected = defaultConnection !== null;

  return (
    <div className="px-3 py-2 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 px-1">
        <Bot size={14} className="text-monastery-lantern" />
        <span className="text-xs font-medium text-monastery-text-primary">
          {agents.length} agent roles — Hermes
        </span>
        {hermesConnected ? (
          <span className="flex items-center gap-1 text-[10px] text-green-400">
            <Wifi size={10} />
            Connected
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-monastery-text-muted">
            <WifiOff size={10} />
            {isLoading ? 'Checking...' : 'Not connected'}
          </span>
        )}
      </div>

      {/* Hermes Connection Status */}
      {!isLoading && (
        <div className={`px-2 py-2 rounded-md text-[11px] leading-relaxed ${
          hermesConnected
            ? 'bg-green-400/5 border border-green-400/10'
            : 'bg-amber-400/5 border border-amber-400/10'
        }`}>
          {hermesConnected ? (
            <>
              <div className="flex items-center gap-1.5 text-green-400 font-medium">
                <Wifi size={10} />
                Connected to Hermes
              </div>
              <p className="text-monastery-text-muted mt-1">
                {defaultConnection.name} — {defaultConnection.base_url}
              </p>
              {defaultConnection.last_used_at && (
                <p className="text-monastery-text-muted mt-0.5">
                  Last used: {new Date(defaultConnection.last_used_at).toLocaleString()}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 text-amber-400 font-medium">
                <ExternalLink size={10} />
                No Hermes connection
              </div>
              <p className="text-monastery-text-muted mt-1">
                Connect a Hermes agent in Settings → Hermes Agent to enable agent runs.
              </p>
              <button
                onClick={() => {
                  // Open settings modal — dispatch custom event
                  window.dispatchEvent(new CustomEvent('monastery:open-settings', { detail: { tab: 'hermes' } }));
                }}
                className="flex items-center gap-1 mt-2 text-[10px] text-monastery-lantern hover:text-monastery-amber transition-colors"
              >
                <Settings size={10} />
                Open Settings
                <ChevronRight size={10} />
              </button>
            </>
          )}
        </div>
      )}

      {/* Agent Role Profiles */}
      <div>
        <div className="flex items-center gap-1.5 px-1 mb-2">
          <span className="text-[10px] font-medium text-monastery-text-muted uppercase tracking-wider">Agent Roles</span>
          <span className="text-[10px] text-monastery-text-muted">({agents.length})</span>
        </div>
        <div className="space-y-1">
          {agents.map(agent => (
            <div
              key={agent.id}
              className="px-2 py-2 rounded-md hover:bg-monastery-dark-surface transition-colors"
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
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-[9px] text-monastery-text-muted">
                      {hermesConnected ? '▶ Available via Hermes' : '⚡ Requires Hermes connection'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Connected instances */}
      {connections.length > 0 && (
        <div className="border-t border-monastery-dark-border pt-3">
          <div className="flex items-center gap-1.5 px-1 mb-2">
            <Wifi size={10} className="text-monastery-text-muted" />
            <span className="text-[10px] font-medium text-monastery-text-muted uppercase tracking-wider">Connections</span>
            <span className="text-[10px] text-monastery-text-muted">({connections.length})</span>
          </div>
          <div className="space-y-1">
            {connections.map(conn => (
              <div
                key={conn.id}
                className="px-2 py-1.5 rounded-md hover:bg-monastery-dark-surface transition-colors"
              >
                <div className="flex items-center gap-2">
                  {conn.is_default ? (
                    <Wifi size={10} className="text-green-400 flex-shrink-0" />
                  ) : (
                    <Wifi size={10} className="text-monastery-text-muted flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-monastery-text-primary truncate">{conn.name}</span>
                      {conn.is_default && (
                        <span className="text-[9px] text-green-400">default</span>
                      )}
                    </div>
                    <p className="text-[10px] text-monastery-text-muted truncate">{conn.base_url}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent dispatch note */}
      <div className="border-t border-monastery-dark-border pt-2">
        <p className="px-1 text-[10px] text-monastery-text-muted italic leading-relaxed">
          Agent roles dispatch to Hermes via REST API. Hermes runs the agent loop, tools, sub-agents,
          and model calls — Monastery provides the project context and file surface.
        </p>
      </div>
    </div>
  );
}
