import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppState, Message, LLMEndpoint, Project, Session, SnapshotSummary, SnapshotDetail, SnapshotDiff } from '../types';

const defaultLayout = {
  chat: 25,
  editor: 50,
  preview: 25,
};

interface AppStore extends AppState {
  // Snapshot state
  currentSnapshots: SnapshotSummary[];
  selectedSnapshot: SnapshotDetail | null;
  isCreatingSnapshot: boolean;
  isRestoring: boolean;
  
  // Actions
  setCurrentProject: (project: Project | null) => void;
  setCurrentSession: (session: Session | null) => void;
  addMessage: (message: Message) => void;
  updateEndpoint: (endpoint: LLMEndpoint) => void;
  setActiveEndpoint: (endpoint: { id: string; name: string } | null) => void;
  setTheme: (theme: 'monastery-dark' | 'scriptorium-light') => void;
  toggleSidebar: () => void;
  togglePreview: () => void;
  updatePaneLayout: (layout: { chat: number; editor: number; preview: number }) => void;
  setResourceUsage: (usage: { cpu: number; memory: number; gpu?: number }) => void;
  
  // Snapshot actions
  setCurrentSnapshots: (snapshots: SnapshotSummary[]) => void;
  setSelectedSnapshot: (snapshot: SnapshotDetail | null) => void;
  setCreatingSnapshot: (creating: boolean) => void;
  setRestoring: (restoring: boolean) => void;
  lastRestoredSnapshotId: string | null;
  setLastRestoredSnapshotId: (id: string | null) => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // Initial state
      currentProject: null,
      sessions: [],
      currentSession: null,
      endpoints: [],
      activeEndpoint: null,
      resourceUsage: null,
      integrations: [],
      theme: 'monastery-dark',
      sidebarCollapsed: true,
      previewCollapsed: true,
      paneLayout: defaultLayout,
      
      // Snapshot initial state
      currentSnapshots: [],
      selectedSnapshot: null,
      isCreatingSnapshot: false,
      isRestoring: false,

      // Actions
      setCurrentProject: (project) => set({ currentProject: project }),
      
      setCurrentSession: (session) => set({ currentSession: session }),
      
      addMessage: (message) => set((state) => {
        if (!state.currentSession) return state;
        
        const updatedSession = {
          ...state.currentSession,
          messages: [...state.currentSession.messages, message],
          updatedAt: Date.now(),
        };
        
        return {
          currentSession: updatedSession,
          sessions: state.sessions.map(s => 
            s.id === updatedSession.id ? updatedSession : s
          ),
        };
      }),
      
      updateEndpoint: (endpoint) => set((state) => ({
        endpoints: state.endpoints.map(e => 
          e.id === endpoint.id ? endpoint : e
        ),
        activeEndpoint: state.activeEndpoint?.id === endpoint.id ? endpoint : state.activeEndpoint,
      })),
      
      setActiveEndpoint: (endpoint) => set({
        activeEndpoint: endpoint ? {
          id: endpoint.id,
          name: endpoint.name,
          url: '',
          status: 'connected' as const,
          isLocal: false,
          priority: 1,
        } : null,
      }),
      
      setTheme: (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        set({ theme });
      },
      
      toggleSidebar: () => set((state) => ({ 
        sidebarCollapsed: !state.sidebarCollapsed 
      })),
      
      togglePreview: () => set((state) => ({ 
        previewCollapsed: !state.previewCollapsed 
      })),
      
      updatePaneLayout: (layout) => set({ paneLayout: layout }),
      
      setResourceUsage: (usage) => set((state) => ({
        resourceUsage: {
          ...state.resourceUsage,
          ...usage,
        },
      })),
      
      // Snapshot actions
      setCurrentSnapshots: (snapshots) => set({ currentSnapshots: snapshots }),
      
      setSelectedSnapshot: (snapshot) => set({ selectedSnapshot: snapshot }),
      
      setCreatingSnapshot: (creating) => set({ isCreatingSnapshot: creating }),
      
      setRestoring: (restoring) => set({ isRestoring: restoring }),
      lastRestoredSnapshotId: null,
      setLastRestoredSnapshotId: (id) => set({ lastRestoredSnapshotId: id }),
    }),
    {
      name: 'monastery-storage',
      partialize: (state) => ({
        theme: state.theme,
        paneLayout: state.paneLayout,
        sidebarCollapsed: state.sidebarCollapsed,
        previewCollapsed: state.previewCollapsed,
        endpoints: state.endpoints,
      }),
    }
  )
);
