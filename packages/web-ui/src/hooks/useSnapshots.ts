import { useState, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { SnapshotDetail, SnapshotDiff } from '../types';

interface CreateSnapshotRequest {
  name?: string;
  description?: string;
  created_by?: string;
  trigger?: 'manual' | 'auto_save' | 'before_change' | 'after_change' | 'pre_deployment' | 'user_request';
  files: Array<{
    file_path: string;
    content?: string;
  }>;
}

interface RestoreSnapshotOptions {
  dry_run?: boolean;
  create_backup?: boolean;
}

const API_BASE = '/api';

export function useSnapshots() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentProject = useAppStore((state) => state.currentProject);

  const listSnapshots = useCallback(async (page = 1, perPage = 50) => {
    if (!currentProject) return null;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `${API_BASE}/projects/${currentProject.id}/snapshots?page=${page}&per_page=${perPage}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch snapshots');
      }
      
      return await response.json();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [currentProject]);

  const getSnapshot = useCallback(async (snapshotId: string): Promise<SnapshotDetail | null> => {
    if (!currentProject) return null;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `${API_BASE}/projects/${currentProject.id}/snapshots/${snapshotId}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch snapshot');
      }
      
      return await response.json();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [currentProject]);

  const createSnapshot = useCallback(async (request: CreateSnapshotRequest) => {
    if (!currentProject) return null;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(
        `${API_BASE}/projects/${currentProject.id}/snapshots`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }
      );
      
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create snapshot');
      }
      
      return await response.json();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [currentProject]);

  const restoreSnapshot = useCallback(
    async (snapshotId: string, options: RestoreSnapshotOptions = {}) => {
      if (!currentProject) return null;

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `${API_BASE}/projects/${currentProject.id}/snapshots/${snapshotId}/restore`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options),
          }
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to restore snapshot');
        }

        return await response.json();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [currentProject]
  );

  const deleteSnapshot = useCallback(async (snapshotId: string): Promise<boolean> => {
    if (!currentProject) return false;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${API_BASE}/projects/${currentProject.id}/snapshots/${snapshotId}`,
        {
          method: 'DELETE',
        }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete snapshot');
      }

      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [currentProject]);

  const diffSnapshots = useCallback(
    async (snapshotId: string, targetId?: string): Promise<SnapshotDiff | null> => {
      if (!currentProject) return null;

      setIsLoading(true);
      setError(null);

      try {
        const url = new URL(
          `${API_BASE}/projects/${currentProject.id}/snapshots/${snapshotId}/diff`
        );
        if (targetId) {
          url.searchParams.set('target', targetId);
        }

        const response = await fetch(url.toString());

        if (!response.ok) {
          throw new Error('Failed to compare snapshots');
        }

        return await response.json();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [currentProject]
  );

  return {
    listSnapshots,
    getSnapshot,
    createSnapshot,
    restoreSnapshot,
    deleteSnapshot,
    diffSnapshots,
    isLoading,
    error,
  };
}
