import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WireEvent } from "./audioRelay";

const integration = fileURLToPath(new URL("../../../integrations/attendee/", import.meta.url));

export type MeetingRuntime = {
  stateDirectory: string;
  certificate: Buffer;
  key: Buffer;
  start: (configuration: WireEvent, onEvent: (event: WireEvent) => void, onExit: (code: number) => void) => void;
  stop: () => Promise<void>;
};

export async function createMeetingRuntime(): Promise<MeetingRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), "elva-meeting-"));
  await chmod(directory, 0o700);
  await mkdir(path.join(directory, "public"), {mode: 0o755});
  try {
    await new Promise<void>((resolve, reject) => {
      const command = spawn("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", path.join(integration, "cert.cnf"), "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "public", "cert.pem")], {stdio: "ignore"});
      command.once("error", () => reject(new Error("OpenSSL is required for the local meeting bridge.")));
      command.once("exit", code => code === 0 ? resolve() : reject(new Error("Could not generate the local meeting certificate.")));
    });
    await chmod(path.join(directory, "key.pem"), 0o600);
    await chmod(path.join(directory, "public", "cert.pem"), 0o644);
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const project = `elva-meeting-${randomBytes(6).toString("hex")}`;
  const environment: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: homedir(), ELVA_MEETING_STATE: directory, ELVA_MEETING_PROJECT: project, ATTENDEE_IMAGE: process.env.ATTENDEE_IMAGE ?? "elva-attendee:31ebd91"};
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) if (process.env[name]) environment[name] = process.env[name];
  await writeFile(path.join(directory, "project"), project, {mode: 0o600});
  const killRunner = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {process.kill(-child.pid, signal);} catch {}
  };
  return {
    stateDirectory: directory,
    certificate: await readFile(path.join(directory, "public", "cert.pem")),
    key: await readFile(path.join(directory, "key.pem")),
    start(configuration, onEvent, onExit) {
      if (child || stopping) throw new Error("Meeting runtime already started or stopped.");
      child = spawn("python3", [path.join(integration, "run.py")], {env: environment, stdio: "pipe", detached: true});
      const processHandle = child;
      let settled = false;
      exited = new Promise(resolve => {
        const finish = (code: number) => { if (settled) return; settled = true; onExit(code); resolve(); };
        processHandle.once("error", () => finish(1));
        processHandle.once("close", code => finish(code ?? 1));
      });
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) {child?.kill("SIGTERM"); return;}
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) { try {onEvent(JSON.parse(line));} catch {} }
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(configuration) + "\n");
    },
    stop() {
      stopping ??= (async () => {
        await writeFile(path.join(directory, "public", "stop"), "", {mode: 0o600});
        if (child && exited) {
          const timer = setTimeout(() => killRunner("SIGTERM"), 15000);
          const deadline = setTimeout(() => killRunner("SIGKILL"), 90000);
          await exited;
          clearTimeout(timer);
          clearTimeout(deadline);
          await writeFile(path.join(directory, "runtime.env"), "", {flag: "a", mode: 0o600});
          await new Promise<void>((resolve, reject) => {
            const cleanup = spawn("docker", ["compose", "--project-name", project, "--file", path.join(integration, "compose.yaml"), "down", "--timeout", "10"], {env: environment, stdio: "ignore", timeout: 60000, killSignal: "SIGKILL"});
            cleanup.once("error", () => reject(new Error(`Meeting cleanup failed. State retained at ${directory}.`)));
            cleanup.once("exit", code => code === 0 ? resolve() : reject(new Error(`Meeting cleanup failed. State retained at ${directory}.`)));
          });
        }
        await rm(directory, {recursive: true, force: true});
      })();
      return stopping;
    }
  };
}
