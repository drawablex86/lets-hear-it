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

## 3. Audio Sample Conditioning & Anti-Pop Micro-Fades

Raw Float32 arrays produced by neural models can contain out-of-range amplitude spikes or sudden non-zero start/end boundaries, triggering audible digital clicks on hardware DACs:

```typescript
function conditionAudioSamples(float32Data: Float32Array): Float32Array {
  const pcm = new Float32Array(float32Data.length);
  // 3ms fade window (at 24kHz = 72 samples; at 48kHz = 144 samples)
  const fadeLength = Math.min(72, Math.floor(float32Data.length / 4));

  for (let i = 0; i < float32Data.length; i++) {
    let s = float32Data[i];
    // 1. Filter NaN or infinite values
    if (isNaN(s) || !isFinite(s)) {
      s = 0;
    } 
    // 2. Hard clamp to prevent DAC clipping distortion
    else if (s > 1.0) {
      s = 1.0;
    } else if (s < -1.0) {
      s = -1.0;
    }

    // 3. Smooth micro fade-in at onset
    if (i < fadeLength) {
      s *= (i / fadeLength);
    }
    // 4. Smooth micro fade-out at tail
    else if (i >= float32Data.length - fadeLength) {
      s *= ((float32Data.length - 1 - i) / fadeLength);
    }

    pcm[i] = s;
  }
  return pcm;
}
```

---

## 4. Continuous Sliding Window Pre-Buffering Pipeline

To achieve continuous playback without audible buffering pauses:
1. **Sliding Lookahead Window of 2**: Maintain a continuous queue where chunk $N+1$ and chunk $N+2$ are pre-buffering while chunk $N$ is actively playing.
2. **Proactive Buffer Priming**: When initiating playback, trigger synthesis for chunk 0 and lookahead chunks in parallel so background inference stays ahead of real-time playback from the start.
3. **Compound Clause Splitting**: Split long compound sentences at natural punctuation marks (commas, semicolons, dashes) at $\sim 200\text{--}250$ characters to ensure individual chunk generation takes $<250\text{ms}$.
