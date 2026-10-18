import { fetchMusicBlob } from "./musicBlob";
import { computePeaks } from "./peaks";

/**
 * The Stitch editor's music waveforms: peaks per media key, decoded once
 * the way the stitch decodes its music (prepareAudioAsync from
 * useAudioMixing, which loads mediabunny lazily and falls back to Web
 * Audio), so the bars line up with what is encoded. The decoded samples are
 * dropped as soon as the peaks are taken. A browser-only module cache,
 * never written into the workflow store; the newest WAVEFORM_LRU_LIMIT
 * keys asked for are kept.
 */

export interface StitchWaveform {
  status: "loading" | "ready" | "error";
  /** The decoded music's length, seconds. */
  duration: number | null;
  peaks: Float32Array | null;
}

/** Decoded channels of a source; tests swap the decoder in with __setWaveformDecoderForTests. */
export type WaveformDecoder = (src: string) => Promise<{ channels: Float32Array[]; duration: number }>;

export const WAVEFORM_LRU_LIMIT = 16;

interface Entry {
  waveform: StitchWaveform;
  lastUsed: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let clock = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

/** As the executor reads the music (stitchInputs, through fetchMusicBlob), every channel. */
async function decodeWithAudioMixing(src: string): Promise<{ channels: Float32Array[]; duration: number }> {
  const blob = await fetchMusicBlob(src);
  const { prepareAudioAsync } = await import("@/hooks/useAudioMixing");
  const audio = await prepareAudioAsync(blob, 0);
  if (!audio) throw new Error("The music could not be decoded");
  const channels: Float32Array[] = [];
  for (let c = 0; c < audio.buffer.numberOfChannels; c++) channels.push(audio.buffer.getChannelData(c));
  return { channels, duration: audio.duration };
}

let decode: WaveformDecoder = decodeWithAudioMixing;

function evict(): void {
  while (entries.size > WAVEFORM_LRU_LIMIT) {
    let oldest: string | null = null;
    let oldestUsed = Infinity;
    for (const [key, entry] of entries) {
      if (entry.lastUsed < oldestUsed) {
        oldest = key;
        oldestUsed = entry.lastUsed;
      }
    }
    if (oldest === null) return;
    entries.delete(oldest);
  }
}

export function getWaveform(key: string): StitchWaveform | undefined {
  return entries.get(key)?.waveform;
}

export function subscribeWaveform(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts the decode once per key; a key already known only counts as used. */
export function requestWaveform(key: string, src: string): void {
  const known = entries.get(key);
  if (known) {
    known.lastUsed = ++clock;
    return;
  }
  const entry: Entry = { waveform: { status: "loading", duration: null, peaks: null }, lastUsed: ++clock };
  entries.set(key, entry);
  evict();
  notify();
  void decode(src).then(
    ({ channels, duration }) => {
      // Evicted (or reset) while decoding: nobody is showing it
      if (entries.get(key) !== entry) return;
      const ready = Number.isFinite(duration) && duration > 0;
      entry.waveform = ready
        ? { status: "ready", duration, peaks: computePeaks(channels) }
        : { status: "error", duration: null, peaks: null };
      notify();
    },
    () => {
      if (entries.get(key) !== entry) return;
      entry.waveform = { status: "error", duration: null, peaks: null };
      notify();
    },
  );
}

export function __setWaveformForTests(key: string, waveform: Partial<StitchWaveform>): void {
  entries.set(key, {
    waveform: { status: "ready", duration: null, peaks: null, ...waveform },
    lastUsed: ++clock,
  });
  notify();
}

export function __resetWaveformForTests(): void {
  entries.clear();
  decode = decodeWithAudioMixing;
  notify();
}

export function __setWaveformDecoderForTests(next: WaveformDecoder | null): void {
  decode = next ?? decodeWithAudioMixing;
}
