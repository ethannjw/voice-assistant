import { Code2, Folder, FolderPlus, X } from "lucide-react";
import type { ProjectCandidate } from "../types";
import type { AppConfig, ProjectConfig } from "../../shared/contracts";

type Props = {
  config: AppConfig | null;
  projectError: string;
  isDiscovering: boolean;
  candidates: ProjectCandidate[];
  onSelect: (projectId: string) => void;
  onDelete: (project: ProjectConfig) => void;
  onDiscover: () => void;
  onAddCandidate: (candidate: ProjectCandidate) => void;
};

export function ProjectPanel({
  config,
  projectError,
  isDiscovering,
  candidates,
  onSelect,
  onDelete,
  onDiscover,
  onAddCandidate
}: Props) {
  return (
    <section className="project-panel" aria-label="Repository workspace">
      <div className="project-heading">
        <div>
          <p className="eyebrow">Current repository</p>
          <h2>{config?.activeProject?.name ?? "No project selected"}</h2>
        </div>
        <Folder size={20} />
      </div>

      <div className="workspace-strip">
        <Code2 size={18} />
        <span>
          {config?.activeProject?.path ??
            "Voice chat is available. Select a project before using repository tools."}
        </span>
      </div>

      <div className="project-row">
        <label className="field-label">Saved repositories</label>
        {config?.projects.length ? (
          <ul className="project-list">
            <ProjectListItem
              active={!config.activeProject}
              name="No project selected"
              path="Voice chat only mode"
              disabled={!config.activeProject}
              onSelect={() => onSelect("")}
            />
            {config.projects.map((project) => (
              <ProjectListItem
                key={project.id}
                active={project.id === config.activeProject?.id}
                name={project.name}
                path={project.path}
                onSelect={() => onSelect(project.id)}
                onDelete={() => onDelete(project)}
              />
            ))}
          </ul>
        ) : (
          <p className="project-list-empty empty-state-subtitle" style={{ margin: 0 }}>
            No saved repositories yet. Use Find repositories to add one.
          </p>
        )}
      </div>

      <div className="project-add-block">
        <div className="project-add-heading">
          <FolderPlus size={16} />
          <span>Add local repository</span>
        </div>
        <div className="project-discovery-row">
          <button type="button" onClick={onDiscover} disabled={!config || isDiscovering}>
            <FolderPlus size={18} />
            {isDiscovering ? "Searching" : "Find repositories"}
          </button>
        </div>
        {candidates.length ? (
          <div className="project-candidate-list">
            {candidates.map((candidate) => {
              const alreadyAdded = config?.projects.some((project) => project.path === candidate.path);
              return (
                <article key={candidate.path} className="project-candidate">
                  <div>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.path}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onAddCandidate(candidate)}
                    disabled={!config}
                  >
                    {alreadyAdded ? "Select" : "Add"}
                  </button>
                </article>
              );
            })}
          </div>
        ) : null}
      </div>

      {projectError ? <p className="project-error">{projectError}</p> : null}
    </section>
  );
}

type ProjectListItemProps = {
  active: boolean;
  name: string;
  path: string;
  disabled?: boolean;
  onSelect: () => void;
  onDelete?: () => void;
};

function ProjectListItem({ active, name, path, disabled, onSelect, onDelete }: ProjectListItemProps) {
  return (
    <li className={`project-list-item ${active ? "active" : ""}`}>
      <button
        type="button"
        className="project-list-select"
        onClick={onSelect}
        disabled={disabled}
      >
        <span className="project-list-name">{name}</span>
        <span className="project-list-path">{path}</span>
      </button>
      {onDelete ? (
        <button
          type="button"
          className="project-list-delete"
          title="Remove project"
          onClick={onDelete}
        >
          <X size={14} />
        </button>
      ) : null}
    </li>
  );
}
