// Covers: MEM-037
// Requirement: recall points light while Kev is still speaking, so the recorder hands out 5 s slices mid-run:
// take() yields a 16 kHz mono WAV of everything recorded since the previous take's mark, re-including
// LIVE_OVERLAP_MS (1 s) of audio before that mark (clamped at the clip start) so a word cut at a slice edge
// is heard whole in the next slice; null when nothing new arrived. Done's stop() yields the untaken
// remainder with the same overlap (null when nothing new since the last take); a clip never sliced still
// stops to the whole recording. The maxMs cap bounds the run across all slices.
// Contract (RED; GREEN implements in static/mic_wav.js):
//   LIVE_OVERLAP_MS === 1000; clip.take() -> Promise<Uint8Array | null>; recording continues after a take
//   (context stays open). Sibling of mic_wav.test.mjs (that file is at the 500-line cap).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as mic from "./mic_wav.js";

const SERVER_CHANNELS = 1;
// At 16 kHz the 1 s overlap is exactly this many samples.
const OVERLAP_16K = 16000;

function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = [];
  for (let off = 44; off + 1 < bytes.length; off += 2) samples.push(dv.getInt16(off, true));
  return {
    channels: dv.getUint16(22, true),
    rate: dv.getUint32(24, true),
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

function signal(n, seed) {
  const rand = seeded(seed);
  return new Float32Array(n).map(() => rand() * 2 - 1);
}

// Same fake as mic_wav.test.mjs: frames are driven by hand through the script processor.
function fakeAudio(sampleRate) {
  const state = { contexts: 0, closed: 0, processors: [] };
  class FakeAudioContext {
    constructor() {
      state.contexts += 1;
      this.sampleRate = sampleRate;
      this.destination = { kind: "destination" };
      this.state = "running";
    }
    createMediaStreamSource() {
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
  // Feeds pcm in browser-sized frames (<= 4096 samples each).
  const feed = (pcm) => {
    for (let off = 0; off < pcm.length; off += 4096) emit(pcm.subarray(off, off + 4096));
  };
  return { AudioContext: FakeAudioContext, state, emit, feed };
}

// At a 16 kHz context downsample is the identity, so an expected slice WAV is exact.
const wavOf = (pcm) => Array.from(mic.encodeWav(pcm, 16000));

async function open(sampleRate, maxMs = 10000) {
  const audio = fakeAudio(sampleRate);
  const clip = await mic.recordClip({ stream: {}, AudioContext: audio.AudioContext, maxMs });
  assert.equal(typeof clip.take, "function", "recordClip must expose take()");
  return { audio, clip };
}

describe("recordClip take() slices", () => {
  test("LIVE_OVERLAP_MS is one second", () => {
    assert.equal(mic.LIVE_OVERLAP_MS, 1000);
  });

  test("the first take() is everything recorded so far (overlap clamped at the clip start)", async () => {
    const { audio, clip } = await open(16000);
    const pcm = signal(40000, 11);
    audio.feed(pcm);
    const wav = await clip.take();
    assert.ok(wav instanceof Uint8Array);
    assert.deepEqual(Array.from(wav), wavOf(pcm));
    assert.equal(audio.state.closed, 0, "take() keeps recording");
  });

  test("take() with no new sample since the mark resolves null", async () => {
    const { audio, clip } = await open(16000);
    assert.equal(await clip.take(), null, "nothing recorded yet");
    audio.feed(signal(3000, 12));
    assert.ok((await clip.take()) instanceof Uint8Array);
    assert.equal(await clip.take(), null, "nothing new since the previous take");
  });

  test("a second take() is 1 s of overlap before the mark plus the new samples", async () => {
    const { audio, clip } = await open(16000);
    const pcm = signal(60000, 13);
    audio.feed(pcm.subarray(0, 40000));
    await clip.take();
    audio.feed(pcm.subarray(40000));
    const second = await clip.take();
    assert.equal(parseWav(second).dataSize, (OVERLAP_16K + 20000) * 2, "16000 overlap + 20000 new samples");
    assert.deepEqual(Array.from(second), wavOf(pcm.subarray(40000 - OVERLAP_16K, 60000)));
  });

  test("the overlap is clamped at the clip start when the previous mark is under 1 s in", async () => {
    const { audio, clip } = await open(16000);
    const pcm = signal(8000, 14);
    audio.feed(pcm.subarray(0, 5000));
    await clip.take();
    audio.feed(pcm.subarray(5000));
    assert.deepEqual(Array.from(await clip.take()), wavOf(pcm), "max(0, 5000 - 16000) = 0 -> all 8000");
  });

  test("slices from a 48 kHz context are 16 kHz WAVs carrying the 1 s overlap", async () => {
    const { audio, clip } = await open(48000);
    audio.feed(new Float32Array(48000).fill(0.25));
    audio.feed(new Float32Array(48000).fill(0.5));
    const first = parseWav(await clip.take());
    assert.equal(first.rate, 16000);
    assert.equal(first.dataSize, 32000 * 2, "2 s at 48 kHz -> 32000 samples at 16 kHz");
    audio.feed(new Float32Array(48000).fill(-0.5));
    const second = parseWav(await clip.take());
    assert.equal(second.rate, 16000);
    assert.equal(second.channels, SERVER_CHANNELS);
    assert.equal(second.dataSize, 32000 * 2, "1 s overlap + 1 s new -> 32000 samples at 16 kHz");
    for (const v of second.samples.slice(0, 16000)) assert.ok(Math.abs(v - 16384) <= 1, `overlap sample ${v}`);
    for (const v of second.samples.slice(16000)) assert.ok(Math.abs(v + 16384) <= 1, `new sample ${v}`);
  });

  test("stop() after takes resolves the untaken remainder with the same 1 s overlap", async () => {
    const { audio, clip } = await open(16000);
    const pcm = signal(50000, 15);
    audio.feed(pcm.subarray(0, 40000));
    await clip.take();
    audio.feed(pcm.subarray(40000));
    assert.deepEqual(Array.from(await clip.stop()), wavOf(pcm.subarray(40000 - OVERLAP_16K, 50000)));
    assert.equal(audio.state.closed, 1);
  });

  test("stop() resolves null when a take() ran and nothing is new since it", async () => {
    const { audio, clip } = await open(16000);
    audio.feed(signal(20000, 16));
    assert.ok((await clip.take()) instanceof Uint8Array);
    assert.equal(await clip.stop(), null);
    assert.equal(await clip.stop(), null, "a repeated stop() resolves the same result");
    assert.equal(audio.state.contexts, 1);
    assert.equal(audio.state.closed, 1);
  });

  test("without any take(), stop() is still the whole clip, even past the overlap window", async () => {
    const audio = fakeAudio(16000);
    const clip = await mic.recordClip({ stream: {}, AudioContext: audio.AudioContext, maxMs: 10000 });
    const pcm = signal(40000, 17);
    audio.feed(pcm);
    assert.deepEqual(Array.from(await clip.stop()), wavOf(pcm));
  });

  test("the maxMs cap bounds the recording across takes", async () => {
    // 2000 ms at 16 kHz = 32000 samples kept in total.
    const { audio, clip } = await open(16000, 2000);
    const pcm = signal(40000, 18);
    audio.feed(pcm.subarray(0, 20000));
    assert.deepEqual(Array.from(await clip.take()), wavOf(pcm.subarray(0, 20000)));
    audio.feed(pcm.subarray(20000));
    assert.deepEqual(
      Array.from(await clip.take()),
      wavOf(pcm.subarray(20000 - OVERLAP_16K, 32000)),
      "samples past the 32000 cap are dropped",
    );
    audio.feed(signal(4096, 19));
    assert.equal(await clip.take(), null, "frames past the cap are not new samples");
    assert.equal(await clip.stop(), null);
  });
});
