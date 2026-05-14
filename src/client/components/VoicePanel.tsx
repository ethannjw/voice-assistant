import { SlidersHorizontal } from "lucide-react";
import { VOICE_STYLES } from "../constants";
import type { VoiceStyleId } from "../types";

type Props = {
  voiceStyle: VoiceStyleId;
  onChange: (style: VoiceStyleId) => void;
};

export function VoicePanel({ voiceStyle, onChange }: Props) {
  const active = VOICE_STYLES.find((style) => style.id === voiceStyle);
  return (
    <details className="voice-panel" aria-label="Voice style">
      <summary className="voice-heading">
        <div>
          <p className="eyebrow">Voice profile</p>
          <h2>{active?.name}</h2>
        </div>
        <SlidersHorizontal size={20} />
      </summary>
      <div className="voice-style-grid">
        {VOICE_STYLES.map((style) => (
          <button
            key={style.id}
            type="button"
            className={`voice-style-option ${style.id === voiceStyle ? "active" : ""}`}
            onClick={() => onChange(style.id)}
          >
            <span>{style.name}</span>
            <small>{style.detail}</small>
          </button>
        ))}
      </div>
    </details>
  );
}
