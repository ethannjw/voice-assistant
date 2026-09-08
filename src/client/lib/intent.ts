import { VOICE_STYLES } from "../constants";
import type { VoiceStyleId } from "../types";

export function isVoiceStyleId(value: string | null): value is VoiceStyleId {
  return VOICE_STYLES.some((style) => style.id === value);
}

export function isExplicitCodingInterruptionRequest(transcript: string) {
  const text = transcript.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) {
    return false;
  }

  if (/(止めないで|止めなくて|中断しないで|キャンセルしないで|続けて|続行)/.test(text)) {
    return false;
  }

  const directStop =
    /^(stop|cancel|abort|interrupt|やめて|止めて|止まって|中断|中断して|停止|停止して|キャンセル|キャンセルして|ストップ)$/.test(
      text
    );
  if (directStop) {
    return true;
  }

  const mentionsCodingTask =
    /(codex|cursor|coding agent|coder|コーデックス|カーソル|処理|作業|タスク|実行|変更|編集|コマンド)/.test(
      text
    );
  const stopIntent = /(stop|cancel|abort|interrupt|やめて|止めて|止まって|中断|停止|キャンセル|ストップ)/.test(text);
  return mentionsCodingTask && stopIntent;
}
