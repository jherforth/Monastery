import { useState } from 'react';
import { Server, Database, Cloud, Loader2, CheckCircle, XCircle, Trash2, AlertTriangle } from 'lucide-react';
import { useHostingServices, ConnectHostingRequest } from '../hooks/useHostingServices';
import type { HostingServiceConnection, HostingServiceType } from '../types';

interface ServiceTemplate {
  type: HostingServiceType;
  label: string;
  description: string;
  icon: typeof Server;
  color: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  hasEmail: boolean;
  /** Services with a well-known API base (e.g. Cloudflare) skip the URL input. */
  fixedBaseUrl?: string;
}

const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    type: 'dokploy',
    label: 'Dokploy',
    description: 'Self-hosted PaaS — deploy apps, databases, and Docker containers',
    icon: Server,
    color: 'text-blue-400',
    tokenLabel: 'API Token',
    tokenPlaceholder: 'Paste your Dokploy API token...',
    hasEmail: false,
  },
  {
    type: 'coolify',
    label: 'Coolify',
    description: 'Self-hosted deployment platform — Vercel/Netlify alternative',
    icon: Server,
    color: 'text-purple-400',
    tokenLabel: 'API Token',
    tokenPlaceholder: 'Paste your Coolify API token...',
    hasEmail: false,
  },
  {
    type: 'pocketbase',
    label: 'Pocketbase',
    description: 'Self-hosted backend — database, auth, file storage',
    icon: Database,
    color: 'text-amber-400',
    tokenLabel: 'Admin Password',
    tokenPlaceholder: 'Paste your admin password...',
    hasEmail: true,
  },
  {
    type: 'cloudflare',
    label: 'Cloudflare',
    description: 'Automates tunnel Public Hostnames + DNS on deploy — no more manual Zero Trust dashboard steps. Token needs: Account → Cloudflare Tunnel: Edit, Zone → DNS: Edit.',
    icon: Cloud,
    color: 'text-orange-400',
    tokenLabel: 'API Token',
    tokenPlaceholder: 'Paste your Cloudflare API token...',
    hasEmail: false,
    fixedBaseUrl: 'https://api.cloudflare.com/client/v4',
  },
];

export function HostingServicesTab() {
  const { connections, connectService, deleteConnection, testConnection } = useHostingServices();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { healthy: boolean; message: string }>>({});
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-service form state
  const [formState, setFormState] = useState<Record<string, { url: string; token: string; email: string; name: string }>>({
    dokploy: { url: '', token: '', email: '', name: 'My Dokploy' },
    coolify: { url: '', token: '', email: '', name: 'My Coolify' },
    pocketbase: { url: '', token: '', email: '', name: 'My Pocketbase' },
    cloudflare: { url: '', token: '', email: '', name: 'My Cloudflare' },
  });

  const handleFormChange = (serviceType: HostingServiceType, field: string, value: string) => {
    setFormState(prev => ({
      ...prev,
      [serviceType]: { ...prev[serviceType], [field]: value },
    }));
  };

  const handleConnect = async (template: ServiceTemplate) => {
    const form = formState[template.type];
    const baseUrl = template.fixedBaseUrl ?? form.url.trim();
    if (!baseUrl || !form.token.trim()) {
      setError(`Please provide both URL and ${template.tokenLabel.toLowerCase()} for ${template.label}`);
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      const req: ConnectHostingRequest = {
        name: form.name || `My ${template.label}`,
        service_type: template.type,
        base_url: baseUrl,
        api_token: form.token.trim(),
        email: template.hasEmail ? form.email.trim() || undefined : undefined,
      };
      await connectService(req);
      setFormState(prev => ({
        ...prev,
        [template.type]: { url: '', token: '', email: '', name: `My ${template.label}` },
      }));
    } catch (e: any) {
      setError(e.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testConnection(id);
      setTestResults(prev => ({ ...prev, [id]: result }));
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [id]: { healthy: false, message: e.message || 'Test failed' } }));
    } finally {
      setTestingId(null);
    }
  };

  const getConnection = (serviceType: HostingServiceType): HostingServiceConnection | undefined =>
    connections.find(c => c.service_type === serviceType);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-monastery-text-primary mb-1">Hosting Services</h3>
        <p className="text-sm text-monastery-text-secondary">
          Configure your self-hosted deployment platforms and backend services before running the wizard.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-400/10 rounded-lg p-3">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-4">
        {SERVICE_TEMPLATES.map((template) => {
          const existingConn = getConnection(template.type);
          const testResult = existingConn ? testResults[existingConn.id] : undefined;

          return (
            <div
              key={template.type}
              className="p-4 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg"
            >
              <div className="flex items-start gap-3 mb-3">
                <template.icon className={`w-5 h-5 ${template.color} flex-shrink-0 mt-0.5`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium text-monastery-text-primary text-sm">{template.label}</h4>
                    {existingConn && testResult && testResult.healthy ? (
                      <span className="px-2 py-0.5 text-xs bg-green-400/10 text-green-400 rounded flex items-center gap-1">
                        <CheckCircle size={12} />
                        Connected
                      </span>
                    ) : existingConn && testResult && !testResult.healthy ? (
                      <span className="px-2 py-0.5 text-xs bg-red-400/10 text-red-400 rounded flex items-center gap-1">
                        <XCircle size={12} />
                        Failed
                      </span>
                    ) : existingConn ? (
                      <span className="px-2 py-0.5 text-xs bg-amber-400/10 text-amber-400 rounded flex items-center gap-1">
                        <AlertTriangle size={12} />
                        Not Verified
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-monastery-text-muted mt-0.5">{template.description}</p>
                  {existingConn && (
                    <p className="text-xs text-monastery-text-secondary mt-1 truncate">
                      {existingConn.base_url}
                    </p>
                  )}
                </div>
              </div>

              {existingConn ? (
                /* Connected state — show actions */
                <div className="space-y-2">
                  {testResult && (
                    <div className={`p-2 rounded text-xs ${
                      testResult.healthy ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'
                    }`}>
                      {testResult.healthy ? '✓ Connection validated' : `✗ ${testResult.message}`}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTest(existingConn.id)}
                      disabled={testingId === existingConn.id}
                      className="px-3 py-1.5 text-xs bg-monastery-dark-tertiary text-monastery-text-primary rounded hover:bg-monastery-lantern hover:text-monastery-dark-bg transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {testingId === existingConn.id && <Loader2 className="w-3 h-3 animate-spin" />}
                      {testingId === existingConn.id ? 'Validating...' : 'Validate'}
                    </button>
                    <button
                      onClick={() => {
                        deleteConnection(existingConn.id);
                        // Clear test result
                        setTestResults(prev => {
                          const next = { ...prev };
                          delete next[existingConn.id];
                          return next;
                        });
                      }}
                      className="px-3 py-1.5 text-xs text-red-400 hover:bg-red-400/10 rounded transition-colors flex items-center gap-1.5"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                /* Not connected — show setup form */
                <div className="space-y-3">
                  {!template.fixedBaseUrl && (
                    <div>
                      <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                        Instance URL
                      </label>
                      <input
                        type="url"
                        value={formState[template.type].url}
                        onChange={e => handleFormChange(template.type, 'url', e.target.value)}
                        placeholder={`https://${template.type.toLowerCase()}.yourdomain.com`}
                        className="w-full px-3 py-2 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
                      />
                    </div>
                  )}

                  {template.hasEmail && (
                    <div>
                      <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                        Admin Email
                      </label>
                      <input
                        type="email"
                        value={formState[template.type].email}
                        onChange={e => handleFormChange(template.type, 'email', e.target.value)}
                        placeholder="admin@yourdomain.com"
                        className="w-full px-3 py-2 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                      {template.tokenLabel}
                    </label>
                    <input
                      type="password"
                      value={formState[template.type].token}
                      onChange={e => handleFormChange(template.type, 'token', e.target.value)}
                      placeholder={template.tokenPlaceholder}
                      className="w-full px-3 py-2 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
                    />
                  </div>

                  <button
                    onClick={() => handleConnect(template)}
                    disabled={connecting}
                    className="px-4 py-1.5 text-xs bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {connecting && <Loader2 className="w-3 h-3 animate-spin" />}
                    Connect
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
