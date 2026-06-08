import { useState } from 'react';
import { useEndpoints, EndpointConfig } from '../hooks/useEndpoints';
import { GitForgeSetup } from './GitForgeSetup';
import { useAppStore } from '../store/useAppStore';
import { Cpu, GitBranch } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SettingsTab = 'llm' | 'git';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
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
      alert('Failed to add endpoint. Please check the URL and try again.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this endpoint?')) return;
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
                              {testingId === endpoint.id ? 'Testing...' : 'Test'}
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
