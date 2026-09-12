export function validateMeetingUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid HTTPS Teams meeting URL."); }
  if (url.protocol !== "https:" || !["teams.microsoft.com", "teams.live.com"].includes(url.hostname) || url.username || url.password || url.port || !/^\/(meet\/[^/]+|l\/meetup-join\/[^/]+)/.test(url.pathname)) {
    throw new Error("Use an HTTPS meeting link from teams.microsoft.com or teams.live.com.");
  }
  return url.toString();
}

export type TeamsOptions = { meetingUrl?: string; workspace?: string; port?: number; name: string; durationMinutes: number; help: boolean };

export function parseTeamsOptions(args: string[]): TeamsOptions {
  const options: TeamsOptions = { name: "Elva AI assistant", durationMinutes: 120, help: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") { options.help = true; continue; }
    if (!["--meeting-url", "--workspace", "--port", "--name", "--duration"].includes(flag)) throw new Error("Unknown option. Run npm run teams -- --help.");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--meeting-url") options.meetingUrl = validateMeetingUrl(value);
    if (flag === "--workspace") options.workspace = value;
    if (flag === "--name") {
      if (!/^[\p{L}\p{M}\p{N} '’._@·・-]{1,50}$/u.test(value)) throw new Error("Bot name must be 1–50 letters, numbers, spaces or supported punctuation.");
      options.name = value;
    }
    if (flag === "--port" || flag === "--duration") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > (flag === "--port" ? 65535 : 1440)) throw new Error(`Invalid ${flag}.`);
      if (flag === "--port") options.port = number;
      else options.durationMinutes = number;
    }
  }
  return options;
}
