// audio-utils.js
// Handles Audio Extraction and WAV Encoding (Multi-channel support)

/* 
// [STABILIZATION] Disabled to prevent mobile memory crashes (decodeAudioData)
async function extractAudioToWav(file) {
    ...
}
function audioBufferToWav(buffer, opt) {
    ...
}
*/

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
