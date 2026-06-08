import { useState, useCallback } from 'react';
import useSWR from 'swr';

export type GitForgeType = 'github' | 'gitlab' | 'forgejo';

export interface GitConnection {
  id: string;
  name: string;
  forge_type: GitForgeType;
  base_url: string;
  api_token: string;
  username: string | null;
  email: string | null;
  is_default: boolean;
  created_at: string;
  last_synced_at: string | null;
}

export interface GitRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  description: string | null;
  private: boolean;
  default_branch: string;
}

export interface GitBranchInfo {
  name: string;
  is_default: boolean;
}

export interface GitStatus {
  branch: string;
  is_clean: boolean;
  ahead: number;
  behind: number;
  changed_files: string[];
  has_remote: boolean;
  remote_url: string | null;
}

export interface ConnectForgeRequest {
  name: string;
  forge_type: GitForgeType;
  base_url?: string;
  api_token: string;
  email?: string;
}

export interface GitPushRequest {
  connection_id: string;
  repo_name: string;
  repo_description?: string;
  private: boolean;
  branch?: string;
  commit_message?: string;
}

export interface GitCloneRequest {
  connection_id: string;
  repo_full_name: string;
  project_name?: string;
  branch?: string;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return res.json();
};

export function useGitForge(projectId?: string | null) {
  const { data: connections, error, mutate } = useSWR<GitConnection[]>(
    '/api/git/connections',
    fetcher,
    { refreshInterval: 30000 }
  );

  const statusUrl = projectId ? `/api/git/status?project_id=${encodeURIComponent(projectId)}` : null;
  const { data: gitStatus, mutate: mutateStatus } = useSWR<GitStatus>(
    statusUrl,
    fetcher,
    { refreshInterval: 15000 }
  );

  const connectForge = useCallback(async (req: ConnectForgeRequest) => {
    const res = await fetch('/api/git/connections', {
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
    const res = await fetch(`/api/git/connections/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to delete' }));
      throw new Error(err.error || 'Failed to delete');
    }
    await mutate();
  }, [mutate]);

  const testConnection = useCallback(async (id: string) => {
    const res = await fetch(`/api/git/connections/${id}/test`, {
      method: 'POST',
    });
    return res.json();
  }, []);

  const listRepos = useCallback(async (connectionId: string): Promise<GitRepo[]> => {
    const res = await fetch(`/api/git/connections/${connectionId}/repos`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to list repos' }));
      throw new Error(err.error || 'Failed to list repos');
    }
    return res.json();
  }, []);

  const pushProject = useCallback(async (req: GitPushRequest) => {
    const res = await fetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Push failed' }));
      throw new Error(err.error || 'Push failed');
    }
    await mutateStatus();
    return res.json();
  }, [mutateStatus]);

  const cloneRepo = useCallback(async (req: GitCloneRequest) => {
    const res = await fetch('/api/git/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Clone failed' }));
      throw new Error(err.error || 'Clone failed');
    }
    return res.json();
  }, []);

  const listBranches = useCallback(async (connectionId: string, repoFullName: string): Promise<GitBranchInfo[]> => {
    const res = await fetch(`/api/git/connections/${connectionId}/branches?repo_full_name=${encodeURIComponent(repoFullName)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to list branches' }));
      throw new Error(err.error || 'Failed to list branches');
    }
    return res.json();
  }, []);

  return {
    connections: connections || [],
    gitStatus: gitStatus || null,
    isLoading: !error && !connections,
    error,
    connectForge,
    deleteConnection,
    testConnection,
    listRepos,
    listBranches,
    pushProject,
    cloneRepo,
    refreshConnections: mutate,
    refreshStatus: mutateStatus,
  };
}
