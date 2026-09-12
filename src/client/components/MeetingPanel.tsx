type Props = {
  mode: "local" | "teams";
  url: string;
  status: string;
  active: boolean;
  onMode: (mode: "local" | "teams") => void;
  onUrl: (url: string) => void;
};

export function MeetingPanel({mode, url, status, active, onMode, onUrl}: Props) {
  return (
    <section className="meeting-panel">
      <label>Session mode
        <select aria-label="Session mode" value={mode} disabled={active} onChange={event => onMode(event.target.value as "local" | "teams")}>
          <option value="local">Normal — local microphone</option>
          <option value="teams">Teams meeting</option>
        </select>
      </label>
      {mode === "teams" ? <>
        <label>Meeting URL
          <input aria-label="Meeting URL" type="url" value={url} autoComplete="off" spellCheck={false} disabled={active} onChange={event => onUrl(event.target.value)} placeholder="https://teams.microsoft.com/meet/…" />
        </label>
        <p>Same project, tools and approvals. Keep this UI open and obtain participant consent. Elva’s generated replies appear below; audio and transcripts are not saved automatically.</p>
        <p role="status" aria-label="Meeting status">{status || "Ready to join"}</p>
      </> : null}
    </section>
  );
}
