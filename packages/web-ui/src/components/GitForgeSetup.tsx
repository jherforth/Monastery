import { useState } from 'react';
import { GitBranch, Github, Gitlab, Server, Plus, Trash2, CheckCircle, XCircle, Loader2, ExternalLink, ChevronRight, FolderGit2, Upload, Download, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { useGitForge, GitForgeType, ConnectForgeRequest, GitConnection, GitRepo } from '../hooks/useGitForge';
import type { GitBranchInfo } from '../hooks/useGitForge';
import { useAppStore } from '../store/useAppStore';

type WizardStep = 'select' | 'url' | 'token' | 'verify';
type ViewMode = 'list' | 'browse' | 'push';

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
  const { connections, connectForge, deleteConnection, testConnection, listRepos, listBranches, pushProject, cloneRepo } = useGitForge();
  const { setCurrentProject } = useAppStore();
  const [step, setStep] = useState<WizardStep>('select');
  const [selectedForge, setSelectedForge] = useState<ForgeTemplate | null>(null);
  const [forgeUrl, setForgeUrl] = useState('');
  const [token, setToken] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ healthy: boolean; message: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repo browser state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [activeConnection, setActiveConnection] = useState<GitConnection | null>(null);
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [cloningId, setCloningId] = useState<number | null>(null);
  const [cloneResult, setCloneResult] = useState<string | null>(null);
  
  // Per-repo branch selection: repo id -> branch name
  const [selectedBranches, setSelectedBranches] = useState<Record<number, string>>({});
  // Branches for each repo: repo id -> branch list
  const [branchesByRepo, setBranchesByRepo] = useState<Record<number, GitBranchInfo[]>>({});
  const [loadingBranchesFor, setLoadingBranchesFor] = useState<number | null>(null);

  // Push form state
  const [pushRepoName, setPushRepoName] = useState('');
  const [pushDescription, setPushDescription] = useState('');
  const [pushPrivate, setPushPrivate] = useState(true);
  const [pushBranch, setPushBranch] = useState('main');
  const [pushMessage, setPushMessage] = useState('Initial commit from Monastery');
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);

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

  const handleBrowseRepos = async (connection: GitConnection) => {
    setActiveConnection(connection);
    setViewMode('browse');
    setLoadingRepos(true);
    setRepoError(null);
    setRepos([]);
    try {
      const repoList = await listRepos(connection.id);
      setRepos(repoList);
    } catch (e: any) {
      setRepoError(e.message || 'Failed to load repositories');
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleClone = async (repo: GitRepo) => {
    if (!activeConnection) return;
    setCloningId(repo.id);
    setCloneResult(null);
    const branch = selectedBranches[repo.id] || repo.default_branch;
    try {
      const result = await cloneRepo({
        connection_id: activeConnection.id,
        repo_full_name: repo.full_name,
        branch: branch || undefined,
      });
      setCloneResult(`Cloned "${result.project_name}" (${branch}) to ${result.project_path}`);
      // Set as current project so files appear in sidebar
      setCurrentProject({
        id: result.project_id,
        name: result.project_name,
        path: result.project_path,
        lastOpened: Date.now(),
        files: [],
      });
    } catch (e: any) {
      setCloneResult(`Clone failed: ${e.message}`);
    } finally {
      setCloningId(null);
    }
  };

  const handleFetchBranches = async (repo: GitRepo) => {
    if (!activeConnection) return;
    // Toggle: if already loaded, collapse
    if (branchesByRepo[repo.id]) {
      const newBranches = { ...branchesByRepo };
      delete newBranches[repo.id];
      setBranchesByRepo(newBranches);
      return;
    }
    setLoadingBranchesFor(repo.id);
    try {
      const branches = await listBranches(activeConnection.id, repo.full_name);
      setBranchesByRepo(prev => ({ ...prev, [repo.id]: branches }));
      // Auto-select default branch
      if (!selectedBranches[repo.id]) {
        const defaultBranch = branches.find(b => b.is_default)?.name || repo.default_branch;
        setSelectedBranches(prev => ({ ...prev, [repo.id]: defaultBranch }));
      }
    } catch (e: any) {
      console.error('Failed to fetch branches:', e);
    } finally {
      setLoadingBranchesFor(null);
    }
  };

  const handleOpenPush = (connection: GitConnection) => {
    setActiveConnection(connection);
    setViewMode('push');
    setPushResult(null);
    setPushRepoName('');
    setPushDescription('');
    setPushPrivate(true);
    setPushBranch('main');
    setPushMessage('Initial commit from Monastery');
  };

  const handlePush = async () => {
    if (!activeConnection || !pushRepoName.trim()) return;
    setPushing(true);
    setPushResult(null);
    try {
      const result = await pushProject({
        connection_id: activeConnection.id,
        repo_name: pushRepoName.trim(),
        repo_description: pushDescription.trim() || undefined,
        private: pushPrivate,
        branch: pushBranch.trim() || 'main',
        commit_message: pushMessage.trim() || undefined,
      });
      setPushResult(`Pushed to ${result.repo_url} (branch: ${result.branch})`);
    } catch (e: any) {
      setPushResult(`Push failed: ${e.message}`);
    } finally {
      setPushing(false);
    }
  };

  const backToList = () => {
    setViewMode('list');
    setActiveConnection(null);
    setRepos([]);
    setRepoError(null);
    setCloneResult(null);
    setPushResult(null);
  };

  return (
    <div className="space-y-6">
      {/* Repo Browser View */}
      {viewMode === 'browse' && activeConnection && (
        <RepoBrowser
          connection={activeConnection}
          repos={repos}
          loading={loadingRepos}
          error={repoError}
          cloningId={cloningId}
          cloneResult={cloneResult}
          selectedBranches={selectedBranches}
          branchesByRepo={branchesByRepo}
          loadingBranchesFor={loadingBranchesFor}
          onSelectBranch={(repoId, branch) => setSelectedBranches(prev => ({ ...prev, [repoId]: branch }))}
          onFetchBranches={handleFetchBranches}
          onClone={handleClone}
          onBack={backToList}
        />
      )}

      {/* Push Form View */}
      {viewMode === 'push' && activeConnection && (
        <PushForm
          connection={activeConnection}
          repoName={pushRepoName}
          onRepoNameChange={setPushRepoName}
          description={pushDescription}
          onDescriptionChange={setPushDescription}
          isPrivate={pushPrivate}
          onPrivateChange={setPushPrivate}
          branch={pushBranch}
          onBranchChange={setPushBranch}
          commitMessage={pushMessage}
          onCommitMessageChange={setPushMessage}
          pushing={pushing}
          pushResult={pushResult}
          onPush={handlePush}
          onBack={backToList}
        />
      )}

      {/* Default: Connection List + Wizard */}
      {viewMode === 'list' && (
        <>
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
                    onBrowse={() => handleBrowseRepos(conn)}
                    onPush={() => handleOpenPush(conn)}
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
                    className="flex items-center gap-3 p-3 rounded-lg bg-monastery-dark-surface border border-monastery-dark-border hover:border-monastery-pine transition-colors text-left"
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
                    className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
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
                    className="px-4 py-1.5 text-xs bg-monastery-pine text-white rounded-lg hover:bg-opacity-90"
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
                    className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none"
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
                    className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
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
                    className="px-4 py-1.5 text-xs bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 flex items-center gap-2"
                  >
                    {connecting && <Loader2 className="w-3 h-3 animate-spin" />}
                    Connect
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
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
            className="text-monastery-lantern hover:underline inline-flex items-center gap-1"
          >
            {forge.label} Token Settings <ExternalLink className="w-3 h-3" />
          </a>
        </li>
        <li>Create a new <strong>Personal Access Token</strong></li>
        <li>Select scopes: <code className="text-monastery-lantern bg-monastery-dark-bg px-1 rounded">{forge.scopes}</code></li>
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
  onBrowse,
  onPush,
}: {
  connection: GitConnection;
  onDelete: () => void;
  onTest: () => void;
  onBrowse: () => void;
  onPush: () => void;
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
        onClick={onBrowse}
        className="p-1.5 text-xs text-monastery-text-secondary hover:text-monastery-pine transition-colors"
        title="Browse repositories"
      >
        <FolderGit2 className="w-4 h-4" />
      </button>
      <button
        onClick={onPush}
        className="p-1.5 text-xs text-monastery-text-secondary hover:text-monastery-lantern transition-colors"
        title="Push project to forge"
      >
        <Upload className="w-4 h-4" />
      </button>
      <button
        onClick={onTest}
        className="p-1.5 text-xs text-monastery-text-secondary hover:text-monastery-lantern transition-colors"
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

// ============================================================
// Repo Browser — list repos for a connection and clone
// ============================================================

function RepoBrowser({
  connection,
  repos,
  loading,
  error,
  cloningId,
  cloneResult,
  selectedBranches,
  branchesByRepo,
  loadingBranchesFor,
  onSelectBranch,
  onFetchBranches,
  onClone,
  onBack,
}: {
  connection: GitConnection;
  repos: GitRepo[];
  loading: boolean;
  error: string | null;
  cloningId: number | null;
  cloneResult: string | null;
  selectedBranches: Record<number, string>;
  branchesByRepo: Record<number, GitBranchInfo[]>;
  loadingBranchesFor: number | null;
  onSelectBranch: (repoId: number, branch: string) => void;
  onFetchBranches: (repo: GitRepo) => void;
  onClone: (repo: GitRepo) => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-1 hover:bg-monastery-dark-surface rounded transition-colors">
          <ArrowLeft className="w-4 h-4 text-monastery-text-secondary" />
        </button>
        <div>
          <h3 className="text-sm font-medium text-monastery-text-primary">{connection.name} — Repositories</h3>
          <p className="text-xs text-monastery-text-muted">{connection.base_url}</p>
        </div>
      </div>

      {cloneResult && (
        <div className={`p-3 rounded-lg text-xs ${
          cloneResult.startsWith('Clone failed') ? 'bg-red-400/10 text-red-400' : 'bg-green-400/10 text-green-400'
        }`}>
          {cloneResult}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-monastery-text-muted" />
          <span className="ml-2 text-sm text-monastery-text-muted">Loading repositories...</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-400/10 rounded-lg p-3">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      ) : repos.length === 0 ? (
        <p className="text-sm text-monastery-text-muted italic py-4">No repositories found on this forge.</p>
      ) : (
        <div className="space-y-1 max-h-[50vh] overflow-y-auto">
          {repos.map((repo) => {
            const currentBranch = selectedBranches[repo.id] || repo.default_branch;
            const branches = branchesByRepo[repo.id];
            const isExpanded = !!branches;
            const isLoadingBranches = loadingBranchesFor === repo.id;

            return (
              <div
                key={repo.id}
                className="rounded-lg bg-monastery-dark-surface border border-monastery-dark-border hover:border-monastery-pine transition-colors"
              >
                {/* Repo header row */}
                <div className="flex items-center gap-3 p-2.5">
                  <FolderGit2 className="w-4 h-4 text-monastery-text-muted flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-monastery-text-primary truncate">{repo.full_name}</div>
                    <div className="text-xs text-monastery-text-muted truncate">
                      {repo.private ? <EyeOff className="w-3 h-3 inline mr-1" /> : <Eye className="w-3 h-3 inline mr-1" />}
                      {repo.private ? 'Private' : 'Public'} · {repo.default_branch}
                      {repo.description && ` · ${repo.description}`}
                    </div>
                  </div>
                  <button
                    onClick={() => onFetchBranches(repo)}
                    className={`px-2 py-1 text-xs rounded transition-colors flex items-center gap-1 flex-shrink-0 ${
                      isExpanded 
                        ? 'bg-monastery-dark-tertiary text-monastery-text-primary' 
                        : 'text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-tertiary'
                    }`}
                    title={isExpanded ? 'Hide branches' : 'Show branches'}
                  >
                    {isLoadingBranches ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <GitBranch className="w-3 h-3" />
                    )}
                    Branches
                  </button>
                  <button
                    onClick={() => onClone(repo)}
                    disabled={cloningId === repo.id}
                    className="px-2.5 py-1.5 text-xs bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 flex items-center gap-1.5 flex-shrink-0 transition-colors"
                  >
                    {cloningId === repo.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Download className="w-3 h-3" />
                    )}
                    Clone
                  </button>
                </div>

                {/* Expanded branch list */}
                {isExpanded && branches.length > 0 && (
                  <div className="border-t border-monastery-dark-border px-3 py-2">
                    <div className="text-xs text-monastery-text-muted mb-1.5">
                      Select branch to clone:
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {branches.map((b) => (
                        <button
                          key={b.name}
                          onClick={() => onSelectBranch(repo.id, b.name)}
                          className={`px-2 py-1 text-xs rounded-full transition-colors ${
                            currentBranch === b.name
                              ? 'bg-monastery-pine text-white'
                              : 'bg-monastery-dark-bg text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-tertiary'
                          }`}
                        >
                          {b.name}
                          {b.is_default && (
                            <span className="ml-1 text-[10px] opacity-70">(default)</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Expanded but no branches (empty repo or error) */}
                {isExpanded && branches.length === 0 && (
                  <div className="border-t border-monastery-dark-border px-3 py-2">
                    <p className="text-xs text-monastery-text-muted italic">No branches found for this repository.</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Push Form — push current project to a forge
// ============================================================

function PushForm({
  connection,
  repoName,
  onRepoNameChange,
  description,
  onDescriptionChange,
  isPrivate,
  onPrivateChange,
  branch,
  onBranchChange,
  commitMessage,
  onCommitMessageChange,
  pushing,
  pushResult,
  onPush,
  onBack,
}: {
  connection: GitConnection;
  repoName: string;
  onRepoNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  isPrivate: boolean;
  onPrivateChange: (v: boolean) => void;
  branch: string;
  onBranchChange: (v: string) => void;
  commitMessage: string;
  onCommitMessageChange: (v: string) => void;
  pushing: boolean;
  pushResult: string | null;
  onPush: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-1 hover:bg-monastery-dark-surface rounded transition-colors">
          <ArrowLeft className="w-4 h-4 text-monastery-text-secondary" />
        </button>
        <div>
          <h3 className="text-sm font-medium text-monastery-text-primary">Push to {connection.name}</h3>
          <p className="text-xs text-monastery-text-muted">Create a new repo and push your project</p>
        </div>
      </div>

      {pushResult && (
        <div className={`p-3 rounded-lg text-xs ${
          pushResult.startsWith('Push failed') ? 'bg-red-400/10 text-red-400' : 'bg-green-400/10 text-green-400'
        }`}>
          {pushResult}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Repository Name</label>
          <input
            type="text"
            value={repoName}
            onChange={(e) => onRepoNameChange(e.target.value)}
            placeholder="my-monastery-project"
            className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Description (optional)</label>
          <input
            type="text"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Created with Monastery"
            className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-monastery-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => onPrivateChange(e.target.checked)}
              className="rounded border-monastery-dark-border bg-monastery-dark-bg"
            />
            Private repository
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Branch</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => onBranchChange(e.target.value)}
              className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Commit Message</label>
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => onCommitMessageChange(e.target.value)}
              className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none"
            />
          </div>
        </div>

        <button
          onClick={onPush}
          disabled={!repoName.trim() || pushing}
          className="w-full px-4 py-2.5 text-sm bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
        >
          {pushing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          {pushing ? 'Pushing...' : 'Create Repo & Push'}
        </button>
      </div>
    </div>
  );
}
