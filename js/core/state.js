import { APP_STATE } from './constants.js';
import { log } from './log.js';

export const state = {
    currentState: APP_STATE.IDLE,
    isOperator: false,
    isConnecting: false,
    isIntentionalDisconnect: false,
    isStateTransitioning: false,
    pausedAt: 0,
    startedAt: 0,
    activeLoadSessionId: 0,
    localOffset: 0,
    autoSyncOffset: 0,
    masterVolume: 1.0,
    currentTrackIndex: -1,
    playlist: [],
};

const cleanupHooks = new Map();
const updateHooks = new Set();

export function registerCleanupHook(stateName, fn) {
    if (!cleanupHooks.has(stateName)) cleanupHooks.set(stateName, []);
    cleanupHooks.get(stateName).push(fn);
}

export function registerUpdateHook(fn) {
    updateHooks.add(fn);
}

export function setState(newState, options = {}) {
    const oldState = state.currentState;
    if (oldState === newState) return;

    if (state.isStateTransitioning) {
        log.warn(`[State] Transition Blocked: Currently moving to another state. Rejecting ${newState}.`);
        return;
    }

    try {
        state.isStateTransitioning = true;
        log.debug(`[State] Transition: ${oldState} -> ${newState}`, options);

        if (!options.skipCleanup) {
            const hooks = cleanupHooks.get(oldState) || [];
            hooks.forEach(fn => {
                try { fn(state); } catch (e) { log.error(`[State] Cleanup hook error for ${oldState}:`, e); }
            });
        }

        state.currentState = newState;

        updateHooks.forEach(fn => {
            try { fn(newState, state); } catch (e) { log.error(`[State] Update hook error:`, e); }
        });

    } finally {
        state.isStateTransitioning = false;
    }

    if (options.onComplete) {
        try { options.onComplete(); } catch (e) { log.error('[State] onComplete error:', e); }
    }
}

window.getState = () => state.currentState;
Object.defineProperty(window, 'isOperator', {
    get: () => state.isOperator,
    set: (v) => { state.isOperator = !!v; },
    configurable: true
});
