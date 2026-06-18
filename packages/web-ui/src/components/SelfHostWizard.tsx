import { useState, useEffect, useCallback } from 'react';
import { useHostingServices } from '../hooks/useHostingServices';
import type { DeployResult, PreviewResult } from '../hooks/useHostingServices';
import { useGitForge } from '../hooks/useGitForge';
import { useAppStore } from '../store/useAppStore';
import {
  Server, Database, CheckCircle2, AlertTriangle, Rocket, GitBranch,
  Loader2, Globe, Copy, Check, ChevronRight, ChevronLeft, Eye, EyeOff,
  Terminal, Upload, XCircle,
} from 'lucide-react';

const STEPS = ['Platform', 'Connect', 'Configure', 'Deploy'] as const;

interface SelfHostWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SelfHostWizard({ isOpen, onClose }: SelfHostWizardProps) {
  const { connections: hostingConns, deployProject, previewDeploy, connectService } = useHostingServices();
  const { connections: gitConns } = useGitForge();
  const currentProject = useAppStore(s => s.currentProject);

  const [step, setStep] = useState(0);
  const [connectUrl, setConnectUrl] = useState('');
  const [connectToken, setConnectToken] = useState('');
  const [connectName, setConnectName] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [appName, setAppName] = useState(currentProject?.name || 'my-app');
  const [domain, setDomain] = useState('');
  const [port, setPort] = useState('3000');
  const [selectedPlatform, setSelectedPlatform] = useState<string>('');
  const [includePocketbase, setIncludePocketbase] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployTab, setDeployTab] = useState<'auto' | 'manual'>('auto');
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  if (!isOpen) return null;

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
    setStep(0); setConnectUrl(''); setConnectToken(''); setConnectName('');
    setConnectError(null); setConnecting(false); setPreview(null);
    setShowPreview(false); setDeployResult(null); setDeployError(null);
    setDeployTab('auto'); setIncludePocketbase(false); setDomain('');
  }, []);

  useEffect(() => {
    if (currentProject?.name) setAppName(currentProject.name);
  }, [currentProject?.name]);

  useEffect(() => {
    if (step === 2 && currentProject?.id) {
      setLoadingPreview(true);
      previewDeploy(currentProject.id, includePocketbase, appName || undefined, parseInt(port) || undefined)
        .then(p => { setPreview(p); setPort(String(p.port)); })
        .catch(() => setPreview(null))
        .finally(() => setLoadingPreview(false));
    }
  }, [step, includePocketbase]);

  const handleSelectPlatform = (platform: string) => {
    setSelectedPlatform(platform);
    setConnectName(`${platform}-monastery`);
    const connected = platform === 'dokploy' ? !!dokploy : !!coolify;
    setStep(connected ? 2 : 1);
  };

  const handleConnect = async () => {
    if (!connectUrl.trim() || !connectToken.trim()) { setConnectError('URL and API token are required.'); return; }
    setConnecting(true); setConnectError(null);
    try {
      await connectService({ name: connectName || selectedPlatform, service_type: selectedPlatform as 'dokploy' | 'coolify', base_url: connectUrl.trim(), api_token: connectToken.trim() });
      setStep(2);
    } catch (e: any) {
      setConnectError(e.message || 'Connection failed');
    } finally { setConnecting(false); }
  };

  const handleDeploy = async () => {
    if (!currentProject?.id) return;
    if (!activePlatformConn) { setDeployError('No deployment platform configured.'); return; }
    setDeploying(true); setDeployError(null); setDeployResult(null);
    try {
      const result = await deployProject({
        connection_id: activePlatformConn.id, project_id: currentProject.id,
        app_name: appName.trim() || 'monastery-app', domain: domain.trim() || undefined,
        port: parseInt(port) || 3000, include_pocketbase: includePocketbase,
        pocketbase_connection_id: includePocketbase ? pocketbase?.id : undefined,
      });
      setDeployResult(result);
    } catch (e: any) { setDeployError(e.message || 'Deployment failed'); }
    finally { setDeploying(false); }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopiedFile(id); setTimeout(() => setCopiedFile(null), 2000); });
  };

  const getCombinedManualCommands = (): string => {
    if (!preview) return '';
    const lines = ['# === Generated by Monastery ===', `# Framework: ${preview.framework} | Port: ${preview.port}`, ''];
    if (includePocketbase) {
      lines.push('# 1. Save the docker-compose.yml below', '# 2. Then run:', 'docker compose up -d', '', '# Or build individually:');
    }
    lines.push(`docker build -t ${appName} .`);
    lines.push(`docker run -d -p ${preview.port}:${preview.port} --name ${appName} ${appName}`);
    return lines.join('\n');
  };

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
                <button onClick={() => { if (i <= step || (i === 1 && platformConnected)) setStep(i); }}
                  disabled={i > step && !(i === 1 && platformConnected)}
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
            <p className="text-xs text-monastery-text-muted">Select where to deploy. Connect your platform in Settings first, or set it up here.</p>
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
                        : <span className="text-xs text-monastery-text-muted">Not configured</span>}</div>
                    <ChevronRight size={16} className="text-monastery-text-muted" /></div>
                  <p className="text-xs text-monastery-text-muted mt-1">{platform === 'dokploy' ? 'Self-hosted PaaS — deploy apps, databases, and Docker containers' : 'Self-hosted deployment platform — Vercel/Netlify alternative'}</p>
                </button>);
            })}
          </div>)}

          {/* STEP 1: Connect */}
          {step === 1 && (<div className="space-y-3">
            <h3 className="text-sm font-medium text-monastery-text-primary flex items-center gap-2"><Upload size={16} className="text-monastery-lantern" /> Connect to {selectedPlatform === 'dokploy' ? 'Dokploy' : 'Coolify'}</h3>
            <p className="text-xs text-monastery-text-muted">Enter your platform's URL and API token from the dashboard under Settings → API Tokens.</p>
            <div><label className="block text-xs font-medium text-monastery-text-secondary mb-1">Instance URL</label>
              <input type="text" value={connectUrl} onChange={e => setConnectUrl(e.target.value)}
                placeholder={selectedPlatform === 'dokploy' ? 'https://dokploy.yourdomain.com' : 'https://coolify.yourdomain.com'}
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none" /></div>
            <div><label className="block text-xs font-medium text-monastery-text-secondary mb-1">API Token</label>
              <input type="password" value={connectToken} onChange={e => setConnectToken(e.target.value)} placeholder="Enter your API token..."
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none" /></div>
            <div><label className="block text-xs font-medium text-monastery-text-secondary mb-1">Connection Name (optional)</label>
              <input type="text" value={connectName} onChange={e => setConnectName(e.target.value)} placeholder="My Server"
                className="w-full px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-monastery-text-primary text-sm placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none" /></div>
            {connectError && <div className="p-3 rounded-lg text-xs bg-red-400/10 text-red-400 flex items-center gap-2"><XCircle size={14} /> {connectError}</div>}
            <button onClick={handleConnect} disabled={connecting || !connectUrl.trim() || !connectToken.trim()}
              className="w-full px-4 py-2 text-sm bg-monastery-pine text-white rounded-lg hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium transition-colors">
              {connecting ? <><Loader2 size={14} className="animate-spin" /> Connecting...</> : 'Connect & Continue'}</button>
          </div>)}

          {/* STEP 2: Configure */}
          {step === 2 && (<div className="space-y-4">
            <h3 className="text-sm font-medium text-monastery-text-primary flex items-center gap-2"><Rocket size={16} className="text-monastery-lantern" /> Configure Your Deployment</h3>
            <div className={`p-2 rounded-lg border text-xs flex items-center gap-2 ${activePlatformConn ? 'border-green-400/30 bg-green-400/5 text-green-400' : 'border-monastery-dark-border bg-monastery-dark-bg text-monastery-text-muted'}`}>
              <CheckCircle2 size={12} />{activePlatformConn ? `Deploying to ${activePlatformConn.service_type} (${activePlatformConn.base_url})` : 'No platform connected'}</div>
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
              <p className="text-xs text-monastery-text-muted">{includePocketbase ? 'Adds Pocketbase (database, auth, file storage) as a service in docker-compose.yml.' : 'Enable if your app needs a database backend.'}</p>
              {includePocketbase && !pocketbase && <p className="text-xs text-amber-400 flex items-center gap-1"><AlertTriangle size={12} /> Pocketbase not configured in Settings. Will use public Docker image.</p>}</div>
            <div className={`p-2 rounded-lg border text-xs ${hasGit ? 'border-green-400/30 bg-green-400/5 text-green-400' : 'border-monastery-dark-border bg-monastery-dark-bg text-monastery-text-muted'}`}>
              <GitBranch size={12} className="inline mr-1" />{hasGit ? `${gitConns.length} Git forge(s) connected` : 'No Git forges — deploy from local project'}</div>
            {/* Generated Files Preview */}
            <div>
              <button onClick={() => setShowPreview(!showPreview)} className="flex items-center gap-2 text-xs text-monastery-text-secondary hover:text-monastery-text-primary transition-colors">
                {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}{showPreview ? 'Hide' : 'Show'} Generated Files{loadingPreview && <Loader2 size={12} className="animate-spin" />}</button>
              {showPreview && preview && (<div className="mt-2 space-y-2">
                <div className="flex items-center gap-2 text-xs text-monastery-text-muted"><span>Framework: <span className="text-monastery-text-primary">{preview.framework}</span></span><span>•</span><span>Port: <span className="text-monastery-text-primary">{preview.port}</span></span></div>
                {preview.files.map((file) => (<div key={file.name} className="rounded-lg border border-monastery-dark-border overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-monastery-dark-tertiary border-b border-monastery-dark-border">
                    <span className="text-xs font-medium text-monastery-text-primary">{file.name}</span>
                    <button onClick={() => copyToClipboard(file.content, file.name)} className="flex items-center gap-1 text-xs text-monastery-text-muted hover:text-monastery-text-primary transition-colors">
                      {copiedFile === file.name ? <><Check size={12} className="text-green-400" /> Copied</> : <><Copy size={12} /> Copy</>}</button></div>
                  <pre className="p-3 text-xs text-monastery-text-secondary font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">{file.content}</pre></div>))}</div>)}</div></div>)}

          {/* STEP 3: Deploy */}
          {step === 3 && (<div className="space-y-4">
            <h3 className="text-sm font-medium text-monastery-text-primary flex items-center gap-2"><Rocket size={16} className="text-monastery-lantern" /> Deploy</h3>
            <div className="p-3 rounded-lg border border-monastery-dark-border bg-monastery-dark-bg space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-monastery-text-muted">App:</span><span className="text-monastery-text-primary">{appName}</span></div>
              <div className="flex justify-between"><span className="text-monastery-text-muted">Platform:</span><span className="text-monastery-text-primary">{activePlatformConn?.service_type || '—'}</span></div>
              <div className="flex justify-between"><span className="text-monastery-text-muted">Port:</span><span className="text-monastery-text-primary">{port}</span></div>
              {domain && <div className="flex justify-between"><span className="text-monastery-text-muted">Domain:</span><span className="text-monastery-text-primary">{domain}</span></div>}
              <div className="flex justify-between"><span className="text-monastery-text-muted">Database:</span><span className="text-monastery-text-primary">{includePocketbase ? 'Pocketbase' : 'None'}</span></div></div>
            <div className="flex border-b border-monastery-dark-border">
              <button onClick={() => setDeployTab('auto')} className={`px-3 py-2 text-xs font-medium transition-colors ${deployTab === 'auto' ? 'text-monastery-lantern border-b-2 border-monastery-lantern' : 'text-monastery-text-secondary hover:text-monastery-text-primary'}`}>🚀 Auto Deploy</button>
              <button onClick={() => setDeployTab('manual')} className={`px-3 py-2 text-xs font-medium transition-colors ${deployTab === 'manual' ? 'text-monastery-lantern border-b-2 border-monastery-lantern' : 'text-monastery-text-secondary hover:text-monastery-text-primary'}`}><Terminal size={12} className="inline mr-1" /> Manual</button></div>
            {deployTab === 'auto' && (<>
              {deployError && <div className="p-3 rounded-lg text-xs bg-red-400/10 text-red-400 flex items-center gap-2"><AlertTriangle size={14} /> {deployError}</div>}
              {deployResult && (<div className="p-3 rounded-lg text-xs bg-green-400/10 text-green-400 space-y-2">
                <div className="flex items-center gap-2 font-medium"><CheckCircle2 size={14} /> App created on {deployResult.platform}!</div>
                <p className="text-monastery-text-secondary">Framework: <span className="text-monastery-text-primary">{deployResult.framework}</span> — Port: {deployResult.port}</p>
                {deployResult.deploy_triggered && <p className="text-monastery-text-secondary">Deployment triggered — building now.</p>}
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
              {preview.files.map((file) => (<div key={file.name} className="rounded-lg border border-monastery-dark-border overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-monastery-dark-tertiary border-b border-monastery-dark-border">
                  <span className="text-xs font-medium text-monastery-text-primary">{file.name}</span>
                  <button onClick={() => copyToClipboard(file.content, file.name)} className="flex items-center gap-1 text-xs text-monastery-text-muted hover:text-monastery-text-primary transition-colors">
                    {copiedFile === file.name ? <><Check size={12} className="text-green-400" /> Copied</> : <><Copy size={12} /> Copy</>}</button></div>
                <pre className="p-3 text-xs text-monastery-text-secondary font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">{file.content}</pre></div>))}</div>)}</div>)}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-monastery-dark-border shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {step > 0 && <button onClick={() => setStep(step - 1)} className="px-3 py-1.5 text-xs bg-monastery-dark-tertiary text-monastery-text-primary rounded-md hover:bg-monastery-dark-border transition-colors flex items-center gap-1"><ChevronLeft size={14} /> Back</button>}</div>
          <div className="flex items-center gap-2">
            <button onClick={() => { resetState(); onClose(); }} className="px-3 py-1.5 text-xs text-monastery-text-muted hover:text-monastery-text-primary transition-colors">Close</button>
            {step < 3 && <button onClick={() => setStep(step + 1)} disabled={step === 0 && !selectedPlatform}
              className="px-4 py-1.5 text-xs bg-monastery-pine text-white rounded-md hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 font-medium transition-colors">Next <ChevronRight size={14} /></button>}</div></div>
        {!currentProject && <div className="px-5 pb-4"><p className="text-xs text-monastery-text-muted text-center">Open a project first to enable deployment.</p></div>}
      </div></div>);
}
