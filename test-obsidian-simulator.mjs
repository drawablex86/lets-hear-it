import fs from "fs";
import path from "path";
import Module from "module";

// Mock globals for browser/renderer
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = {
  createElement: (tag) => ({
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    style: {},
    appendChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
  }),
  body: {
    appendChild: () => {},
    removeChild: () => {},
  }
};
globalThis.AudioContext = class {
  constructor() {
    this.state = "running";
    this.sampleRate = 24000;
  }
  createBuffer(channels, length, rate) {
    const channelData = new Float32Array(length);
    return {
      getChannelData: () => channelData,
      copyToChannel: (src, ch) => { channelData.set(src); },
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      duration: length / rate
    };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {},
      stop: () => {},
      onended: null
    };
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
};
globalThis.CSS = {
  highlights: {
    set: () => {},
    delete: () => {}
  }
};
globalThis.Highlight = class {};

// Mock Obsidian
const mockPlugin = class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  load() {}
  addCommand() {}
  addSettingTab() {}
  addRibbonIcon() { return { addClass: () => {} }; }
  addStatusBarItem() { return { setText: () => {} }; }
  registerEvent() {}
  loadData() { return Promise.resolve({}); }
  saveData() { return Promise.resolve(); }
};

const mockObsidian = {
  Plugin: mockPlugin,
  PluginSettingTab: class {},
  FileSystemAdapter: class {},
  Notice: class {
    constructor(msg) { console.log(`[Obsidian Notice]: ${msg}`); }
    setMessage(msg) { console.log(`[Obsidian Notice Update]: ${msg}`); }
    hide() {}
  },
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    addDropdown() { return this; }
    addSlider() { return this; }
  },
  setIcon: () => {},
  addIcon: (id, svg) => { console.log(`[Obsidian addIcon]: ${id}`); },
  requestUrl: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) })
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === "obsidian") return mockObsidian;
  return originalRequire.apply(this, arguments);
};

console.log("=== Loading built main.js into Obsidian Simulation ===");
const mainModule = originalRequire.call(this, path.resolve("main.js"));
const PluginClass = mainModule.default;

console.log("=== Instantiating Plugin ===");
const mockApp = {
  workspace: {
    getActiveViewOfType: () => null,
    on: () => {},
  },
  vault: {
    adapter: {
      getBasePath: () => process.cwd()
    }
  }
};
const plugin = new PluginClass(mockApp, { id: "lets-hear-it", dir: path.resolve("v0") });

console.log("=== Calling onload() ===");
await plugin.onload();

console.log("=== Initializing AudioContext & Engine ===");
await plugin.ensureAudioContext();

console.log("=== Initializing Kokoro Model ===");
await plugin.ttsEngine.initModel();

console.log("=== Synthesizing test sentence ===");
const testSentence = "Hello, this is an automated test of local text to speech.";
const item = await plugin.ttsEngine.synthesizeSentence(testSentence, 0);
console.log(`Generated audio item! Duration: ${item.duration}s, audioBuffer length: ${item.audioBuffer.length}`);

console.log("=== AUTOMATED TEST PASSED WITH COMPLETE SUCCESS! ===");
process.exit(0);
