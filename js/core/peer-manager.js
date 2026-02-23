import { log } from './log.js';

export const PeerManager = {
    connectedPeers: [],
    activeHostConnByPeerId: new Map(),
    peerSlotByPeerId: new Map(),
    maxGuestSlots: 3,

    init() {
        this.connectedPeers.length = 0;   // Clear in-place (preserve array reference)
        this.activeHostConnByPeerId.clear();
        this.peerSlotByPeerId.clear();
    },

    addPeer(peerObj) {
        this.connectedPeers.push(peerObj);
    },

    removePeer(peerId) {
        const idx = this.connectedPeers.findIndex(p => p.id === peerId);
        if (idx >= 0) this.connectedPeers.splice(idx, 1);  // In-place (preserve array reference)
        this.activeHostConnByPeerId.delete(peerId);
        this.peerSlotByPeerId.delete(peerId);
    },

    getPeer(peerId) {
        return this.connectedPeers.find(p => p.id === peerId);
    },

    getAvailableSlot(preferredSlot, peerId) {
        const usedSlots = new Set();
        this.connectedPeers.forEach(p => {
            if (p.id !== peerId && p.slot) usedSlots.add(p.slot);
        });

        if (preferredSlot && !usedSlots.has(preferredSlot)) return preferredSlot;

        for (let i = 1; i <= this.maxGuestSlots; i++) {
            if (!usedSlots.has(i)) return i;
        }
        return null;
    },

    getPeerLabel(slot) {
        const labels = ['HOST', 'DEVICE 1', 'DEVICE 2', 'DEVICE 3'];
        return labels[slot] || `DEVICE ${slot}`;
    },

    assignSlot(peerId, slot) {
        this.peerSlotByPeerId.set(peerId, slot);
    },

    releaseSlot(peerId) {
        this.peerSlotByPeerId.delete(peerId);
    }
};
