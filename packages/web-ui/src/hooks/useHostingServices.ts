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
  domain?: string;
  port?: number;
  include_pocketbase?: boolean;
  pocketbase_connection_id?: string;
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

  const previewDeploy = useCallback(async (projectId: string, includePocketbase: boolean, appName?: string, port?: number): Promise<PreviewResult> => {
    const res = await fetch('/api/hosting/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        include_pocketbase: includePocketbase,
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
    deployProject,
    previewDeploy,
    refreshConnections: mutate,
  };
}
