# Reference: esbuild WASM Patching Guide for Electron

When bundling `onnxruntime-web` or `@huggingface/transformers` for Obsidian, standard bundler setups fail due to:
1. Dynamic `.mjs` module imports over `file://` protocols.
2. Emscripten's internal `XMLHttpRequest` attempting to load `.wasm` binaries.
3. Node-only packages (`worker_threads`, `module`) referenced inside `.mjs` runners.

Here is the exact battle-tested esbuild plugin setup to handle these issues.

---

## 1. Copy & Sanitize onnxruntime-web Binaries

Add an `onEnd` hook inside an esbuild plugin:

```javascript
import fs from "fs";
import path from "path";

export const copyAndSanitizeWasmPlugin = {
  name: "copy-wasm-plugin",
  setup(build) {
    build.onEnd(() => {
      const ortDistPath = path.resolve("node_modules/onnxruntime-web/dist");
      if (!fs.existsSync(ortDistPath)) return;

      const files = fs.readdirSync(ortDistPath);
      const targetDir = path.resolve(".");

      for (const file of files) {
        const src = path.join(ortDistPath, file);
        const dest = path.join(targetDir, file);

        // 1. Copy raw .wasm binaries
        if (file.endsWith(".wasm")) {
          fs.copyFileSync(src, dest);
        }

        // 2. Patch .mjs glue runners
        else if (file.endsWith(".mjs")) {
          let content = fs.readFileSync(src, "utf8");

          // Sanitize node-only imports that trigger browser syntax errors
          content = content.replace(/await\s+import\s*\(\s*["']module["']\s*\)/g, "{ createRequire: () => () => ({}) }");
          content = content.replace(/await\s+import\s*\(\s*["']worker_threads["']\s*\)/g, "{ workerData: undefined }");
          content = content.replace(/require\s*\(\s*["']worker_threads["']\s*\)/g, "{}");

          // Intercept Emscripten's async and sync file loaders
          const xhrAsyncPattern = /if\(na\(a\)\)return new Promise\(\(d,c\)=>\{var e=new XMLHttpRequest;e\.open\("GET",a,!0\);e\.responseType="arraybuffer";e\.onload=\(\)=>\{200==e\.status\|\|0==e\.status&&e\.response\?d\(e\.response\):c\(e\.status\)\};e\.onerror=c;e\.send\(null\)\}\);/g;
          const fsAsyncReplacement = `if (typeof require === "function" && typeof a === "string" && a.startsWith("file://")) {
            const fs = require("fs");
            const p = decodeURIComponent(a.replace(/^file:\\/\\//, ""));
            if (fs.existsSync(p)) {
              const buf = fs.readFileSync(p);
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            }
          }`;
          content = content.replace(xhrAsyncPattern, fsAsyncReplacement);

          // Patch Emscripten Ta(a) which resolves wasm Uint8Array
          const taPattern = /async function Ta\(a\)\{if\(!ta\)try\{var b=await la\(a\);return new Uint8Array\(b\)\}catch\{\}if\(a==Sa&&ta\)a=new Uint8Array\(ta\);else if\(ma\)a=ma\(a\);else throw"both async and sync fetching of the wasm failed";return a\}/g;
          const taReplacement = `async function Ta(a) {
            if (typeof require === "function" && typeof a === "string" && a.startsWith("file://")) {
              const fs = require("fs");
              const p = decodeURIComponent(a.replace(/^file:\\/\\//, ""));
              if (fs.existsSync(p)) {
                const buf = fs.readFileSync(p);
                return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
              }
            }
            if (!ta) try { var b = await la(a); return new Uint8Array(b); } catch {}
            if (a == Sa && ta) a = new Uint8Array(ta);
            else if (ma) a = ma(a);
            else throw "both async and sync fetching of the wasm failed";
            return a;
          }`;
          content = content.replace(taPattern, taReplacement);

          fs.writeFileSync(dest, content, "utf8");
        }
      }
    });
  }
};
```

---

## 2. Dynamic Import Patch for `main.js`

After esbuild compiles `main.js`, patch the dynamic `import(r)` statements to support Data URLs:

```javascript
const mainJsPath = path.resolve("main.js");
if (fs.existsSync(mainJsPath)) {
  let mainJs = fs.readFileSync(mainJsPath, "utf8");
  const search = `(await import(r)).default`;
  const replacement = `(await (async (specifier) => {
    if (typeof require === "function" && typeof specifier === "string") {
      if (specifier.startsWith("file://")) {
        const fs = require("fs");
        const filePath = decodeURIComponent(specifier.replace(/^file:\\/\\//, ""));
        if (fs.existsSync(filePath)) {
          const fileContent = fs.readFileSync(filePath);
          const base64 = Buffer.from(fileContent).toString("base64");
          return import(\`data:text/javascript;base64,\${base64}\`);
        }
      } else if (specifier.startsWith("blob:")) {
        try {
          const resp = await fetch(specifier);
          const buf = await resp.arrayBuffer();
          const base64 = Buffer.from(buf).toString("base64");
          return import(\`data:text/javascript;base64,\${base64}\`);
        } catch (e) {}
      }
    }
    return import(specifier);
  })(r)).default`;

  if (mainJs.includes(search)) {
    mainJs = mainJs.replaceAll(search, replacement);
  }

  // Neutralize CDN wasmPaths override in transformers.js if present
  const cdnSearch = `!x.wasm.wasmPaths&&(x.wasm.wasmPaths=\`https://cdn.jsdelivr.net/npm/@huggingface/transformers@\${c.env.version}/dist/\`)`;
  if (mainJs.includes(cdnSearch)) {
    mainJs = mainJs.replace(cdnSearch, `true`);
  }

  fs.writeFileSync(mainJsPath, mainJs, "utf8");
}
```
