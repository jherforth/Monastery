import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';

export interface SnapshotSummary {
  id: string;
  project_id: string;
  name: string;
  description?: string;
  created_at: string;
  created_by?: string;
  parent_snapshot_id?: string;
  is_active: boolean;
  tags: string[];
  files_count: number;
  total_size_bytes: number;
}

export interface SnapshotFile {
  id: string;
  snapshot_id: string;
  file_path: string;
  content?: string;
  file_hash: string;
  created_at: string;
  size_bytes: number;
}

export interface SnapshotDetail {
  snapshot: SnapshotSummary;
  files: SnapshotFile[];
}

export interface CreateSnapshotRequest {
  name?: string;
  description?: string;
  created_by?: string;
  trigger?: 'manual' | 'auto_save' | 'before_change' | 'after_change' | 'pre_deployment' | 'user_request';
  files: Array<{
    file_path: string;
    content?: string;
  }>;
}

export interface RestoreSnapshotOptions {
  dry_run?: boolean;
  create_backup?: boolean;
}

export interface SnapshotDiff {
  added_files: FileDiff[];
  removed_files: FileDiff[];
  modified_files: FileDiff[];
  unchanged_files: FileDiff[];
}

export interface FileDiff {
  file_path: string;
  old_hash?: string;
  new_hash?: string;
  old_size: number;
  new_size: number;
  change_type: 'added' | 'removed' | 'modified' | 'unchanged';
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
