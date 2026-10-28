// @ts-check
// Spoken recall audio (MEM-032, plan D4): mic stream -> PCM -> 16 kHz mono 16-bit WAV, chunked under the
// server's per-request cap, relayed to POST /recall/audio. ScriptProcessor, not AudioWorklet: a worklet
// needs a separate module file and the deprecated node is still supported everywhere we demo.

export const TARGET_SAMPLE_RATE = 16000;
// Mirrors src/memripal/recall_relay.py MAX_CHUNK_BYTES (decoded audio bytes per request).
export const MAX_CHUNK_BYTES = 1024 * 1024;
const WAV_HEADER_BYTES = 44;
export const MAX_CHUNK_SAMPLES = (MAX_CHUNK_BYTES - WAV_HEADER_BYTES) / 2;
// Each live slice re-includes this much audio before its mark, so a word cut at a slice edge is heard whole
// in the next slice (MEM-037).
export const LIVE_OVERLAP_MS = 1000;
// meta_client.py::_check_wav_format accepts only these framerates.
const SERVER_RATES = [16000, 24000];

export class RecallAudioError extends Error {
  /**
   * @param {string} code
   * @param {number | null} status
   */
  constructor(code, status) {
    super(`recall audio failed: ${code}`);
    this.name = "RecallAudioError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Canonical 44-byte PCM header + little-endian int16 samples, mono.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(samples, sampleRate) {
  if (!SERVER_RATES.includes(sampleRate)) throw new RangeError(`unsupported WAV sample rate ${sampleRate}`);
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const dv = new DataView(bytes.buffer);
  /** @param {number} off @param {string} s */
  const tag = (off, s) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  tag(36, "data");
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Number.isNaN(samples[i]) ? 0 : Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true);
  }
  return bytes;
}

/**
 * Box-average resampling: each output sample is the mean of its input window, so it stays within the
 * input's range and a constant stays constant.
 * @param {Float32Array} samples never mutated
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function downsample(samples, fromRate, toRate) {
  const n = samples.length;
  const out = new Float32Array(Math.floor((n * toRate) / fromRate));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor((i * fromRate) / toRate);
    const end = Math.min(n, Math.max(start + 1, Math.floor(((i + 1) * fromRate) / toRate)));
    let sum = 0;
    for (let k = start; k < end; k++) sum += samples[k];
    out[i] = sum / (end - start);
  }
  return out;
}

/**
 * Split so each chunk's WAV is at most maxBytes. Chunks are views onto the input.
 * @param {Float32Array} samples
 * @param {number} [maxBytes]
 * @returns {Float32Array[]}
 */
export function chunkSamples(samples, maxBytes = MAX_CHUNK_BYTES) {
  const per = Math.floor((maxBytes - WAV_HEADER_BYTES) / 2);
  if (!(per >= 1)) throw new RangeError(`chunk cap ${maxBytes} bytes cannot hold one sample`);
  const chunks = [];
  for (let off = 0; off < samples.length; off += per) chunks.push(samples.subarray(off, off + per));
  return chunks;
}

/**
 * Record the stream until stop(), keeping at most maxMs of audio. take() slices off what is new since the
 * previous take (plus LIVE_OVERLAP_MS before it) while recording continues; stop() then yields only the
 * untaken remainder, or null when nothing is new since the last take.
 * @param {{ stream: MediaStream, AudioContext: typeof AudioContext, maxMs: number }} opts
 * @returns {Promise<{ take: () => Promise<Uint8Array | null>, stop: () => Promise<Uint8Array | null> }>}
 */
export async function recordClip({ stream, AudioContext, maxMs }) {
  const ctx = new AudioContext();
  const rate = ctx.sampleRate;
  const maxSamples = Math.floor((maxMs * rate) / 1000);
  const overlap = Math.floor((LIVE_OVERLAP_MS * rate) / 1000);
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  /** @type {Float32Array[]} */
  const frames = [];
  let kept = 0;
  node.onaudioprocess = (event) => {
    if (kept >= maxSamples) return;
    // The browser reuses this buffer across callbacks, so copy (slice) what we keep.
    const frame = event.inputBuffer.getChannelData(0).slice(0, maxSamples - kept);
    frames.push(frame);
    kept += frame.length;
  };
  source.connect(node);
  // A ScriptProcessor only fires while connected to the destination; its output buffer stays silent.
  node.connect(ctx.destination);
  // Samples before the mark were handed out by take(); 0 until the first non-empty take.
  let mark = 0;
  /** WAV of the kept samples from `from` on. @param {number} from */
  const wavFrom = (from) => {
    const pcm = new Float32Array(kept - from);
    let pos = 0;
    for (const f of frames) {
      const end = pos + f.length;
      if (end > from) pcm.set(pos >= from ? f : f.subarray(from - pos), Math.max(0, pos - from));
      pos = end;
    }
    return encodeWav(downsample(pcm, rate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
  };
  const slice = () => {
    const wav = wavFrom(Math.max(0, mark - overlap));
    mark = kept;
    return wav;
  };
  /** @type {Promise<Uint8Array | null> | null} */
  let done = null;
  const finish = async () => {
    node.onaudioprocess = null;
    source.disconnect();
    node.disconnect();
    await ctx.close();
    return mark > 0 && kept === mark ? null : slice();
  };
  return {
    take: async () => (done || kept === mark ? null : slice()),
    stop: () => (done ??= finish()),
  };
}

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
  let binary = "";
  // Chunked: String.fromCharCode over a 1 MiB spread would overflow the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** @type {Record<number, string>} */
const STATUS_CODES = {
  401: "passcode_required",
  409: "live_only",
  413: "too_large",
  429: "budget_exhausted",
  502: "upstream",
};

/**
 * @param {{ fetch: typeof fetch, wav: Uint8Array, keywords: string[], passcode?: string | null }} opts
 * @returns {Promise<{ text: string }>}
 */
export async function postRecallAudio({ fetch, wav, keywords, passcode }) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (passcode) headers["X-Memripal-Passcode"] = passcode;
  let resp;
  try {
    resp = await fetch("/recall/audio", {
      method: "POST",
      headers,
      body: JSON.stringify({ audio: toBase64(wav), keywords }),
    });
  } catch {
    throw new RecallAudioError("network", null);
  }
  // Mapped by status alone: a 413 from a proxy may not carry a JSON body.
  if (!resp.ok) throw new RecallAudioError(STATUS_CODES[resp.status] ?? "unexpected", resp.status);
  const payload = await resp.json().catch(() => null);
  if (!payload || typeof payload.text !== "string") throw new RecallAudioError("upstream", resp.status);
  return { text: payload.text };
}
