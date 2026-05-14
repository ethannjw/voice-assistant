import type { VoiceStyleId } from "../types";

export type AudioContextCtor = typeof AudioContext;

export function getAudioContextCtor(): AudioContextCtor | null {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ??
    null
  );
}

export async function ensureAudioContext(current: AudioContext | null): Promise<AudioContext> {
  const Ctor = getAudioContextCtor();
  if (!Ctor) {
    throw new Error("Web Audio is not available in this browser.");
  }
  const context = current ?? new Ctor();
  if (context.state === "suspended") {
    await context.resume();
  }
  return context;
}

export function buildVoiceStyleGraph(context: AudioContext, source: AudioNode, style: VoiceStyleId) {
  const cleanupTasks: Array<() => void> = [];
  const output = context.createGain();

  output.gain.value = 0.9;
  output.connect(context.destination);
  cleanupTasks.push(() => output.disconnect());

  const connectStyledGraph = (effectNodes: AudioNode[], dry: number, wet: number) => {
    const firstEffect = effectNodes[0];
    const lastEffect = effectNodes[effectNodes.length - 1];
    const dryGain = context.createGain();
    const wetGain = context.createGain();

    dryGain.gain.value = dry;
    wetGain.gain.value = wet;
    source.connect(dryGain).connect(output);
    source.connect(firstEffect);
    for (let index = 0; index < effectNodes.length - 1; index += 1) {
      effectNodes[index].connect(effectNodes[index + 1]);
    }
    lastEffect.connect(wetGain).connect(output);
    cleanupTasks.push(() => {
      source.disconnect();
      dryGain.disconnect();
      wetGain.disconnect();
      effectNodes.forEach((node) => node.disconnect());
    });
  };

  const cleanup = () => cleanupTasks.splice(0).forEach((task) => task());

  if (style === "natural") {
    return cleanup;
  }

  if (style === "console_ai") {
    const highpass = createBiquad(context, "highpass", 180, 0.7);
    const mid = createBiquad(context, "peaking", 1400, 1.2, 5.2);
    const lowpass = createBiquad(context, "lowpass", 4400, 0.8);

    connectStyledGraph([highpass, mid, lowpass], 0.18, 1);
    return cleanup;
  }

  if (style === "starship") {
    const highpass = createBiquad(context, "highpass", 120, 0.8);
    const presence = createBiquad(context, "peaking", 2400, 0.9, 3.6);
    const lowpass = createBiquad(context, "lowpass", 6400, 0.7);
    const delay = context.createDelay(0.28);
    const feedback = context.createGain();
    delay.delayTime.value = 0.055;
    feedback.gain.value = 0.16;
    delay.connect(feedback).connect(delay);
    cleanupTasks.push(() => feedback.disconnect());

    connectStyledGraph([highpass, presence, lowpass, delay], 0.72, 0.34);
    return cleanup;
  }

  if (style === "synthetic") {
    const highpass = createBiquad(context, "highpass", 210, 0.8);
    const presence = createBiquad(context, "peaking", 1850, 1.1, 4.8);
    const lowpass = createBiquad(context, "lowpass", 4600, 0.8);
    const shaper = context.createWaveShaper();

    shaper.curve = makeDistortionCurve(24);
    shaper.oversample = "2x";

    connectStyledGraph([highpass, presence, lowpass, shaper], 0.58, 0.5);
    return cleanup;
  }

  const highpass = createBiquad(context, "highpass", 90, 0.7);
  const lowShelf = createBiquad(context, "lowshelf", 190, 0.8, 5);
  const lowpass = createBiquad(context, "lowpass", 3000, 0.85);

  connectStyledGraph([highpass, lowShelf, lowpass], 0.28, 1);
  return cleanup;
}

function createBiquad(
  context: AudioContext,
  type: BiquadFilterType,
  frequency: number,
  q: number,
  gain = 0
) {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  filter.gain.value = gain;
  return filter;
}

function makeDistortionCurve(amount: number) {
  const samples = 2048;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;

  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }

  return curve;
}
