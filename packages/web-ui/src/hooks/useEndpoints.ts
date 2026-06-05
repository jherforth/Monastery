import { useState, useCallback } from 'react';
import useSWR from 'swr';

export interface EndpointConfig {
  id: string;
  name: string;
  base_url: string;
  api_key?: string;
  is_favorite: boolean;
  is_local: boolean;
  created_at: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
  capabilities?: string[];
}

export interface TestEndpointResponse {
  endpoint_id: string;
  is_healthy: boolean;
  message: string;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return res.json();
};

export function useEndpoints() {
  const { data: endpoints, error, mutate } = useSWR<EndpointConfig[]>(
    '/api/endpoints',
    fetcher
  );

  const addEndpoint = useCallback(async (endpoint: {
    name: string;
    base_url: string;
    api_key?: string;
  }) => {
    const res = await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(endpoint),
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Failed to add endpoint' }));
      throw new Error(error.error || 'Failed to add endpoint');
    }
    
    const newEndpoint = await res.json();
    await mutate();
    return newEndpoint;
  }, [mutate]);

  const deleteEndpoint = useCallback(async (id: string) => {
    const res = await fetch(`/api/endpoints/${id}`, {
      method: 'DELETE',
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Failed to delete endpoint' }));
      throw new Error(error.error || 'Failed to delete endpoint');
    }
    
    await mutate();
  }, [mutate]);

  const testEndpoint = useCallback(async (id: string) => {
    const res = await fetch(`/api/endpoints/${id}/test`, {
      method: 'POST',
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Failed to test endpoint' }));
      throw new Error(error.error || 'Failed to test endpoint');
    }
    
    return res.json() as Promise<TestEndpointResponse>;
  }, []);

  return {
    endpoints: endpoints || [],
    isLoading: !error && !endpoints,
    isError: error,
    addEndpoint,
    deleteEndpoint,
    testEndpoint,
    mutate,
  };
}

export function useModels(endpointId?: string) {
  const url = endpointId 
    ? `/api/models?endpoint_id=${endpointId}`
    : '/api/models';
  
  const { data: models, error, mutate } = useSWR<ModelInfo[]>(url, fetcher);

  return {
    models: models || [],
    isLoading: !error && !models,
    isError: error,
    mutate,
  };
}
