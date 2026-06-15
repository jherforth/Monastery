import { useCallback } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetch';
import type { HostingServiceConnection, HostingServiceType } from '../types';

export interface ConnectHostingRequest {
  name: string;
  service_type: HostingServiceType;
  base_url: string;
  api_token: string;
  email?: string;
}

export function useHostingServices() {
  const { data: connections, error, mutate } = useSWR<HostingServiceConnection[]>(
    '/api/hosting/connections',
    fetcher,
    { refreshInterval: 30000 }
  );

  const connectService = useCallback(async (req: ConnectHostingRequest) => {
    const res = await fetch('/api/hosting/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to connect' }));
      throw new Error(err.error || 'Failed to connect');
    }
    await mutate();
    return res.json();
  }, [mutate]);

  const deleteConnection = useCallback(async (id: string) => {
    const res = await fetch(`/api/hosting/connections/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to delete' }));
      throw new Error(err.error || 'Failed to delete');
    }
    await mutate();
  }, [mutate]);

  const testConnection = useCallback(async (id: string) => {
    const res = await fetch(`/api/hosting/connections/${id}/test`, {
      method: 'POST',
    });
    return res.json() as Promise<{ healthy: boolean; message: string }>;
  }, []);

  return {
    connections: connections || [],
    isLoading: !error && !connections,
    error,
    connectService,
    deleteConnection,
    testConnection,
    refreshConnections: mutate,
  };
}
