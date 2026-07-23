import { useState, useEffect } from 'react';
import { useEndpoints } from '../hooks/useEndpoints';
import { GitForgeSetup } from './GitForgeSetup';
import { HostingServicesTab } from './HostingServicesTab';
import { useHermesAgent } from '../hooks/useHermesAgent';
import { useAppStore } from '../store/useAppStore';
import { useDialogs } from './ui/dialogs';
import { Cpu, GitBranch, Server, Bot, Trash2, Wifi, Star } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab to show when the modal opens (deep link, e.g. from "Open Settings" buttons). */
  initialTab?: SettingsTab;
}

export type SettingsTab = 'llm' | 'git' | 'hosting' | 'hermes';

export function SettingsModal({ isOpen, onClose, initialTab }: SettingsModalProps) {
  const { endpoints, isLoading, addEndpoint, deleteEndpoint, testEndpoint, mutate } = useEndpoints();
  const setActiveEndpoint = useAppStore(s => s.setActiveEndpoint);
  const [newEndpoint, setNewEndpoint] = useState({
    name: '',
    base_url: '',
    api_key: '',
  });
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { is_healthy: boolean; message: string }>>({});
  const [activeTab, setActiveTab] = useState<SettingsTab>('llm');

  // Hermes connection state
  const {
    connections: hermesConnections,
    isLoading: hermesLoading,
    createConnection: createHermes,
    deleteConnection: deleteHermes,
    testConnection: testHermes,
    setDefault: setHermesDefault,
  } = useHermesAgent();
  const [newHermes, setNewHermes] = useState({ name: '', base_url: '', api_key: '' });
  const [hermesTestingId, setHermesTestingId] = useState<string | null>(null);
  const [hermesTestResults, setHermesTestResults] = useState<Record<string, { success: boolean; status: number; error?: string }>>({});
  const [hermesError, setHermesError] = useState<string | null>(null);
  const { confirm: confirmDialog, notice } = useDialogs();

  // Honor deep links each time the modal opens with a requested tab.
  useEffect(() => {
    if (isOpen && initialTab) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const added = await addEndpoint({
        name: newEndpoint.name,
        base_url: newEndpoint.base_url,
        api_key: newEndpoint.api_key || undefined,
      });
      setNewEndpoint({ name: '', base_url: '', api_key: '' });
      setActiveEndpoint({ id: added.id, name: added.name });
      await mutate();
    } catch (error) {
      console.error('Failed to add endpoint:', error);
      notice({ title: 'Failed to add endpoint', message: 'Please check the URL and try again.' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!await confirmDialog({ title: 'Delete endpoint?', message: 'Are you sure you want to delete this endpoint?', danger: true, confirmLabel: 'Delete' })) return;
    try {
      await deleteEndpoint(id);
      await mutate();
    } catch (error) {
      console.error('Failed to delete endpoint:', error);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testEndpoint(id);
      setTestResults(prev => ({ ...prev, [id]: { is_healthy: result.is_healthy, message: result.message } }));
      if (result.is_healthy) {
        // Find the endpoint name from the list
        const ep = endpoints.find(e => e.id === id);
        if (ep) {
          setActiveEndpoint({ id: ep.id, name: ep.name });
        }
      }
    } catch (error) {
      console.error('Failed to test endpoint:', error);
      setTestResults(prev => ({ ...prev, [id]: { is_healthy: false, message: error instanceof Error ? error.message : 'Request failed' } }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div 
        className="bg-monastery-dark-surface rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 border-b border-monastery-dark-border shrink-0">
          <h2 className="text-xl font-semibold text-monastery-text-primary">Settings</h2>
          <p className="text-sm text-monastery-text-secondary mt-1">
            Configure LLM endpoints, Git forges, and integrations
          </p>

          {/* Tab Navigation */}
          <div className="flex gap-1 mt-4 bg-monastery-dark-bg rounded-lg p-1">
            <button
              onClick={() => setActiveTab('llm')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'llm'
                  ? 'bg-monastery-dark-surface text-monastery-text-primary'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              <Cpu className="w-4 h-4" />
              LLM Endpoints
            </button>
            <button
              onClick={() => setActiveTab('git')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'git'
                  ? 'bg-monastery-dark-surface text-monastery-text-primary'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              <GitBranch className="w-4 h-4" />
              Git Forges
            </button>
            <button
              onClick={() => setActiveTab('hosting')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'hosting'
                  ? 'bg-monastery-dark-surface text-monastery-text-primary'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              <Server className="w-4 h-4" />
              Hosting Services
            </button>
            <button
              onClick={() => setActiveTab('hermes')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'hermes'
                  ? 'bg-monastery-dark-surface text-monastery-text-primary'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              <Bot className="w-4 h-4" />
              Hermes Agent
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {activeTab === 'llm' ? (
            <>
              {/* Add New Endpoint */}
              <form onSubmit={handleSubmit} className="mb-8">
                <h3 className="text-lg font-medium text-monastery-text-primary mb-4">Add New Endpoint</h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-monastery-text-secondary mb-1">
                      Name
                    </label>
                    <input
                      type="text"
                      value={newEndpoint.name}
                      onChange={e => setNewEndpoint(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="e.g., My Ollama Server"
                      className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-md text-monastery-text-primary focus:outline-none focus:border-monastery-lantern"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-monastery-text-secondary mb-1">
                      Base URL
                    </label>
                    <input
                      type="url"
                      value={newEndpoint.base_url}
                      onChange={e => setNewEndpoint(prev => ({ ...prev, base_url: e.target.value }))}
                      placeholder="e.g., http://localhost:11434"
                      className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-md text-monastery-text-primary focus:outline-none focus:border-monastery-lantern"
                      required
                    />
                    <p className="text-xs text-monastery-text-secondary mt-1">
                      For local services, use http://host.docker.internal:PORT in Docker
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-monastery-text-secondary mb-1">
                      API Key (Optional)
                    </label>
                    <input
                      type="password"
                      value={newEndpoint.api_key}
                      onChange={e => setNewEndpoint(prev => ({ ...prev, api_key: e.target.value }))}
                      placeholder="sk-..."
                      className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-md text-monastery-text-primary focus:outline-none focus:border-monastery-lantern"
                    />
                    <p className="text-xs text-monastery-text-secondary mt-1">
                      Required for cloud providers like OpenAI, not needed for local Ollama
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="px-4 py-2 bg-monastery-lantern text-monastery-dark-bg rounded-md font-medium hover:opacity-90 transition-opacity"
                  >
                    Add Endpoint
                  </button>
                </div>
              </form>

              {/* Existing Endpoints */}
              <div>
                <h3 className="text-lg font-medium text-monastery-text-primary mb-4">Configured Endpoints</h3>
                
                {isLoading ? (
                  <div className="text-center py-8 text-monastery-text-secondary">Loading...</div>
                ) : endpoints.length === 0 ? (
                  <div className="text-center py-8 text-monastery-text-secondary">
                    No endpoints configured. Add one above to get started.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {endpoints.map((endpoint) => (
                      <div
                        key={endpoint.id}
                        className="p-4 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-monastery-text-primary">{endpoint.name}</h4>
                              {endpoint.is_local && (
                                <span className="px-2 py-0.5 text-xs bg-monastery-dark-tertiary text-monastery-text-secondary rounded">
                                  Local
                                </span>
                              )}
                              {endpoint.is_favorite && (
                                <span className="text-monastery-lantern">★</span>
                              )}
                            </div>
                            <p className="text-sm text-monastery-text-secondary mt-1">{endpoint.base_url}</p>
                            
                            {testResults[endpoint.id] !== undefined && (
                              <div className={`mt-2 p-2 rounded text-xs ${testResults[endpoint.id].is_healthy ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
                                {testResults[endpoint.id].is_healthy ? '✓ Connection successful' : `✗ ${testResults[endpoint.id].message}`}
                              </div>
                            )}
                          </div>
                          
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleTest(endpoint.id)}
                              disabled={testingId === endpoint.id}
                              className="px-3 py-1.5 text-sm bg-monastery-dark-tertiary text-monastery-text-primary rounded hover:bg-monastery-lantern hover:text-monastery-dark-bg transition-colors disabled:opacity-50"
                            >
                              {testingId === endpoint.id ? 'Validating...' : 'Validate'}
                            </button>
                            <button
                              onClick={() => handleDelete(endpoint.id)}
                              className="px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 rounded transition-colors"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : activeTab === 'hosting' ? (
            <HostingServicesTab />
          ) : activeTab === 'hermes' ? (
            <>
              {/* Add New Hermes Connection */}
              <form onSubmit={async (e) => {
                e.preventDefault();
                setHermesError(null);
                try {
                  await createHermes(newHermes.name, newHermes.base_url, newHermes.api_key);
                  setNewHermes({ name: '', base_url: '', api_key: '' });
                } catch (err: any) {
                  setHermesError(err.message || 'Failed to add connection');
                }
              }} className="mb-8">
                <h3 className="text-lg font-medium text-monastery-text-primary mb-4">Connect Hermes Agent</h3>
                <p className="text-sm text-monastery-text-secondary mb-4">
                  Point Monastery at your Hermes agent's REST API. Hermes handles the agent loop, tools,
                  and sub-agents — Monastery provides the project context and file surface.
                </p>

                {hermesError && (
                  <div className="mb-4 p-3 bg-red-400/10 border border-red-400/20 rounded text-sm text-red-400">
                    {hermesError}
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-monastery-text-secondary mb-1">
                      Name
                    </label>
                    <input
                      type="text"
                      value={newHermes.name}
                      onChange={e => setNewHermes(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="e.g., Home Lab Hermes"
                      className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-md text-monastery-text-primary focus:outline-none focus:border-monastery-lantern"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-monastery-text-secondary mb-1">
                      Base URL
                    </label>
                    <input
                      type="url"
                      value={newHermes.base_url}
                      onChange={e => setNewHermes(prev => ({ ...prev, base_url: e.target.value }))}
                      placeholder="http://localhost:8642"
                      className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-md text-monastery-text-primary focus:outline-none focus:border-monastery-lantern"
                      required
                    />
                    <p className="text-xs text-monastery-text-secondary mt-1">
                      Hermes REST API runs on port 8642 by default. Use host.docker.internal for Docker.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-monastery-text-secondary mb-1">
                      API Key
                    </label>
                    <input
                      type="password"
                      value={newHermes.api_key}
                      onChange={e => setNewHermes(prev => ({ ...prev, api_key: e.target.value }))}
                      placeholder="hermes-api-key-..."
                      className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-md text-monastery-text-primary focus:outline-none focus:border-monastery-lantern"
                      required
                    />
                    <p className="text-xs text-monastery-text-secondary mt-1">
                      Your Hermes API key from <code className="text-monastery-lantern">~/.hermes/.env</code> or config.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="px-4 py-2 bg-monastery-lantern text-monastery-dark-bg rounded-md font-medium hover:opacity-90 transition-opacity"
                  >
                    Connect Hermes
                  </button>
                </div>
              </form>

              {/* Existing Hermes Connections */}
              <div>
                <h3 className="text-lg font-medium text-monastery-text-primary mb-4">Connected Agents</h3>

                {hermesLoading ? (
                  <div className="text-center py-8 text-monastery-text-secondary">Loading...</div>
                ) : hermesConnections.length === 0 ? (
                  <div className="text-center py-8 text-monastery-text-secondary">
                    No Hermes connections yet. Add one above.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {hermesConnections.map((conn) => (
                      <div
                        key={conn.id}
                        className="p-4 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-monastery-text-primary">{conn.name}</h4>
                              {conn.is_default && (
                                <span className="px-2 py-0.5 text-xs bg-monastery-lantern/20 text-monastery-lantern rounded">
                                  Default
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-monastery-text-secondary mt-1">{conn.base_url}</p>
                            {conn.last_used_at && (
                              <p className="text-xs text-monastery-text-muted mt-1">
                                Last used: {new Date(conn.last_used_at).toLocaleString()}
                              </p>
                            )}

                            {hermesTestResults[conn.id] !== undefined && (
                              <div className={`mt-2 p-2 rounded text-xs ${
                                hermesTestResults[conn.id].success
                                  ? 'bg-green-400/10 text-green-400'
                                  : 'bg-red-400/10 text-red-400'
                              }`}>
                                {hermesTestResults[conn.id].success
                                  ? '✓ Connection successful'
                                  : `✗ ${hermesTestResults[conn.id].error || `HTTP ${hermesTestResults[conn.id].status}`}`}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {!conn.is_default && (
                              <button
                                onClick={() => setHermesDefault(conn.id)}
                                className="px-2 py-1.5 text-xs bg-monastery-dark-tertiary text-monastery-text-secondary rounded hover:text-monastery-lantern transition-colors"
                                title="Set as default"
                              >
                                <Star className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={async () => {
                                setHermesTestingId(conn.id);
                                try {
                                  const result = await testHermes(conn.id);
                                  setHermesTestResults(prev => ({ ...prev, [conn.id]: result }));
                                } catch (err: any) {
                                  setHermesTestResults(prev => ({
                                    ...prev,
                                    [conn.id]: { success: false, status: 0, error: err.message },
                                  }));
                                } finally {
                                  setHermesTestingId(null);
                                }
                              }}
                              disabled={hermesTestingId === conn.id}
                              className="px-3 py-1.5 text-sm bg-monastery-dark-tertiary text-monastery-text-primary rounded hover:bg-monastery-lantern hover:text-monastery-dark-bg transition-colors disabled:opacity-50"
                            >
                              <Wifi className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={async () => {
                                if (!await confirmDialog({ title: 'Delete Hermes connection?', message: `Delete Hermes connection "${conn.name}"?`, danger: true, confirmLabel: 'Delete' })) return;
                                await deleteHermes(conn.id);
                              }}
                              className="px-2 py-1.5 text-xs text-red-500 hover:bg-red-500/10 rounded transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <GitForgeSetup />
          )}
        </div>

        <div className="p-6 border-t border-monastery-dark-border flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-monastery-dark-tertiary text-monastery-text-primary rounded-md hover:bg-monastery-lantern hover:text-monastery-dark-bg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
