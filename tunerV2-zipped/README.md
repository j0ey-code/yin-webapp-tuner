j0ey-code
December 2025 - May 2026
YIN Algorithm Based 440 Hz Monophonic Chromatic Pitch Estimation Web Application
A Further Exploration in Both Digital Signal Processing and Simple HTML / CSS + JavaScript Web Application Development

This is my personal JavaScript implementation of the basic YIN algorithm, for monophonic pitch estimation in both instruments and a singer's vocal pitch. 
The initial idea was architected with my dad (a principal software engineer of many years) over winter break, following my first semester at a four-year university.
That design used auto-correlation for the pitch estimation, but when I returned from winter break, I still noticed glaring innaccuracies and, upon continued reading, found out about the YIN algorithm.

At that point, I began re-structuring the back-end to use the YIN algorithm audio processing pipeline, as originally outlined in 2002 by Alain de Cheveigne and Hideki Kawahara...
http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf

Luckily, the front-end had already been mostly set-up by that point. In earnest, I used Claude (the Opus 4.6 model specifically) to generate the initial HTML / CSS design templates.
In the past year, I have found Claude to be remarkably efficient (in my own personal work) at generating basic and even complex HTML / CSS markdowns, pages, templates, and animations.
To this end, the front-end design was delegated to Claude - upon generation of HTML / CSS artifacts, I would give a clean "rubber ducky" read-through, make necessary edits, and wire to the back-end as needed.

By around the end of March, early April, I had what is essentially the finished product. 
The only differences between that version and this one are improved annotations / comments, and modified const parameters to remove the application's previous, inherent "guitar bias". 
Something I had done explicitly when modifying the parameters of the program in March / April, as I am a bass / guitar player first and foremost. 
The most guitar biased parameters, previously, had been on lines 65 and 67 - const variables YIN_THRESHOLD and LOW_PASS_CUTOFF. 
These values were previously 0.25 (lenient but excessive threshold to basically guarantee guitars are always heard) and 1400 Hz (covering a guitar's frequency range, specifically, at pre-filtering) respectively.
At values, now set to 0.2 and 5000 Hz, we still permit great leniency in the thresholding for easier detection purposes on a wide range of microphones, 
and the spectral pre-filtering has now been attenuated to a greater 5000 Hz range, which encompasses basically ALL the low-band bass spectrum frequencies we want to catch in our pre-filter.

Additionally, a mobile toggle was added between March and now (middle of May). Line 378 ("const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);").
Here, we capture whether the recording device is mobile or not, and store that fact as a simple boolean flag.
Mobile devices have microphones that are designed differently than a headset mic, a singer's mic, or a more deeply embedded mic (e.g. a hearing aid, a wire).
Because of this, the raw signal it captures is typically significantly quieter than other microphones, as it's supposed to be a phone mic all things considered.
Only targeting a specific sound source: the speaker, whoever is on the phone / mobile device talking on a call (though phone mics ARE omni-directional).
To this end, our boolean flag is used to trigger autoGainControl conditionally. autoGainControl will allow quiet signals to be boosted, effectively compressing the signal.
For us, this means equality in the frequency pickup overall and on a phone microphone, this is crucial. We must enable autoGainControl on mobile devices to compensate for this,
and detect the signal should it be played right next to the phone's mic, or a couple of arms lengths away from the phone's mic.

In the code, there is more reasoning behind the spectral pre-filtering being added. But, in essence, I wanted a naive way for the application to at least try and detect polyphonic pitch (i.e. chords).
The pre-filter is designed to lock onto the lowest frequency note (i.e. the bass / root note, hence the low-end sweeping pre-filter at up to only 5000 Hz). 
If a confident candidate note is found within that range, the rest of the signal is ignored, and the bass / root note becomes the focus of the algorithm's pitch estimation.
In this way, by playing a very simple, 1-3-5 (NON-inverted) triad chord (e.g. A major, G minor, F# major, etc.) the application should confidently detect the root note at least, and read that back. 
NOTE:: This presents a significant semantic error when playing non-simple, extended, inverted, or otherwise complex chords into the application however.
From comments in lines 366 - 374 in the "tunerV2.js" IIFE code file...

"This introduces an unfortunate semantic error - also an acceptable trade off (for now). Because music theory is naturally complex, so is polyphonic pitch detection. Though a chord may be an A minor (A-C-E) for instance, there are various extensions and inversions that can be played to manipulate the chord. For example, we may introduce a 7th and 9th to the triad (A-C-E-G-B) to form an A minor 9th [Am9th] chord - at which point the YIN algorithm will almost surely be muddied by the amount of overtones and sub-harmonics within such a complex chord, low-pass filter or not. The true error will show however if an inversion chord is played.
Consider now an A minor 7th [Am7th] (A-C-E-G) BUT with the 7th note stacked as the chord's bass root (G-A-C-E). This is, fundamentally, still an Am7th chord - the triad is still present, but the key / scale's 7th now roots the chord. Neither our low-pass spectral pre-filter, nor the YIN algorithm, have any way of knowing this. Therefore, though such a chord *should* display as an "A", it will most likely show as a "G" due to the low-pass filter biasing towards the lower frequencies."

Overall, this was an extremely fun project to eat up some time this spring semester, alongside my first real course in Data Structures and Algorithms.
I am generally pleased with how it turned out, and it even works better than the chromatic tuning app I had installed on my phone previously.
Now, if I ever need a tuner in a pinch, I can just navigate to the website(s) where I host this neat little web application of mine.

// 13 June 2026
const BUFFER_SIZE in eval.js test files and analyzer.fftSize on line 398 of "tunerV2.js" core program
have been doubled from 4096 to 8192 in order to mitigate errors from attack / decay transient conditions
to accomodate this, the smoothCents UI updater has been incremented slightly too, as doubling the 
buffer frame presents a challenge for the YIN algorithm, which is already fairly computationally
heavy, and this web app. implementation is intended to run on browsers as well - the smoothCents
variable multiplier has been incremented by 0.075 to allow for more responsiveness on the purely
front-end, HTML/CSS side of the application, to help account for the computational burden now
also tacked on by doubling the analyzer node's fast fourier transform / buffer size within the JS (line 398) 

// 16 June 2026 [for Professor(s) Specifically Too!!]
critical error information and data gathered and synthesized
created and finally consolidated 3 different evaluation and test scripts 
for the web application's accuracy in pitch estimation and detection
"yin-eval.js", "yin-eval10x.js", and "yin-eval-rng.js"
the core pipeline, including the low-pass filter, is within each 
evaluation script along with matching parameters to "tunerV2.js",
before the CONDITIONS array which houses / defines our test conditions.
direct, synthesized audio frequencies and signals are fed 
into the pipeline using the node.js libraries, filter + YIN processes them,
and then outputs the results from the tests to a JSON file in the 
present working directory, which is set and named at the very bottom.
the BiquadFilter and AnalyzerNode math and logic had to be recreated, with 
assistance from Claude, because the Web Audio API BiquadFilter and AnalyzerNode 
features can't be accessed without direct, online web browser access.
The link to said BiquadFilter logic and math, sourced from the "Web Audio Cookbook",
can be found here: https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html

/* Running the Unit Test Scripts (yin-eval.js, yin-eval10x.js, yin-eval-rng.js) */
// 1. Ensure you have node.js installed on your machine
// 2. Navigate to the "tunerV2" project directory in your command prompt, console, or terminal window
// 3. Run "node yin-eval.js", "node yin-eval10x.js", etc. - a msg should appear w/ basic info. about the tests
// 4. Wait for testing suite script to conclude
// 5. Results will splash to console / terminal and also be outputted to a "results.json" file in the PWD by default

