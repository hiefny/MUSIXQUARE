import { log } from './log.js';
import { MSG } from './constants.js';

export const NetworkManager = {
    peer: null,
    myId: null,
    hostConn: null,
    connectedPeers: [],

    // App-level override for host incoming connection handling
    onIncomingConnection: null,

    // Relay state
    upstreamDataConn: null,
    downstreamDataPeers: [],
    relayChunkQueue: [],
    isRelaying: false,

    // Latency / Sync
    lastLatencyMs: 0,
    latencyHistory: [],
    usePingCompensation: true,

    // Roster / Labels
    peerLabels: {}, // Key: PeerID, Value: "DEVICE X"
    lastKnownDeviceList: null,

    // Handlers mapped by MSG type
    handlers: {},

    registerHandler(type, fn) {
        this.handlers[type] = fn;
    },

    async init(requestedId = null) {
        // PeerJS must already be loaded (via CDN script)
        if (!window.Peer) {
            throw new Error('PEERJS_NOT_LOADED');
        }

        // Clean up existing peer instance
        if (this.peer) {
            try { this.peer.destroy(); } catch (e) { /* noop */ }
            this.peer = null;
        }

        // Local-only ICE: no STUN/TURN (forces same LAN / same Wi‑Fi)
        const peerOpts = {
            debug: 1,
            config: {
                iceServers: [],
                sdpSemantics: 'unified-plan',
                bundlePolicy: 'max-bundle',
                iceCandidatePoolSize: 0,
            }
        };

        // Custom Signaling Server support
        const customPeerServer = window.__MUSIXQUARE_PEER_SERVER__;
        if (customPeerServer && typeof customPeerServer === 'object') {
            if (customPeerServer.host) peerOpts.host = customPeerServer.host;
            if (customPeerServer.port) peerOpts.port = customPeerServer.port;
            if (customPeerServer.path) peerOpts.path = customPeerServer.path;
            if (typeof customPeerServer.secure === 'boolean') peerOpts.secure = customPeerServer.secure;
            if (customPeerServer.key) peerOpts.key = customPeerServer.key;
        }

        this.peer = new Peer(requestedId || undefined, peerOpts);

        return new Promise((resolve, reject) => {
            this.peer.on('open', (id) => {
                this.myId = id;
                log.info(`[Network] Peer opened. ID: ${id}`);
                resolve(id);
            });

            this.peer.on('error', (err) => {
                log.error('[Network] Peer error:', err);
                reject(err);
            });

            this.peer.on('connection', (conn) => {
                if (this.onIncomingConnection) {
                    this.onIncomingConnection(conn);
                } else {
                    this._setupIncomingConnection(conn);
                }
            });

            this.peer.on('disconnected', () => {
                log.warn('[Network] Disconnected from signaling server');
            });
        });
    },

    _setupIncomingConnection(conn) {
        // Incoming connections are HOST-only (accepted by host)
        conn.on('open', () => {
            log.info(`[Network] Accepted connection from: ${conn.peer}`);
            if (!this.connectedPeers.find(p => p.peer === conn.peer)) {
                this.connectedPeers.push(conn);
            }
            conn.on('data', (data) => this._handleData(data, conn));

            conn.on('close', () => {
                log.warn(`[Network] Connection closed: ${conn.peer}`);
                this.connectedPeers = this.connectedPeers.filter(p => p.peer !== conn.peer);
                this.downstreamDataPeers = this.downstreamDataPeers.filter(p => p.peer !== conn.peer);
            });
        });
    },

    connectToHost(hostId) {
        if (!this.peer || !hostId) return;

        log.info(`[Network] Connecting to host: ${hostId}`);
        const conn = this.peer.connect(hostId, {
            metadata: { type: 'join' }
        });

        conn.on('open', () => {
            log.info(`[Network] Connection to host established: ${conn.peer}`);
            this.hostConn = conn;
            window.hostConn = conn; // Legacy compatibility

            conn.on('data', (data) => this._handleData(data, conn));

            conn.on('close', () => {
                log.error('[Network] Host disconnected');
                this.hostConn = null;
                window.hostConn = null;
                // Notify app.js via state or event
            });
        });

        return conn;
    },

    _handleData(data, conn) {
        if (!data || !data.type) return;

        // Automated Command Relay (Bi-directional)
        this._relayMessage(data, conn);

        const handler = this.handlers[data.type];
        if (handler) {
            try {
                handler(data, conn);
            } catch (e) {
                log.error(`[Network] Error in handler for ${data.type}:`, e);
            }
        }
    },

    _relayMessage(data, conn) {
        if (this.hostConn) {
            // RELAY DOWNSTREAM (Control commands from Upstream -> Downstream)
            if (this.downstreamDataPeers.length > 0) {
                const RELAYABLE_COMMANDS = [
                    MSG.PLAY, MSG.PAUSE, MSG.VOLUME, MSG.SEEK,
                    MSG.EQ_UPDATE, MSG.PREAMP, MSG.EQ_RESET,
                    MSG.REVERB, MSG.REVERB_TYPE, MSG.REVERB_DECAY,
                    MSG.REVERB_PREDELAY, MSG.REVERB_LOWCUT, MSG.REVERB_HIGHCUT,
                    MSG.STEREO_WIDTH, MSG.VBASS,
                    MSG.REPEAT_MODE, MSG.SHUFFLE_MODE,
                    MSG.YOUTUBE_PLAY, MSG.YOUTUBE_SYNC, MSG.YOUTUBE_STATE,
                    MSG.YOUTUBE_SUB_TITLE_UPDATE,
                    MSG.STATUS_SYNC, MSG.CHAT,
                    MSG.PLAYLIST_UPDATE, MSG.PLAYLIST
                ];

                if (RELAYABLE_COMMANDS.includes(data.type)) {
                    this.downstreamDataPeers.forEach(p => {
                        if (p.open) p.send(data);
                    });
                }
            }

            // RELAY UPSTREAM (Operator requests from Downstream -> Upstream)
            if (conn !== this.hostConn && this.hostConn.open) {
                if (data.type && data.type.startsWith('request-')) {
                    this.hostConn.send(data);
                }
            }
        }
    },

    sendToHost(data) {
        if (this.hostConn && this.hostConn.open) {
            this.hostConn.send(data);
        }
    },

    broadcast(data) {
        this.connectedPeers.forEach(conn => {
            if (conn.open) conn.send(data);
        });
    }
};
