import fs from "fs";
import path from "path";
import ts from "typescript";

const cleanerCode = fs.readFileSync("src/engine/cleaner.ts", "utf8");
const transpiled = ts.transpileModule(cleanerCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const m = { exports: {} };
const fn = new Function("module", "exports", transpiled.outputText);
fn(m, m.exports);
const { cleanMarkdownForSpeech } = m.exports;

async function run() {
	console.log("=== RUNNING AUTOMATED E2E VERIFICATION ===");

	// 1. Test Markdown cleaner
	const sampleMd = `
# Kokoro TTS Test
This is **Kokoro-82M** running locally inside Obsidian.
Visit [[Neural Voice|Kokoro]] or check out [arXiv](https://arxiv.org).
\`\`\`ts
const code = true;
\`\`\`
Check: Dr. Smith tested 3.14 sentences.
	`;
	const { cleanText, sentences } = cleanMarkdownForSpeech(sampleMd);
	console.log(`[Cleaner] Extracted ${sentences.length} sentences cleanly.`);
	if (sentences.length < 2) {
		throw new Error("Cleaner failed to segment sentences properly");
	}

	// 2. Test patched WASM glue files
	const jsepPath = path.resolve("v0/ort-wasm-simd-threaded.jsep.mjs");
	const jsep = fs.readFileSync(jsepPath, "utf8");

	if (!jsep.includes("buf.buffer.slice")) {
		throw new Error("WASM loader in jsep.mjs does not have local fs binary patch!");
	}

	if (jsep.includes("if(na(a))return new Promise((d,c)=>{var e=new XMLHttpRequest")) {
		throw new Error("jsep.mjs still contains unpatched async XMLHttpRequest!");
	}

	// 3. Test main.js dynamic import patch
	const mainJs = fs.readFileSync(path.resolve("v0/main.js"), "utf8");
	if (!mainJs.includes("URL.createObjectURL(blob)")) {
		throw new Error("main.js does not have Blob URL dynamic import patch!");
	}

	console.log("=== ALL AUTOMATED TESTS PASSED SUCCESSFULLY! ===");
}

run().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
