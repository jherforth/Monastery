import { useState, useCallback } from 'react';
import { SessionInfo, SessionDetail, SessionMessage } from '../types';

interface CreateSessionParams {
  title?: string;
}

export function useSessions(projectId: string | null) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiBase = '/api';

  // Fetch all sessions for a project
  const fetchSessions = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/projects/${projectId}/sessions`);
      if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
      const data: SessionInfo[] = await res.json();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Create a new session
  const createSession = useCallback(async (params?: CreateSessionParams): Promise<SessionDetail | null> => {
    if (!projectId) return null;
    setError(null);
    try {
      const res = await fetch(`${apiBase}/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
      if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
      const session: SessionDetail = await res.json();
      await fetchSessions(); // Refresh list
      setCurrentSession(session);
      return session;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [projectId, fetchSessions]);

  // Get a session with its messages
  const getSession = useCallback(async (sessionId: string): Promise<SessionDetail | null> => {
    if (!projectId) return null;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/projects/${projectId}/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`Failed to get session: ${res.status}`);
      const session: SessionDetail = await res.json();
      setCurrentSession(session);
      return session;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Delete a session
  const deleteSession = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!projectId) return false;
    setError(null);
    try {
      const res = await fetch(`${apiBase}/projects/${projectId}/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`);
      if (currentSession?.id === sessionId) {
        setCurrentSession(null);
      }
      await fetchSessions();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [projectId, fetchSessions, currentSession]);

  // Add a message to the current session (saves to backend)
  const addMessage = useCallback(async (message: { role: string; content: string; model?: string }): Promise<SessionMessage | null> => {
    if (!projectId || !currentSession?.id) return null;
    try {
      const res = await fetch(`${apiBase}/projects/${projectId}/sessions/${currentSession.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!res.ok) throw new Error(`Failed to add message: ${res.status}`);
      const msg: SessionMessage = await res.json();
      
      // Update local state
      setCurrentSession(prev => prev ? {
        ...prev,
        messages: [...prev.messages, msg],
        updated_at: new Date().toISOString(),
      } : null);
      
      return msg;
    } catch (err) {
      console.error('Failed to save message:', err);
      return null;
    }
  }, [projectId, currentSession]);

  return {
    sessions,
    currentSession,
    isLoading,
    error,
    fetchSessions,
    createSession,
    getSession,
    deleteSession,
    addMessage,
    setCurrentSession,
  };
}
