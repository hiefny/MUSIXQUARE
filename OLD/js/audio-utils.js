// audio-utils.js
// Handles Audio Extraction and WAV Encoding (Multi-channel support)

/**
 * Extracts audio from a Video/Audio File and returns a WAV Blob.
 * 
 * @param {File} file - The source video or audio file.
 * @returns {Promise<Blob>} - A Promise resolving to a WAV Blob.
 */
async function extractAudioToWav(file) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log(`[AudioUtils] Starting extraction: ${file.name} (${file.type})`);

            // 1. Read File to ArrayBuffer
            const arrayBuffer = await file.arrayBuffer();

            // 2. Decode Audio Data using OfflineContext (or standard Context)
            // We use a temporary context to decode.
            // Note: webkitAudioContext fallback not usually needed for modern decodeAudioData, 
            // but standard 'AudioContext' is best.
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

            console.log(`[AudioUtils] Decoded: ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz, ${audioBuffer.duration}s`);

            // 3. Encode to WAV
            const wavBlob = audioBufferToWav(audioBuffer);

            // Clean up context if possible (close to save memory)
            if (ctx.state !== 'closed') ctx.close();

            // preserve original name but change extension
            const originalName = file.name;
            const newName = originalName.substring(0, originalName.lastIndexOf('.')) + ".wav";

            // Return with metadata
            // We attach a custom property 'name' to Blob if needed, but File constructor is better.
            const wavFile = new File([wavBlob], newName, { type: "audio/wav" });

            resolve(wavFile);

        } catch (e) {
            console.error("[AudioUtils] Extraction Failed:", e);
            reject(e);
        }
    });
}

/**
 * Encodes an AudioBuffer to a WAV format Blob.
 * Supports arbitrary channel counts (Mono, Stereo, 5.1, 7.1 etc.)
 * 
 * Reference logic adapted from standard WAV encoding practices.
 */
function audioBufferToWav(buffer, opt) {
    opt = opt || {};
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = opt.float32 ? 3 : 1; // 3 = IEEE Float, 1 = PCM
    const bitDepth = format === 3 ? 32 : 16;

    let result;
    if (numChannels === 2) {
        result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
    } else if (numChannels === 1) {
        result = buffer.getChannelData(0);
    } else {
        // Multi-channel Interleaving
        result = interleaveMulti(buffer);
    }

    return encodeWAV(result, numChannels, sampleRate, format, bitDepth);
}

function interleave(inputL, inputR) {
    const length = inputL.length + inputR.length;
    const result = new Float32Array(length);

    let index = 0;
    let inputIndex = 0;

    while (index < length) {
        result[index++] = inputL[inputIndex];
        result[index++] = inputR[inputIndex];
        inputIndex++;
    }
    return result;
}

function interleaveMulti(buffer) {
    const numChannels = buffer.numberOfChannels;
    const len = buffer.length;
    const result = new Float32Array(len * numChannels);

    // Get all channel data
    const channels = [];
    for (let i = 0; i < numChannels; i++) {
        channels.push(buffer.getChannelData(i));
    }

    let ptr = 0;
    for (let i = 0; i < len; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            result[ptr++] = channels[ch][i];
        }
    }
    return result;
}

function encodeWAV(samples, numChannels, sampleRate, format, bitDepth) {
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    /* RIFF identifier */
    writeString(view, 0, 'RIFF');
    /* RIFF chunk length */
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    /* RIFF type */
    writeString(view, 8, 'WAVE');
    /* format chunk identifier */
    writeString(view, 12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw) */
    view.setUint16(20, format, true);
    /* channel count */
    view.setUint16(22, numChannels, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * blockAlign, true);
    /* block align (channel count * bytes per sample) */
    view.setUint16(32, blockAlign, true);
    /* bits per sample */
    view.setUint16(34, bitDepth, true);
    /* data chunk identifier */
    writeString(view, 36, 'data');
    /* data chunk length */
    view.setUint32(40, samples.length * bytesPerSample, true);

    if (format === 1) { // PCM
        floatTo16BitPCM(view, 44, samples);
    } else {
        floatTo32BitFloat(view, 44, samples);
    }

    return new Blob([view], { type: 'audio/wav' });
}

function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
}

function floatTo32BitFloat(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 4) {
        output.setFloat32(offset, input[i], true);
    }
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Expose to window
window.extractAudioToWav = extractAudioToWav;
