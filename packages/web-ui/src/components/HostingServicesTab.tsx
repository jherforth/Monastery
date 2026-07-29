import { useState } from 'react';
import { Server, Database, Cloud, Loader2, CheckCircle, XCircle, Trash2, AlertTriangle, Plus, KeyRound } from 'lucide-react';
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
  const { connections, connectService, deleteConnection, testConnection, setTunnelToken } = useHostingServices();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { healthy: boolean; message: string }>>({});
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tunnel-token editor: each platform server runs its own tunnel, so tokens attach to
  // dokploy/coolify connections. '+' opens the picker; saving writes to the chosen connection.
  const [tokenFormOpen, setTokenFormOpen] = useState(false);
  const [tokenConnectionId, setTokenConnectionId] = useState('');
  const [tokenValue, setTokenValue] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const platformConns = connections.filter(c => c.service_type === 'dokploy' || c.service_type === 'coolify');

  const handleSaveTunnelToken = async () => {
    if (!tokenConnectionId || !tokenValue.trim()) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      await setTunnelToken(tokenConnectionId, tokenValue.trim());
      setTokenFormOpen(false);
      setTokenConnectionId('');
      setTokenValue('');
    } catch (e: any) {
      setTokenError(e.message || 'Failed to save tunnel token');
    } finally {
      setTokenBusy(false);
    }
  };

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

      {/* Cloudflare tunnel tokens — one per platform server (each server runs its own
          connector). Saved tokens are used automatically by deploys with the tunnel enabled,
          so nothing needs pasting in the wizard. */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-medium text-monastery-text-primary flex items-center gap-2">
            <KeyRound size={14} className="text-orange-400" /> Cloudflare Tunnel tokens
          </h4>
          <button
            onClick={() => { setTokenFormOpen(o => !o); setTokenError(null); }}
            disabled={platformConns.length === 0}
            className="p-1.5 text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-tertiary rounded-lg transition-colors disabled:opacity-40"
            title={platformConns.length === 0 ? 'Connect Dokploy or Coolify first' : 'Add a tunnel token'}
          >
            <Plus size={14} />
          </button>
        </div>
        <p className="text-xs text-monastery-text-muted mb-3">
          The connector token for the tunnel running on each platform's server. Deploys with the
          tunnel enabled use the saved token automatically — one per service.
        </p>

        {/* Saved tokens */}
        <div className="space-y-2">
          {platformConns.filter(c => c.has_tunnel_token).map(conn => (
            <div key={conn.id} className="flex items-center gap-2 p-2.5 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg">
              <Cloud size={14} className="text-orange-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-monastery-text-primary">{conn.name}</span>
                <span className="text-xs text-monastery-text-muted ml-2">({conn.service_type})</span>
                <span className="text-xs text-monastery-text-muted ml-2 font-mono">token saved ••••</span>
              </div>
              <button
                onClick={() => { setTokenConnectionId(conn.id); setTokenValue(''); setTokenFormOpen(true); setTokenError(null); }}
                className="px-2 py-1 text-xs text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-tertiary rounded transition-colors"
              >
                Replace
              </button>
              <button
                onClick={() => setTunnelToken(conn.id, null).catch(e => setTokenError(e.message))}
                className="px-2 py-1 text-xs text-red-400 hover:bg-red-400/10 rounded transition-colors flex items-center gap-1"
              >
                <Trash2 size={12} /> Remove
              </button>
            </div>
          ))}
          {platformConns.every(c => !c.has_tunnel_token) && !tokenFormOpen && (
            <p className="text-xs text-monastery-text-muted italic">
              No tunnel tokens saved yet{platformConns.length === 0 ? ' — connect Dokploy or Coolify above first' : ''}.
            </p>
          )}
        </div>

        {/* Add / replace form */}
        {tokenFormOpen && (
          <div className="mt-3 p-3 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg space-y-3">
            <div>
              <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Service</label>
              <select
                value={tokenConnectionId}
                onChange={e => setTokenConnectionId(e.target.value)}
                className="w-full px-3 py-2 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none"
              >
                <option value="">— select service —</option>
                {platformConns.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.service_type}){c.has_tunnel_token ? ' — replaces saved token' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Tunnel Token</label>
              <input
                type="password"
                value={tokenValue}
                onChange={e => setTokenValue(e.target.value)}
                placeholder="Paste the cloudflared connector token..."
                className="w-full px-3 py-2 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
              />
              <p className="text-xs text-monastery-text-muted mt-1">
                Cloudflare Zero Trust → Networks → Tunnels → the tunnel on this server → Configure → copy token.
              </p>
            </div>
            {tokenError && <p className="text-xs text-red-400">{tokenError}</p>}
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveTunnelToken}
                disabled={tokenBusy || !tokenConnectionId || !tokenValue.trim()}
                className="px-4 py-1.5 text-xs bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 flex items-center gap-1.5"
              >
                {tokenBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                Save token
              </button>
              <button
                onClick={() => { setTokenFormOpen(false); setTokenError(null); }}
                className="px-3 py-1.5 text-xs text-monastery-text-secondary hover:text-monastery-text-primary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
