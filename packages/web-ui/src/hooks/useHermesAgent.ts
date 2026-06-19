import { useCallback } from 'react';
import useSWR from 'swr';
import { apiPost, apiDelete } from '../lib/fetch';

export interface HermesConnection {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  is_default: boolean;
  created_at: string;
  last_used_at: string | null;
}

interface HermesConnectionList {
  connections: HermesConnection[];
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export function useHermesAgent() {
  const {
    data,
    error,
    isLoading,
    mutate,
  } = useSWR<HermesConnectionList>('/api/hermes/connections', fetcher, {
    revalidateOnFocus: false,
  });

  const connections = data?.connections ?? [];

  const createConnection = useCallback(async (name: string, base_url: string, api_key: string) => {
    const result = await apiPost<HermesConnection>('/api/hermes/connections', {
      name,
      base_url,
      api_key,
    }, 'Failed to create Hermes connection');
    await mutate();
    return result;
  }, [mutate]);

  const deleteConnection = useCallback(async (id: string) => {
    await apiDelete(`/api/hermes/connections/${id}`, 'Failed to delete Hermes connection');
    await mutate();
  }, [mutate]);

  const testConnection = useCallback(async (id: string) => {
    const res = await fetch(`/api/hermes/connections/${id}/test`, { method: 'POST' });
    return res.json() as Promise<{ success: boolean; status: number; error?: string }>;
  }, []);

  const setDefault = useCallback(async (id: string) => {
    await fetch(`/api/hermes/connections/${id}/default`, { method: 'POST' });
    await mutate();
  }, [mutate]);

  return {
    connections,
    defaultConnection: connections.find((c: HermesConnection) => c.is_default) ?? null,
    isLoading,
    error,
    createConnection,
    deleteConnection,
    testConnection,
    setDefault,
    refresh: () => mutate(),
  };
}
