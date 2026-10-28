// Covers: MEM-032
// Requirement: a spoken recall answer reaches POST /recall/audio as a WAV the server accepts: the mic stream
// is recorded to PCM, downsampled, encoded as RIFF/WAVE mono 16-bit at 16 kHz, split so no clip exceeds the
// server's 1 MiB per-chunk cap (chunking by bytes, not a duration cap: each chunk's WAV, i.e. its
// base64-decoded upload, is <= MAX_CHUNK_BYTES), and relayed with the passcode header only when one is set;
// server refusals surface as typed error codes the UI can act on (D4). No network but the injected fetch.
// Contract (RED; GREEN implements in static/mic_wav.js):
//   TARGET_SAMPLE_RATE === 16000; MAX_CHUNK_BYTES === 1048576; MAX_CHUNK_SAMPLES === (1048576 - 44) / 2.
//   encodeWav(Float32Array, sampleRate) -> Uint8Array: 44-byte canonical PCM header (RIFF size 36 + data,
//     fmt size 16, format 1, 1 channel, rate, byteRate rate*2, blockAlign 2, 16 bits, data size 2n) then
//     little-endian int16 samples; clamps to [-1, 1] (1 -> 32767, -1 -> -32768, NaN -> 0); RangeError for a
//     rate other than 16000 or 24000.
//   downsample(Float32Array, fromRate, toRate) -> Float32Array of floor(n * toRate / fromRate) samples,
//     deterministic, never outside the input's [min, max]; input not mutated.
//   chunkSamples(Float32Array, maxBytes = MAX_CHUNK_BYTES) -> Float32Array[] in order, each holding at most
//     floor((maxBytes - 44) / 2) samples, concatenating back to the input; [] for empty input; RangeError
//     when maxBytes cannot hold one sample.
//   recordClip({stream, AudioContext, maxMs}) -> (Promise of) {stop(): Promise<Uint8Array>}: new
//     AudioContext(); ctx.createMediaStreamSource(stream); ctx.createScriptProcessor(...) whose
//     onaudioprocess (or "audioprocess" listener) gets {inputBuffer.getChannelData(0)}; frames are copied
//     (the browser reuses the buffer); only the first floor(maxMs * ctx.sampleRate / 1000) samples kept;
//     stop() closes the context once and resolves encodeWav(downsample(pcm, ctx.sampleRate, 16000), 16000);
//     a repeated stop() resolves the same bytes.
//   postRecallAudio({fetch, wav, keywords, passcode}) -> Promise<{text}>: fetch("/recall/audio", {method
//     "POST", Content-Type application/json, body JSON exactly {audio: base64(wav), keywords}}), header
//     X-Memripal-Passcode only for a non-empty passcode. Non-2xx rejects RecallAudioError {code, status} by
//     status: 401 passcode_required, 409 live_only, 413 too_large, 429 budget_exhausted, 502 upstream, any
//     other unexpected; fetch rejecting -> code network; 2xx without a string text -> code upstream.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as mic from "./mic_wav.js";

// Server WAV contract, hard-coded from src/memripal/meta_client.py::_check_wav_format (called by
// recall_relay.is_relayable_wav): channels == 1, sampwidth == 2 bytes, framerate in (16000, 24000).
const SERVER_CHANNELS = 1;
const SERVER_SAMPLE_WIDTH_BYTES = 2;
const SERVER_RATES = [16000, 24000];
// src/memripal/recall_relay.py: MAX_CHUNK_BYTES = 1024 * 1024 (decoded audio bytes per request).
const SERVER_MAX_CHUNK_BYTES = 1024 * 1024;

const ascii = (bytes, off, n) => String.fromCharCode(...bytes.subarray(off, off + n));

function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = [];
  for (let off = 44; off + 1 < bytes.length; off += 2) samples.push(dv.getInt16(off, true));
  return {
    riff: ascii(bytes, 0, 4),
    riffSize: dv.getUint32(4, true),
    wave: ascii(bytes, 8, 4),
    fmt: ascii(bytes, 12, 4),
    fmtSize: dv.getUint32(16, true),
    format: dv.getUint16(20, true),
    channels: dv.getUint16(22, true),
    rate: dv.getUint32(24, true),
    byteRate: dv.getUint32(28, true),
    blockAlign: dv.getUint16(32, true),
    bits: dv.getUint16(34, true),
    data: ascii(bytes, 36, 4),
    dataSize: dv.getUint32(40, true),
    samples,
  };
}

// Deterministic LCG so "random" signals are identical on every run (ADR-0006).
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe("encodeWav", () => {
  test("writes a byte-exact canonical PCM header followed by int16 little-endian samples", () => {
    const wav = mic.encodeWav(new Float32Array([0, 1, -1]), 16000);
    assert.ok(wav instanceof Uint8Array);
    // prettier-ignore
    const expected = [
      0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, // "RIFF", 36 + 6
      0x57, 0x41, 0x56, 0x45, // "WAVE"
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, // "fmt ", 16
      0x01, 0x00, 0x01, 0x00, // PCM, mono
      0x80, 0x3e, 0x00, 0x00, // 16000 Hz
      0x00, 0x7d, 0x00, 0x00, // byte rate 32000
      0x02, 0x00, 0x10, 0x00, // block align 2, 16 bits
      0x64, 0x61, 0x74, 0x61, 0x06, 0x00, 0x00, 0x00, // "data", 6
      0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, // 0, 32767, -32768
    ];
    assert.deepEqual(Array.from(wav), expected);
  });

  test("empty input is a valid 44-byte WAV with zero data bytes", () => {
    const wav = mic.encodeWav(new Float32Array(0), 16000);
    assert.equal(wav.length, 44);
    const h = parseWav(wav);
    assert.equal(h.riff, "RIFF");
    assert.equal(h.wave, "WAVE");
    assert.equal(h.data, "data");
    assert.equal(h.riffSize, 36);
    assert.equal(h.dataSize, 0);
  });

  test("clamps out-of-range and non-finite samples instead of wrapping", () => {
    const wav = mic.encodeWav(new Float32Array([2, -2, 1.5, -7, Infinity, -Infinity, NaN]), 16000);
    assert.deepEqual(parseWav(wav).samples, [32767, -32768, 32767, -32768, 32767, -32768, 0]);
  });

  test("scales in-range samples to the int16 range", () => {
    const [half, negHalf] = parseWav(mic.encodeWav(new Float32Array([0.5, -0.5]), 16000)).samples;
    assert.ok(Math.abs(half - 16384) <= 1, `0.5 -> ${half}`);
    assert.ok(Math.abs(negHalf + 16384) <= 1, `-0.5 -> ${negHalf}`);
  });

  test("24 kHz is also accepted and written into rate and byte rate", () => {
    const h = parseWav(mic.encodeWav(new Float32Array(4), 24000));
    assert.equal(h.rate, 24000);
    assert.equal(h.byteRate, 48000);
  });

  test("a rate the server would reject throws RangeError", () => {
    for (const rate of [8000, 22050, 44100, 48000, 0]) {
      assert.throws(() => mic.encodeWav(new Float32Array(2), rate), RangeError, `rate ${rate}`);
    }
  });

  test("header sizes track the sample count for any length", () => {
    const rand = seeded(7);
    for (let i = 0; i < 25; i++) {
      const n = Math.floor(rand() * 5000);
      const wav = mic.encodeWav(new Float32Array(n).map(() => rand() * 2 - 1), 16000);
      const h = parseWav(wav);
      assert.equal(wav.length, 44 + 2 * n);
      assert.equal(h.riffSize, 36 + 2 * n);
      assert.equal(h.dataSize, 2 * n);
    }
  });

  test("matches the server's _check_wav_format constants at TARGET_SAMPLE_RATE", () => {
    assert.equal(mic.TARGET_SAMPLE_RATE, 16000);
    assert.ok(SERVER_RATES.includes(mic.TARGET_SAMPLE_RATE));
    const h = parseWav(mic.encodeWav(new Float32Array(10), mic.TARGET_SAMPLE_RATE));
    assert.equal(h.format, 1, "WAVE_FORMAT_PCM");
    assert.equal(h.fmtSize, 16);
    assert.equal(h.channels, SERVER_CHANNELS);
    assert.equal(h.bits / 8, SERVER_SAMPLE_WIDTH_BYTES);
    assert.equal(h.blockAlign, SERVER_CHANNELS * SERVER_SAMPLE_WIDTH_BYTES);
    assert.ok(SERVER_RATES.includes(h.rate));
    assert.equal(h.byteRate, h.rate * h.blockAlign);
  });
});

describe("downsample", () => {
  test("48000 -> 24000 halves the length", () => {
    const out = mic.downsample(new Float32Array([0.1, 0.1, 0.2, 0.2, 0.3, 0.3]), 48000, 24000);
    assert.ok(out instanceof Float32Array);
    assert.equal(out.length, 3);
  });

  test("output length is n * toRate / fromRate for whole-ratio and fractional-ratio rates", () => {
    assert.equal(mic.downsample(new Float32Array(4800), 48000, 16000).length, 1600);
    assert.equal(mic.downsample(new Float32Array(441), 44100, 16000).length, 160);
  });

  test("same rate keeps every sample", () => {
    const input = new Float32Array([0.25, -0.5, 1]);
    assert.deepEqual(Array.from(mic.downsample(input, 16000, 16000)), [0.25, -0.5, 1]);
  });

  test("a constant signal stays constant", () => {
    const out = mic.downsample(new Float32Array(960).fill(0.25), 48000, 16000);
    for (const v of out) assert.ok(Math.abs(v - 0.25) < 1e-6, `got ${v}`);
  });

  test("is deterministic, bounded by the input range, and leaves the input unmodified", () => {
    const rand = seeded(42);
    const input = new Float32Array(4410).map(() => rand() * 1.6 - 0.8);
    const before = Array.from(input);
    const a = mic.downsample(input, 44100, 16000);
    const b = mic.downsample(input, 44100, 16000);
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.deepEqual(Array.from(input), before);
    const lo = Math.min(...before);
    const hi = Math.max(...before);
    for (const v of a) assert.ok(v >= lo - 1e-6 && v <= hi + 1e-6, `${v} outside [${lo}, ${hi}]`);
  });

  test("empty input gives empty output", () => {
    assert.equal(mic.downsample(new Float32Array(0), 48000, 16000).length, 0);
  });
});

describe("chunkSamples", () => {
  test("constants mirror the server cap", () => {
    assert.equal(mic.MAX_CHUNK_BYTES, SERVER_MAX_CHUNK_BYTES);
    assert.equal(mic.MAX_CHUNK_SAMPLES, (SERVER_MAX_CHUNK_BYTES - 44) / 2);
  });

  test("empty recording yields no chunks", () => {
    assert.deepEqual(mic.chunkSamples(new Float32Array(0)), []);
  });

  test("a recording that fits is one chunk with the same samples", () => {
    const chunks = mic.chunkSamples(new Float32Array([0.1, 0.2, 0.3]));
    assert.equal(chunks.length, 1);
    assert.deepEqual(Array.from(chunks[0]), Array.from(new Float32Array([0.1, 0.2, 0.3])));
  });

  test("exactly MAX_CHUNK_SAMPLES is one chunk; one more sample spills into a second", () => {
    const max = mic.MAX_CHUNK_SAMPLES;
    assert.deepEqual(
      mic.chunkSamples(new Float32Array(max)).map((c) => c.length),
      [max],
    );
    assert.deepEqual(
      mic.chunkSamples(new Float32Array(max + 1)).map((c) => c.length),
      [max, 1],
    );
  });

  test("every chunk's WAV fits the server cap and the chunks reassemble the recording in order", () => {
    const rand = seeded(3);
    const input = new Float32Array(2 * mic.MAX_CHUNK_SAMPLES + 777).map(() => rand() * 2 - 1);
    const chunks = mic.chunkSamples(input);
    assert.equal(chunks.length, 3);
    for (const c of chunks) {
      const wav = mic.encodeWav(c, mic.TARGET_SAMPLE_RATE);
      assert.ok(wav.length <= SERVER_MAX_CHUNK_BYTES, `chunk WAV ${wav.length} bytes`);
    }
    assert.deepEqual(concat(chunks), input);
  });

  test("a custom byte cap bounds each chunk's WAV size", () => {
    const input = new Float32Array(10).map((_, i) => i / 10);
    const chunks = mic.chunkSamples(input, 44 + 8);
    assert.deepEqual(
      chunks.map((c) => c.length),
      [4, 4, 2],
    );
    assert.deepEqual(concat(chunks), input);
  });

  test("a cap too small for one sample throws RangeError", () => {
    assert.throws(() => mic.chunkSamples(new Float32Array(3), 45), RangeError);
  });
});

function fakeAudio(sampleRate) {
  const state = { contexts: 0, closed: 0, sources: [], processors: [] };
  class FakeAudioContext {
    constructor() {
      state.contexts += 1;
      this.sampleRate = sampleRate;
      this.destination = { kind: "destination" };
      this.state = "running";
    }
    createMediaStreamSource(stream) {
      state.sources.push(stream);
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const listeners = [];
      const node = {
        onaudioprocess: null,
        connect() {},
        disconnect() {},
        addEventListener(type, fn) {
          if (type === "audioprocess") listeners.push(fn);
        },
        removeEventListener() {},
        listeners,
      };
      state.processors.push(node);
      return node;
    }
    async resume() {}
    async close() {
      state.closed += 1;
      this.state = "closed";
    }
  }
  // Like the browser, reuses one Float32Array across callbacks.
  const shared = new Float32Array(4096);
  const emit = (values) => {
    const node = state.processors[0];
    assert.ok(node, "recordClip must create a script processor");
    const frame = shared.subarray(0, values.length);
    frame.set(values);
    const event = { inputBuffer: { numberOfChannels: 1, sampleRate, length: frame.length, getChannelData: () => frame } };
    if (typeof node.onaudioprocess === "function") node.onaudioprocess(event);
    for (const fn of node.listeners) fn(event);
  };
  return { AudioContext: FakeAudioContext, state, emit };
}

describe("recordClip", () => {
  test("records the given stream's frames and stop() resolves their WAV", async () => {
    const audio = fakeAudio(16000);
    const stream = { id: "mic-stream" };
    const clip = await mic.recordClip({ stream, AudioContext: audio.AudioContext, maxMs: 1000 });
    assert.deepEqual(audio.state.sources, [stream]);
    audio.emit([0, 1, -1]);
    audio.emit([1, 0]);
    const wav = await clip.stop();
    assert.ok(wav instanceof Uint8Array);
    assert.deepEqual(Array.from(wav), Array.from(mic.encodeWav(new Float32Array([0, 1, -1, 1, 0]), 16000)));
  });

  test("copies each frame although the browser reuses its buffer", async () => {
    const audio = fakeAudio(16000);
    const clip = await mic.recordClip({ stream: {}, AudioContext: audio.AudioContext, maxMs: 1000 });
    audio.emit([1, 1]);
    audio.emit([-1, -1]);
    assert.deepEqual(parseWav(await clip.stop()).samples, [32767, 32767, -32768, -32768]);
  });

  test("keeps only maxMs of audio and drops later frames", async () => {
    const audio = fakeAudio(16000);
    const clip = await mic.recordClip({ stream: {}, AudioContext: audio.AudioContext, maxMs: 250 });
    for (let i = 0; i < 3; i++) audio.emit(new Float32Array(2048).fill(0.5));
    audio.emit(new Float32Array(2048).fill(-1));
    const h = parseWav(await clip.stop());
    assert.equal(h.dataSize, 4000 * 2, "250 ms at 16 kHz is 4000 samples");
    assert.ok(!h.samples.includes(-32768), "frames past the cap are dropped");
  });

  test("downsamples a 48 kHz context to a 16 kHz WAV the server accepts", async () => {
    const audio = fakeAudio(48000);
    const clip = await mic.recordClip({ stream: {}, AudioContext: audio.AudioContext, maxMs: 100 });
    for (let i = 0; i < 2; i++) audio.emit(new Float32Array(4096).fill(0.5));
    const h = parseWav(await clip.stop());
    assert.equal(h.rate, 16000);
    assert.equal(h.channels, SERVER_CHANNELS);
    assert.equal(h.dataSize, 1600 * 2, "100 ms at 48 kHz is 4800 samples -> 1600 at 16 kHz");
    for (const v of h.samples) assert.ok(Math.abs(v - 16384) <= 1, `got ${v}`);
  });

  test("stop() with no frames is an empty WAV; stop closes the context once and is idempotent", async () => {
    const audio = fakeAudio(16000);
    const clip = await mic.recordClip({ stream: {}, AudioContext: audio.AudioContext, maxMs: 1000 });
    const first = await clip.stop();
    assert.equal(first.length, 44);
    audio.emit([0.5, 0.5]);
    const second = await clip.stop();
    assert.deepEqual(Array.from(second), Array.from(first));
    assert.equal(audio.state.contexts, 1);
    assert.equal(audio.state.closed, 1);
  });
});

function fakeFetch(status, body, { badJson = false } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (badJson) throw new SyntaxError("Unexpected token <");
        return body;
      },
      text: async () => (badJson ? "<html>413</html>" : JSON.stringify(body)),
    };
  };
  return { fetch, calls };
}

function trapGlobalFetch(t) {
  return t.mock.method(globalThis, "fetch", async () => {
    throw new Error("postRecallAudio must use the injected fetch");
  });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

describe("postRecallAudio", () => {
  const wav = mic.encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000);

  test("POSTs {audio: base64 WAV, keywords} as JSON to /recall/audio and returns {text}", async (t) => {
    const globalFetch = trapGlobalFetch(t);
    const { fetch, calls } = fakeFetch(200, { text: "the red door" });
    const result = await mic.postRecallAudio({ fetch, wav, keywords: ["red door", "lamp"], passcode: "" });
    assert.deepEqual(result, { text: "the red door" });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, "/recall/audio");
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(init.body), {
      audio: Buffer.from(wav).toString("base64"),
      keywords: ["red door", "lamp"],
    });
    assert.equal(globalFetch.mock.callCount(), 0);
  });

  test("sends X-Memripal-Passcode only when a passcode is set", async () => {
    const withCode = fakeFetch(200, { text: "" });
    await mic.postRecallAudio({ fetch: withCode.fetch, wav, keywords: [], passcode: "open sesame" });
    assert.equal(new Headers(withCode.calls[0].init.headers).get("x-memripal-passcode"), "open sesame");
    for (const passcode of ["", undefined, null]) {
      const none = fakeFetch(200, { text: "" });
      await mic.postRecallAudio({ fetch: none.fetch, wav, keywords: [], passcode });
      assert.equal(new Headers(none.calls[0].init.headers).has("x-memripal-passcode"), false, `passcode ${passcode}`);
    }
  });

  test("base64-encodes a full MAX_CHUNK_BYTES clip intact", async () => {
    const big = new Uint8Array(SERVER_MAX_CHUNK_BYTES).map((_, i) => (i * 31 + 7) & 0xff);
    const { fetch, calls } = fakeFetch(200, { text: "ok" });
    await mic.postRecallAudio({ fetch, wav: big, keywords: [], passcode: "" });
    assert.equal(JSON.parse(calls[0].init.body).audio, Buffer.from(big).toString("base64"));
  });

  const statusCodes = [
    [401, "passcode_required"],
    [409, "live_only"],
    [413, "too_large"],
    [429, "budget_exhausted"],
    [502, "upstream"],
  ];
  for (const [status, code] of statusCodes) {
    test(`HTTP ${status} rejects with RecallAudioError code ${code}`, async () => {
      const { fetch } = fakeFetch(status, { error: code });
      const err = await rejection(mic.postRecallAudio({ fetch, wav, keywords: [], passcode: "" }));
      assert.ok(err instanceof mic.RecallAudioError, String(err));
      assert.ok(err instanceof Error);
      assert.equal(err.code, code);
      assert.equal(err.status, status);
    });
  }

  test("maps by status even when the error body is not JSON", async () => {
    const { fetch } = fakeFetch(413, null, { badJson: true });
    const err = await rejection(mic.postRecallAudio({ fetch, wav, keywords: [], passcode: "" }));
    assert.equal(err.code, "too_large");
  });

  test("any other non-2xx status is code unexpected with its status", async () => {
    for (const status of [400, 415, 500, 503]) {
      const { fetch } = fakeFetch(status, { error: "whatever" });
      const err = await rejection(mic.postRecallAudio({ fetch, wav, keywords: [], passcode: "" }));
      assert.ok(err instanceof mic.RecallAudioError);
      assert.equal(err.code, "unexpected", `status ${status}`);
      assert.equal(err.status, status);
    }
  });

  test("a fetch that rejects surfaces as code network", async () => {
    const fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const err = await rejection(mic.postRecallAudio({ fetch, wav, keywords: [], passcode: "" }));
    assert.ok(err instanceof mic.RecallAudioError);
    assert.equal(err.code, "network");
  });

  test("a 200 without a string text is code upstream", async () => {
    for (const body of [{}, { text: 5 }, null]) {
      const { fetch } = fakeFetch(200, body);
      const err = await rejection(mic.postRecallAudio({ fetch, wav, keywords: [], passcode: "" }));
      assert.ok(err instanceof mic.RecallAudioError);
      assert.equal(err.code, "upstream", JSON.stringify(body));
    }
  });
});
