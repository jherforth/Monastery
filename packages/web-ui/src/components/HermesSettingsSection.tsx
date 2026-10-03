// HIDDEN since simplification Phase 1 (docs/SIMPLIFICATION_PLAN.md): Hermes is no longer part of
// the chat loop, so this Settings section is not rendered anywhere. Kept intact (connections stay
// in the DB, backend routes still work) until Phase 3 deletes it for good.
import { useState } from 'react';
import { Bot, Star, Wifi, Trash2 } from 'lucide-react';
import { useHermesAgent } from '../hooks/useHermesAgent';
import { ConnectionForm } from './ui/ConnectionForm';
import { ConnectionCard } from './ui/ConnectionCard';
import { StatusBadge } from './ui/StatusBadge';
import { useDialogs } from './ui/dialogs';

// ============================================================
// Hermes Agent — agent runtime connections
// ============================================================

export function HermesSection() {
  const {
    connections,
    isLoading,
    createConnection,
    deleteConnection,
    testConnection,
    setDefault,
  } = useHermesAgent();
  const { confirm } = useDialogs();
  const [addError, setAddError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; status: number; error?: string }>>({});

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testConnection(id);
      setTestResults(prev => ({ ...prev, [id]: result }));
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [id]: { success: false, status: 0, error: err.message } }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-sm font-medium text-monastery-text-secondary uppercase tracking-wider mb-3">
          Connected Agents
        </h3>
        {isLoading ? (
          <p className="text-sm text-monastery-text-muted">Loading…</p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-monastery-text-muted italic">No Hermes connections yet. Add one below.</p>
        ) : (
          <div className="space-y-2">
            {connections.map(conn => (
              <ConnectionCard
                key={conn.id}
                icon={<Bot size={18} className="text-monastery-lantern" />}
                title={conn.name}
                subtitle={`${conn.base_url}${conn.last_used_at ? ` · last used ${new Date(conn.last_used_at).toLocaleString()}` : ''}`}
                badges={conn.is_default ? <StatusBadge variant="success">default</StatusBadge> : undefined}
                testResult={testResults[conn.id] !== undefined
                  ? {
                      ok: testResults[conn.id].success,
                      message: testResults[conn.id].success
                        ? '✓ Connection successful'
                        : `✗ ${testResults[conn.id].error || `HTTP ${testResults[conn.id].status}`}`,
                    }
                  : null}
                actions={[
                  ...(!conn.is_default
                    ? [{ label: 'Set default', icon: <Star size={12} />, onClick: () => setDefault(conn.id) }]
                    : []),
                  { label: 'Test', icon: <Wifi size={12} />, onClick: () => handleTest(conn.id), busy: testingId === conn.id },
                  {
                    label: 'Delete', icon: <Trash2 size={12} />, danger: true,
                    onClick: async () => {
                      if (!await confirm({ title: 'Delete Hermes connection?', message: `Delete Hermes connection "${conn.name}"?`, danger: true, confirmLabel: 'Delete' })) return;
                      await deleteConnection(conn.id);
                    },
                  },
                ]}
              />
            ))}
          </div>
        )}
      </section>

      <section className="border-t border-monastery-dark-border pt-5">
        <h3 className="text-sm font-medium text-monastery-text-secondary uppercase tracking-wider mb-3">
          Connect Hermes Agent
        </h3>
        <p className="text-sm text-monastery-text-secondary mb-4">
          Point Monastery at your Hermes agent's REST API. Hermes handles the agent loop, tools,
          and sub-agents — Monastery provides the project context and file surface.
        </p>
        <ConnectionForm
          error={addError}
          submitLabel="Connect Hermes"
          fields={[
            { key: 'name', label: 'Name', placeholder: 'e.g., Home Lab Hermes', required: true },
            { key: 'base_url', label: 'Base URL', type: 'url', placeholder: 'http://localhost:8642', required: true,
              help: 'Hermes REST API runs on port 8642 by default. Use host.docker.internal for Docker.' },
            { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'hermes-api-key-...', required: true,
              help: 'Your Hermes API key from ~/.hermes/.env or config.' },
          ]}
          onSubmit={async (v) => {
            setAddError(null);
            try {
              await createConnection(v.name, v.base_url, v.api_key);
            } catch (err: any) {
              setAddError(err.message || 'Failed to add connection');
              throw err;
            }
          }}
        />
      </section>
    </div>
  );
}
