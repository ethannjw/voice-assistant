import { Send } from "lucide-react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  isSubmitting: boolean;
};

export function PromptRow({ value, onChange, onSubmit, canSubmit, isSubmitting }: Props) {
  return (
    <div className="prompt-row">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Skip when IME is composing (Japanese input etc.)
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          onSubmit();
        }}
        placeholder="Ask by text — Enter to send, ⌘Enter from anywhere"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        title="Send (⌘Enter)"
      >
        {isSubmitting ? <span className="spinner" aria-label="Sending" /> : <Send size={18} />}
      </button>
    </div>
  );
}
