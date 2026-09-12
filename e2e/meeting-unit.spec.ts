import { expect, test } from "@playwright/test";
import { parseTeamsOptions, validateMeetingUrl } from "../src/server/meeting/options";
import { MeetingAudioRelay } from "../src/server/meeting/audioRelay";

test("Teams CLI accepts a URL, workspace and port without changing normal defaults", () => {
  expect(parseTeamsOptions(["--meeting-url", "https://teams.microsoft.com/meet/123?p=secret", "--workspace", ".", "--port", "8788"])).toMatchObject({ meetingUrl: "https://teams.microsoft.com/meet/123?p=secret", workspace: ".", port: 8788 });
  expect(parseTeamsOptions([]).meetingUrl).toBeUndefined();
  expect(() => parseTeamsOptions(["--unknown"])).toThrow();
  expect(() => parseTeamsOptions(["--port", "0"])).toThrow();
  expect(() => parseTeamsOptions(["--meeting-url"])).toThrow();
});

test("meeting validation rejects unsafe destinations without exposing the URL", () => {
  for (const value of ["file:///secret", "https://teams.microsoft.com.evil.test/meet/secret", "https://user:secret@teams.microsoft.com/meet/123", "https://teams.microsoft.com:999/meet/123", "https://teams.microsoft.com/"]) {
    try { validateMeetingUrl(value); throw new Error("accepted"); } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("accepted");
    }
  }
});

test("meeting relay gates output and handles whole-response completion and cancellation offsets", () => {
  const provider: Record<string, any>[] = [];
  const bot: Record<string, any>[] = [];
  const browser: Record<string, any>[] = [];
  const relay = new MeetingAudioRelay(event => provider.push(event), event => bot.push(event), event => browser.push(event));
  const delta = (item: string) => ({type: "response.output_audio.delta", response_id: "reply", item_id: item, content_index: 0, delta: Buffer.alloc(4800).toString("base64")});
  relay.provider(delta("ignored"));
  expect(bot).toHaveLength(0);
  relay.control({type: "response.create", response: {metadata: {attention_reply: "invited"}}});
  relay.provider({type: "response.created", response: {id: "reply", metadata: {attention_reply: "invited"}}});
  relay.provider(delta("first"));
  relay.provider({type: "response.output_audio.done", response_id: "reply"});
  expect(bot.map(event => event.trigger)).toEqual(["realtime_audio.bot_output"]);
  relay.provider(delta("second"));
  relay.control({type: "output_audio_buffer.clear"});
  relay.meeting({trigger: "elva.playback", data: {kind: "cleared", response_id: "reply", played_ms: 125}});
  expect(provider.at(-1)).toMatchObject({type: "conversation.item.truncate", item_id: "second", audio_end_ms: 25});
  const count = bot.length;
  relay.provider(delta("late"));
  expect(bot).toHaveLength(count);
  expect(browser.at(-1)).toMatchObject({type: "output_audio_buffer.cleared"});
});

test("meeting input is gated until manual control is confirmed and respects mute", () => {
  const sent: unknown[] = [];
  const relay = new MeetingAudioRelay(event => sent.push(event), () => {}, () => {});
  const audio = {trigger: "realtime_audio.mixed", data: {sample_rate: 24000, chunk: Buffer.alloc(4800).toString("base64")}};
  relay.meeting(audio);
  expect(sent).toHaveLength(0);
  relay.provider({type: "session.updated", session: {audio: {input: {turn_detection: {create_response: false, interrupt_response: false}}}}});
  relay.meeting(audio);
  expect(sent).toHaveLength(1);
  relay.muted = true;
  relay.meeting(audio);
  expect(sent).toHaveLength(1);
  expect(() => relay.meeting({...audio, data: {...audio.data, sample_rate: 48000}})).toThrow();
  expect(() => relay.provider({type: "session.updated", session: {}})).toThrow();
});
