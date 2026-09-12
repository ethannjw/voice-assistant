import "dotenv/config";
import { createMeetingRuntime } from "./runtime";

const runtime = await createMeetingRuntime();
try {
  const code = await new Promise<number>(resolve => runtime.start({check_only: true}, event => console.log(JSON.stringify(event)), resolve));
  process.exitCode = code;
} finally {
  await runtime.stop();
}
