import { log } from './log.js';

export const AudioEngine = {
    masterGain: null,
    preamp: null,
    widener: null,
    reverb: null,
    eqNodes: [],
    analyser: null,
    toneSplit: null,
    toneMerge: null,
    gainL: null,
    gainR: null,

    // Reverb damping/mixing
    rvbLowCut: null,
    rvbHighCut: null,
    rvbCrossFade: null,

    // Virtual Bass
    vbFilter: null,
    vbCheby: null,
    vbPostFilter: null,
    vbGain: null,

    globalLowPass: null,

    _initAudioPromise: null,

    async init() {
        if (this.masterGain) {
            if (typeof Tone !== 'undefined' && Tone?.context?.state !== 'running') {
                try { await Tone.start(); } catch (_) { /* best-effort */ }
            }
            return;
        }

        if (this._initAudioPromise) return this._initAudioPromise;

        this._initAudioPromise = (async () => {
            try {
            if (typeof Tone === 'undefined' || !Tone?.context) {
                throw new Error('Tone.js not loaded');
            }

            if (Tone.context.state !== 'running') {
                await Tone.start();
            }

            // 2. Channel & Stereo Processing
            this.toneSplit = new Tone.Split();
            this.toneMerge = new Tone.Merge();
            this.gainL = new Tone.Gain(1);
            this.gainR = new Tone.Gain(1);

            this.toneSplit.connect(this.gainL, 0);
            this.toneSplit.connect(this.gainR, 1);

            // Default Routing: Stereo (L->0, R->1 of merge)
            this.gainL.connect(this.toneMerge, 0, 0);
            this.gainR.connect(this.toneMerge, 0, 1);

            // 3. Effects Chain
            this.masterGain = new Tone.Gain(1);

            const freqs = [60, 230, 910, 3600, 14000];
            this.eqNodes = freqs.map(f => new Tone.Filter({
                type: "peaking",
                frequency: f,
                Q: 1.0,
                gain: 0
            }));

            this.preamp = new Tone.Gain(1);
            this.widener = new Tone.StereoWidener(1);

            this.reverb = new Tone.Reverb({
                decay: 5.0,
                preDelay: 0.1
            });
            this.reverb.wet.value = 1;
            await this.reverb.generate();

            this.rvbLowCut = new Tone.Filter(20, "highpass", -12);
            this.rvbHighCut = new Tone.Filter(20000, "lowpass", -12);
            this.rvbCrossFade = new Tone.CrossFade(0);

            // Virtual Bass
            const subFreq = 120; // default (matches app.js initial value)
            this.vbFilter = new Tone.Filter(subFreq, "lowpass", -12);
            this.vbCheby = new Tone.Chebyshev(50);
            this.vbPostFilter = new Tone.Filter(20000, "lowpass", -12);
            this.vbGain = new Tone.Gain(0);

            this.globalLowPass = new Tone.Filter(20000, "lowpass");

            // Analyser
            this.analyser = new Tone.Analyser("fft", 2048);
            this.analyser.smoothing = 0.3;

            // Routing
            this.widener.connect(this.preamp);
            this.preamp.connect(this.toneSplit);

            this.toneMerge.connect(this.globalLowPass);
            let eqIn = this.globalLowPass;
            this.eqNodes.forEach(fx => {
                eqIn.connect(fx);
                eqIn = fx;
            });

            // Reverb Path
            eqIn.connect(this.rvbCrossFade.a);
            eqIn.connect(this.reverb);
            this.reverb.connect(this.rvbLowCut);
            this.rvbLowCut.connect(this.rvbHighCut);
            this.rvbHighCut.connect(this.rvbCrossFade.b);

            // Output
            this.rvbCrossFade.connect(this.masterGain);

            // Virtual Bass Path (Parallel)
            eqIn.connect(this.vbFilter);
            this.vbFilter.connect(this.vbCheby);
            this.vbCheby.connect(this.vbPostFilter);
            this.vbPostFilter.connect(this.vbGain);
            this.vbGain.connect(this.masterGain);

            this.masterGain.connect(this.analyser);
            this.masterGain.toDestination();

            log.info('[AudioEngine] Initialized');
            } catch (e) {
                this._initAudioPromise = null; // Allow retry on failure
                throw e;
            }
        })();

        return this._initAudioPromise;
    }
};
