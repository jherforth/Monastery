import { useState, useEffect, useCallback } from 'react';
import { useHostingServices } from '../hooks/useHostingServices';
import type { DeployResult, PreviewResult, HostingServer } from '../hooks/useHostingServices';
import { useGitForge } from '../hooks/useGitForge';
import { useAppStore } from '../store/useAppStore';
import {
  Server, Database, CheckCircle2, AlertTriangle, Rocket, GitBranch,
  Loader2, Globe, Copy, Check, ChevronRight, ChevronLeft, Eye, EyeOff,
  Terminal, Cloud, Wrench, Settings,
} from 'lucide-react';
import { FilePreviewCard } from './FilePreviewCard';

// Connecting a platform is Settings' job (Settings → Hosting) — the wizard only picks,
// configures, and deploys. Unconnected platforms deep-link there instead of re-implementing
// the connect form.
const STEPS = ['Platform', 'Configure', 'Deploy'] as const;

interface SelfHostWizardProps {
  isOpen: boolean;
  onClose: () => void;
  /** Hand a failed deployment's build log to the connected LLM to fix (posts into chat).
   *  When the log can't be retrieved, called with empty logs + { fallback: true } for a
   *  proactive Dockerfile/config review. */
  onFixBuildError?: (logs: string, appName: string, opts?: { fallback?: boolean; status?: string }) => void;
}

export function SelfHostWizard({ isOpen, onClose, onFixBuildError }: SelfHostWizardProps) {
  const { connections: hostingConns, deployProject, previewDeploy, listServers, fetchDeploymentLog } = useHostingServices();
  const { connections: gitConns } = useGitForge();
  const currentProject = useAppStore(s => s.currentProject);

  const [step, setStep] = useState(0);
  const [appName, setAppName] = useState(currentProject?.name || 'my-app');
  const [domain, setDomain] = useState('');
  const [port, setPort] = useState('3000');
  const [selectedPlatform, setSelectedPlatform] = useState<string>('');
  const [includePocketbase, setIncludePocketbase] = useState(false);
  const [includeCloudflareTunnel, setIncludeCloudflareTunnel] = useState(false);
  const [cloudflareTunnelToken, setCloudflareTunnelToken] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployTab, setDeployTab] = useState<'auto' | 'manual'>('auto');
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [servers, setServers] = useState<HostingServer[]>([]);
  const [selectedServer, setSelectedServer] = useState<string>('');
  const [loadingServers, setLoadingServers] = useState(false);
  const [serversError, setServersError] = useState<string | null>(null);
  const [fixingBuild, setFixingBuild] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  const dokploy = hostingConns.find(c => c.service_type === 'dokploy');
  const coolify = hostingConns.find(c => c.service_type === 'coolify');
  const pocketbase = hostingConns.find(c => c.service_type === 'pocketbase');
  const hasGit = gitConns.length > 0;
  const activePlatformConn =
    selectedPlatform === 'dokploy' ? dokploy :
    selectedPlatform === 'coolify' ? coolify :
    dokploy || coolify;
  const platformConnected = !!activePlatformConn;

  const resetState = useCallback(() => {
    setStep(0); setPreview(null);
    setShowPreview(false); setDeployResult(null); setDeployError(null);
    setDeployTab('auto'); setIncludePocketbase(false); setDomain('');
    setIncludeCloudflareTunnel(false); setCloudflareTunnelToken('');
    setServers([]); setSelectedServer(''); setServersError(null);
  }, []);

  useEffect(() => {
    if (currentProject?.name) setAppName(currentProject.name);
  }, [currentProject?.name]);

  useEffect(() => {
    if (step === 1 && currentProject?.id) {
      setLoadingPreview(true);
      previewDeploy(
        currentProject.id,
        includePocketbase,
        includeCloudflareTunnel,
        appName || undefined,
        parseInt(port) || undefined,
      )
        .then(p => { setPreview(p); setPort(String(p.port)); })
        .catch(() => setPreview(null))
        .finally(() => setLoadingPreview(false));
    }
  }, [step, includePocketbase, includeCloudflareTunnel]);

  // Fetch the platform's servers when entering the Configure step so the user can pick
  // a deploy target (avoids the default "localhost" server trap on Coolify/Dokploy).
  useEffect(() => {
    const platform = activePlatformConn?.service_type;
    if (step !== 1 || !activePlatformConn?.id || (platform !== 'coolify' && platform !== 'dokploy')) {
      return;
    }
    let cancelled = false;
    setLoadingServers(true); setServersError(null);
    listServers(activePlatformConn.id)
      .then(list => {
        if (cancelled) return;
        setServers(list);
        // Preselect a usable, non-localhost server when available.
        const preferred = list.find(s => s.is_usable && !s.is_localhost)
          ?? list.find(s => !s.is_localhost)
          ?? list[0];
        setSelectedServer(preferred?.uuid ?? '');
      })
      .catch(e => { if (!cancelled) { setServers([]); setServersError(e.message || 'Failed to load servers'); } })
      .finally(() => { if (!cancelled) setLoadingServers(false); });
    return () => { cancelled = true; };
  }, [step, activePlatformConn?.id, activePlatformConn?.service_type, listServers]);

  const handleSelectPlatform = (platform: string) => {
    const connected = platform === 'dokploy' ? !!dokploy : !!coolify;
    if (!connected) {
      // One home for connections: hand off to Settings → Hosting (the wizard would
      // otherwise render underneath the Settings view, so close it first).
      onClose();
      window.dispatchEvent(new CustomEvent('monastery:open-settings', { detail: { tab: 'hosting' } }));
      return;
    }
    setSelectedPlatform(platform);
    setStep(1);
  };

  const handleDeploy = async () => {
    if (!currentProject?.id) return;
    if (!activePlatformConn) { setDeployError('No deployment platform configured.'); return; }
    setDeploying(true); setDeployError(null); setDeployResult(null);
    try {
      const result = await deployProject({
        connection_id: activePlatformConn.id, project_id: currentProject.id,
        app_name: appName.trim() || 'monastery-app', domain: domain.trim() || undefined,
        server_uuid: selectedServer || undefined,
        port: parseInt(port) || 3000, include_pocketbase: includePocketbase,
        pocketbase_connection_id: includePocketbase ? pocketbase?.id : undefined,
        include_cloudflare_tunnel: includeCloudflareTunnel,
        cloudflare_tunnel_token: includeCloudflareTunnel ? cloudflareTunnelToken || undefined : undefined,
      });
      setDeployResult(result);
    } catch (e: any) { setDeployError(e.message || 'Deployment failed'); }
    finally { setDeploying(false); }
  };

  // Pull the latest deployment's build log and hand it to the connected LLM (in chat) to fix.
  const handleFixBuild = async () => {
    if (!activePlatformConn || !deployResult || !onFixBuildError) return;
    const appId = deployResult.app_uuid || deployResult.app_id;
    if (!appId) { setFixError('No deployed app id to fetch logs for.'); return; }
    setFixingBuild(true); setFixError(null);
    try {
      const { status, logs, detail } = await fetchDeploymentLog(activePlatformConn.id, appId);
      if (logs && logs.trim()) {
        onFixBuildError(logs, deployResult.app_name);
        onClose(); // surface the chat where the LLM applies the fix
        return;
      }
      // No log text. If the build is still running, ask the user to wait rather than guessing.
      if (status === 'running' || status === 'unknown') {
        setFixError(`No build log yet (status: ${status}). If the build is still running, wait for it to finish and retry. ${detail || ''}`);
        return;
      }
      // Build finished but the log isn't retrievable (e.g. Dokploy can't serve logs from a remote
      // deploy server via the API). Fall back to a proactive Dockerfile/config review.
      onFixBuildError('', deployResult.app_name, { fallback: true, status });
      onClose();
    } catch (e: any) {
      setFixError(e.message || 'Failed to fetch build log');
    } finally { setFixingBuild(false); }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopiedFile(id); setTimeout(() => setCopiedFile(null), 2000); });
  };

  const getCombinedManualCommands = (): string => {
    if (!preview) return '';
    const lines = ['# === Generated by Monastery ===', `# Framework: ${preview.framework} | Port: ${preview.port}`, ''];
    if (includeCloudflareTunnel) {
      lines.push('# Before deploying, set your tunnel token:', '#   export CF_TUNNEL_TOKEN=your-tunnel-token', '');
    }
    if (includePocketbase || includeCloudflareTunnel) {
      lines.push('# Deploy with Docker Compose:', 'docker compose up -d', '');
      if (!includeCloudflareTunnel) {
        lines.push('# Or build and run individually:');
        lines.push(`docker build -t ${appName} .`);
        lines.push(`docker run -d -p ${preview.port}:${preview.port} --name ${appName} ${appName}`);
      }
    } else {
      lines.push(`docker build -t ${appName} .`);
      lines.push(`docker run -d -p ${preview.port}:${preview.port} --name ${appName} ${appName}`);
    }
    lines.push('');
    if (includeCloudflareTunnel) {
      lines.push('# After deploy, in Cloudflare Zero Trust dashboard:');
      lines.push('#   Tunnels → your tunnel → Configure → Public Hostname');
      lines.push(`#   Add: ${domain || 'app.yourdomain.com'} → http://localhost:${preview.port}`);
    } else {
      lines.push('# To make your app public:');
      lines.push('#   Option 1: Add an ingress rule to your existing Cloudflare Tunnel');
      lines.push('#   Option 2: Use a reverse proxy (Nginx/Caddy/Traefik)');
      lines.push('#   Option 3: Run "cloudflared tunnel login" and create a new tunnel');
    }
    return lines.join('\n');
  };

  // Early return AFTER all hooks — must be last before JSX
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-monastery-dark-surface rounded-lg w-full max-w-xl max-h-[90vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
        {/* Header + Stepper */}
        <div className="p-5 border-b border-monastery-dark-border shrink-0">
          <div className="flex items-center gap-3">
            <Rocket size={24} className="text-monastery-lantern" />
            <div><h2 className="text-lg font-semibold text-monastery-text-primary">Self-Host Wizard</h2>
              <p className="text-xs text-monastery-text-secondary mt-0.5">Deploy to your own infrastructure</p></div>
          </div>
          <div className="flex items-center gap-1 mt-4">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-1 flex-1">
                <button onClick={() => { if (i <= step) setStep(i); }}
                  disabled={i > step}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${
                    i === step ? 'bg-monastery-pine/20 text-monastery-pine font-medium' :
                    i < step ? 'text-monastery-text-muted hover:text-monastery-text-secondary' : 'text-monastery-text-muted/50'}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    i === step ? 'bg-monastery-pine text-white' : i < step ? 'bg-green-400/20 text-green-400' : 'bg-monastery-dark-border text-monastery-text-muted'}`}>
                    {i < step ? '✓' : i + 1}</span>
                  <span className="hidden sm:inline">{label}</span>
                </button>
                {i < STEPS.length - 1 && <ChevronRight size={12} className="text-monastery-text-muted shrink-0" />}
              </div>))}
          </div>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {/* STEP 0: Select Platform */}
          {step === 0 && (<div className="space-y-3">
            <h3 className="text-sm font-medium text-monastery-text-primary flex items-center gap-2"><Server size={16} className="text-blue-400" /> Choose Your Deployment Platform</h3>
            <p className="text-xs text-monastery-text-muted">Select where to deploy. Choosing an unconnected platform opens Settings → Hosting to connect it.</p>
            {(['dokploy', 'coolify'] as const).map(platform => {
              const conn = platform === 'dokploy' ? dokploy : coolify;
              const Icon = Server;
              const color = platform === 'dokploy' ? 'text-blue-400' : 'text-purple-400';
              return (
                <button key={platform} onClick={() => handleSelectPlatform(platform)}
                  className={`w-full p-3 rounded-lg border text-left transition-colors ${conn ? 'border-green-400/30 bg-green-400/5 hover:bg-green-400/10' : 'border-monastery-dark-border bg-monastery-dark-bg hover:bg-monastery-dark-tertiary'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><Icon size={16} className={color} />
                      <span className="text-sm font-medium text-monastery-text-primary">{platform === 'dokploy' ? 'Dokploy' : 'Coolify'}</span>
                      {conn ? <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={12} /> Connected</span>
                        : <span className="flex items-center gap-1 text-xs text-monastery-text-muted"><Settings size={11} /> Connect in Settings</span>}</div>
                    <ChevronRight size={16} className="text-monastery-text-muted" /></div>
                  <p className="text-xs text-monastery-text-muted mt-1">{platform === 'dokploy' ? 'Self-hosted PaaS — deploy apps, databases, and Docker containers' : 'Self-hosted deployment platform — Vercel/Netlify alternative'}</p>
                </button>);
            })}
          </div>)}

          {/* STEP 1: Configure */}
          {step === 1 && (<div className="space-y-4">
            <h3 className="text-sm font-medium text-monastery-text-primary flex items-center gap-2"><Rocket size={16} className="text-monastery-lantern" /> Configure Your Deployment</h3>
            <div className={`p-2 rounded-lg border text-xs flex items-center gap-2 ${activePlatformConn ? 'border-green-400/30 bg-green-400/5 text-green-400' : 'border-monastery-dark-border bg-monastery-dark-bg text-monastery-text-muted'}`}>
              <CheckCircle2 size={12} />{activePlatformConn ? `Deploying to ${activePlatformConn.service_type} (${activePlatformConn.base_url})` : 'No platform connected'}</div>
            {/* Deployment server selector */}
            {(activePlatformConn?.service_type === 'coolify' || activePlatformConn?.service_type === 'dokploy') && (
              <div>
                <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Deployment Server</label>
                {loadingServers ? (
                  <div className="text-xs text-monastery-text-muted flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading servers…</div>
                ) : serversError ? (
                  <div className="text-xs text-red-400">{serversError}</div>
                ) : servers.length === 0 ? (
                  <div className="text-xs text-monastery-text-muted">No servers found. Add one in your {activePlatformConn?.service_type} dashboard first.</div>
                ) : (
                  <select value={selectedServer} onChange={e => setSelectedServer(e.target.value)}
                    className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none">
                    {servers.map(s => (
                      <option key={s.uuid} value={s.uuid}>
                        {s.name}{s.ip ? ` (${s.ip})` : ''}{s.is_localhost ? ' — localhost' : ''}{!s.is_usable ? ' — unreachable' : ''}
                      </option>
                    ))}
                  </select>
                )}
                {servers.find(s => s.uuid === selectedServer)?.is_localhost && (
                  <p className="text-xs text-amber-300 mt-1 flex items-start gap-1">
                    <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                    This is the platform's own host — the app will run there and may collide on port 80. Pick a remote server to deploy to your VPS.
                  </p>
                )}
              </div>
            )}
            <div><label className="block text-xs font-medium text-monastery-text-secondary mb-1">App Name</label>
              <input type="text" value={appName} onChange={e => setAppName(e.target.value)} placeholder="my-monastery-app"
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none" /></div>
            <div className="flex gap-3">
              <div className="flex-1"><label className="block text-xs font-medium text-monastery-text-secondary mb-1">Domain (optional)</label>
                <input type="text" value={domain} onChange={e => setDomain(e.target.value)} placeholder="app.yourdomain.com"
                  className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none" /></div>
              <div className="w-24"><label className="block text-xs font-medium text-monastery-text-secondary mb-1">Port</label>
                <input type="number" value={port} onChange={e => setPort(e.target.value)}
                  className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none" /></div></div>
            {dokploy && coolify && (<div><label className="block text-xs font-medium text-monastery-text-secondary mb-1">Platform</label>
              <select value={selectedPlatform || (dokploy ? 'dokploy' : 'coolify')} onChange={e => setSelectedPlatform(e.target.value)}
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm focus:border-monastery-pine focus:outline-none">
                {dokploy && <option value="dokploy">Dokploy</option>}{coolify && <option value="coolify">Coolify</option>}</select></div>)}
            {/* Pocketbase toggle */}
            <div className="p-3 rounded-lg border border-monastery-dark-border bg-monastery-dark-bg space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Database size={16} className="text-amber-400" /><span className="text-sm font-medium text-monastery-text-primary">Include Pocketbase Backend</span></div>
                <button onClick={() => setIncludePocketbase(!includePocketbase)} className={`relative w-10 h-5 rounded-full transition-colors ${includePocketbase ? 'bg-monastery-pine' : 'bg-monastery-dark-border'}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${includePocketbase ? 'left-5' : 'left-0.5'}`} /></button></div>
              <p className="text-xs text-monastery-text-muted">{includePocketbase ? (pocketbase ? `Wires your configured Pocketbase (${pocketbase.base_url}) into the app as POCKETBASE_URL (build-time + runtime).` : 'Injects your configured Pocketbase URL into the app as POCKETBASE_URL.') : 'Enable if your app needs a database backend.'}</p>
              {includePocketbase && !pocketbase && <p className="text-xs text-amber-400 flex items-center gap-1"><AlertTriangle size={12} /> No Pocketbase connection. Add one in Settings → Hosting Services first, or this will be skipped.</p>}</div>
            {/* Cloudflare Tunnel toggle */}
            <div className="p-3 rounded-lg border border-monastery-dark-border bg-monastery-dark-bg space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Cloud size={16} className="text-orange-400" /><span className="text-sm font-medium text-monastery-text-primary">Cloudflare Tunnel</span></div>
                <button onClick={() => setIncludeCloudflareTunnel(!includeCloudflareTunnel)} className={`relative w-10 h-5 rounded-full transition-colors ${includeCloudflareTunnel ? 'bg-monastery-pine' : 'bg-monastery-dark-border'}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${includeCloudflareTunnel ? 'left-5' : 'left-0.5'}`} /></button></div>
              <p className="text-xs text-monastery-text-muted">{includeCloudflareTunnel
                ? 'Adds cloudflared to docker-compose.yml. Your app will be reachable at your domain via Cloudflare Tunnel — no open ports needed.'
                : 'Skip if your server already has cloudflared or a reverse proxy. Enable to bundle cloudflared into the deployment.'}</p>
              {includeCloudflareTunnel && (
                <div>
                  <label className="block text-xs font-medium text-monastery-text-secondary mb-1">Tunnel Token</label>
                  <input type="password" value={cloudflareTunnelToken} onChange={e => setCloudflareTunnelToken(e.target.value)}
                    placeholder="Paste your Cloudflare tunnel token..."
                    className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none" />
                  <p className="text-xs text-monastery-text-muted mt-1">Find this in Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Configure → copy token.</p>
                </div>
              )}
            </div>
            <div className={`p-2 rounded-lg border text-xs ${hasGit ? 'border-green-400/30 bg-green-400/5 text-green-400' : 'border-monastery-dark-border bg-monastery-dark-bg text-monastery-text-muted'}`}>
              <GitBranch size={12} className="inline mr-1" />{hasGit ? `${gitConns.length} Git forge(s) connected` : 'No Git forges — deploy from local project'}</div>
            {/* Generated Files Preview */}
            <div>
              <button onClick={() => setShowPreview(!showPreview)} className="flex items-center gap-2 text-xs text-monastery-text-secondary hover:text-monastery-text-primary transition-colors">
                {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}{showPreview ? 'Hide' : 'Show'} Generated Files{loadingPreview && <Loader2 size={12} className="animate-spin" />}</button>
              {showPreview && preview && (<div className="mt-2 space-y-2">
                <div className="flex items-center gap-2 text-xs text-monastery-text-muted"><span>Framework: <span className="text-monastery-text-primary">{preview.framework}</span></span><span>•</span><span>Port: <span className="text-monastery-text-primary">{preview.port}</span></span></div>
                {preview.files.map((file) => (
                  <FilePreviewCard key={file.name} file={file} copiedFile={copiedFile} onCopy={copyToClipboard} />
                ))}</div>)}</div></div>)}

          {/* STEP 2: Deploy */}
          {step === 2 && (<div className="space-y-4">
            <h3 className="text-sm font-medium text-monastery-text-primary flex items-center gap-2"><Rocket size={16} className="text-monastery-lantern" /> Deploy</h3>
            <div className="p-3 rounded-lg border border-monastery-dark-border bg-monastery-dark-bg space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-monastery-text-muted">App:</span><span className="text-monastery-text-primary">{appName}</span></div>
              <div className="flex justify-between"><span className="text-monastery-text-muted">Platform:</span><span className="text-monastery-text-primary">{activePlatformConn?.service_type || '—'}</span></div>
              <div className="flex justify-between"><span className="text-monastery-text-muted">Port:</span><span className="text-monastery-text-primary">{port}</span></div>
              {domain && <div className="flex justify-between"><span className="text-monastery-text-muted">Domain:</span><span className="text-monastery-text-primary">{domain}</span></div>}
              <div className="flex justify-between"><span className="text-monastery-text-muted">Database:</span><span className="text-monastery-text-primary">{includePocketbase ? 'Pocketbase' : 'None'}</span></div>
              <div className="flex justify-between"><span className="text-monastery-text-muted">Tunnel:</span><span className="text-monastery-text-primary">{includeCloudflareTunnel ? 'Cloudflare' : 'None'}</span></div></div>
            <div className="flex border-b border-monastery-dark-border">
              <button onClick={() => setDeployTab('auto')} className={`px-3 py-2 text-xs font-medium transition-colors ${deployTab === 'auto' ? 'text-monastery-lantern border-b-2 border-monastery-lantern' : 'text-monastery-text-secondary hover:text-monastery-text-primary'}`}>🚀 Auto Deploy</button>
              <button onClick={() => setDeployTab('manual')} className={`px-3 py-2 text-xs font-medium transition-colors ${deployTab === 'manual' ? 'text-monastery-lantern border-b-2 border-monastery-lantern' : 'text-monastery-text-secondary hover:text-monastery-text-primary'}`}><Terminal size={12} className="inline mr-1" /> Manual</button></div>
            {deployTab === 'auto' && (<>
              {deployError && <div className="p-3 rounded-lg text-xs bg-red-400/10 text-red-400 flex items-center gap-2"><AlertTriangle size={14} /> {deployError}</div>}
              {deployResult && (<div className="p-3 rounded-lg text-xs bg-green-400/10 text-green-400 space-y-2">
                <div className="flex items-center gap-2 font-medium"><CheckCircle2 size={14} /> {deployResult.redeployed ? `Redeployed existing app on ${deployResult.platform}` : `App created on ${deployResult.platform}!`}</div>
                <p className="text-monastery-text-secondary">Framework: <span className="text-monastery-text-primary">{deployResult.framework}</span> — Port: {deployResult.port}</p>
                {deployResult.server && <p className="text-monastery-text-secondary">Server: <span className="text-monastery-text-primary">{deployResult.server}</span></p>}
                {deployResult.access_url && (
                  <div className="pt-1">
                    <p className="text-monastery-text-secondary mb-1">Open on your network (give it a moment to finish building):</p>
                    <a href={deployResult.access_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded bg-monastery-dark-bg text-monastery-lantern hover:underline break-all">
                      <Globe size={12} className="shrink-0" /> {deployResult.access_url}
                    </a>
                  </div>
                )}
                {deployResult.server_is_localhost && (
                  <p className="text-amber-300 flex items-start gap-1"><AlertTriangle size={11} className="shrink-0 mt-0.5" /> Deployed to the platform's own host — to reach a VPS instead, pick a remote server above and redeploy.</p>
                )}
                {deployResult.deploy_triggered && <p className="text-monastery-text-secondary">Deployment triggered — building now.</p>}
                {onFixBuildError && (deployResult.app_uuid || deployResult.app_id) && (
                  <div className="mt-1 pt-2 border-t border-green-400/20 space-y-1">
                    <p className="text-monastery-text-muted">Build failing on the platform? Pull the build log and let the AI fix it.</p>
                    <button
                      type="button"
                      onClick={handleFixBuild}
                      disabled={fixingBuild}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-monastery-dark-border bg-monastery-dark-surface text-monastery-text-secondary hover:border-monastery-pine hover:text-monastery-text-primary transition-colors disabled:opacity-50"
                    >
                      {fixingBuild ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
                      {fixingBuild ? 'Fetching build log…' : 'Fix build error with AI'}
                    </button>
                    {fixError && <p className="text-amber-300 flex items-start gap-1"><AlertTriangle size={11} className="shrink-0 mt-0.5" /> {fixError}</p>}
                  </div>
                )}
                {deployResult.pocketbase_url && (
                  <p className="text-monastery-text-secondary flex items-start gap-1">
                    <Database size={11} className="shrink-0 mt-0.5 text-amber-400" />
                    Pocketbase wired in as <code className="px-1 rounded bg-monastery-dark-bg text-monastery-lantern break-all ml-1">POCKETBASE_URL={deployResult.pocketbase_url}</code>
                  </p>
                )}
                {deployResult.tunnel_requested && (
                  deployResult.tunnel_deployed ? (
                    <div className="mt-1 pt-2 border-t border-green-400/20 space-y-1">
                      <div className="flex items-center gap-2 font-medium"><Cloud size={13} /> Cloudflare connector launched</div>
                      <p className="text-monastery-text-secondary">
                        Last step (one-time, in Cloudflare): Zero Trust → Networks → Tunnels → your tunnel → <strong>Public Hostname</strong> → add your domain with <strong>Service</strong> set to:
                      </p>
                      <code className="block px-2 py-1 rounded bg-monastery-dark-bg text-monastery-lantern">{deployResult.tunnel_service_url}</code>
                      <p className="text-monastery-text-muted">The connector should show <strong>HEALTHY</strong> in the dashboard within a minute.</p>
                    </div>
                  ) : (
                    <div className="mt-1 pt-2 border-t border-amber-400/20 flex items-start gap-1 text-amber-300">
                      <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                      <span>Connector not launched{deployResult.tunnel_error ? `: ${deployResult.tunnel_error}` : ''}. Run cloudflared manually, then point the Public Hostname at {deployResult.tunnel_service_url || `http://localhost:${deployResult.port}`}.</span>
                    </div>
                  )
                )}
                <a href={deployResult.dashboard_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-monastery-lantern hover:underline"><Globe size={12} /> Open {deployResult.platform} Dashboard</a></div>)}
              <button onClick={handleDeploy} disabled={deploying || !activePlatformConn || !currentProject}
                className="w-full px-4 py-2.5 text-sm bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium transition-colors">
                {deploying ? <><Loader2 size={14} className="animate-spin" /> Deploying...</> : <><Rocket size={14} /> Deploy Now</>}</button></>)}
            {deployTab === 'manual' && preview && (<div className="space-y-3">
              <p className="text-xs text-monastery-text-muted">Copy these files to your server and run the commands below. No API connection needed.</p>
              <div className="rounded-lg border border-monastery-dark-border overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-monastery-dark-tertiary border-b border-monastery-dark-border">
                  <span className="text-xs font-medium text-monastery-text-primary flex items-center gap-1"><Terminal size={12} /> Terminal Commands</span>
                  <button onClick={() => copyToClipboard(getCombinedManualCommands(), 'commands')} className="flex items-center gap-1 text-xs text-monastery-text-muted hover:text-monastery-text-primary transition-colors">
                    {copiedFile === 'commands' ? <><Check size={12} className="text-green-400" /> Copied</> : <><Copy size={12} /> Copy All</>}</button></div>
                <pre className="p-3 text-xs text-monastery-text-secondary font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">{getCombinedManualCommands()}</pre></div>
              {preview.files.map((file) => (
                <FilePreviewCard key={file.name} file={file} copiedFile={copiedFile} onCopy={copyToClipboard} />
              ))}</div>)}</div>)}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-monastery-dark-border shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {step > 0 && <button onClick={() => setStep(step - 1)} className="px-3 py-1.5 text-xs bg-monastery-dark-tertiary text-monastery-text-primary rounded-md hover:bg-monastery-dark-border transition-colors flex items-center gap-1"><ChevronLeft size={14} /> Back</button>}</div>
          <div className="flex items-center gap-2">
            <button onClick={() => { resetState(); onClose(); }} className="px-3 py-1.5 text-xs text-monastery-text-muted hover:text-monastery-text-primary transition-colors">Close</button>
            {step < 2 && <button onClick={() => setStep(step + 1)} disabled={step === 0 && !platformConnected}
              className="px-4 py-1.5 text-xs bg-monastery-pine text-white rounded-md hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 font-medium transition-colors">Next <ChevronRight size={14} /></button>}</div></div>
        {!currentProject && <div className="px-5 pb-4"><p className="text-xs text-monastery-text-muted text-center">Open a project first to enable deployment.</p></div>}
      </div></div>);
}
