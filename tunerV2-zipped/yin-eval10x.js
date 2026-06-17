/*  YIN Algorithm Evaluation Harness v2
    =====================================
    Now implements the full signal chain matching the live app:
      mic -> 2nd-order Butterworth low-pass @ 5000 Hz -> YIN
    
    The BiquadFilterNode from Web Audio API is replicated here
    using the standard Audio EQ Cookbook (Robert Bristow-Johnson)
    biquad coefficient formulas, applied as a direct-form II
    transposed IIR filter — identical math to what the browser runs.
    
    Runs every test TWICE: once raw (YIN only) and once through
    the pre-filter (matching the live app's pipeline), so you get
    a direct, one-to-one comparison.
    
    Usage: node yin-eval10x.js
    Output: results-10x.json  */

const fs = require('fs');

// Constants (matching tunerV2.js exactly) 

const A4_FREQ        = 440;
const YIN_THRESHOLD  = 0.20;    // line 65 of tunerV2.js
const CLARITY_FLOOR  = 0.625;    // line 66
const LOW_PASS_CUTOFF = 5000;   // line 67 — spectral pre-filter cutoff
const SAMPLE_RATE    = 44100;
const BUFFER_SIZE    = 8192;    // line 398 — analyzer.fftSize

const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

// ───────────────────────────────────────────────────────────────────────
/*  Biquad Low-Pass Filter (replicating Web Audio BiquadFilterNode) 

    The Web Audio API BiquadFilterNode with type 'lowpass' uses the
    Audio EQ Cookbook formulas by Robert Bristow-Johnson 
    (https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html). 
  
    With Q set to Math.SQRT1_2 (≈0.7071), this produces a second-order
    Butterworth response: maximally flat passband, -12 dB/octave
    rolloff above the cutoff frequency.

    Coefficient derivation (Audio EQ Cookbook, low-pass case):
    w0    = 2π × f0 / Fs
    alpha = sin(w0) / (2 × Q)
    b0    = (1 - cos(w0)) / 2
    b1    =  1 - cos(w0)
    b2    = (1 - cos(w0)) / 2
    a0    =  1 + alpha
    a1    = -2 × cos(w0)
    a2    =  1 - alpha
    
    All coefficients are then normalized by dividing through by a0.     */
// ────────────────────────────────────────────────────────────────────────

/*  mathematically the same function as the Web Audio API BiquadFilter Node logic
    computes the same coefficients normally found and tracked by the Biquad Filter Node*/
function computeBiquadCoeffs(cutoffHz, Q, sampleRate) {
  const w0 = 2 * Math.PI * cutoffHz / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);

  const b0 = (1 - cosw0) / 2;
  const b1 =  1 - cosw0;
  const b2 = (1 - cosw0) / 2;
  const a0 =  1 + alpha;
  const a1 = -2 * cosw0;
  const a2 =  1 - alpha;

  // normalize by a0
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0
  };
}

/*  Apply the biquad filter to an entire buffer using direct-form II
    transposed structure (same as Web Audio API's internal implementation).

    Direct-form II transposed uses two state variables (z1, z2) and
    processes each sample as:
    output = b0 × input + z1
    z1     = b1 × input - a1 × output + z2
    z2     = b2 × input - a2 × output

    This form is preferred for floating-point because it minimizes
    accumulated rounding error compared to direct-form I. */

function applyBiquadFilter(inputBuffer, coeffs) {
  const output = new Float32Array(inputBuffer.length);
  let z1 = 0, z2 = 0;  // filter state (delay elements)

  for (let i = 0; i < inputBuffer.length; i++) {
    const x = inputBuffer[i];
    const y = coeffs.b0 * x + z1;
    z1 = coeffs.b1 * x - coeffs.a1 * y + z2;
    z2 = coeffs.b2 * x - coeffs.a2 * y;
    output[i] = y;
  }

  return output;
}


/* pre-compute biquad low-pass filter coefficients once (they never change); 
   test program harness output will now be a 1-to-1 identical result of the 
   direct implementation through tunerV2.js, utilizing a low-pass filter */
const LP_COEFFS = computeBiquadCoeffs(LOW_PASS_CUTOFF, Math.SQRT1_2, SAMPLE_RATE);

// ───────────────────────────────────────────────────────────────────────────────
/*  main YIN algorithm (identical to tunerV2.js core audio processing pipeline) 

    extracted YIN core algorithm functions (same as tunerV2.js lines 145-265)
    to precisely simulate implementation from tunerV2.js for unit testing

    pipeline : mic / input -> lowpass filter -> YIN -> output                   */
// ───────────────────────────────────────────────────────────────────────────────

function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;
  const halfSize = Math.floor(SIZE / 2);

  // RMS noise gate
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.003) return { freq: -1, clarity: 0, rms };

  // Step 1: core difference function d(τ)
  const diff = new Float32Array(halfSize);
  for (let tau = 0; tau < halfSize; tau++) {
    let sum = 0;
    for (let i = 0; i < halfSize; i++) {
      const delta = buf[i] - buf[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Step 2: CMNDF d'(τ)
  const cmndf = new Float32Array(halfSize);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfSize; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = diff[tau] / (runningSum / tau);
  }

  // Step 3: absolute threshold search
  const minLag = Math.floor(sampleRate / 5000);
  const maxLag = Math.min(halfSize, Math.floor(sampleRate / 27));

  let bestTau = -1;
  for (let tau = minLag; tau < maxLag; tau++) {
    if (cmndf[tau] < YIN_THRESHOLD) {
      while (tau + 1 < maxLag && cmndf[tau + 1] < cmndf[tau]) tau++;
      bestTau = tau;
      break;
    }
  }

  // fallback: global minimum
  if (bestTau < 0) {
    let globalMin = Infinity, globalMinTau = -1;
    for (let tau = minLag; tau < maxLag; tau++) {
      if (cmndf[tau] < globalMin) { globalMin = cmndf[tau]; globalMinTau = tau; }
    }
    if (globalMin < 0.5) bestTau = globalMinTau;
    else return { freq: -1, clarity: 1 - globalMin, rms };
  }

  // Step 4: parabolic interpolation
  let refinedTau = bestTau;
  if (bestTau > 0 && bestTau < halfSize - 1) {
    const y0 = cmndf[bestTau - 1], y1 = cmndf[bestTau], y2 = cmndf[bestTau + 1];
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (denom !== 0) refinedTau = bestTau + (y0 - y2) / denom;
  }

  const clarity = 1 - cmndf[bestTau];
  return { freq: sampleRate / refinedTau, clarity, rms };
}

function freqToNote(freq) {
  const semitones = 12 * Math.log2(freq / A4_FREQ);
  const rounded   = Math.round(semitones);
  const cents     = (semitones - rounded) * 100;
  const midi      = 69 + rounded;
  const noteIndex = ((midi % 12) + 12) % 12;
  const octave    = Math.floor(midi / 12) - 1;
  return { noteIndex, octave, cents, midi };
}

// ──────────────────────────────────────────────────
// vv synthetic tone generations for unit testing vv
// ──────────────────────────────────────────────────

function noteFrequency(noteIndex, octave) {
  const midi = noteIndex + (octave + 1) * 12;
  return A4_FREQ * Math.pow(2, (midi - 69) / 12);
}

function majorThirdAbove(freq) { return freq * Math.pow(2, 4 / 12); }
function perfectFifthAbove(freq) { return freq * Math.pow(2, 7 / 12); }

function generateTone(freq, sampleRate, bufferSize, options = {}) {
  const {
    harmonics = [],
    noiseFactor = 0,
    amplitude = 0.5,
    vibrato = null,
    inharmonicity = 0,
    onset = false,
    subHarmonic = 0,
    secondTone = null,
    amplitudeDecay = 0,
  } = options;
  const buf = new Float32Array(bufferSize);

  for (let i = 0; i < bufferSize; i++) {
    const t = i / sampleRate;
    const progress = i / bufferSize;

    let instFreq = freq;
    if (vibrato) {
      const depthHz = freq * (Math.pow(2, vibrato.depth / 1200) - 1);
      instFreq = freq + depthHz * Math.sin(2 * Math.PI * vibrato.rate * t);
    }

    let sample = Math.sin(2 * Math.PI * instFreq * t);

    for (const h of harmonics) {
      const stretchedMultiple = h.multiple * Math.sqrt(1 + inharmonicity * h.multiple * h.multiple);
      sample += h.relativeAmp * Math.sin(2 * Math.PI * instFreq * stretchedMultiple * t);
    }

    if (subHarmonic > 0) {
      sample += subHarmonic * Math.sin(2 * Math.PI * (instFreq / 2) * t);
    }

    if (secondTone) {
      sample += secondTone.amplitude * Math.sin(2 * Math.PI * secondTone.freq * t);
    }

    if (noiseFactor > 0) {
      sample += noiseFactor * (Math.random() * 2 - 1);
    }

    let env = amplitude;
    if (amplitudeDecay > 0) {
      env *= Math.exp(-amplitudeDecay * t);
    }
    if (onset && progress < 0.25) {
      if (progress < 0.05) env *= 0.01;
      else if (progress < 0.10) env *= 3.0;
      else env *= 1.0 + (0.25 - progress) * 2;
    }

    buf[i] = sample * env;
  }
  return buf;
}

// ─────────────────────────────────
// vv Test configurations below vv
// ─────────────────────────────────

const CONDITIONS = [
  // Baseline 
  {
    name: 'pure_sine',
    label: 'Pure Sine Wave',
    opts: { harmonics: [], noiseFactor: 0, amplitude: 0.5 }
  },
  {
    name: 'with_harmonics',
    label: 'Fundamental + Harmonics (2nd–5th)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.35 },
        { multiple: 4, relativeAmp: 0.2 },
        { multiple: 5, relativeAmp: 0.1 },
      ],
      noiseFactor: 0, amplitude: 0.4
    }
  },
  // Noise stress
  {
    name: 'light_noise',
    label: 'Harmonics + Light Noise (~20 dB SNR)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.35 },
      ],
      noiseFactor: 0.05, amplitude: 0.4
    }
  },
  {
    name: 'heavy_noise',
    label: 'Harmonics + Heavy Noise (~10 dB SNR)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.25 },
      ],
      noiseFactor: 0.15, amplitude: 0.4
    }
  },
  {
    name: 'extreme_noise',
    label: 'Harmonics + Extreme Noise (~6 dB SNR)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.2 },
      ],
      noiseFactor: 0.3, amplitude: 0.4
    }
  },
  // Amplitude challenges 
  {
    name: 'quiet_signal',
    label: 'Quiet Signal (low amplitude)',
    opts: { harmonics: [], noiseFactor: 0.01, amplitude: 0.08 }
  },
  {
    name: 'very_quiet',
    label: 'Very Quiet Signal (near noise gate)',
    opts: { harmonics: [], noiseFactor: 0.005, amplitude: 0.02 }
  },
  {
    name: 'pluck_decay',
    label: 'Plucked String Decay (exponential)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.6 },
        { multiple: 3, relativeAmp: 0.4 },
        { multiple: 4, relativeAmp: 0.25 },
        { multiple: 5, relativeAmp: 0.15 },
      ],
      noiseFactor: 0.02, amplitude: 0.7, amplitudeDecay: 8
    }
  },
  // Vibrato 
  {
    name: 'light_vibrato',
    label: 'Light Vibrato (5 Hz, ±15 cents)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.2 },
      ],
      amplitude: 0.4, vibrato: { rate: 5, depth: 15 }
    }
  },
  {
    name: 'heavy_vibrato',
    label: 'Heavy Vibrato (6 Hz, ±40 cents)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.2 },
      ],
      amplitude: 0.4, vibrato: { rate: 6, depth: 40 }
    }
  },
  // Harmonic interference 
  {
    name: 'strong_3rd_harmonic',
    label: 'Dominant 3rd Harmonic (odd-harmonic bias)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.15 },
        { multiple: 3, relativeAmp: 0.9 },
        { multiple: 5, relativeAmp: 0.5 },
        { multiple: 7, relativeAmp: 0.25 },
      ],
      amplitude: 0.35
    }
  },
  {
    name: 'sub_harmonic',
    label: 'Sub-Harmonic Interference (octave below)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.2 },
      ],
      subHarmonic: 0.3, amplitude: 0.4
    }
  },
  {
    name: 'inharmonic_piano',
    label: 'Inharmonic Partials (piano-like stretch)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.35 },
        { multiple: 4, relativeAmp: 0.2 },
        { multiple: 5, relativeAmp: 0.1 },
      ],
      inharmonicity: 0.0004, amplitude: 0.4
    }
  },
  
  // Onset / transient
  
  {
    name: 'attack_transient',
    label: 'Attack Transient (onset burst)',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.3 },
      ],
      noiseFactor: 0.03, amplitude: 0.5, onset: true
    }
  },
  {
  name: 'attack_noisy',
  label: 'Attack Transient + Heavy Noise',
  opts: {
    harmonics: [
      { multiple: 2, relativeAmp: 0.5 },
      { multiple: 3, relativeAmp: 0.3 },
    ],
    noiseFactor: 0.15, amplitude: 0.5, onset: true
  }
  },
  {
  name: 'attack_pluck',
  label: 'Attack Transient + Pluck Decay',
  opts: {
    harmonics: [
      { multiple: 2, relativeAmp: 0.6 },
      { multiple: 3, relativeAmp: 0.4 },
      { multiple: 4, relativeAmp: 0.25 },
    ],
    noiseFactor: 0.03, amplitude: 0.7,
    onset: true, amplitudeDecay: 8
  }
  },
  {
  name: 'attack_vibrato',
  label: 'Attack Transient + Vibrato (vocal onset)',
  opts: {
    harmonics: [
      { multiple: 2, relativeAmp: 0.4 },
      { multiple: 3, relativeAmp: 0.2 },
    ],
    amplitude: 0.5, onset: true,
    vibrato: { rate: 5, depth: 20 }
  }
  },

  // Polyphonic interference 
  {
    name: 'major_third_chord',
    label: 'Two-Note: Fundamental + Major 3rd',
    opts: (freq) => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.3 },
      ],
      secondTone: { freq: majorThirdAbove(freq), amplitude: 0.4 },
      amplitude: 0.4
    })
  },
  {
  name: 'minor_third',
  label: 'Two-Note: Fundamental + Minor 3rd',
  opts: (freq) => ({
    harmonics: [{ multiple: 2, relativeAmp: 0.3 }],
    secondTone: { freq: freq * Math.pow(2, 3/12), amplitude: 0.4 },
    amplitude: 0.4
  })
  },
  {
    name: 'power_chord',
    label: 'Two-Note: Fundamental + Perfect 5th',
    opts: (freq) => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.3 },
      ],
      secondTone: { freq: perfectFifthAbove(freq), amplitude: 0.4 },
      amplitude: 0.4
    })
  },
  // Combined worst-case 
  {
    name: 'worst_case',
    label: 'Worst Case: Vibrato + Noise + Harmonics + Decay',
    opts: {
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.4 },
        { multiple: 4, relativeAmp: 0.2 },
      ],
      noiseFactor: 0.1, amplitude: 0.5,
      vibrato: { rate: 5.5, depth: 25 },
      amplitudeDecay: 5
    }
  }
];

const OCTAVE_MIN = 0;
const OCTAVE_MAX = 8;
const TRIALS_PER_COMBO = 10;  // repeat each note/octave/condition combo 10 times


/* Pipeline runner 

   Two pipelines, matching the two things we want to compare:
   'raw'      — buffer goes directly to detectPitch (YIN only)
   'filtered' — buffer passes through the low-pass spectral filter first,
                and then through the detectPitch function (implementation) */

function runPipeline(buf, sampleRate, applyFilter) {
  const input = applyFilter ? applyBiquadFilter(buf, LP_COEFFS) : buf;
  return detectPitch(input, sampleRate);
}


// ── Evaluation engine ──────────────────────────────────────────────

function runEval() {
  const pipelines = ['raw', 'filtered'];
  const allResults = {};

  for (const pipeline of pipelines) {
    const applyFilter = pipeline === 'filtered';
    const results = [];
    let totalTests = 0, totalCorrect = 0;

    const noteSummary = NOTE_NAMES.map((name, idx) => ({
      noteIndex: idx,
      noteName: name,
      tested: 0,
      correct: 0,
      centsErrors: [],
      octaveErrors: 0,
      wrongNote: 0,
      noDetection: 0
    }));

    for (let octave = OCTAVE_MIN; octave <= OCTAVE_MAX; octave++) {
      for (let noteIdx = 0; noteIdx < 12; noteIdx++) {
        const expectedFreq = noteFrequency(noteIdx, octave);
        if (expectedFreq < 27 || expectedFreq > 5000) continue;

        for (const cond of CONDITIONS) {
          const opts = typeof cond.opts === 'function' ? cond.opts(expectedFreq) : cond.opts;

          // repeat each combo TRIALS_PER_COMBO times for statistical significance
          // (deterministic conditions will repeat identically, but noisy/random
          //  conditions will produce different noise seeds each trial)
          for (let trial = 0; trial < TRIALS_PER_COMBO; trial++) {

          const buf = generateTone(expectedFreq, SAMPLE_RATE, BUFFER_SIZE, opts);
          const result = runPipeline(buf, SAMPLE_RATE, applyFilter);

          totalTests++;
          noteSummary[noteIdx].tested++;

          let correct = false;
          let detectedNoteName = null;
          let detectedOctave = null;
          let centsOff = null;

          if (result.freq > 0 && result.clarity >= CLARITY_FLOOR) {
            const info = freqToNote(result.freq);
            detectedNoteName = NOTE_NAMES[info.noteIndex];
            detectedOctave = info.octave;
            centsOff = info.cents;

            if (info.noteIndex === noteIdx && info.octave === octave) {
              correct = true;
              totalCorrect++;
              noteSummary[noteIdx].correct++;
              noteSummary[noteIdx].centsErrors.push(centsOff);
            } else if (info.noteIndex === noteIdx) {
              noteSummary[noteIdx].octaveErrors++;
            } else {
              noteSummary[noteIdx].wrongNote++;
            }
          } else {
            noteSummary[noteIdx].noDetection++;
          }

          results.push({
            pipeline,
            expectedNote: NOTE_NAMES[noteIdx],
            expectedOctave: octave,
            expectedFreq: Math.round(expectedFreq * 100) / 100,
            condition: cond.name,
            trial: trial,
            detectedFreq: result.freq > 0 ? Math.round(result.freq * 100) / 100 : null,
            detectedNote: detectedNoteName,
            detectedOctave,
            centsOff: centsOff !== null ? Math.round(centsOff * 100) / 100 : null,
            clarity: Math.round(result.clarity * 1000) / 1000,
            rms: Math.round(result.rms * 10000) / 10000,
            correct
          });

          } // end trial loop
        }
      }
    }

    const summary = noteSummary.map(n => ({
      noteIndex: n.noteIndex,
      noteName: n.noteName,
      tested: n.tested,
      correct: n.correct,
      octaveErrors: n.octaveErrors,
      wrongNote: n.wrongNote,
      noDetection: n.noDetection,
      accuracyPct: n.tested > 0 ? Math.round((n.correct / n.tested) * 10000) / 100 : 0,
      avgCentsError: n.centsErrors.length > 0
        ? Math.round((n.centsErrors.reduce((a, b) => a + Math.abs(b), 0) / n.centsErrors.length) * 100) / 100
        : null,
      maxCentsError: n.centsErrors.length > 0
        ? Math.round(Math.max(...n.centsErrors.map(Math.abs)) * 100) / 100
        : null,
    }));

    const conditionSummary = CONDITIONS.map(c => {
      const cr = results.filter(r => r.condition === c.name);
      const cc = cr.filter(r => r.correct).length;
      return {
        condition: c.name, label: c.label,
        tested: cr.length, correct: cc,
        accuracyPct: Math.round((cc / cr.length) * 10000) / 100
      };
    });

    const octaveSummary = [];
    for (let oct = OCTAVE_MIN; oct <= OCTAVE_MAX; oct++) {
      const or2 = results.filter(r => r.expectedOctave === oct);
      if (or2.length === 0) continue;
      const oc = or2.filter(r => r.correct).length;
      octaveSummary.push({
        octave: oct, tested: or2.length, correct: oc,
        accuracyPct: Math.round((oc / or2.length) * 10000) / 100
      });
    }

    allResults[pipeline] = {
      overall: { totalTests, totalCorrect, accuracyPct: Math.round((totalCorrect / totalTests) * 10000) / 100 },
      perNote: summary,
      perCondition: conditionSummary,
      perOctave: octaveSummary,
      rawResults: results
    };
  }

  return allResults;
}


// ── Execute and report ─────────────────────────────────────────────

console.log('YIN Evaluation Harness v2 — 10× Trials per Combo');
console.log('============================================================');
console.log(`  Sample rate:     ${SAMPLE_RATE} Hz`);
console.log(`  Buffer size:     ${BUFFER_SIZE} samples`);
console.log(`  YIN threshold:   ${YIN_THRESHOLD}`);
console.log(`  LP cutoff:       ${LOW_PASS_CUTOFF} Hz (2nd-order Butterworth, Q = ${Math.SQRT1_2.toFixed(4)})`);
console.log(`  Clarity floor:   ${CLARITY_FLOOR}`);
console.log(`  Octave range:    ${OCTAVE_MIN}–${OCTAVE_MAX}`);
console.log(`  Conditions:      ${CONDITIONS.length}`);
console.log(`  Trials per combo: ${TRIALS_PER_COMBO}`);
console.log(`  Est. total tests: ~${CONDITIONS.length * 84 * TRIALS_PER_COMBO * 2} (both pipelines)`);
console.log('');

const startTime = Date.now();
const data = runEval();
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`  Completed in ${elapsed}s\n`);

for (const pipeline of ['raw', 'filtered']) {
  const d = data[pipeline];
  const tag = pipeline === 'raw' ? 'YIN ONLY (raw)' : 'LP FILTER + YIN (live app)';
  console.log(`┌─────────────────────────────────────────────────────────┐`);
  console.log(`│  ${tag.padEnd(55)}│`);
  console.log(`├─────────────────────────────────────────────────────────┤`);
  console.log(`│  Tests: ${String(d.overall.totalTests).padEnd(6)} Correct: ${String(d.overall.totalCorrect).padEnd(6)} Accuracy: ${String(d.overall.accuracyPct + '%').padEnd(8)}│`);
  console.log(`└─────────────────────────────────────────────────────────┘`);
  console.log('');

  console.log('  Per-note accuracy:');
  for (const n of d.perNote) {
    const bar = '█'.repeat(Math.round(n.accuracyPct / 5));
    const cents = n.avgCentsError !== null ? `  avg ±${n.avgCentsError}¢` : '';
    console.log(`    ${n.noteName.padEnd(3)} ${String(n.accuracyPct + '%').padStart(7)}  ${bar}  (${n.correct}/${n.tested})${cents}`);
  }
  console.log('');

  console.log('  Per-condition accuracy:');
  for (const c of d.perCondition) {
    console.log(`    ${c.label.padEnd(45)} ${String(c.accuracyPct + '%').padStart(7)}  (${c.correct}/${c.tested})`);
  }
  console.log('');

  console.log('  Per-octave accuracy:');
  for (const o of d.perOctave) {
    console.log(`    Octave ${o.octave}:  ${String(o.accuracyPct + '%').padStart(7)}  (${o.correct}/${o.tested})`);
  }
  console.log('\n');
}

// ── Side-by-side comparison table ──────────────────────────────────

console.log('═══════════════════════════════════════════════════════════');
console.log('  SIDE-BY-SIDE COMPARISON: raw YIN vs. filtered (live app)');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

console.log('  By condition:');
console.log(`    ${'Condition'.padEnd(45)} ${'Raw'.padStart(7)}  ${'Filter'.padStart(7)}  ${'Δ'.padStart(7)}`);
console.log(`    ${'─'.repeat(45)} ${'─'.repeat(7)}  ${'─'.repeat(7)}  ${'─'.repeat(7)}`);
for (let i = 0; i < CONDITIONS.length; i++) {
  const rawAcc = data.raw.perCondition[i].accuracyPct;
  const filtAcc = data.filtered.perCondition[i].accuracyPct;
  const delta = Math.round((filtAcc - rawAcc) * 100) / 100;
  const deltaStr = delta > 0 ? `+${delta}%` : delta < 0 ? `${delta}%` : '  0%';
  console.log(`    ${CONDITIONS[i].label.padEnd(45)} ${String(rawAcc + '%').padStart(7)}  ${String(filtAcc + '%').padStart(7)}  ${deltaStr.padStart(7)}`);
}
console.log('');

console.log('  By note:');
console.log(`    ${'Note'.padEnd(5)} ${'Raw'.padStart(7)}  ${'Filter'.padStart(7)}  ${'Δ'.padStart(7)}`);
console.log(`    ${'─'.repeat(5)} ${'─'.repeat(7)}  ${'─'.repeat(7)}  ${'─'.repeat(7)}`);
for (let i = 0; i < 12; i++) {
  const rawAcc = data.raw.perNote[i].accuracyPct;
  const filtAcc = data.filtered.perNote[i].accuracyPct;
  const delta = Math.round((filtAcc - rawAcc) * 100) / 100;
  const deltaStr = delta > 0 ? `+${delta}%` : delta < 0 ? `${delta}%` : '  0%';
  console.log(`    ${NOTE_NAMES[i].padEnd(5)} ${String(rawAcc + '%').padStart(7)}  ${String(filtAcc + '%').padStart(7)}  ${deltaStr.padStart(7)}`);
}
console.log('');

console.log('  By octave:');
console.log(`    ${'Oct'.padEnd(5)} ${'Raw'.padStart(7)}  ${'Filter'.padStart(7)}  ${'Δ'.padStart(7)}`);
console.log(`    ${'─'.repeat(5)} ${'─'.repeat(7)}  ${'─'.repeat(7)}  ${'─'.repeat(7)}`);
for (let i = 0; i < data.raw.perOctave.length; i++) {
  const rawAcc = data.raw.perOctave[i].accuracyPct;
  const filtAcc = data.filtered.perOctave[i].accuracyPct;
  const delta = Math.round((filtAcc - rawAcc) * 100) / 100;
  const deltaStr = delta > 0 ? `+${delta}%` : delta < 0 ? `${delta}%` : '  0%';
  console.log(`    Oct ${data.raw.perOctave[i].octave} ${String(rawAcc + '%').padStart(7)}  ${String(filtAcc + '%').padStart(7)}  ${deltaStr.padStart(7)}`);
}

// ── Write full results (summaries only; rawResults omitted at 25× scale) ──

const outputData = {
  raw: { overall: data.raw.overall, perNote: data.raw.perNote, perCondition: data.raw.perCondition, perOctave: data.raw.perOctave },
  filtered: { overall: data.filtered.overall, perNote: data.filtered.perNote, perCondition: data.filtered.perCondition, perOctave: data.filtered.perOctave }
};
fs.writeFileSync('results-10x.json', JSON.stringify(outputData, null, 2));
console.log('\n  Summary results written to results-10x.json');

