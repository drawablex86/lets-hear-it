import { Mp3Encoder } from "@breezystack/lamejs";

/**
 * Converts a Float32Array of audio samples (-1.0 to 1.0) into 16-bit signed PCM Int16Array.
 */
export function float32ToInt16(samples: Float32Array): Int16Array {
	const len = samples.length;
	const int16 = new Int16Array(len);
	for (let i = 0; i < len; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return int16;
}

/**
 * Encodes mono 24kHz PCM Float32Array audio samples into an MP3 ArrayBuffer.
 *
 * @param samples Float32Array of audio samples at 24000 Hz mono
 * @param sampleRate Sampling rate (default 24000 for Kokoro)
 * @param kbps MP3 bitrate in kbps (default 128)
 * @returns ArrayBuffer containing the binary MP3 data
 */
export function encodeFloat32ToMp3(
	samples: Float32Array,
	sampleRate = 24000,
	kbps = 128
): ArrayBuffer {
	const encoder = new Mp3Encoder(1, sampleRate, kbps);
	const int16Samples = float32ToInt16(samples);

	const mp3Chunks: Uint8Array[] = [];
	// Encode in chunks to prevent large memory spikes
	const chunkSize = 1152; // LAME standard frame size

	for (let i = 0; i < int16Samples.length; i += chunkSize) {
		const chunk = int16Samples.subarray(i, i + chunkSize);
		const mp3buf = encoder.encodeBuffer(chunk);
		if (mp3buf && mp3buf.length > 0) {
			mp3Chunks.push(new Uint8Array(mp3buf));
		}
	}

	const endBuf = encoder.flush();
	if (endBuf && endBuf.length > 0) {
		mp3Chunks.push(new Uint8Array(endBuf));
	}

	// Calculate total byte size
	const totalLength = mp3Chunks.reduce((acc, curr) => acc + curr.length, 0);
	const result = new Uint8Array(totalLength);

	let offset = 0;
	for (const chunk of mp3Chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result.buffer;
}
