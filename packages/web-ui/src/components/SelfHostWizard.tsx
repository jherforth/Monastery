import { useState } from 'react';
import { useHostingServices, DeployResult } from '../hooks/useHostingServices';
import { useGitForge } from '../hooks/useGitForge';
import { useAppStore } from '../store/useAppStore';
import { Server, Database, CheckCircle2, AlertTriangle, Rocket, GitBranch, Loader2, Globe } from 'lucide-react';

interface SelfHostWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SelfHostWizard({ isOpen, onClose }: SelfHostWizardProps) {
  const { connections: hostingConns, deployProject } = useHostingServices();
  const { connections: gitConns } = useGitForge();
  const currentProject = useAppStore(s => s.currentProject);

  const [appName, setAppName] = useState(currentProject?.name || 'my-app');
  const [selectedPlatform, setSelectedPlatform] = useState<string>('');
  const [port, setPort] = useState('3000');
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  if (!isOpen) return null;

  const dokploy = hostingConns.find(c => c.service_type === 'dokploy');
  const coolify = hostingConns.find(c => c.service_type === 'coolify');
  const pocketbase = hostingConns.find(c => c.service_type === 'pocketbase');
  const hasGit = gitConns.length > 0;
  const hasDeployPlatform = !!(dokploy || coolify);

  const handleDeploy = async () => {
    if (!currentProject?.id) {
      setDeployError('No project open. Open a project first.');
      return;
    }

    const platformConn = selectedPlatform === 'dokploy' ? dokploy : selectedPlatform === 'coolify' ? coolify : dokploy || coolify;
    if (!platformConn) {
      setDeployError('No deployment platform configured.');
      return;
    }

    setDeploying(true);
    setDeployError(null);
    setDeployResult(null);

    try {
      const result = await deployProject({
        connection_id: platformConn.id,
        project_id: currentProject.id,
        app_name: appName.trim() || 'monastery-app',
        port: parseInt(port) || 3000,
      });
      setDeployResult(result);
    } catch (e: any) {
      setDeployError(e.message || 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-monastery-dark-surface rounded-lg w-full max-w-lg max-h-[85vh] flex flex-col shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 border-b border-monastery-dark-border shrink-0">
          <div className="flex items-center gap-3">
            <Rocket size={24} className="text-monastery-lantern" />
            <div>
              <h2 className="text-xl font-semibold text-monastery-text-primary">Self-Host Wizard</h2>
              <p className="text-sm text-monastery-text-secondary mt-0.5">
                Deploy your project to your own infrastructure
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-5">
          {/* Step 1: Deployment Platforms */}
          <div>
            <h3 className="text-sm font-medium text-monastery-text-primary mb-3 flex items-center gap-2">
              <Server size={16} className="text-blue-400" />
              Deployment Platform
              <span className="text-xs text-monastery-text-muted font-normal">(choose one)</span>
            </h3>

            <div className="space-y-2">
              {/* Dokploy */}
              <div className={`p-3 rounded-lg border ${dokploy ? 'border-green-400/30 bg-green-400/5' : 'border-monastery-dark-border bg-monastery-dark-bg'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server size={16} className="text-blue-400" />
                    <span className="text-sm font-medium text-monastery-text-primary">Dokploy</span>
                    {dokploy ? (
                      <span className="flex items-center gap-1 text-xs text-green-400">
                        <CheckCircle2 size={12} />
                        Connected
                      </span>
                    ) : (
                      <span className="text-xs text-monastery-text-muted">Not configured</span>
                    )}
                  </div>
                  {dokploy && (
                    <span className="text-xs text-monastery-text-muted">{dokploy.base_url}</span>
                  )}
                </div>
                <p className="text-xs text-monastery-text-muted mt-1">Self-hosted PaaS — deploy apps, databases, and Docker containers</p>
              </div>

              {/* Coolify */}
              <div className={`p-3 rounded-lg border ${coolify ? 'border-green-400/30 bg-green-400/5' : 'border-monastery-dark-border bg-monastery-dark-bg'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server size={16} className="text-purple-400" />
                    <span className="text-sm font-medium text-monastery-text-primary">Coolify</span>
                    {coolify ? (
                      <span className="flex items-center gap-1 text-xs text-green-400">
                        <CheckCircle2 size={12} />
                        Connected
                      </span>
                    ) : (
                      <span className="text-xs text-monastery-text-muted">Not configured</span>
                    )}
                  </div>
                  {coolify && (
                    <span className="text-xs text-monastery-text-muted">{coolify.base_url}</span>
                  )}
                </div>
                <p className="text-xs text-monastery-text-muted mt-1">Self-hosted deployment platform — Vercel/Netlify alternative</p>
              </div>
            </div>
          </div>

          {/* Database Backend */}
          <div>
            <h3 className="text-sm font-medium text-monastery-text-primary mb-3 flex items-center gap-2">
              <Database size={16} className="text-amber-400" />
              Database Backend
              <span className="text-xs text-monastery-text-muted font-normal">(auto-configured if needed)</span>
            </h3>

            <div className={`p-3 rounded-lg border ${pocketbase ? 'border-green-400/30 bg-green-400/5' : 'border-monastery-dark-border bg-monastery-dark-bg'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database size={16} className="text-amber-400" />
                  <span className="text-sm font-medium text-monastery-text-primary">Pocketbase</span>
                  {pocketbase ? (
                    <span className="flex items-center gap-1 text-xs text-green-400">
                      <CheckCircle2 size={12} />
                      Connected
                    </span>
                  ) : (
                    <span className="text-xs text-monastery-text-muted">Not configured</span>
                  )}
                </div>
                {pocketbase && (
                  <span className="text-xs text-monastery-text-muted">{pocketbase.base_url}</span>
                )}
              </div>
              <p className="text-xs text-monastery-text-muted mt-1">Self-hosted backend — database, auth, file storage. Auto-configured when your app requires a database.</p>
            </div>
          </div>

          {/* Git Integration */}
          <div>
            <h3 className="text-sm font-medium text-monastery-text-primary mb-3 flex items-center gap-2">
              <GitBranch size={16} className="text-monastery-pine" />
              Git Repository
            </h3>
            <div className={`p-3 rounded-lg border ${hasGit ? 'border-green-400/30 bg-green-400/5' : 'border-monastery-dark-border bg-monastery-dark-bg'}`}>
              <p className="text-xs text-monastery-text-muted">
                {hasGit
                  ? `${gitConns.length} forge${gitConns.length > 1 ? 's' : ''} connected — ready to push`
                  : 'No Git forges configured. Connect one in Settings to push your project.'}
              </p>
            </div>
          </div>
        </div>

        {/* Footer — Deploy Form */}
        <div className="p-6 border-t border-monastery-dark-border shrink-0 space-y-4">
          {/* Deploy Configuration */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                App Name
              </label>
              <input
                type="text"
                value={appName}
                onChange={e => setAppName(e.target.value)}
                placeholder="my-monastery-app"
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                  Platform
                </label>
                <select
                  value={selectedPlatform || (dokploy ? 'dokploy' : coolify ? 'coolify' : '')}
                  onChange={e => setSelectedPlatform(e.target.value)}
                  className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none"
                  disabled={!hasDeployPlatform}
                >
                  <option value="">Auto-select</option>
                  {dokploy && <option value="dokploy">Dokploy</option>}
                  {coolify && <option value="coolify">Coolify</option>}
                </select>
              </div>
              <div className="w-24">
                <label className="block text-xs font-medium text-monastery-text-secondary mb-1">
                  Port
                </label>
                <input
                  type="number"
                  value={port}
                  onChange={e => setPort(e.target.value)}
                  className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Result / Error */}
          {deployError && (
            <div className="p-3 rounded-lg text-xs bg-red-400/10 text-red-400 flex items-center gap-2">
              <AlertTriangle size={14} />
              {deployError}
            </div>
          )}

          {deployResult && (
            <div className="p-3 rounded-lg text-xs bg-green-400/10 text-green-400 space-y-2">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 size={14} />
                App created on {deployResult.platform}!
              </div>
              <p className="text-monastery-text-secondary">
                Framework detected: <span className="text-monastery-text-primary">{deployResult.framework}</span> — Port: {deployResult.port}
              </p>
              {deployResult.deploy_triggered && (
                <p className="text-monastery-text-secondary">Deployment triggered — building now.</p>
              )}
              <a
                href={deployResult.dashboard_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-monastery-lantern hover:underline"
              >
                <Globe size={12} />
                Open {deployResult.platform} Dashboard
              </a>
            </div>
          )}

          {/* Deploy Button */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                onClose();
              }}
              className="px-4 py-2 text-sm bg-monastery-dark-tertiary text-monastery-text-primary rounded-md hover:bg-monastery-lantern hover:text-monastery-dark-bg transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleDeploy}
              disabled={deploying || !hasDeployPlatform || !currentProject}
              className="px-5 py-2 text-sm bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-medium transition-colors"
            >
              {deploying ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Rocket size={14} />
                  Deploy Now
                </>
              )}
            </button>
          </div>

          {!currentProject && (
            <p className="text-xs text-monastery-text-muted text-center">
              Open a project first to enable deployment.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
