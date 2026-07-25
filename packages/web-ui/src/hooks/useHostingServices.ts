import { useCallback } from 'react';
import useSWR from 'swr';
import { fetcher, apiPost, apiDelete } from '../lib/fetch';
import type { HostingServiceConnection, HostingServiceType } from '../types';

export interface ConnectHostingRequest {
  name: string;
  service_type: HostingServiceType;
  base_url: string;
  api_token: string;
  email?: string;
}

interface DeployRequest {
  connection_id: string;
  project_id: string;
  app_name: string;
  server_uuid?: string;
  domain?: string;
  port?: number;
  include_pocketbase?: boolean;
  pocketbase_connection_id?: string;
  include_cloudflare_tunnel?: boolean;
  cloudflare_tunnel_token?: string;
  /** Cloudflare API connection for automated tunnel routing (Public Hostname + DNS). */
  cloudflare_connection_id?: string;
}

export interface HostingServer {
  uuid: string;
  name: string;
  ip?: string | null;
  is_localhost: boolean;
  is_usable: boolean;
}

export interface DeployResult {
  success: boolean;
  platform: string;
  app_uuid?: string;
  app_id?: string;
  app_name: string;
  deploy_triggered: boolean;
  dashboard_url: string;
  framework: string;
  port: number;
  redeployed?: boolean;
  server?: string;
  server_is_localhost?: boolean;
  host_port?: number;
  access_url?: string | null;
  tunnel_requested?: boolean;
  tunnel_deployed?: boolean;
  tunnel_error?: string | null;
  tunnel_service_url?: string | null;
  /** Always present: the app's published URL on the deploy host (http://127.0.0.1:<host_port>) —
   *  the Service target for a tunnel Public Hostname, tunnel toggle or not. */
  host_service_url?: string | null;
  /** Portable deployment identity from .monastery/deploy.json. */
  deploy_id?: string;
  /** True when an existing platform app was adopted via the manifest marker (no duplicate created). */
  adopted?: boolean;
  /** True when the deployed branch differs from the one the manifest recorded. */
  branch_mismatch?: boolean;
  /** Cloudflare routing automation outcome (undefined = not applicable). */
  routing_configured?: boolean | null;
  routing_error?: string | null;
  routed_url?: string | null;
  pocketbase_url?: string | null;
}

export interface PreviewResult {
  framework: string;
  build_command: string;
  output_dir: string;
  default_port: number;
  port: number;
  app_name: string;
  files: Array<{
    name: string;
    content: string;
    language: string;
  }>;
}

export function useHostingServices() {
  const { data: connections, error, mutate } = useSWR<HostingServiceConnection[]>(
    '/api/hosting/connections',
    fetcher,
    { refreshInterval: 30000 }
  );

  const connectService = useCallback(async (req: ConnectHostingRequest) => {
    const result = await apiPost('/api/hosting/connections', req, 'Failed to connect');
    await mutate();
    return result;
  }, [mutate]);

  const deleteConnection = useCallback(async (id: string) => {
    await apiDelete(`/api/hosting/connections/${id}`, 'Failed to delete');
    await mutate();
  }, [mutate]);

  const testConnection = useCallback(async (id: string) => {
    const res = await fetch(`/api/hosting/connections/${id}/test`, {
      method: 'POST',
    });
    return res.json() as Promise<{ healthy: boolean; message: string }>;
  }, []);

  const listServers = useCallback(async (connectionId: string): Promise<HostingServer[]> => {
    const res = await fetch(`/api/hosting/connections/${connectionId}/servers`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to list servers' }));
      throw new Error(err.error || 'Failed to list servers');
    }
    return res.json();
  }, []);

  const fetchDeploymentLog = useCallback(async (connectionId: string, appId: string): Promise<{ status: string; logs: string; detail?: string }> => {
    const res = await fetch(`/api/hosting/connections/${connectionId}/deployment-log?app=${encodeURIComponent(appId)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to fetch deployment log' }));
      throw new Error(err.error || 'Failed to fetch deployment log');
    }
    return res.json();
  }, []);

  const deployProject = useCallback(async (req: DeployRequest): Promise<DeployResult> => {
    const res = await fetch('/api/hosting/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Deploy failed' }));
      throw new Error(err.error || 'Deploy failed');
    }
    return res.json();
  }, []);

  const previewDeploy = useCallback(async (
    projectId: string,
    includePocketbase: boolean,
    includeTunnel: boolean,
    appName?: string,
    port?: number,
  ): Promise<PreviewResult> => {
    const res = await fetch('/api/hosting/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        include_pocketbase: includePocketbase,
        include_cloudflare_tunnel: includeTunnel,
        app_name: appName,
        port,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Preview failed' }));
      throw new Error(err.error || 'Preview failed');
    }
    return res.json();
  }, []);

  return {
    connections: connections || [],
    isLoading: !error && !connections,
    error,
    connectService,
    deleteConnection,
    testConnection,
    listServers,
    fetchDeploymentLog,
    deployProject,
    previewDeploy,
    refreshConnections: mutate,
  };
}
