import { useCallback, useEffect, useRef, useState } from "react";
import { getAudioContextCtor } from "../lib/audio";

export function useMicrophoneLevel() {
  const [micLevel, setMicLevel] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const contextRef = useRef<AudioContext | null>(null);

  const stop = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
    setMicLevel(0);
  }, []);

  const start = useCallback(
    (stream: MediaStream) => {
      stop();
      try {
        const Ctor = getAudioContextCtor();
        if (!Ctor) return;
        const ctx = new Ctor();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        contextRef.current = ctx;
        analyserRef.current = analyser;

        const buffer = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          const node = analyserRef.current;
          if (!node) return;
          node.getByteTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i += 1) {
            const value = (buffer[i] - 128) / 128;
            sum += value * value;
          }
          const rms = Math.sqrt(sum / buffer.length);
          setMicLevel(Math.min(1, rms * 3));
          animationFrameRef.current = requestAnimationFrame(tick);
        };
        animationFrameRef.current = requestAnimationFrame(tick);
      } catch {
        // Mic visualization is best-effort.
      }
    },
    [stop]
  );

  useEffect(() => () => stop(), [stop]);

  return { micLevel, start, stop };
}
