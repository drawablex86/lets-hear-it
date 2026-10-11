# Reference: WebAudio Resampling & Gapless Playback

When implementing audio synthesis (TTS, audio generation, speech playback) in Obsidian, incorrect WebAudio configuration causes audio buffer under-runs, clicking, and popping on macOS and Windows.

---

## 1. Decoupling Hardware DAC Sample Rate from Model Sample Rate

### The Mistake:
```typescript
// ❌ WRONG: Forcing hardware AudioContext to match model output
const audioCtx = new AudioContext({ sampleRate: 24000 });
```
On macOS, hardware DACs (speakers, headphones, external interfaces) usually operate at **44,100 Hz** or **48,000 Hz**. Requesting a custom sample rate forces CoreAudio to adapt with software resampling at the driver layer, causing frequent audio glitches and pops.

### The Correct Pattern:
```typescript
// ✅ CORRECT: Let AudioContext negotiate system native rate (44.1k/48k)
const audioCtx = new AudioContext();

// Feed model PCM into an AudioBuffer with the model's native rate (e.g., 24000)
function createBufferFromPCM(pcmData: Float32Array, modelSampleRate = 24000): AudioBuffer {
  const buffer = audioCtx.createBuffer(1, pcmData.length, modelSampleRate);
  buffer.copyToChannel(pcmData, 0);
  return buffer;
}
```
WebAudio's internal audio graph resamples the 24kHz buffer to the DAC's 48kHz output automatically with zero latency, zero buffer under-runs, and broadcast clarity.

---

## 2. Handling Chromium Autoplay Policies in Obsidian

Chromium enforces that an `AudioContext` cannot produce sound until the user interacts with the window (click, keyboard stroke).

Always resume the context inside your plugin's command or ribbon click handlers:

```typescript
async function ensureAudioContext(audioCtx: AudioContext): Promise<void> {
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
}
```

---

## 3. Gapless Pre-Buffering Pipeline

To achieve sub-second response times without audible gaps between sentences:
1. Split document text into sentence chunks.
2. Synthesize Chunk 0 and immediately trigger playback (`sourceNode.start()`).
3. While Chunk 0 is playing, synthesize Chunk 1 and Chunk 2 in the background.
4. Schedule Chunk 1 to start seamlessly as Chunk 0 ends using WebAudio precise timestamps (`sourceNode.start(nextStartTime)`).
