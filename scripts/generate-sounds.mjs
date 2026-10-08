// Generates ErgoFocus chime WAVs replicating the original Web Audio API
// synthesis from src/utils/audio.ts (oscillators + gain envelopes).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const linear = (t, t0, t1, v0, v1) => v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
const exponential = (t, t0, t1, v0, v1) => v0 * Math.pow(v1 / v0, clamp01((t - t0) / (t1 - t0)));

function writeWav(file, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  samples.forEach((s, i) => {
    const v = Math.max(-1, Math.min(1, s));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  });
  writeFileSync(file, buf);
}

const sine = (phase) => Math.sin(2 * Math.PI * phase);
const triangle = (phase) => 2 * Math.asin(Math.sin(2 * Math.PI * phase)) / Math.PI;

// playGentleChime: sine 528Hz exponential ramp to 792Hz in 0.15s,
// gain linear 0.001 -> 0.12 in 0.05s, exponential decay to 0.0001 by 0.8s
function gentleChime(duration = 0.85) {
  const out = [];
  let phase = 0;
  for (let i = 0; i < SR * duration; i++) {
    const t = i / SR;
    const freq = t < 0.15 ? exponential(t, 0, 0.15, 528, 792) : 792;
    phase += freq / SR;
    const gain =
      t < 0.05 ? linear(t, 0, 0.05, 0.001, 0.12)
      : t < 0.8 ? exponential(t, 0.05, 0.8, 0.12, 0.0001)
      : 0;
    out.push(sine(phase) * gain);
  }
  return out;
}

// playCorrectionPulse: triangle 320Hz linear ramp to 260Hz in 0.2s,
// gain linear 0.001 -> 0.08 in 0.03s, exponential decay to 0.0001 by 0.35s
function correctionPulse(duration = 0.4) {
  const out = [];
  let phase = 0;
  for (let i = 0; i < SR * duration; i++) {
    const t = i / SR;
    const freq = t < 0.2 ? linear(t, 0, 0.2, 320, 260) : 260;
    phase += freq / SR;
    const gain =
      t < 0.03 ? linear(t, 0, 0.03, 0.001, 0.08)
      : t < 0.35 ? exponential(t, 0.03, 0.35, 0.08, 0.0001)
      : 0;
    out.push(triangle(phase) * gain);
  }
  return out;
}

// playSuccessChime: C5, E5, G5, C6 sine notes staggered by 0.08s,
// each gain linear 0.001 -> 0.1 in 0.02s, exponential decay to 0.0001 by +0.5s
function successChime(duration = 0.85) {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  const out = new Array(SR * duration).fill(0);
  notes.forEach((freq, i) => {
    const start = i * 0.08;
    const phase0 = i * 0.37; // decorrelate phases like separate oscillators
    for (let j = 0; j < SR * 0.55; j++) {
      const t = j / SR;
      const idx = Math.round((start + t) * SR);
      if (idx >= out.length) break;
      const gain =
        t < 0.02 ? linear(t, 0, 0.02, 0.001, 0.1)
        : t < 0.5 ? exponential(t, 0.02, 0.5, 0.1, 0.0001)
        : 0;
      out[idx] += sine(phase0 + freq * t) * gain;
    }
  });
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
writeWav(join(OUT_DIR, 'gentle-chime.wav'), gentleChime());
writeWav(join(OUT_DIR, 'correction-pulse.wav'), correctionPulse());
writeWav(join(OUT_DIR, 'success-chime.wav'), successChime());
console.log('Generated chimes in', OUT_DIR);
