// Opus stereo SDP helpers for the system-audio media paths. They are kept apart
// from network/peer.ts, which never munges SDP itself, because only the lazy
// system-audio host, guest and SFU modules and the PRO direct and SFU
// publishers use them.

/**
 * Munge SDP to force Opus codec into high-fidelity stereo mode.
 * Fixes Chrome's tendency to downmix to 1-channel mono and limit bitrate.
 */
export function forceStereoSdp(sdp: string): string {
  let modified = sdp;
  const stereoParams = ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=256000', 'useinbandfec=1'];

  // 1. Find opus payload types
  const opusPTs: string[] = [];
  const rtpmapRegex = /a=rtpmap:(\d+) opus\/48000\/2/g;
  let match;
  while ((match = rtpmapRegex.exec(sdp)) !== null) {
    opusPTs.push(match[1]);
  }

  // 2. Add/replace stereo params to ALL fmtp lines for these PTs
  for (const pt of opusPTs) {
    let foundFmtp = false;
    const fmtpRegex = new RegExp(`^a=fmtp:${pt}(?:(?:\\s+|;)([^\\r\\n]*))?$`, 'gm');
    modified = modified.replace(fmtpRegex, (_line, params: string | undefined) => {
      foundFmtp = true;
      const preservedParams = (params || '')
        .split(';')
        .map((param) => param.trim())
        .filter(Boolean)
        .filter((param) => !/^(stereo|sprop-stereo|maxaveragebitrate|useinbandfec)=/i.test(param));

      return `a=fmtp:${pt} ${[...preservedParams, ...stereoParams].join('; ')}`;
    });

    if (!foundFmtp) {
      // If no fmtp line exists, append it after the rtpmap line
      const rtpmapLine = new RegExp(`a=rtpmap:${pt} opus/48000/2`);
      modified = modified.replace(rtpmapLine, (line) => {
        return line + `\r\na=fmtp:${pt} ${stereoParams.join('; ')}`;
      });
    }
  }
  return modified;
}

/**
 * True only when the remote endpoint explicitly prefers Opus stereo receive.
 * RFC 7587 makes `stereo` unidirectional, so a publisher must inspect the
 * answer instead of assuming its own offer enabled stereo transmission.
 */
export function sdpPrefersOpusStereo(sdp: string): boolean {
  const opusPayloadTypes = new Set<string>();
  for (const match of sdp.matchAll(/^a=rtpmap:(\d+)\s+opus\/48000\/2\s*$/gim)) {
    if (match[1]) opusPayloadTypes.add(match[1]);
  }
  if (opusPayloadTypes.size === 0) return false;

  for (const match of sdp.matchAll(/^a=fmtp:(\d+)\s+([^\r\n]*)$/gim)) {
    const payloadType = match[1];
    const parameters = match[2];
    if (!payloadType || !parameters || !opusPayloadTypes.has(payloadType)) continue;
    if (
      parameters
        .split(';')
        .map((parameter) => parameter.trim())
        .some((parameter) => /^stereo\s*=\s*1$/i.test(parameter))
    ) {
      return true;
    }
  }
  return false;
}
