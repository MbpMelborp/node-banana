import type { VolumePoint } from "@/types";
import { gainAt } from "./curve";

/**
 * The Stitch sound mix on plain sample arrays. The encoder takes one sample
 * rate and channel count for the whole track, so every clip's sound and the
 * music are brought to one master format, laid out by sequence time, and
 * summed. Nothing here touches mediabunny or the Web Audio API.
 */

/** Planar samples, one Float32Array per channel. */
export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
}

/** A decoded block and where it starts in its source, in seconds. */
export interface PcmChunk extends Pcm {
  timestamp: number;
}

export interface MasterFormat {
  sampleRate: number;
  channels: 1 | 2;
}

/** The parts of an AudioBuffer read here (jsdom has none). */
export interface AudioBufferLike {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

const DEFAULT_BLOCK_SIZE = 128;

const frameCount = (pcm: Pcm) => pcm.channels[0]?.length ?? 0;

/** Copies the channel data, so the buffer can be released. */
export function pcmFromAudioBuffer(buffer: AudioBufferLike, timestamp = 0): PcmChunk {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  return { sampleRate: buffer.sampleRate, channels, timestamp };
}

/**
 * The first `frames` samples of each channel (fewer when the buffer is shorter), as views on the buffer's own data:
 * nothing is copied, so the buffer must outlive them. For the music, of which a stitch plays only the beginning.
 */
export function pcmHead(buffer: AudioBufferLike, frames: number): Pcm {
  const end = Math.max(0, Math.min(buffer.length, Math.ceil(frames)));
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).subarray(0, end));
  return { sampleRate: buffer.sampleRate, channels };
}

/** Linear interpolation; the same pcm when the rate already matches. Length round(n · ratio). */
export function resampleLinear(pcm: Pcm, sampleRate: number): Pcm {
  if (pcm.sampleRate === sampleRate) return pcm;
  const n = frameCount(pcm);
  const length = Math.round((n * sampleRate) / pcm.sampleRate);
  const step = pcm.sampleRate / sampleRate;
  const channels = pcm.channels.map((source) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const position = i * step;
      const i0 = Math.min(Math.floor(position), n - 1);
      const i1 = Math.min(i0 + 1, n - 1);
      const frac = position - i0;
      out[i] = source[i0] + (source[i1] - source[i0]) * frac;
    }
    return out;
  });
  return { sampleRate, channels };
}

const SQRT1_2 = Math.SQRT1_2;

/**
 * Mono → several duplicates it; several → mono averages them. Quad and 5.1 →
 * stereo use the Web Audio speaker downmix (channel order L, R, C, LFE, SL,
 * SR; the LFE is dropped), so a centre channel's dialogue is kept. Otherwise
 * the first channels are kept (a missing one repeats the last).
 */
export function remix(pcm: Pcm, channels: number): Pcm {
  const sources = pcm.channels;
  if (sources.length === channels || sources.length === 0) return pcm;
  if (channels === 2 && (sources.length === 4 || sources.length === 6)) {
    const n = frameCount(pcm);
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    if (sources.length === 4) {
      const [l, r, sl, sr] = sources;
      for (let i = 0; i < n; i++) {
        left[i] = 0.5 * (l[i] + sl[i]);
        right[i] = 0.5 * (r[i] + sr[i]);
      }
    } else {
      const [l, r, c, , sl, sr] = sources;
      for (let i = 0; i < n; i++) {
        left[i] = l[i] + SQRT1_2 * (c[i] + sl[i]);
        right[i] = r[i] + SQRT1_2 * (c[i] + sr[i]);
      }
    }
    return { sampleRate: pcm.sampleRate, channels: [left, right] };
  }
  if (channels === 1) {
    const n = frameCount(pcm);
    const mono = new Float32Array(n);
    for (const source of sources) for (let i = 0; i < n; i++) mono[i] += source[i];
    for (let i = 0; i < n; i++) mono[i] /= sources.length;
    return { sampleRate: pcm.sampleRate, channels: [mono] };
  }
  return {
    sampleRate: pcm.sampleRate,
    channels: Array.from({ length: channels }, (_, c) => sources[Math.min(c, sources.length - 1)].slice()),
  };
}

export function toMasterFormat(pcm: Pcm, format: MasterFormat): Pcm {
  return resampleLinear(remix(pcm, format.channels), format.sampleRate);
}

/**
 * The samples of [fromSec, toSec), exactly round((to − from) · sr) of them, in
 * the first chunk's format. Each chunk goes by its own timestamp, so sound
 * before `from` is skipped and a gap (or sound that starts late) is silence.
 * No chunks → null.
 */
export function sliceChunksToRange(chunks: readonly PcmChunk[], fromSec: number, toSec: number): Pcm | null {
  if (chunks.length === 0) return null;
  const sampleRate = chunks[0].sampleRate;
  const channelCount = chunks[0].channels.length;
  const n = Math.max(0, Math.round((toSec - fromSec) * sampleRate));
  const out = Array.from({ length: channelCount }, () => new Float32Array(n));
  // Rounded once, and each chunk by its own whole-sample position: rounding
  // each chunk's difference from a start on a half sample would leave
  // one-sample gaps or overlaps at the seams.
  const fromSample = Math.round(fromSec * sampleRate);
  for (const chunk of chunks) {
    const pcm =
      chunk.sampleRate === sampleRate && chunk.channels.length === channelCount
        ? chunk
        : resampleLinear(remix(chunk, channelCount), sampleRate);
    const offset = Math.round(chunk.timestamp * sampleRate) - fromSample;
    const length = frameCount(pcm);
    const start = Math.max(0, -offset);
    const end = Math.min(length, n - offset);
    if (end <= start) continue;
    for (let c = 0; c < channelCount; c++) out[c].set(pcm.channels[c].subarray(start, end), offset + start);
  }
  return { sampleRate, channels: out };
}

/**
 * The music's rate when the music is the only source; with any clip sound, the
 * highest rate among all the sources, so a low-rate voice-over does not drag
 * the clips down. As many channels as the widest source, at most 2. Nothing
 * usable given → null.
 */
export function chooseMasterFormat(
  music: { sampleRate: number; channels: number } | null,
  clips: ReadonlyArray<{ sampleRate: number; channels: number }>,
): MasterFormat | null {
  const usable = (s: { sampleRate: number; channels: number }) =>
    Number.isFinite(s.sampleRate) && s.sampleRate > 0 && s.channels >= 1;
  const clipSources = clips.filter(usable);
  const sources = [...(music && usable(music) ? [music] : []), ...clipSources];
  if (sources.length === 0) return null;
  const widest = Math.max(...sources.map((s) => s.channels));
  const sampleRate = clipSources.length === 0 ? sources[0].sampleRate : Math.max(...sources.map((s) => s.sampleRate));
  return { sampleRate, channels: widest >= 2 ? 2 : 1 };
}

/** target[c][offset + i] += source[c][i] · gain; indices outside target are ignored. */
export function mixInto(target: Float32Array[], source: Float32Array[], offset: number, gain: number): void {
  if (gain === 0) return;
  const channels = Math.min(target.length, source.length);
  for (let c = 0; c < channels; c++) {
    const into = target[c];
    const from = source[c];
    const start = Math.max(0, -offset);
    const end = Math.min(from.length, into.length - offset);
    for (let i = start; i < end; i++) into[offset + i] += from[i] * gain;
  }
}

/**
 * Multiplies by the curve's gain at startSec + i/sr. The gain is read at each
 * block's edges and ramped straight inside the block, so a steep move does
 * not click. An empty curve is flat at 1 and changes nothing.
 */
export function applyCurveGain(
  channels: Float32Array[],
  sampleRate: number,
  curve: readonly VolumePoint[],
  startSec = 0,
  blockSize = DEFAULT_BLOCK_SIZE,
): void {
  if (curve.length === 0 || channels.length === 0) return;
  const n = channels[0].length;
  const block = Math.max(1, Math.floor(blockSize));
  for (let blockStart = 0; blockStart < n; blockStart += block) {
    const blockEnd = Math.min(blockStart + block, n);
    const g0 = gainAt(curve, startSec + blockStart / sampleRate);
    const g1 = gainAt(curve, startSec + blockEnd / sampleRate);
    const span = blockEnd - blockStart;
    for (let i = blockStart; i < blockEnd; i++) {
      const gain = g0 + ((g1 - g0) * (i - blockStart)) / span;
      for (const channel of channels) channel[i] *= gain;
    }
  }
}

/** A NaN becomes silence; everything else is left as it is. */
export function silenceNaN(channels: Float32Array[]): void {
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) if (Number.isNaN(channel[i])) channel[i] = 0;
  }
}

/** Hard clip to [−1, 1]; a NaN becomes silence. No limiter: loud sums distort. */
export function clampSamples(channels: Float32Array[]): void {
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      channel[i] = Number.isNaN(v) ? 0 : Math.min(Math.max(v, -1), 1);
    }
  }
}

export interface LoopMix {
  format: MasterFormat;
  /** One loop of the sequence, in seconds. */
  loopLength: number;
  /** In the master format; muted and silent clips are not listed. */
  clips: ReadonlyArray<{ pcm: Pcm; seqStart: number; gain: number }>;
  /** In the master format: the music the loops play (at least loopCount loops of it). Null when none or muted. */
  music: { pcm: Pcm; curve: readonly VolumePoint[] } | null;
}

/**
 * One loop of the master sound, round(loopLength · sr) samples. Each clip is
 * mixed in at its sequence start with its gain. The music keeps running across
 * loops (loop k reads its samples from k · loopSamples on, silence past its
 * end), and the curve, which covers one loop, shapes it again each time.
 *
 * The result is hard-clipped only when sources can sum: music under clip
 * sound, or a gain above 1. Clips never overlap, so one source at a time
 * (every unedited node) passes its samples through as they were decoded,
 * overs included.
 */
export function mixLoop(mix: LoopMix, loopIndex: number): Float32Array[] {
  const { sampleRate, channels } = mix.format;
  const loopSamples = Math.max(0, Math.round(mix.loopLength * sampleRate));
  const out = Array.from({ length: channels }, () => new Float32Array(loopSamples));
  for (const clip of mix.clips) {
    mixInto(out, clip.pcm.channels, Math.round(clip.seqStart * sampleRate), clip.gain);
  }
  if (mix.music) {
    const from = loopIndex * loopSamples;
    const music = mix.music.pcm.channels.map((channel) => {
      const segment = new Float32Array(loopSamples);
      if (from < channel.length) segment.set(channel.subarray(from, from + loopSamples));
      return segment;
    });
    applyCurveGain(music, sampleRate, mix.music.curve);
    mixInto(out, music, 0, 1);
  }
  const sums = (mix.music !== null && mix.clips.length > 0) || mix.clips.some((clip) => clip.gain > 1);
  if (sums) clampSamples(out);
  else silenceNaN(out);
  return out;
}
