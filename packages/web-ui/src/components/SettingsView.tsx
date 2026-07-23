import { useState, useEffect } from 'react';
import { Cpu, GitBranch, Server, Bot, X, Star, Wifi, Trash2, CheckCircle } from 'lucide-react';
import { useEndpoints } from '../hooks/useEndpoints';
import { useHermesAgent } from '../hooks/useHermesAgent';
import { useAppStore } from '../store/useAppStore';
import { GitForgeSetup } from './GitForgeSetup';
import { HostingServicesTab } from './HostingServicesTab';
import { ConnectionForm } from './ui/ConnectionForm';
import { ConnectionCard } from './ui/ConnectionCard';
import { StatusBadge } from './ui/StatusBadge';
import { useDialogs } from './ui/dialogs';

/** Section ids keep the legacy tab names — the monastery:open-settings event contract. */
export type SettingsTab = 'llm' | 'git' | 'hosting' | 'hermes';

interface SettingsViewProps {
  isOpen: boolean;
  onClose: () => void;
  /** Section to show when the view opens (deep link, e.g. from "Open Settings" buttons). */
  initialTab?: SettingsTab;
}

const SECTIONS: Array<{ id: SettingsTab; label: string; icon: typeof Cpu; blurb: string }> = [
  { id: 'llm', label: 'Models', icon: Cpu, blurb: 'LLM endpoints Monastery can chat through' },
  { id: 'hermes', label: 'Hermes Agent', icon: Bot, blurb: 'Agent runtime for Agent mode and roles' },
  { id: 'git', label: 'Git Forges', icon: GitBranch, blurb: 'GitHub, GitLab, Forgejo, Gitea' },
  { id: 'hosting', label: 'Hosting', icon: Server, blurb: 'Dokploy, Coolify, Pocketbase' },
];

/**
 * Settings is a full-screen sectioned view (not a cramped modal): one home for every
 * connection type, each section built on the shared ConnectionForm/Card primitives.
 */
export function SettingsView({ isOpen, onClose, initialTab }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsTab>('llm');

  // Honor deep links each time the view opens with a requested section.
  useEffect(() => {
    if (isOpen && initialTab) setSection(initialTab);
  }, [isOpen, initialTab]);

  // Escape closes, like any full-screen view.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const active = SECTIONS.find(s => s.id === section)!;

  return (
    <div className="fixed inset-0 z-40 bg-monastery-dark-bg flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-monastery-dark-border shrink-0">
        <div>
          <h2 className="text-lg font-semibold text-monastery-text-primary">Settings</h2>
          <p className="text-xs text-monastery-text-muted">{active.blurb}</p>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-monastery-dark-surface rounded-lg transition-colors text-monastery-text-secondary"
          title="Close settings (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Section nav */}
        <nav className="w-52 border-r border-monastery-dark-border p-3 space-y-1 shrink-0">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  section === s.id
                    ? 'bg-monastery-dark-surface text-monastery-text-primary font-medium'
                    : 'text-monastery-text-secondary hover:bg-monastery-dark-surface hover:text-monastery-text-primary'
                }`}
              >
                <Icon size={15} className={section === s.id ? 'text-monastery-lantern' : ''} />
                {s.label}
              </button>
            );
          })}
        </nav>

        {/* Section content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl">
            {section === 'llm' && <ModelsSection />}
            {section === 'hermes' && <HermesSection />}
            {section === 'git' && <GitForgeSetup />}
            {section === 'hosting' && <HostingServicesTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Models — LLM endpoints
// ============================================================

function ModelsSection() {
  const { endpoints, isLoading, addEndpoint, deleteEndpoint, testEndpoint, mutate } = useEndpoints();
  const setActiveEndpoint = useAppStore(s => s.setActiveEndpoint);
  const { confirm } = useDialogs();
  const [addError, setAddError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { is_healthy: boolean; message: string }>>({});

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testEndpoint(id);
      setTestResults(prev => ({ ...prev, [id]: { is_healthy: result.is_healthy, message: result.message } }));
      if (result.is_healthy) {
        const ep = endpoints.find(e => e.id === id);
        if (ep) setActiveEndpoint({ id: ep.id, name: ep.name });
      }
    } catch (error) {
      setTestResults(prev => ({ ...prev, [id]: { is_healthy: false, message: error instanceof Error ? error.message : 'Request failed' } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!await confirm({ title: 'Delete endpoint?', message: 'Are you sure you want to delete this endpoint?', danger: true, confirmLabel: 'Delete' })) return;
    try {
      await deleteEndpoint(id);
      await mutate();
    } catch (error) {
      console.error('Failed to delete endpoint:', error);
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-sm font-medium text-monastery-text-secondary uppercase tracking-wider mb-3">
          Configured Endpoints
        </h3>
        {isLoading ? (
          <p className="text-sm text-monastery-text-muted">Loading…</p>
        ) : endpoints.length === 0 ? (
          <p className="text-sm text-monastery-text-muted italic">No endpoints configured. Add one below to get started.</p>
        ) : (
          <div className="space-y-2">
            {endpoints.map(ep => (
              <ConnectionCard
                key={ep.id}
                icon={<Cpu size={18} className="text-monastery-lantern" />}
                title={ep.name}
                subtitle={ep.base_url}
                badges={
                  <>
                    {ep.is_local && <StatusBadge variant="muted">local</StatusBadge>}
                    {ep.is_favorite && <span className="text-monastery-lantern text-xs">★</span>}
                  </>
                }
                testResult={testResults[ep.id] !== undefined
                  ? { ok: testResults[ep.id].is_healthy, message: testResults[ep.id].is_healthy ? '✓ Connection successful' : `✗ ${testResults[ep.id].message}` }
                  : null}
                actions={[
                  { label: 'Validate', icon: <CheckCircle size={12} />, onClick: () => handleTest(ep.id), busy: testingId === ep.id },
                  { label: 'Delete', icon: <Trash2 size={12} />, onClick: () => handleDelete(ep.id), danger: true },
                ]}
              />
            ))}
          </div>
        )}
      </section>

      <section className="border-t border-monastery-dark-border pt-5">
        <h3 className="text-sm font-medium text-monastery-text-secondary uppercase tracking-wider mb-3">
          Add New Endpoint
        </h3>
        <ConnectionForm
          error={addError}
          submitLabel="Add Endpoint"
          fields={[
            { key: 'name', label: 'Name', placeholder: 'e.g., My Ollama Server', required: true },
            { key: 'base_url', label: 'Base URL', type: 'url', placeholder: 'e.g., http://localhost:11434', required: true,
              help: 'For local services, use http://host.docker.internal:PORT in Docker' },
            { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'sk-...',
              help: 'Required for cloud providers like OpenAI, not needed for local Ollama' },
          ]}
          onSubmit={async (v) => {
            setAddError(null);
            try {
              const added = await addEndpoint({ name: v.name, base_url: v.base_url, api_key: v.api_key || undefined });
              setActiveEndpoint({ id: added.id, name: added.name });
              await mutate();
            } catch (e) {
              setAddError('Failed to add endpoint. Please check the URL and try again.');
              throw e;
            }
          }}
        />
      </section>
    </div>
  );
}

// ============================================================
// Hermes Agent — agent runtime connections
// ============================================================

function HermesSection() {
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
