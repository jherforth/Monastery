import { useState } from 'react';
import { GitBranch, Github, Gitlab, Server, Plus, Trash2, CheckCircle, XCircle, Loader2, ExternalLink, ChevronRight } from 'lucide-react';
import { useGitForge, GitForgeType, ConnectForgeRequest, GitConnection, GitRepo } from '../hooks/useGitForge';

type WizardStep = 'select' | 'url' | 'token' | 'verify';

interface ForgeTemplate {
  type: GitForgeType;
  label: string;
  icon: typeof Github;
  tokenUrl: string;
  scopes: string;
  exampleBaseUrl: string;
  color: string;
}

const FORGE_TEMPLATES: ForgeTemplate[] = [
  {
    type: 'github',
    label: 'GitHub',
    icon: Github,
    tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo&description=Monastery',
    scopes: 'repo (Full control of private repositories)',
    exampleBaseUrl: 'https://api.github.com',
    color: 'text-gray-300',
  },
  {
    type: 'gitlab',
    label: 'GitLab',
    icon: Gitlab,
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Monastery&scopes=api,read_user',
    scopes: 'api, read_user',
    exampleBaseUrl: 'https://gitlab.com/api/v4',
    color: 'text-orange-400',
  },
  {
    type: 'forgejo',
    label: 'Forgejo (Self-Hosted)',
    icon: Server,
    tokenUrl: '', // User provides their own URL
    scopes: 'repo (Read & Write repositories)',
    exampleBaseUrl: 'https://git.yourdomain.com',
    color: 'text-emerald-400',
  },
];

export function GitForgeSetup() {
  const { connections, connectForge, deleteConnection, testConnection, listRepos, pushProject } = useGitForge();
  const [step, setStep] = useState<WizardStep>('select');
  const [selectedForge, setSelectedForge] = useState<ForgeTemplate | null>(null);
  const [forgeUrl, setForgeUrl] = useState('');
  const [token, setToken] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ healthy: boolean; message: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetWizard = () => {
    setStep('select');
    setSelectedForge(null);
    setForgeUrl('');
    setToken('');
    setConnectionName('');
    setTestResult(null);
    setError(null);
  };

  const handleSelectForge = (forge: ForgeTemplate) => {
    setSelectedForge(forge);
    setConnectionName(`My ${forge.label}`);
    if (forge.type === 'forgejo') {
      setStep('url');
    } else {
      setForgeUrl(forge.exampleBaseUrl);
      setStep('token');
    }
  };

  const handleVerifyUrl = () => {
    if (!forgeUrl.trim()) {
      setError('Please enter your Forgejo instance URL');
      return;
    }
    setError(null);
    setStep('token');
  };

  const handleConnect = async () => {
    if (!selectedForge || !token.trim()) return;
    setConnecting(true);
    setError(null);

    try {
      const req: ConnectForgeRequest = {
        name: connectionName || `My ${selectedForge.label}`,
        forge_type: selectedForge.type,
        api_token: token.trim(),
        base_url: selectedForge.type === 'forgejo' ? forgeUrl.trim() : undefined,
      };
      await connectForge(req);
      resetWizard();
    } catch (e: any) {
      setError(e.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleTestConnection = async (id: string) => {
    setTesting(true);
    try {
      const result = await testConnection(id);
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ healthy: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Connected Forges List */}
      <div>
        <h3 className="text-sm font-medium text-monastery-text-secondary uppercase tracking-wider mb-3">
          Connected Forges
        </h3>
        {connections.length === 0 ? (
          <p className="text-sm text-monastery-text-muted italic">
            No Git forges connected yet. Connect one below to push and pull your AI-generated projects.
          </p>
        ) : (
          <div className="space-y-2">
            {connections.map((conn) => (
              <ConnectionCard
                key={conn.id}
                connection={conn}
                onDelete={() => deleteConnection(conn.id)}
                onTest={() => handleTestConnection(conn.id)}
                testResult={conn.id === testResult ? undefined /* not tracking per-id */ : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Wizard */}
      <div className="border-t border-monastery-dark-border pt-4">
        <h3 className="text-sm font-medium text-monastery-text-secondary uppercase tracking-wider mb-3">
          Connect a New Forge
        </h3>

        {/* Step 1: Select Forge */}
        {step === 'select' && (
          <div className="grid grid-cols-1 gap-2">
            {FORGE_TEMPLATES.map((forge) => (
              <button
                key={forge.type}
                onClick={() => handleSelectForge(forge)}
                className="flex items-center gap-3 p-3 rounded-lg bg-monastery-dark-surface border border-monastery-dark-border hover:border-monastery-pine-green transition-colors text-left"
              >
                <forge.icon className={`w-5 h-5 ${forge.color}`} />
                <div className="flex-1">
                  <div className="text-sm font-medium text-monastery-text-primary">{forge.label}</div>
                  <div className="text-xs text-monastery-text-muted">
                    {forge.type === 'forgejo' ? 'Your own self-hosted Git service' : `Connect to ${forge.label}.com`}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-monastery-text-muted" />
              </button>
            ))}
          </div>
        )}

        {/* Step 2: Forgejo URL */}
        {step === 'url' && selectedForge && (
          <div className="space-y-4">
            <div className="bg-monastery-dark-bg rounded-lg p-3 border border-monastery-dark-border">
              <p className="text-xs text-monastery-text-secondary leading-relaxed">
                Enter the full URL of your Forgejo instance. This must be reachable from the Monastery container
                (same Docker network or LAN).
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                Forgejo Instance URL
              </label>
              <input
                type="text"
                value={forgeUrl}
                onChange={(e) => setForgeUrl(e.target.value)}
                placeholder={FORGE_TEMPLATES[2].exampleBaseUrl}
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine-green focus:outline-none"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setStep('select')}
                className="px-3 py-1.5 text-xs text-monastery-text-secondary hover:text-monastery-text-primary"
              >
                Back
              </button>
              <button
                onClick={handleVerifyUrl}
                className="px-4 py-1.5 text-xs bg-monastery-pine-green text-white rounded-lg hover:bg-opacity-90"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Token Guide */}
        {step === 'token' && selectedForge && (
          <div className="space-y-4">
            <TokenGuide forge={selectedForge} baseUrl={forgeUrl} />

            <div>
              <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                Connection Name
              </label>
              <input
                type="text"
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine-green focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                Personal Access Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your token here..."
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine-green focus:outline-none"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-red-400 bg-red-400/10 rounded-lg p-2">
                <XCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => selectedForge.type === 'forgejo' ? setStep('url') : setStep('select')}
                className="px-3 py-1.5 text-xs text-monastery-text-secondary hover:text-monastery-text-primary"
              >
                Back
              </button>
              <button
                onClick={handleConnect}
                disabled={!token.trim() || connecting}
                className="px-4 py-1.5 text-xs bg-monastery-pine-green text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 flex items-center gap-2"
              >
                {connecting && <Loader2 className="w-3 h-3 animate-spin" />}
                Connect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TokenGuide({ forge, baseUrl }: { forge: ForgeTemplate; baseUrl: string }) {
  const tokenUrl = forge.type === 'forgejo'
    ? `${baseUrl}/user/settings/applications`
    : forge.tokenUrl;

  return (
    <div className="bg-monastery-dark-bg rounded-lg p-3 border border-monastery-dark-border space-y-2">
      <p className="text-xs font-medium text-monastery-text-primary">
        How to create a {forge.label} token:
      </p>
      <ol className="text-xs text-monastery-text-secondary space-y-1 list-decimal list-inside">
        <li>
          Go to{' '}
          <a
            href={tokenUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-monastery-lantern-gold hover:underline inline-flex items-center gap-1"
          >
            {forge.label} Token Settings <ExternalLink className="w-3 h-3" />
          </a>
        </li>
        <li>Create a new <strong>Personal Access Token</strong></li>
        <li>Select scopes: <code className="text-monastery-lantern-gold bg-monastery-dark-bg px-1 rounded">{forge.scopes}</code></li>
        <li>Copy the generated token and paste it below</li>
      </ol>
      {forge.type === 'forgejo' && (
        <div className="mt-2 p-2 bg-amber-400/10 border border-amber-400/20 rounded text-xs text-amber-300">
          <strong>Self-Hosted Note:</strong> Your Forgejo instance at <code className="text-amber-200">{baseUrl}</code> must
          be reachable from the Monastery container. If running in Docker, ensure both are on the same network.
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  connection,
  onDelete,
  onTest,
}: {
  connection: GitConnection;
  onDelete: () => void;
  onTest: () => void;
  testResult?: { healthy: boolean; message: string };
}) {
  const ForgeIcon = connection.forge_type === 'gitlab' ? Gitlab
    : connection.forge_type === 'forgejo' ? Server
    : Github;

  const forgeColor = connection.forge_type === 'gitlab' ? 'text-orange-400'
    : connection.forge_type === 'forgejo' ? 'text-emerald-400'
    : 'text-gray-300';

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-monastery-dark-surface border border-monastery-dark-border">
      <ForgeIcon className={`w-5 h-5 ${forgeColor} flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-monastery-text-primary truncate">{connection.name}</div>
        <div className="text-xs text-monastery-text-muted truncate">
          {connection.username || connection.forge_type} · {connection.base_url}
        </div>
      </div>
      <button
        onClick={onTest}
        className="p-1.5 text-xs text-monastery-text-secondary hover:text-monastery-lantern-gold transition-colors"
        title="Test connection"
      >
        <CheckCircle className="w-4 h-4" />
      </button>
      <button
        onClick={onDelete}
        className="p-1.5 text-xs text-monastery-text-secondary hover:text-red-400 transition-colors"
        title="Remove connection"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
