/* j0ey-code
   YIN Algorithm Based 440 Hz Chromatic Tuner - JavaScript IIFE Code
   December 2025 - May 2026
   =========================================================
   Musical Instrument and Vocal Pitch Tuning Web Application
   JavaScript Implementation of the YIN Monophonic Pitch 
   Estimation Algorithm w/ Spectral Pre-Filtering */

// http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf
// original 2002 paper on the YIN algorithm, by Cheveigne and Kawahara

/* NOTE(S): This was designed while going through my Data Structures and
Algorithms class as a pet project to help learn JavaScript and build
a cool, somewhat unique project that would actually be of use to me personally.
The algorithm I chose to write my paper about for the semester ended up being the
one I used for the core implementation of this application: the YIN algorithm.
That being said, there are a few things I'd like to mention about this program...
  + This is the version 2 / v2, as the first one implemented auto-correlation ~
  + Claude Opus 4.6 (an AI agent) was involved in helping mostly with the front-end design,
    as well as working through some of the computational logic of the YIN algorithm with me ~
  + There are still a few noticeable semantic bugs when using the application, namely...
      - Extremely higher or lower frequency instruments may find difficulty in accurate estimation;
        outside the range of an 88-key piano (where the analysis frame frequency sample is set), it's hard to tell
      - Last second or initial false positive catches on the analysis frame of incorrect sub-harmonics (e.g. the fifth, the third, etc.)
      - Requires more extensive testing to be sure of other possible errors
  + The YIN algorithm is not designed for polyphonic (chordal) pitch estimation, HOWEVER,
    a naive attempt has been made to intuit this using a low-pass spectral pre-filter; this presents
    a couple additional semantic errors: please see lines 337 - 365 for further breakdown on this ~ */

(() => {
  // navigational UI logic for built-in HTML / CSS return button
  // not relevant to chromatic tuning app's functionality
  document.getElementById('returnBtn').addEventListener('click', (e) => {
    if (window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
    // else, allow the href value to take over as fallback
  });

  // 12-tone chromatic note information constants
  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const DISPLAY_NAMES = [
    { letter: 'C', accidental: '' },
    { letter: 'C', accidental: '♯' },
    { letter: 'D', accidental: '' },
    { letter: 'D', accidental: '♯' },
    { letter: 'E', accidental: '' },
    { letter: 'F', accidental: '' },
    { letter: 'F', accidental: '♯' },
    { letter: 'G', accidental: '' },
    { letter: 'G', accidental: '♯' },
    { letter: 'A', accidental: '' },
    { letter: 'A', accidental: '♯' },
    { letter: 'B', accidental: '' },
  ];
 
  // constant which sets the tuning frequency to standard 440 Hz concert pitch
  const A4_FREQ = 440;  // an A4 note defined as falling at a 440 Hz frequency - 440 Hz standard concert tuning pitch definition
  // UI threshold constant to define how close (how many "cents") within the center is "in-tune" 
  const IN_TUNE_THRESHOLD = 5; // cents
 
  /* vvv Key Parameters, Set-up, and Initialization Directly Below vvv */

  const YIN_THRESHOLD = 0.20;         // Absolute threshold for CMNDF trough; 0.1 in Cheveigne and Kawahara's paper / implementation
  const CLARITY_FLOOR = 0.625;        // Minimum clarity to display a note
  const LOW_PASS_CUTOFF = 5000;       // spectral pre-filter: attenuate above this (Hz)
                                      // 5000 Hz covers the lowest-end bass frequencies on an 88-key concert piano
 
  // DOM interface references ~ wiring to the front-end HTML elements by IDs
  const noteLetter   = document.getElementById('noteLetter');
  const noteAccident = document.getElementById('noteAccidental');
  const noteOctave   = document.getElementById('noteOctave');
  const noteDisplay  = document.getElementById('noteDisplay');
  const freqReadout  = document.getElementById('freqReadout');
  const centsNeedle  = document.getElementById('centsNeedle');
  const centsValue   = document.getElementById('centsValue');
  const volumeFill   = document.getElementById('volumeFill');
  const chromaticEl  = document.getElementById('chromaticStrip');
  const startBtn     = document.getElementById('startBtn');
  const btnLabel     = document.getElementById('btnLabel');
  const overlay      = document.getElementById('overlay');
  const overlayIcon  = document.getElementById('overlayIcon');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayText  = document.getElementById('overlayText');
 
  // chromatic note elements arranged into chromatic note display strip
  NOTE_NAMES.forEach((name, i) => {
    const el = document.createElement('div');
    el.className = 'chromatic-note';
    el.textContent = name;
    el.dataset.index = i;
    chromaticEl.appendChild(el);
  });
 
  /* tick marks / cents ticks on tuning gauge for visual clarity of tuner's functionality
     nothing but additional UI flair to give application authentic, genuine digital tuner feel */
  const centsTicks = document.getElementById('centsTicks');
  for (let c = -50; c <= 50; c += 5) {
    const tick = document.createElement('div');
    const pct = ((c + 50) / 100) * 100;
    tick.className = 'cents-tick' + (c % 10 === 0 ? ' major' : '');
    tick.style.left = pct + '%';
    centsTicks.appendChild(tick);
  }
 
  // initializing audio state variables for crucial Web Audio API objects
  let audioCtx = null;  // Web Audio API context; superobject owning the entire audio graph
  let analyzer = null;  // Web Audio API AnalyzerNode; gives a snapshot of current waveform / period samples
  let stream = null;    // holds MediaStream object returned on line 325; browser's interface to actual mic. / audio input
  let running = false;  // boolean flag to tell whether the tuner is currently active and listening or not (lines 349, 375, & 397)
  let rafId = null;     // requestAnimationFrame (raf) ID so that the analysis loop can be terminated
  let buffer = null;    // a Float32Array which will hold the raw, time-domain samples pulled using analyzer / AnalyzerNode
 
  /* vital function to perform conversion of frequencies detected into the
     respective note on the 12-tone chromatic scale */
  function freqToNote(freq) {
    const semitones = 12 * Math.log2(freq / A4_FREQ);
    const rounded = Math.round(semitones);
    const cents = (semitones - rounded) * 100;
    const midi = 69 + rounded;
    const noteIndex = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    return { noteIndex, octave, cents, midi };
  }
 
  /* vvv Core YIN Implementation Found Below!! vvv
  
    Additionally: spectral pre-filtering has been added. 
    The spectral pre-filtering happens upstream in the Web Audio
    graph (a BiquadFilterNode low-pass at 5000 Hz), so by the
    time samples reach this function, high-frequency harmonic
    content and noise have already been rolled off.
  
    YIN itself has 6 steps, all implemented below:
      Step 1 — Difference function
      Step 2 — Cumulative mean normalized difference (CMNDF)
      Step 3 — Absolute thresholding
      Step 4 — Parabolic interpolation
      Step 5 — Best local estimate (handled by step 3 logic)
      Step 6 — (Best global, skipped — single-frame detector) */

/* 26 June 2026 || 2 Part Solution for Transient Signal Conditions
=====================================================================
Layer A / Part 1 Now a Part of the Core detectPitch() Freq. Detection 
Function and Audio Pipeline Just a Bit Further Below (lines 181-344); 
Description of Solution Layer A / Part 1 Found *Directly* Below
=====================================================================
LAYER A / PART (1/2) — ADAPTIVE BUFFER OFFSET
=====================================================================
This replaces the existing detectPitch function.
Changes are at the TOP of the function, before the difference
function loop. Everything from the difference function onward
is identical to the current implementation — the only change
is which slice of the buffer gets analyzed.

The onset detection works by splitting the 8192-sample buffer
into four 2048-sample quarters and comparing their energy:
  
Quarter layout (8192 samples total):
 ┌──────────┬──────────┬──────────┬──────────┐
 │  Q1      │  Q2      │  Q3      │  Q4      │
 │  0-2047  │ 2048-4095│ 4096-6143│ 6144-8191│
 └──────────┴──────────┴──────────┴──────────┘
|==|==|==|==| 

Steady-state signal:
Q1 ≈ Q2 ≈ Q3 ≈ Q4  →  no onset  →  analyze full buffer
  
Onset/attack transient:
Q1 >> Q2 ≈ Q3 ≈ Q4  →  onset!   →  skip Q1, analyze Q2-Q4
  
After skipping, we still have 6144 samples — well above the
4096 that was already sufficient for steady-state detection.
YIN's difference function only uses half the buffer anyway
halfSize), so effective analysis length goes from 4096 to 3072.
That's still 50% more than the original 2048 halfSize. */


// driver function below!! runs the full YIN pipeline on a single buffer frame
// lines 144 - 265 encompass the detectPitch(buf, sampleRate) "YIN pipeline" function
  function detectPitch(buf, sampleRate) {
    const SIZE = buf.length;  // buffer length, 4096 samples, set on line 342
    
    // full buffer RMS noise gate - check for signal, ignore silence if no signal found
    let rms = 0;  // root mean squared - a standard measure for signal energy
    for (let i = 0; i < SIZE; i++) {
      rms += buf[i] * buf[i];
    }  
    rms = Math.sqrt(rms / SIZE); 
    if (rms < 0.003) { // if rms is negligible, return freq as -1 (i.e. no signal / pitch detected)
      return { freq: -1, clarity: 0, rms };
    }

    // LAYER A / PART 1 HERE: "Late-start" onset detection and adaptive buffer via per-quarter RMS
    // Q1 is split into smaller sub-segments to detect brief transient spikes that get
    // diluted when averaged across the full 2048-sample quarter.
    // Q2-Q4 remain full quarters — they represent steady-state signal and don't need finer resolution.
    const QUARTER = SIZE / 4;
    const SUB_SEG_SIZE = 512;                             // scan Q1 in 512-sample slices
    const NUM_SUBS = Math.floor(QUARTER / SUB_SEG_SIZE);  // 4 sub-segments
    const ONSET_RATIO = 2.0;  // lowered from 2.5 — sub-segments
                              // concentrate the spike energy instead
                              // of diluting it across the full quarter

    // Compute Q2, Q3, Q4 RMS as the steady-state baseline
    let baselineSum = 0;
    for (let i = QUARTER; i < SIZE; i++) {
      baselineSum += buf[i] * buf[i];
    }
    const baselineRms = Math.sqrt(baselineSum / (SIZE - QUARTER));

    // Scan Q1 in sub-segments — flag onset if ANY slice spikes
    let onsetDetected = false;
    if (baselineRms > 0.003) {
      for (let s = 0; s < NUM_SUBS; s++) {
        let segSum = 0;
        const segStart = s * SUB_SEG_SIZE;
        const segEnd = segStart + SUB_SEG_SIZE;
        for (let i = segStart; i < segEnd; i++) {
          segSum += buf[i] * buf[i];
        }
        const segRms = Math.sqrt(segSum / SUB_SEG_SIZE);
        if (segRms > ONSET_RATIO * baselineRms) {
          onsetDetected = true;
          break;
        }
      }
    }

    let offset = 0;
    let effectiveSize = SIZE;
    if (onsetDetected) {
      offset = QUARTER;
      effectiveSize = SIZE - QUARTER;
    }

    // halve the buffer, now 2048, to account for tau lag run ahead
    // YIN only computes lags up to half the buffer; consider, buf[i] >= buf[i + tau]
    const halfSize = Math.floor(effectiveSize / 2);

// ================================================================
// TRUE / PURELY YIN ALGORITHMIC PIPELINE BEGINS HERE~!!
// ================================================================

/*  Step 1: Core Difference Function d(τ)
    (see Cheveigne & Kawahara 2002, equation / formula 6)
    For each lag tau τ, sum the squared differences between
    each sample and the sample τ positions ahead;
    a perfect period will produce d(τ) == 0 */
    const diff = new Float32Array(halfSize);    // initialize array of 32-bit floats for difference value accumulation
    for (let tau = 0; tau < halfSize; tau++) {  // O(n^2) complexity time of d(τ); 2048 x 2048 = 4 million operations per frame
      let sum = 0;                              // faster implementations of this do exist, using FFT-computations in O(nlogn) time
      for (let i = 0; i < halfSize; i++) {
        const delta = buf[offset + i] - buf[offset + i + tau];  // subtract the values
        sum += delta * delta;                   // square the difference, increment to sum
      }
      diff[tau] = sum;  // store the sum accumulated so far to the array, at the respective tau / lag value
    }
 
/*  Step 2: Cumulative Mean Normalized Difference (CMNDF) d'(τ)
    (see Cheveigne & Kawahara 2002, equation / formula 8)
    CMNDF(0) is defined as 1. For τ > 0, it equals
    d(τ) divided by the running average of all d values
    from 1 to τ, thereby normalizing d(τ) by making "dips" in 
    the function comparable across different lag ranges. */
    const cmndf = new Float32Array(halfSize); // create array of 32-bit floats for cumulative mean normalized difference value accumulation
    cmndf[0] = 1;                             // defined by convention of the CMNDF to avoid a division by zero error
    let runningSum = 0;
    for (let tau = 1; tau < halfSize; tau++) {  // begin at tau = 1; run the lag across half the buffer
      runningSum += diff[tau];                  // collect running sum for CMNDF computation
      cmndf[tau] = diff[tau] / (runningSum / tau);  // perform computation and store value in cmndf[] array at respective tau / lag value
    }

//  NOTE: On interpreting the output of the CMNDF...
/*  The dissimilarity metric values being gathered above: "Is d(t) small relative to what d has been up until this point?" 
    a CMNDF value == 1 means the lag is exactly average, relatively; a CMNDF value < 1 means the lagged period is better than average;
    a CMNDF value approaching 0 (e.g. 0.025, 0.00625, 0.00075, etc.) indicates near-perfect periodicity between the two signals */
 
/*  Step 3: Absolute Threshold Search
    (see Cheveigne & Kawahara 2002, equations 9 & 10)
    Walk the CMNDF from the minimum plausible lag (highest
    pitch we'd detect, ~5000 Hz) upward. The first time a valley dips below 
    YIN_THRESHOLD and then starts rising, that's our candidate period. */
    const minLag = Math.floor(sampleRate / 5000);
    const maxLag = Math.min(halfSize, Math.floor(sampleRate / 27));
 
    let bestTau = -1;
    for (let tau = minLag; tau < maxLag; tau++) {
      // look for a value below threshold where the function was decreasing into it (local minimum region)
      if (cmndf[tau] < YIN_THRESHOLD) {
        // walk forward to find the exact local minimum within this valley
        while (tau + 1 < maxLag && cmndf[tau + 1] < cmndf[tau]) {
          tau++;
        }
        bestTau = tau;
        break;
      }
    }
 
/*  Fallback: if nothing crossed the threshold, take
    the global minimum of CMNDF as a last resort, but
    only if its reasonably low enough to consider */
    if (bestTau < 0) {
      let globalMin = Infinity;
      let globalMinTau = -1;
      for (let tau = minLag; tau < maxLag; tau++) {
        if (cmndf[tau] < globalMin) {
          globalMin = cmndf[tau];
          globalMinTau = tau;
        }
      }
      // only accept the global minimum if it's a convincing estimation
      // anything above a 0.5 cutoff is too iffy to trust as a confident detection 
      if (globalMin < 0.5) {
        bestTau = globalMinTau;
      } else {
        return { freq: -1, clarity: 1 - globalMin, rms };
      }
    }
 
/*  Step 4: Parabolic Interpolation
    (see Cheveigne & Kawahara 2002, pg. 4 section II.E.)
    The true minimum falls *between* two integer lag samples. 
    Fit a parabola through the 3 points centered on bestTau to find
    the refined, fractional offset vertex for the tau / lag value. */
    let refinedTau = bestTau;   // finding the refinedTau periodicity estimate by parabolic interpolation
    if (bestTau > 0 && bestTau < halfSize - 1) {
      const y0 = cmndf[bestTau - 1];  // fit parabola through three points adjacent to bestTau
      const y1 = cmndf[bestTau];
      const y2 = cmndf[bestTau + 1];
      const denom = 2 * (y0 - 2 * y1 + y2); // compute denominator for vertex formula
      if (denom !== 0) {
        refinedTau = bestTau + (y0 - y2) / denom; // apply parabolic vertex offset for frequency estimate refinement
      }
    }

// ================================================================
// TRUE / PURELY YIN ALGORITHMIC PIPELINE ENDS HERE~!!
// ================================================================
 
/*  Conversion of CMNDF Metrics for Clarity
    Convert CMNDF value to a 0–1 "clarity" score where
    1 now equals perfect periodicity instead. CMNDF of 0 typically 
    means a perfect match; a value of 1 means no correlation at all. 
    Essentially, inverting the meaning of the raw CMNDF values for readability.
    CMNDF[bestTau] = 0.001 -> clarity -> 0.999, perfect periodicity
    CMNDF[bestTau] = 0.999 -> clarity -> 0.001, poor / average periodcity*/
    const clarity = 1 - cmndf[bestTau];
 
    return {
      freq: sampleRate / refinedTau,  // detected frequency is the sample rate divided by the period in samples
      clarity: clarity,
      rms: rms
    };
  }
 
  // UI updating for real-time responsiveness of application
  let smoothCents = 0;
  let lastNoteIdx = -1;
  let silenceFrames = 0;

/*  26 June 2026:: began architecting and implementing two pronged "pincer" solution for transient signal issues
    PART (2/2) FOR TRANSIENT SIGNAL DETECTION SOLUTION: Note Consensus Gate Post-Audio Pipeline, Pre-UI Layer 
    ============================================================================================================
    new variables below as part of "pre-display layer" consensus gate part of solution to help
    handle attack, decay, burst, onset, and other transient signal condition detection problems */ 
  
  const CONSENSUS_FRAMES = 2;        // require this many frames to agree
  let pitchHistory = [];             // ring buffer of recent note values
  let lastConfirmedNote = -1;        // last note which passed consensus
 
  function updateUI(freq, clarity, rms) {
    // Volume bar
    const vol = Math.min(rms * 6, 1);
    volumeFill.style.width = (vol * 100) + '%';
 
  /*  a condition to check for a significant amount of "silence frames",
      where signal level caught falls below RMS gate threshold, using a "silence counter" - 
      this helps keep the display from blanking, during pauses after or between note(s) */

    if (freq < 0 || clarity < CLARITY_FLOOR) {
      silenceFrames++;
      if (silenceFrames > 15) {             // if 15+ consecutive frames of silence (rms < 0.03)
        noteDisplay.classList.add('idle');  // wipe current UI display
        noteLetter.textContent = '—';
        noteAccident.textContent = '';
        noteOctave.textContent = '';
        freqReadout.innerHTML = '— Hz';
        centsNeedle.style.left = '50%';
        centsNeedle.classList.remove('in-tune');  // CSS class toggling to update UI
        noteLetter.classList.remove('in-tune');   // CSS class toggling to update UI
        centsValue.textContent = '0 ¢';
        lastNoteIdx = -1;
        // resetting pitchHistory and lastConfirmedNote for clean state management
        pitchHistory = [];
        lastConfirmedNote = -1;
        highlightChromatic(-1, false);
      }
      return;
    }
 
    silenceFrames = 0;                      // else, there is no silence, sound signal detected
    noteDisplay.classList.remove('idle');   // remove idle status class listing from noteDisplay element
 
    const info = freqToNote(freq);              // extrapolate note information from detected frequency


// PART (2/2) SOLUTION FOR TRANSIENT SIGNAL CONDITIONS
// THE FRAME && NOTE / PITCH CONSENSUS GATE, OPERATING AT THE PRE-DISPLAY LAYER

/* 26 June 2026 || 2 Part Solution for Transient Signal Conditions
==================================================================
LAYER B / PART (2/2) — FRAME CONSENSUS GATE
==================================================================
This modifies the existing updateUI function and the state
variables just above it. The consensus gate maintains a small
ring buffer of recent pitch detections (MIDI note numbers).
The display only updates when the last N frames agree on the
same note within a tolerance of ±1 semitone.
  
Why ±1 semitone tolerance instead of exact match?
Because a note right on the boundary between two semitones 
(e.g. 49.8 cents sharp of A, which is essentially Bb) can
legitimately oscillate between adjacent notes frame-to-frame.
Requiring exact match would cause display stutter on those
boundary notes. ±1 semitone catches the ÷3 lock (which jumps
~19 semitones) while allowing natural boundary oscillation.

Why 2 frames and not 3?
At 60fps with an 8192-sample buffer at 44100 Hz sample rate,
each buffer frame spans ~186ms. Two frames = ~372ms of agreement.
The ÷3 lock only ever corrupts the first frame after onset —
by frame 2, the transient has passed. Requiring 3 frames would
add perceptible latency (~558ms) for no additional benefit.

Timing math:
  - Buffer duration: 8192 / 44100 ≈ 186ms per frame
  - 2-frame gate:    ~372ms worst-case latency
  - Human perception threshold for tuner response: ~400-500ms
  - So, 2 frames sits right at the edge of imperceptible! */


// push current detected note / MIDI frequency into the pitchHistory ring buffer for caching
    pitchHistory.push(info.midi);
    if (pitchHistory.length > CONSENSUS_FRAMES) {
      pitchHistory.shift();
    }

    // check if we currently have enough frames to analyze, and if they all agree
    let consensus = false;
    if (pitchHistory.length >= CONSENSUS_FRAMES) {
      consensus = true;
      const reference = pitchHistory[0];
      for (let i = 1; i < pitchHistory.length; i++) {
        if (Math.abs(pitchHistory[i] - reference) > 1) {
          // more than 1 semitone difference, then no consensus
          consensus = false;
          break;
        }
      }
    }

    // always update the frequency readout and cents needle
    // (these provide real-time responsiveness even w/o consensus)
    freqReadout.innerHTML = freq.toFixed(1) + ' <span>Hz</span>';
    smoothCents += (info.cents - smoothCents) * 0.425;
    const pct = 50 + (smoothCents / 50) * 50;
    centsNeedle.style.left = Math.max(0, Math.min(100, pct)) + '%';
 
    if (!consensus) {
      // no consensus yet so hold the current display, don't update note
      // but DO update the cents needle and frequency readout above
      // so the UI still feels responsive and "alive", even w/o consensus
      return;
    }

    lastConfirmedNote = info.midi;
    const dn = DISPLAY_NAMES[info.noteIndex];   // save note as display name 
    const inTune = Math.abs(info.cents) < IN_TUNE_THRESHOLD;  // check deviation from center "in-tune" marker / threshold
 
    noteLetter.textContent = dn.letter;               // fetch note letter
    noteLetter.classList.toggle('in-tune', inTune);   // toggle whether frequency is within threshold of "in-tune" for given note
    noteAccident.textContent = dn.accidental;         // if the note features an accidental (sharp or flat), fetch that too
    noteOctave.textContent = info.octave;             // fetch the note's specific octave given the frequency as well (C4, E2, D5, etc.)

    centsNeedle.classList.toggle('in-tune', inTune);
 
    const sign = info.cents >= 0 ? '+' : '';
    centsValue.textContent = sign + info.cents.toFixed(1) + ' ¢';
 
    highlightChromatic(info.noteIndex, inTune);
    lastNoteIdx = info.noteIndex;
  }
 
  // lights up the detected note on the chromatic element strip bar
  function highlightChromatic(idx, inTune) {
    const notes = chromaticEl.children;
    for (let i = 0; i < notes.length; i++) {
      notes[i].classList.remove('active', 'in-tune');
      if (i === idx) {
        notes[i].classList.add(inTune ? 'in-tune' : 'active');
      }
    }
  }
 
/*  Analysis Loop - the glue holding our program components together
    each call of the analysis loop / analyze grabs a fresh buffer of samples from 
    the running analyzer node, runs YIN on it, and updates the display accordingly */
  function analyze() {
    analyzer.getFloatTimeDomainData(buffer);  // fetch fresh buffer of samples
    const result = detectPitch(buffer, audioCtx.sampleRate);  // execute YIN on the caught buffer
    updateUI(result.freq, result.clarity, result.rms);  // update the UI based on retrieved signal data
    rafId = requestAnimationFrame(analyze); // tells browser to call analyze on next screen refresh (60 - 200 FPS)
  }
 
/*  Complete Audio Signal Chain w/ Spectral Pre-Filter
    
    Signal chain: mic input -> low-pass biquad spectral pre-filter -> analyzer / YIN
  
    The BiquadFilterNode acts as a second order Butterworth low-pass
    spectral pre-filter implementation at 5000 Hz. This rolls off upper harmonics and 
    high frequency noise(s) before YIN ever sees the waveform, which:
      + Reduces harmonic interference *in chord / polyphonic situations*
      + Suppresses mic hiss and room noise
      + Helps YIN lock onto the fundamental more reliably 
    
    NOTE: For this implementation, we have biased the low-pass pre-filter at the 5000 Hz range,
          which encompasses the entire frequency span of a guitar, and the lowest bass frequencies
          of an 88-key piano / keyboard. This pre-filter has been added in a naive attempt to bias
          YIN towards only detecting the bass / root note of a standard 1-3-5 chord triad; 
          for the developer's personal purposes and use case, this is insignificant and an acceptable trade off. 
          This does NOT mean that the application is incapable of detecting outside the 5000 Hz frequency range, rather,
          that a note played within the 5000 Hz frequency range (either alone or in sequence with other notes, polyphonically)
          will be favored as the candidate frequency to estimate the fundamental frequency for - a bias towards lower frequencies.
    
    BUG:  This introduces an unfortunate semantic error - also an acceptable trade off (for now). Because music theory is naturally
          complex, so is polyphonic pitch detection. Though a chord may be an A minor (A-C-E) for instance, there are various extensions
          and inversions that can be played to manipulate the chord. For example, we may introduce a 7th and 9th to the triad (A-C-E-G-B) 
          to form an A minor 9th [Am9th] chord - at which point the YIN algorithm will almost surely be muddied by the amount of overtones
          and sub-harmonics within such a complex chord, low-pass filter or not. The true error will show however if an inversion chord is played.
          Consider now an A minor 7th [Am7th] (A-C-E-G) BUT with the 7th note stacked as the chord's bass root (G-A-C-E). 
          This is, fundamentally, still an Am7th chord - the triad is still present, but the key / scale's 7th now roots the chord.
          Neither our low-pass spectral pre-filter, nor the YIN algorithm, have any way of knowing this. Therefore, though such a chord
          *should* display as an "A", it will most likely show as a "G" due to the low-pass filter biasing towards the lower frequencies. */
  
  async function start() {
    // a boolean flag to detect mobile devices, such as smartphones and tablets
    const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();  // Web Audio API master context brought in
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: isMobile,  // autoGainControl is determined by the device itself; on for mobile devices, off for desktops / laptops
        }
      });
 
      const source = audioCtx.createMediaStreamSource(stream);
 
      // Spectral pre-filter: second order low-pass
      const lpFilter = audioCtx.createBiquadFilter();
      lpFilter.type = 'lowpass';
      lpFilter.frequency.value = LOW_PASS_CUTOFF;   // 5000 Hz
      lpFilter.Q.value = Math.SQRT1_2;  // Butterworth
 
      analyzer = audioCtx.createAnalyser();  // instantiating AnalyserNode
      analyzer.fftSize = 8192;    // assigning analysis frame size
      buffer = new Float32Array(analyzer.fftSize);  // assigning analysis frame size to buffer capacity
 
      // connect the audio signal chain: source -> filter -> analyzer
      source.connect(lpFilter);     // run source input signal through low-pass filter to 
      lpFilter.connect(analyzer);   // run output of low-pass filter as final input to analyzer / YIN algorithm
 
      running = true;
      startBtn.classList.add('active');       // CSS class toggling to update UI (start button into red "Listening / Recording" bar)
      btnLabel.textContent = 'Listening…';
      overlay.classList.remove('visible');
 
      analyze();      // run the core analysis loop
    } catch (err) {         // error handling for various failure conditions
      console.error(err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        overlayIcon.textContent = '🔇';
        overlayTitle.textContent = 'Permission Denied';
        overlayText.textContent = 'Microphone access was denied. Please allow microphone access in your browser settings and reload the page.';
      } else if (err.name === 'NotFoundError') {
        overlayIcon.textContent = '⚠️';
        overlayTitle.textContent = 'No Microphone Found';
        overlayText.textContent = 'No audio input device was detected. Please connect a microphone and try again.';
      } else {
        overlayIcon.textContent = '⚠️';
        overlayTitle.textContent = 'Audio Error';
        overlayText.textContent = err.message || 'An unknown error occurred while accessing audio.';
      }
      overlay.classList.add('visible');
    }
  }
 
  // function to terminate application functionality / analysis loop
  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
    }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }
    if (audioCtx) {
      audioCtx.close();
    }
    audioCtx = null;
    stream = null;
    startBtn.classList.remove('active');
    btnLabel.textContent = 'Start Tuner';
    noteDisplay.classList.add('idle');
    noteLetter.textContent = '—';
    noteAccident.textContent = '';
    noteOctave.textContent = '';
    freqReadout.innerHTML = '— Hz';
    centsNeedle.style.left = '50%';
    centsNeedle.classList.remove('in-tune');
    noteLetter.classList.remove('in-tune');
    centsValue.textContent = '0 ¢';
    volumeFill.style.width = '0%';
    highlightChromatic(-1, false);
  }
 
  startBtn.addEventListener('click', () => {
    if (running) {
      stop();
    } else { 
      start();
    }
  });
})();
