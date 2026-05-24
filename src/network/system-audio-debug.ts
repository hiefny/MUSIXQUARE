import { getState } from '../core/state.ts';
import { isAudioReady, getAudioContext } from '../audio/engine.ts';
import { getSystemAudioCaptureDebugSnapshot } from '../audio/system-capture.ts';
import { getPlaybackOwnership } from '../player/ownership.ts';
import type { ConnectedPeer, DataConnection } from '../types/index.ts';
import { getSystemAudioGuestDebugSnapshot } from './system-audio-guest.ts';
import { getSystemAudioHostDebugSnapshot } from './system-audio-host.ts';
import { getSystemAudioSfuDebugSnapshot } from './system-audio-sfu.ts';

interface PeerConnectionRef {
  label: string;
  pc?: RTCPeerConnection | null;
}

function short(value: string | null | undefined): string {
  if (!value) return '-';
  return value.slice(0, 8);
}

function yn(value: unknown): string {
  return value ? 'yes' : 'no';
}

function list(value: unknown): string {
  if (!Array.isArray(value)) return value == null ? '-' : String(value);
  return value.length ? value.map(String).join(',') : 'none';
}

function age(timestamp: number | undefined): string {
  if (!timestamp) return 'never';
  const ms = Math.max(0, Date.now() - timestamp);
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

function dataConnLine(conn: DataConnection | null | undefined): string {
  if (!conn) return 'none';
  const pc = conn.peerConnection;
  const states = pc
    ? `${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState}`
    : 'no-pc';
  const dc = conn.dataChannel?.readyState || conn.controlChannel?.readyState || '-';
  return `peer:${short(conn.peer)} open:${yn(conn.open)} dc:${dc} pc:${states}`;
}

function statNumber(report: Record<string, unknown>, key: string): string {
  const value = report[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '-';
}

function isAudioRtpReport(report: Record<string, unknown>): boolean {
  return report.kind === 'audio' || report.mediaType === 'audio';
}

async function collectStats(refs: PeerConnectionRef[]): Promise<string[]> {
  const seen = new Set<RTCPeerConnection>();
  const unique = refs.filter((ref): ref is PeerConnectionRef & { pc: RTCPeerConnection } => {
    if (!ref.pc || seen.has(ref.pc)) return false;
    seen.add(ref.pc);
    return true;
  });
  const lines: string[] = [];

  for (const ref of unique) {
    const state = `${ref.pc.connectionState}/${ref.pc.iceConnectionState}/${ref.pc.signalingState}`;
    try {
      const stats = await ref.pc.getStats();
      const rtp: string[] = [];
      for (const value of stats.values()) {
        const report = value as Record<string, unknown>;
        if (!isAudioRtpReport(report)) continue;
        if (report.type === 'inbound-rtp') {
          rtp.push(
            `in bytes:${statNumber(report, 'bytesReceived')} pkts:${statNumber(report, 'packetsReceived')} lost:${statNumber(report, 'packetsLost')} jitter:${statNumber(report, 'jitter')}`,
          );
        } else if (report.type === 'outbound-rtp') {
          rtp.push(
            `out bytes:${statNumber(report, 'bytesSent')} pkts:${statNumber(report, 'packetsSent')} retrans:${statNumber(report, 'retransmittedPacketsSent')}`,
          );
        }
      }
      lines.push(
        `  ${ref.label} pc:${state} | ${rtp.slice(0, 4).join(' | ') || 'no audio RTP stats'}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`  ${ref.label} pc:${state} | stats-error:${message}`);
    }
  }

  if (lines.length === 0) lines.push('  none');
  return lines;
}

export async function collectSystemAudioDebugText(): Promise<string> {
  const capture = getSystemAudioCaptureDebugSnapshot();
  const host = getSystemAudioHostDebugSnapshot();
  const guest = getSystemAudioGuestDebugSnapshot();
  const sfu = getSystemAudioSfuDebugSnapshot();
  const playback = getPlaybackOwnership();
  const peers = getState('network.connectedPeers') as ConnectedPeer[];
  const hostConn = getState('network.hostConn');
  const activeHostConns = getState('network.activeHostConnByPeerId');
  const lines: string[] = ['SYSTEM AUDIO DEBUG'];

  lines.push(`[Time] ${new Date().toISOString()}`);
  lines.push(`[UA] ${navigator.userAgent}`);
  lines.push(
    `[App] role:${getState('network.appRole')} conn:${getState('network.connectionType')} my:${short(getState('network.myId'))} code:${getState('network.sessionCode') || '-'}`,
  );
  lines.push(
    `[Playback] owner:${playback.owner} mode:${playback.mode ?? 'none'}/${playback.activity} receiving:${yn(playback.isReceivingSystemAudio)} placeholder:${yn(playback.isSystemAudioPlaceholder)}`,
  );
  lines.push(`[HostConn] ${dataConnLine(hostConn)}`);
  lines.push(`[HostDataConns] ${activeHostConns.size}`);
  for (const [peerId, conn] of activeHostConns.entries()) {
    lines.push(`  ${short(peerId)} ${dataConnLine(conn)}`);
  }
  lines.push(`[Peers] ${peers.length}`);
  for (const peer of peers) {
    lines.push(
      `  #${peer.joinOrder} ${peer.label} id:${short(peer.id)} type:${peer.connectionType} status:${peer.status} data:${dataConnLine(peer.conn)}`,
    );
  }

  if (isAudioReady()) {
    try {
      const ctx = getAudioContext();
      lines.push(
        `[AudioCtx] ready:yes state:${ctx.state} sr:${ctx.sampleRate} time:${ctx.currentTime.toFixed(2)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`[AudioCtx] ready:yes error:${message}`);
    }
  } else {
    lines.push('[AudioCtx] ready:no');
  }

  lines.push(
    `[Capture] active:${yn(capture.active)} capturedActive:${yn(capture.capturedStreamActive)} tracks:${list(capture.capturedTracks)}`,
  );
  lines.push(
    `  started:${age(capture.lastCaptureStartedAt as number | undefined)} streamsReady:${age(capture.lastStreamsReadyAt as number | undefined)} startBroadcast:${age(capture.lastStartBroadcastAt as number | undefined)} stopBroadcast:${age(capture.lastStopBroadcastAt as number | undefined)} stopped:${age(capture.lastCaptureStoppedAt as number | undefined)}`,
  );
  lines.push(
    `  graph source:${yn(capture.sourceNode)} splitter:${yn(capture.splitter)} upmix:${yn(capture.stereoUpmix)} destL:${yn(capture.destL)} destR:${yn(capture.destR)}`,
  );
  lines.push(
    `  L active:${yn(capture.streamLActive)} tracks:${list(capture.streamLTracks)} | R active:${yn(capture.streamRActive)} tracks:${list(capture.streamRTracks)}`,
  );

  lines.push(
    `[DirectHost] active:${yn(host.active)} fallback:${yn(host.remoteDirectFallbackEnabled)} conns:${host.mediaConnCount}`,
  );
  for (const conn of host.mediaConns) {
    lines.push(
      `  conn ${conn.peerShort} type:${conn.metadataType} pc:${conn.pcState ? `${conn.pcState.connectionState}/${conn.pcState.iceConnectionState}` : 'none'}`,
    );
  }
  lines.push('[DirectHostRecent]');
  if (host.recentCalls.length === 0) lines.push('  none');
  for (const call of host.recentCalls) {
    lines.push(
      `  ${age(call.at)} ${short(call.peerId)} ${call.peerLabel || '-'} ${call.connectionType || '-'} ${call.action}${call.reason ? `:${call.reason}` : ''}${call.metadataType ? ` type:${call.metadataType}` : ''}${call.error ? ` err:${call.error}` : ''}`,
    );
  }

  lines.push(
    `[DirectGuest] receiving:${yn(guest.systemReceiving)} placeholder:${yn(guest.placeholder)} got L/R/S/Synced:${yn(guest.gotL)}/${yn(guest.gotR)}/${yn(guest.gotStereo)}/${yn(guest.gotSynced)}`,
  );
  lines.push(
    `  start:${age(guest.lastStartAt)} ignored:${age(guest.lastStartIgnoredAt)}${guest.lastStartIgnoredReason ? `:${guest.lastStartIgnoredReason}` : ''} stop:${age(guest.lastStopAt)} cleanup:${age(guest.lastCleanupAt)}`,
  );
  lines.push(
    `  watchdog active:${yn(guest.watchdogActive)} armed:${age(guest.watchdogArmedAt)} timeout:${age(guest.watchdogTimedOutAt)}`,
  );
  lines.push(
    `  graph sourceL:${yn(guest.sourceL)} sourceR:${yn(guest.sourceR)} sourceStereo:${yn(guest.sourceStereo)} merger:${yn(guest.merger)} primer:${yn(guest.decoderPrimer)}`,
  );
  if (guest.channels.length === 0) lines.push('  channels:none');
  for (const channel of guest.channels) {
    const pc = channel.pcState
      ? `${channel.pcState.connectionState}/${channel.pcState.iceConnectionState}`
      : 'none';
    lines.push(
      `  ${channel.channel} peer:${short(channel.peerId)} type:${channel.metadataType || '-'} in:${age(channel.incomingAt)} ans:${age(channel.answerAt)} stream:${age(channel.streamAt)} graph:${age(channel.graphAt)} pc:${pc}`,
    );
    lines.push(
      `    tracks:${channel.streamTracks.length ? channel.streamTracks.join(',') : 'none'}${channel.answerError ? ` answerErr:${channel.answerError}` : ''}${channel.graphError ? ` graphErr:${channel.graphError}` : ''}${channel.error ? ` err:${channel.error}` : ''}${channel.closedAt ? ` closed:${age(channel.closedAt)}` : ''}`,
    );
  }

  lines.push(
    `[SFUHost] session:${short(sfu.host.sessionId)} tracks:${sfu.host.publishedTracks.length} publishing:${yn(sfu.host.publishInFlight)} unavailable:${yn(sfu.host.unavailable)} pc:${sfu.host.pcState ? `${sfu.host.pcState.connectionState}/${sfu.host.pcState.iceConnectionState}` : 'none'}`,
  );
  lines.push(
    `[SFUGuest] session:${short(sfu.guest.sessionId)} receiving:${yn(sfu.guest.receiving)} connecting:${yn(sfu.guest.connectInFlight)} sourceL:${yn(sfu.guest.sourceL)} sourceR:${yn(sfu.guest.sourceR)} pc:${sfu.guest.pcState ? `${sfu.guest.pcState.connectionState}/${sfu.guest.pcState.iceConnectionState}` : 'none'}`,
  );

  const pcRefs: PeerConnectionRef[] = [
    ...(hostConn?.peerConnection
      ? [{ label: `data:host:${short(hostConn.peer)}`, pc: hostConn.peerConnection }]
      : []),
    ...peers
      .filter((peer) => !!peer.conn?.peerConnection)
      .map((peer) => ({ label: `data:${short(peer.id)}`, pc: peer.conn?.peerConnection })),
    ...host.peerConnections,
    ...guest.peerConnections,
    ...sfu.peerConnections,
  ];
  lines.push('[RTCStats]');
  lines.push(...(await collectStats(pcRefs)));

  return lines.join('\n');
}
