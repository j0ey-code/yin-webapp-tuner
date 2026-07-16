/*  YIN Algorithm and JavaScript Web App Evaluation / Test Harness
    ===============================================================
            RANDOMIZED REAL-WORLD EXTENSION (yin-eval-rng.js)

    Extends the original "yin-eval.js" deterministic test harness 
    w/ stochastic, real-world signal conditions that vary on every run:

      NEW in generateTone():
        • phaseOffset     — random starting phase (0–2π)
        • dcOffset        — DC bias from cheap microphones
        • frequencyDrift  — slow random-walk pitch instability
        • tremolo         — amplitude modulation (rate + depth)
        • noiseType       — 'white' (default), 'pink', or 'brown'

      NEW in evaluation loop:
        • micro-detuning  — ±0–30 cents offset per test (real
                            instruments are never perfectly in tune)
        • random amplitude — randomized signal level per test
        • buffer capture offset — random window into a longer
                            generated signal (simulates AnalyserNode
                            grabbing an arbitrary slice)

      NEW CONDITIONS ENTIRELY (14 added → 35 total):
        • Random phase (verify YIN phase invariance)
        • Micro-detuning ±10¢, ±25¢, ±random¢
        • Pink noise, brown noise
        • Frequency drift (slow random walk)
        • Tremolo (amplitude modulation)
        • Random amplitude (near noise gate to loud)
        • Random buffer capture offset
        • Randomized vibrato (random rate + depth per test)
        • Randomized harmonics (random partial amplitudes)
          and...
        • Full random: all above randomization conditions combined

    Deterministic conditions from v2 are preserved unchanged so
    results remain directly comparable to the baseline harness.

    Usage: node yin-eval-rng.js
    Output: results-rng.json  */

const fs = require('fs');

// Constants (match tunerV2.js exactly!)

const A4_FREQ        = 440;
const YIN_THRESHOLD  = 0.20;
const CLARITY_FLOOR  = 0.625;
const LOW_PASS_CUTOFF = 5000;
const SAMPLE_RATE    = 44100;
const BUFFER_SIZE    = 8192;

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
    https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html */

function applyBiquadFilter(inputBuffer, coeffs) {
  const output = new Float32Array(inputBuffer.length);
  let z1 = 0, z2 = 0;

  for (let i = 0; i < inputBuffer.length; i++) {
    const x = inputBuffer[i];
    const y = coeffs.b0 * x + z1;
    z1 = coeffs.b1 * x - coeffs.a1 * y + z2;
    z2 = coeffs.b2 * x - coeffs.a2 * y;
    output[i] = y;
  }

  return output;
}

const LP_COEFFS = computeBiquadCoeffs(LOW_PASS_CUTOFF, Math.SQRT1_2, SAMPLE_RATE);

// ───────────────────────────────────────────────────────────────────────────────
/*  main YIN algorithm (identical to tunerV2.js core audio processing pipeline) 

    extracted YIN core algorithm functions (same as tunerV2.js lines 145-265)
    to precisely simulate implementation from tunerV2.js for unit testing

    pipeline : mic / input -> lowpass filter -> YIN -> output                   */
// ───────────────────────────────────────────────────────────────────────────────

function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;

  // Full-buffer RMS noise gate
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.003) return { freq: -1, clarity: 0, rms };

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

  const diff = new Float32Array(halfSize);
  for (let tau = 0; tau < halfSize; tau++) {
    let sum = 0;
    for (let i = 0; i < halfSize; i++) {
      const delta = buf[offset + i] - buf[offset + i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  const cmndf = new Float32Array(halfSize);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfSize; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = diff[tau] / (runningSum / tau);
  }

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

  if (bestTau < 0) {
    let globalMin = Infinity, globalMinTau = -1;
    for (let tau = minLag; tau < maxLag; tau++) {
      if (cmndf[tau] < globalMin) { globalMin = cmndf[tau]; globalMinTau = tau; }
    }
    if (globalMin < 0.5) bestTau = globalMinTau;
    else return { freq: -1, clarity: 1 - globalMin, rms };
  }

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


// ──────────────────────────────────────────────────────────────────
// ── Noise generators ─────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

/*  Pink noise (1/f spectrum) using the Voss-McCartney algorithm.
    Sums multiple octave-band random generators that update at
    halving rates, producing an approximate -3 dB/octave rolloff.
    Real acoustic environments (rooms, HVAC, audience noise) have
    roughly pink spectral profiles. */

function generatePinkNoise(length) {
  const NUM_ROWS = 16;
  const rows = new Float32Array(NUM_ROWS);
  const out = new Float32Array(length);
  let runningSum = 0;

  for (let i = 0; i < NUM_ROWS; i++) {
    rows[i] = Math.random() * 2 - 1;
    runningSum += rows[i];
  }

  for (let i = 0; i < length; i++) {
    // determine which row to update based on trailing zeros of i
    let n = i;
    let k = 0;
    while (k < NUM_ROWS - 1 && (n & 1) === 0 && n > 0) {
      k++;
      n >>= 1;
    }
    runningSum -= rows[k];
    rows[k] = Math.random() * 2 - 1;
    runningSum += rows[k];

    // normalize: NUM_ROWS uniform sources sum to stddev ≈ sqrt(N/3)
    out[i] = runningSum / NUM_ROWS;
  }

  return out;
}

/*  Brown noise (1/f² spectrum, aka Brownian / red noise).
    Generated by integrating white noise with a leaky integrator
    (pole at ~0.99) to prevent DC drift. Produces a steep
    -6 dB/octave rolloff — models rumble, traffic, wind buffeting. */

function generateBrownNoise(length) {
  const out = new Float32Array(length);
  let state = 0;
  const leak = 0.99;

  for (let i = 0; i < length; i++) {
    state = leak * state + (Math.random() * 2 - 1) * 0.1;
    out[i] = state;
  }

  // normalize to roughly ±1 range
  let maxAbs = 0;
  for (let i = 0; i < length; i++) {
    if (Math.abs(out[i]) > maxAbs) maxAbs = Math.abs(out[i]);
  }
  if (maxAbs > 0) {
    for (let i = 0; i < length; i++) out[i] /= maxAbs;
  }

  return out;
}


// ──────────────────────────────────────────────────────────────────
// ── Utility: random helpers ──────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

// uniform random in [min, max]
function randRange(min, max) {
  return min + Math.random() * (max - min);
}

// random sign: +1 or -1
function randSign() {
  return Math.random() < 0.5 ? -1 : 1;
}

// clamp value to [min, max]
function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}


// ──────────────────────────────────────────────────────────────────
// ── Enhanced tone generator ──────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

/*  Extended generateTone() with new real-world parameters:

    phaseOffset      — starting phase in radians (default: 0)
                       real mic captures pick up at arbitrary phase

    dcOffset         — DC bias added to signal (default: 0)
                       cheap mics / audio interfaces have DC bias

    frequencyDrift   — random walk on fundamental, in cents/second
                       (default: 0) — real instruments wobble slightly

    tremolo          — { rate: Hz, depth: 0–1 } amplitude modulation
                       (default: null) — acoustic instruments have it

    noiseType        — 'white' | 'pink' | 'brown' (default: 'white')
                       real environments have colored noise spectra

    bufferOffset     — if > 0, generates (bufferSize + bufferOffset)
                       samples then returns a random slice of bufferSize
                       (simulates AnalyserNode circular buffer capture)  */

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
    // ── new v3 options ──
    phaseOffset = 0,
    dcOffset = 0,
    frequencyDrift = 0,
    tremolo = null,
    noiseType = 'white',
    bufferOffset = 0,
  } = options;

  // if bufferOffset is set, generate a longer signal and slice later
  const genLength = bufferOffset > 0 ? bufferSize + bufferOffset : bufferSize;
  const buf = new Float32Array(genLength);

  // pre-generate colored noise if needed (white is inline per-sample)
  let coloredNoise = null;
  if (noiseFactor > 0 && noiseType === 'pink') {
    coloredNoise = generatePinkNoise(genLength);
  } else if (noiseFactor > 0 && noiseType === 'brown') {
    coloredNoise = generateBrownNoise(genLength);
  }

  // frequency drift: pre-compute a random walk in cents
  let driftCents = null;
  if (frequencyDrift > 0) {
    driftCents = new Float32Array(genLength);
    let currentDrift = 0;
    const stepSizeCents = frequencyDrift / sampleRate; // cents per sample
    for (let i = 0; i < genLength; i++) {
      currentDrift += (Math.random() * 2 - 1) * stepSizeCents;
      // soft clamp to prevent extreme drift (±50 cents max)
      currentDrift = clamp(currentDrift, -50, 50);
      driftCents[i] = currentDrift;
    }
  }

  // use phase accumulator for accurate frequency tracking
  // (necessary for drift and vibrato to avoid phase discontinuities)
  let phase = phaseOffset;
  const harmonicPhases = harmonics.map(() => phaseOffset);
  let subPhase = phaseOffset;
  let secondPhase = phaseOffset;

  for (let i = 0; i < genLength; i++) {
    const t = i / sampleRate;
    const progress = i / genLength;

    // base frequency with optional drift
    let instFreq = freq;
    if (driftCents && driftCents[i] !== 0) {
      instFreq = freq * Math.pow(2, driftCents[i] / 1200);
    }
    if (vibrato) {
      const depthHz = instFreq * (Math.pow(2, vibrato.depth / 1200) - 1);
      instFreq = instFreq + depthHz * Math.sin(2 * Math.PI * vibrato.rate * t);
    }

    // fundamental via phase accumulator
    const phaseInc = 2 * Math.PI * instFreq / sampleRate;
    phase += phaseInc;
    let sample = Math.sin(phase);

    // harmonics via their own phase accumulators
    for (let h = 0; h < harmonics.length; h++) {
      const harm = harmonics[h];
      const stretchedMultiple = harm.multiple * Math.sqrt(1 + inharmonicity * harm.multiple * harm.multiple);
      harmonicPhases[h] += 2 * Math.PI * instFreq * stretchedMultiple / sampleRate;
      sample += harm.relativeAmp * Math.sin(harmonicPhases[h]);
    }

    if (subHarmonic > 0) {
      subPhase += 2 * Math.PI * (instFreq / 2) / sampleRate;
      sample += subHarmonic * Math.sin(subPhase);
    }

    if (secondTone) {
      secondPhase += 2 * Math.PI * secondTone.freq / sampleRate;
      sample += secondTone.amplitude * Math.sin(secondPhase);
    }

    // noise injection (white, pink, or brown)
    if (noiseFactor > 0) {
      if (coloredNoise) {
        sample += noiseFactor * coloredNoise[i];
      } else {
        sample += noiseFactor * (Math.random() * 2 - 1);
      }
    }

    // envelope: base amplitude with optional decay, onset, tremolo
    let env = amplitude;
    if (amplitudeDecay > 0) {
      env *= Math.exp(-amplitudeDecay * t);
    }
    if (onset && progress < 0.25) {
      if (progress < 0.05) env *= 0.01;
      else if (progress < 0.10) env *= 3.0;
      else env *= 1.0 + (0.25 - progress) * 2;
    }
    if (tremolo) {
      // tremolo modulates amplitude: env *= 1 - depth * (0.5 + 0.5*sin(...))
      // at depth=1, amplitude goes from 0 to full; at depth=0.3, it's subtle
      env *= 1 - tremolo.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * tremolo.rate * t));
    }

    buf[i] = sample * env + dcOffset;
  }

  // if buffer offset mode: slice a random window
  if (bufferOffset > 0) {
    const start = Math.floor(Math.random() * bufferOffset);
    return buf.slice(start, start + bufferSize);
  }

  return buf;
}


// ──────────────────────────────────────────────────────────────────
// ── Helper functions ─────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

function noteFrequency(noteIndex, octave) {
  const midi = noteIndex + (octave + 1) * 12;
  return A4_FREQ * Math.pow(2, (midi - 69) / 12);
}

function majorThirdAbove(freq) { return freq * Math.pow(2, 4 / 12); }
function perfectFifthAbove(freq) { return freq * Math.pow(2, 7 / 12); }


// ──────────────────────────────────────────────────────────────────
// ── Test conditions ──────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

/*  CONDITIONS array: all 21 original deterministic tests are preserved
    unchanged for baseline comparison. 14 new randomized conditions
    follow, each exercising a different axis of real-world variance.

    Conditions marked (RNG) produce different results on every run. */

const CONDITIONS = [

  // ════════════════════════════════════════════════════════════════
  // ORIGINAL DETERMINISTIC CONDITIONS (1–21, unchanged from v2)
  // ════════════════════════════════════════════════════════════════

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
  },


  // ════════════════════════════════════════════════════════════════
  // NEW RANDOMIZED REAL-WORLD CONDITIONS (22–35)
  // ════════════════════════════════════════════════════════════════

  // ── Phase randomization ────────────────────────────────────────
  /*  In the live app, the mic signal is continuous — the AnalyserNode
      grabs a snapshot at an arbitrary phase. YIN is theoretically
      phase-invariant, but this verifies it with harmonics present. */
  {
    name: 'rng_random_phase',
    label: '(RNG) Random Starting Phase + Harmonics',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.35 },
        { multiple: 4, relativeAmp: 0.2 },
      ],
      amplitude: 0.4,
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Micro-detuning ─────────────────────────────────────────────
  /*  Real instruments are never perfectly in tune. These test whether
      the tuner identifies the correct *nearest note* when the input
      is offset by a small, known number of cents from the nominal
      chromatic frequency. The expected note stays the same (±25¢ is
      well within the ±50¢ semitone boundary). */
  {
    name: 'rng_detune_10',
    label: '(RNG) Micro-Detune ±10 cents',
    detuneCents: () => randRange(-10, 10),
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.25 },
      ],
      amplitude: 0.4,
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },
  {
    name: 'rng_detune_25',
    label: '(RNG) Micro-Detune ±25 cents',
    detuneCents: () => randRange(-25, 25),
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.25 },
      ],
      amplitude: 0.4,
      noiseFactor: 0.03,
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },
  {
    name: 'rng_detune_random',
    label: '(RNG) Micro-Detune ±random (0–30¢) + Noise',
    detuneCents: () => randSign() * randRange(0, 30),
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.35 },
      ],
      amplitude: 0.4,
      noiseFactor: 0.08,
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Colored noise ──────────────────────────────────────────────
  /*  Real acoustic environments have colored noise spectra:
      - Pink noise (1/f): room ambience, HVAC, audience murmur
      - Brown noise (1/f²): traffic rumble, wind, mechanical vibration
      These stress-test the low-pass filter's ability to reject
      low-frequency interference that white noise doesn't model. */
  {
    name: 'rng_pink_noise',
    label: '(RNG) Pink Noise (~12 dB SNR)',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.25 },
      ],
      amplitude: 0.4,
      noiseFactor: 0.12,
      noiseType: 'pink',
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },
  {
    name: 'rng_brown_noise',
    label: '(RNG) Brown Noise (~12 dB SNR)',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.25 },
      ],
      amplitude: 0.4,
      noiseFactor: 0.12,
      noiseType: 'brown',
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Frequency drift ────────────────────────────────────────────
  /*  Real instruments don't hold perfectly stable pitch. Guitar
      strings settle after plucking, voice wavers, wind instruments
      shift with air pressure. This adds a slow random walk on the
      fundamental — distinct from periodic vibrato. */
  {
    name: 'rng_freq_drift',
    label: '(RNG) Frequency Drift (slow random walk)',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.2 },
      ],
      amplitude: 0.4,
      frequencyDrift: randRange(80, 200),  // cents/sec random walk speed
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Tremolo (amplitude modulation) ─────────────────────────────
  /*  Tremolo is periodic amplitude variation, common in classical
      guitar, electric guitar (amp tremolo), and some vocal styles.
      It modulates the RMS level the noise gate sees, which could
      cause intermittent dropout on quiet signals. */
  {
    name: 'rng_tremolo',
    label: '(RNG) Tremolo (amplitude modulation)',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.2 },
      ],
      amplitude: 0.4,
      tremolo: { rate: randRange(3, 8), depth: randRange(0.15, 0.5) },
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Random amplitude ───────────────────────────────────────────
  /*  Real signals arrive at wildly varying levels depending on
      instrument volume, mic distance, gain settings. This sweeps
      from near the noise gate threshold up to clipping-adjacent. */
  {
    name: 'rng_random_amplitude',
    label: '(RNG) Random Amplitude (0.015–0.9)',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.25 },
      ],
      amplitude: randRange(0.015, 0.9),
      noiseFactor: 0.02,
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Buffer capture offset ──────────────────────────────────────
  /*  The AnalyserNode in Web Audio grabs the most recent N samples
      from a circular buffer. The note onset doesn't align with the
      buffer start — this simulates capturing the signal at an
      arbitrary position, which is especially impactful for decaying
      tones where the start vs. end of the buffer see very different
      amplitudes. */
  {
    name: 'rng_buffer_offset',
    label: '(RNG) Random Buffer Capture Offset',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.5 },
        { multiple: 3, relativeAmp: 0.3 },
        { multiple: 4, relativeAmp: 0.15 },
      ],
      amplitude: 0.5,
      noiseFactor: 0.03,
      amplitudeDecay: randRange(2, 6),
      bufferOffset: Math.floor(randRange(1024, 4096)),
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Randomized vibrato ─────────────────────────────────────────
  /*  Real vibrato varies continuously in rate and depth — singers
      especially vary from ~4 Hz narrow to ~7 Hz wide within a
      single performance. */
  {
    name: 'rng_vibrato',
    label: '(RNG) Randomized Vibrato (rate 3–8 Hz, depth 5–35¢)',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.2 },
      ],
      amplitude: 0.4,
      vibrato: { rate: randRange(3, 8), depth: randRange(5, 35) },
      noiseFactor: 0.02,
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Randomized harmonics ───────────────────────────────────────
  /*  Every instrument has a unique harmonic fingerprint, and it
      changes with playing dynamics. This randomizes the number
      (2–7) and relative amplitudes (0.05–0.8) of upper partials,
      covering everything from flute-like (few, weak) to brass-like
      (many, strong). */
  {
    name: 'rng_harmonics',
    label: '(RNG) Randomized Harmonic Spectrum (2–7 partials)',
    opts: () => {
      const numHarmonics = Math.floor(randRange(2, 8));
      const harmonics = [];
      for (let h = 2; h <= numHarmonics + 1; h++) {
        harmonics.push({
          multiple: h,
          relativeAmp: randRange(0.05, 0.8) / h, // natural rolloff
        });
      }
      return {
        harmonics,
        amplitude: 0.4,
        noiseFactor: 0.02,
        phaseOffset: Math.random() * 2 * Math.PI,
      };
    }
  },

  // ── DC offset ──────────────────────────────────────────────────
  /*  Cheap microphones and audio interfaces often have a small DC
      bias. This shouldn't affect YIN (the difference function
      cancels DC), but verifies it doesn't interact badly with
      the noise gate or LP filter. */
  {
    name: 'rng_dc_offset',
    label: '(RNG) DC Offset Bias (±0.01–0.1)',
    opts: () => ({
      harmonics: [
        { multiple: 2, relativeAmp: 0.4 },
        { multiple: 3, relativeAmp: 0.25 },
      ],
      amplitude: 0.35,
      noiseFactor: 0.03,
      dcOffset: randSign() * randRange(0.01, 0.1),
      phaseOffset: Math.random() * 2 * Math.PI,
    })
  },

  // ── Full random: everything at once ────────────────────────────
  /*  The ultimate stress test: every randomization axis enabled
      simultaneously. Random phase, detuning, colored noise, drift,
      tremolo, random harmonics, random amplitude, DC offset. This
      models the messiest real-world signal the tuner could see. */
  {
    name: 'rng_full_random',
    label: '(RNG) Full Random (all axes combined)',
    detuneCents: () => randSign() * randRange(0, 20),
    opts: () => {
      const numHarmonics = Math.floor(randRange(2, 6));
      const harmonics = [];
      for (let h = 2; h <= numHarmonics + 1; h++) {
        harmonics.push({
          multiple: h,
          relativeAmp: randRange(0.05, 0.6) / h,
        });
      }
      const noiseTypes = ['white', 'pink', 'brown'];
      return {
        harmonics,
        amplitude: randRange(0.05, 0.7),
        noiseFactor: randRange(0.01, 0.15),
        noiseType: noiseTypes[Math.floor(Math.random() * 3)],
        vibrato: Math.random() < 0.5
          ? { rate: randRange(3, 7), depth: randRange(5, 30) }
          : null,
        tremolo: Math.random() < 0.3
          ? { rate: randRange(3, 8), depth: randRange(0.1, 0.4) }
          : null,
        frequencyDrift: Math.random() < 0.4 ? randRange(40, 150) : 0,
        dcOffset: randSign() * randRange(0, 0.05),
        phaseOffset: Math.random() * 2 * Math.PI,
        bufferOffset: Math.random() < 0.3 ? Math.floor(randRange(512, 2048)) : 0,
      };
    }
  },
];

const OCTAVE_MIN = 0;
const OCTAVE_MAX = 8;


// ──────────────────────────────────────────────────────────────────
// ── Pipeline runner ──────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

function runPipeline(buf, sampleRate, applyFilter) {
  const input = applyFilter ? applyBiquadFilter(buf, LP_COEFFS) : buf;
  return detectPitch(input, sampleRate);
}


// ──────────────────────────────────────────────────────────────────
// ── Evaluation engine ────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

/*  The eval loop now supports per-condition micro-detuning:
    if a condition has a `detuneCents` function, it's called to
    generate a random cents offset. The test frequency is shifted
    by that offset, but the expected note stays the same (since
    detuning is bounded within ±30¢ < 50¢ semitone boundary).
    The actual detuning applied is recorded in the raw results. */

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
        const nominalFreq = noteFrequency(noteIdx, octave);
        if (nominalFreq < 27 || nominalFreq > 5000) continue;

        for (const cond of CONDITIONS) {
          // apply micro-detuning if the condition defines it
          let detuneApplied = 0;
          let expectedFreq = nominalFreq;
          if (typeof cond.detuneCents === 'function') {
            detuneApplied = cond.detuneCents();
            expectedFreq = nominalFreq * Math.pow(2, detuneApplied / 1200);
          }

          const opts = typeof cond.opts === 'function' ? cond.opts(expectedFreq) : cond.opts;
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
            nominalFreq: Math.round(nominalFreq * 100) / 100,
            detuneApplied: Math.round(detuneApplied * 100) / 100,
            condition: cond.name,
            detectedFreq: result.freq > 0 ? Math.round(result.freq * 100) / 100 : null,
            detectedNote: detectedNoteName,
            detectedOctave,
            centsOff: centsOff !== null ? Math.round(centsOff * 100) / 100 : null,
            clarity: Math.round(result.clarity * 1000) / 1000,
            rms: Math.round(result.rms * 10000) / 10000,
            correct
          });
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


// ──────────────────────────────────────────────────────────────────
// ── Execute and report ───────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────

console.log('YIN Evaluation Harness v3 — RANDOMIZED REAL-WORLD EXTENSION');
console.log('============================================================');
console.log(`  Sample rate:     ${SAMPLE_RATE} Hz`);
console.log(`  Buffer size:     ${BUFFER_SIZE} samples`);
console.log(`  YIN threshold:   ${YIN_THRESHOLD}`);
console.log(`  LP cutoff:       ${LOW_PASS_CUTOFF} Hz (2nd-order Butterworth, Q = ${Math.SQRT1_2.toFixed(4)})`);
console.log(`  Clarity floor:   ${CLARITY_FLOOR}`);
console.log(`  Octave range:    ${OCTAVE_MIN}–${OCTAVE_MAX}`);
console.log(`  Conditions:      ${CONDITIONS.length} (21 deterministic + ${CONDITIONS.length - 21} randomized)`);
console.log('');

const data = runEval();

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
  console.log(`    ${'— DETERMINISTIC —'.padEnd(55)}`);
  for (const c of d.perCondition) {
    if (c.condition.startsWith('rng_') && d.perCondition.indexOf(c) === d.perCondition.findIndex(x => x.condition.startsWith('rng_'))) {
      console.log(`    ${'— RANDOMIZED (RNG) —'.padEnd(55)}`);
    }
    console.log(`    ${c.label.padEnd(55)} ${String(c.accuracyPct + '%').padStart(7)}  (${c.correct}/${c.tested})`);
  }
  console.log('');

  console.log('  Per-octave accuracy:');
  for (const o of d.perOctave) {
    console.log(`    Octave ${o.octave}:  ${String(o.accuracyPct + '%').padStart(7)}  (${o.correct}/${o.tested})`);
  }
  console.log('\n');
}

// ── Side-by-side comparison ──────────────────────────────────────

console.log('════════════════════════════════════════════════════════════');
console.log('  SIDE-BY-SIDE COMPARISON: raw YIN vs. filtered (live app)  ');
console.log('════════════════════════════════════════════════════════════');
console.log('');

console.log('  By condition:');
console.log(`    ${'Condition'.padEnd(55)} ${'Raw'.padStart(7)}  ${'Filter'.padStart(7)}  ${'Δ'.padStart(7)}`);
console.log(`    ${'─'.repeat(55)} ${'─'.repeat(7)}  ${'─'.repeat(7)}  ${'─'.repeat(7)}`);
for (let i = 0; i < CONDITIONS.length; i++) {
  const rawAcc = data.raw.perCondition[i].accuracyPct;
  const filtAcc = data.filtered.perCondition[i].accuracyPct;
  const delta = Math.round((filtAcc - rawAcc) * 100) / 100;
  const deltaStr = delta > 0 ? `+${delta}%` : delta < 0 ? `${delta}%` : '  0%';
  console.log(`    ${CONDITIONS[i].label.padEnd(55)} ${String(rawAcc + '%').padStart(7)}  ${String(filtAcc + '%').padStart(7)}  ${deltaStr.padStart(7)}`);
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

// Write full results

fs.writeFileSync('results-rng.json', JSON.stringify(data, null, 2));
console.log('\n  Full results written to results-rng.json');
