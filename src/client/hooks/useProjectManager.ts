import { useCallback, useEffect, useState } from "react";
import type { ProjectCandidate } from "../types";
import type { AppConfig, ProjectConfig } from "../../shared/contracts";

type Logger = (message: string) => void;

type Hooks = {
  isConnected: boolean;
  disconnect: () => void;
  requestConfirm: (dialog: {
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
  }) => void;
  onSystemLog: Logger;
  onAfterChange?: () => void;
};

export function useProjectManager({
  isConnected,
  disconnect,
  requestConfirm,
  onSystemLog,
  onAfterChange
}: Hooks) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [candidates, setCandidates] = useState<ProjectCandidate[]>([]);
  const [projectError, setProjectError] = useState("");
  const [isDiscovering, setIsDiscovering] = useState(false);

  const refreshConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/config");
      setConfig((await response.json()) as AppConfig);
    } catch (error) {
      onSystemLog(`Failed to load config: ${String(error)}`);
    }
  }, [onSystemLog]);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  const wrapWithConfirm = useCallback(
    (action: () => void | Promise<void>, summary: string) => {
      if (!isConnected) {
        void action();
        return;
      }
      requestConfirm({
        title: "Disconnect realtime session?",
        body: `${summary} The current GPT-Realtime-2 session will be disconnected.`,
        confirmLabel: "Continue",
        onConfirm: action
      });
    },
    [isConnected, requestConfirm]
  );

  const ensureDisconnected = useCallback(() => {
    if (isConnected) {
      disconnect();
      onSystemLog("Realtime session disconnected because the active project changed.");
    }
  }, [disconnect, isConnected, onSystemLog]);

  const selectProject = useCallback(
    (projectId: string) => {
      if (!config) return;
      if (!projectId) {
        deselectProject();
        return;
      }
      if (projectId === config.activeProject?.id) return;

      const target = config.projects.find((project) => project.id === projectId);
      wrapWithConfirm(async () => {
        ensureDisconnected();
        setProjectError("");
        const response = await fetch(`/api/projects/${projectId}/select`, { method: "POST" });
        const data = await response.json();
        if (!response.ok) {
          setProjectError(String(data.error ?? "Failed to select project."));
          return;
        }
        setConfig((current) => ({
          ...(current ?? data),
          activeProject: data.activeProject as ProjectConfig,
          projects: data.projects as ProjectConfig[]
        }));
        onAfterChange?.();
        onSystemLog(`Working in ${data.activeProject.path}`);
      }, `Switching to ${target?.name ?? projectId}.`);
    },
    [config, ensureDisconnected, onAfterChange, onSystemLog, wrapWithConfirm]
  );

  const deselectProject = useCallback(() => {
    wrapWithConfirm(async () => {
      ensureDisconnected();
      setProjectError("");
      const response = await fetch("/api/projects/deselect", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setProjectError(String(data.error ?? "Failed to clear the active project."));
        return;
      }
      setConfig((current) => ({
        ...(current ?? data),
        activeProject: data.activeProject as ProjectConfig | null,
        projects: data.projects as ProjectConfig[]
      }));
      onAfterChange?.();
      onSystemLog("No project selected. Voice chat remains available.");
    }, "Clearing active project.");
  }, [ensureDisconnected, onAfterChange, onSystemLog, wrapWithConfirm]);

  const addCandidate = useCallback(
    (candidate: ProjectCandidate) => {
      wrapWithConfirm(async () => {
        ensureDisconnected();
        setProjectError("");
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: candidate.name, path: candidate.path })
        });
        const data = await response.json();
        if (!response.ok) {
          setProjectError(String(data.error ?? "Failed to add project."));
          return;
        }
        setConfig((current) => ({
          ...(current ?? data),
          activeProject: data.activeProject as ProjectConfig,
          projects: data.projects as ProjectConfig[]
        }));
        onAfterChange?.();
        onSystemLog(`Added project ${data.activeProject.path}`);
      }, `Adding ${candidate.name}.`);
    },
    [ensureDisconnected, onAfterChange, onSystemLog, wrapWithConfirm]
  );

  const deleteProject = useCallback(
    (project: ProjectConfig) => {
      requestConfirm({
        title: "Remove project?",
        body: `${project.name} will be removed from the saved list. The repository on disk is left untouched.`,
        confirmLabel: "Remove",
        onConfirm: async () => {
          if (project.id === config?.activeProject?.id && isConnected) {
            disconnect();
            onSystemLog("Realtime session disconnected because the active project was removed.");
          }
          const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
          const data = await response.json();
          if (!response.ok) {
            setProjectError(String(data.error ?? "Failed to remove project."));
            return;
          }
          setConfig((current) => ({
            ...(current ?? data),
            activeProject: data.activeProject as ProjectConfig | null,
            projects: data.projects as ProjectConfig[]
          }));
          onAfterChange?.();
          onSystemLog(`Removed project ${project.name}.`);
        }
      });
    },
    [config?.activeProject?.id, disconnect, isConnected, onAfterChange, onSystemLog, requestConfirm]
  );

  const discoverProjects = useCallback(async () => {
    setProjectError("");
    setIsDiscovering(true);
    try {
      const response = await fetch("/api/projects/discover", { method: "POST" });
      const data = (await response.json()) as { projects?: ProjectCandidate[]; error?: string };
      if (!response.ok) {
        setProjectError(data.error ?? "Failed to find repositories.");
        return;
      }
      setCandidates(data.projects ?? []);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDiscovering(false);
    }
  }, []);

  return {
    config,
    candidates,
    projectError,
    isDiscovering,
    selectProject,
    deselectProject,
    addCandidate,
    deleteProject,
    discoverProjects,
    refreshConfig
  };
}
