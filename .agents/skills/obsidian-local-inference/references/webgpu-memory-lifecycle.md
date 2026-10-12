# Reference: WebGPU Memory Lifecycle, Explicit Tensor Disposal & Queue Pipelining in Electron

When deploying on-device neural models (ONNX Runtime Web, Transformers.js, Kokoro, Whisper, embeddings) with WebGPU inside Obsidian's Electron desktop environment, plugins must handle unique constraints across V8 JavaScript garbage collection, GPU driver memory, and real-time audio/UI scheduling.

---

## 1. The Dual-Heap Disconnect (V8 vs. WebGPU Driver Memory)

### The Core Problem
1. **JavaScript V8 Heap**: V8 only manages small JS wrapper objects (`ort.Tensor`, `GPUBuffer` wrappers), which consume negligible memory (a few dozen bytes).
2. **Native GPU / Driver Heap**: The actual multi-megabyte tensor buffers live in unmanaged C++/driver memory arenas inside Chromium's GPU process.
3. **The Garbage Collector Blind Spot**: Because V8 sees almost zero heap pressure from tiny JS handles, it never triggers major Mark-Sweep GC cycles. As a result, underlying WebGPU buffers remain pinned, causing RAM/VRAM to escalate rapidly into gigabytes and eventually crashing the renderer or GPU process with out-of-memory (OOM) errors.

---

## 2. Explicit Tensor Lifecycle Management

### Best Practice: Disposing Intermediate & Input Tensors
High-level libraries often drop intermediate tensor references on the floor without calling `.dispose()`. In WebGPU execution providers, every forward pass retains GPU buffer allocations unless explicitly released.

Intercept inference methods or wrap execution pipelines to guarantee cleanup:

```typescript
// Intercept model forward pass to guarantee disposal
async function executeInferenceWithZeroLeaks(model: any, inputs: Record<string, any>) {
  try {
    const result = await model(inputs);
    return result;
  } finally {
    // Explicitly dispose all input tensors
    for (const key of Object.keys(inputs)) {
      const tensor = inputs[key];
      if (tensor && typeof tensor.dispose === "function") {
        try {
          tensor.dispose();
        } catch (_) {}
      }
    }
  }
}
```

---

## 3. Cooperative V8 Garbage Collection in Electron

### Safe Dynamic GC Activation in Obsidian
In standard web browsers, `window.gc()` is disabled. In Obsidian Desktop, you can leverage Node integration to enable and invoke V8's garbage collector safely without needing custom command-line startup flags:

```typescript
export class MemoryManager {
  private static gcDebounceTimeout: number | null = null;
  private static operationsSinceLastGC = 0;

  /**
   * Safely invokes V8 garbage collector if available in Electron.
   */
  public static triggerGarbageCollection(): void {
    try {
      const win = typeof window !== "undefined" ? (window as unknown as { gc?: () => void }) : undefined;
      if (typeof win?.gc === "function") {
        win.gc();
        return;
      }

      const req = (typeof window !== "undefined" ? (window as unknown as { require?: (mod: string) => Record<string, unknown> }).require : undefined) ||
        (typeof require === "function" ? require : undefined);
      if (req) {
        const v8 = req("v8") as { setFlagsFromString?: (flags: string) => void };
        const vm = req("vm") as { runInNewContext?: (code: string) => unknown };
        if (typeof v8?.setFlagsFromString === "function" && typeof vm?.runInNewContext === "function") {
          v8.setFlagsFromString("--expose_gc");
          const gcFn = vm.runInNewContext("gc") as (() => void) | undefined;
          if (typeof gcFn === "function") {
            gcFn();
          }
        }
      }
    } catch {
      // Ignore if environment forbids explicit GC
    }
  }

  /**
   * Schedules a debounced, idle GC sweep.
   * NEVER run synchronous GC after every inference iteration:
   * synchronous GC freezes the event loop for 50-150ms, causing UI stutter
   * and dramatic sawtooth memory pressure curves!
   */
  public static scheduleIdleGCSweep(forceNow = false): void {
    MemoryManager.operationsSinceLastGC++;

    if (forceNow || MemoryManager.operationsSinceLastGC >= 8) {
      if (MemoryManager.gcDebounceTimeout !== null) {
        window.clearTimeout(MemoryManager.gcDebounceTimeout);
        MemoryManager.gcDebounceTimeout = null;
      }
      MemoryManager.operationsSinceLastGC = 0;

      // Defer to idle frame to ensure high-priority UI and audio threads are never blocked
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => {
          MemoryManager.triggerGarbageCollection();
        });
      } else {
        window.setTimeout(() => {
          MemoryManager.triggerGarbageCollection();
        }, 100);
      }
      return;
    }

    if (MemoryManager.gcDebounceTimeout === null) {
      MemoryManager.gcDebounceTimeout = window.setTimeout(() => {
        MemoryManager.gcDebounceTimeout = null;
        MemoryManager.operationsSinceLastGC = 0;
        MemoryManager.triggerGarbageCollection();
      }, 3000);
    }
  }
}
```

---

## 4. Half-Precision (`fp16`) Shader Hazards in WebGPU

### Why `fp16` Breaks Audio & Normalization Heads
While `fp16` cuts VRAM in half and accelerates heavy matrix multiplications, transformer-based audio vocoders and normalization blocks (AdaIN, LayerNorm, RMSNorm) compute variances and sums that exceed half-precision limits ($65,504$).
Under Chromium's WGSL/WebGPU compiler, this causes:
- Numerical overflow resulting in `+Inf` or `NaN`.
- Severe robotic, cracked, or static audio clipping.

### The Solution
1. **Force `fp32` for Generative Audio**: On WebGPU, always use `dtype: "fp32"` for text-to-speech and vocoders. Small models (50–100M parameters) only occupy $\sim 300\text{MB}$ in `fp32`, which modern GPUs handle effortlessly with pristine acoustics.
2. **Audio Sample Conditioning**: Always clamp raw output PCM arrays to `[-1.0, 1.0]` and apply micro fade-in/fade-out curves ($3\text{ms}$) to prevent DAC boundary pops.

---

## 5. Pipelined Sliding Window Buffering for Compound Content

### The Starvation Trap of 1-Chunk Lookahead
If a pipeline only buffers 1 item ahead (`N+1`):
- A short chunk (e.g. 1.2s playback) followed by a long compound sentence (e.g. 1.8s synthesis) starves the buffer before the next chunk is ready.
- This creates annoying "buffering delays every few sentences".

### The Continuous Sliding Window Pattern
1. **Set Lookahead to 2**: Maintain a continuous sliding window (`BUFFER_LOOKAHEAD = 2`). While item $N$ plays, items $N+1$ and $N+2$ are already pre-buffered or synthesizing in the background.
2. **Proactive Buffer Priming**: When starting playback, initiate synthesis for item 0 *and* lookahead items concurrently so the background pipeline is ahead of the playback cursor from second zero.
3. **Optimized Clause Splitting**: Split compound sentences at natural punctuation marks (commas, semicolons, em-dashes) at $\sim 200\text{--}250$ characters to guarantee no single chunk blocks the queue.
