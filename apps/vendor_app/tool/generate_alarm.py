#!/usr/bin/env python3
"""Generates the Kraveo new-order alarm tone (20 s, mono, 44.1 kHz) as WAV, then ogg if ffmpeg exists.

Pattern per 2 s cycle: a rising three-note chime (C6-E6-G6), a short gap, the same chime again, then silence.
Ten cycles = 20 s, and the file ends in silence so it also loops cleanly in the app.
Usage: python3 tool/generate_alarm.py <out_dir>   (writes new_order_alarm.wav and, if possible, new_order_alarm.ogg)
"""
import math, os, shutil, struct, subprocess, sys, wave

RATE = 44100
SECONDS = 20
CYCLE = 2.0
NOTES = [1046.50, 1318.51, 1567.98]  # C6 E6 G6

def note(buf, start, freq, length=0.42):
    n0 = int(start * RATE)
    for i in range(int(length * RATE)):
        j = n0 + i
        if j >= len(buf):
            break
        t = i / RATE
        attack = min(1.0, t / 0.004)
        env = attack * math.exp(-t / 0.13)
        s = (math.sin(2 * math.pi * freq * t)
             + 0.45 * math.sin(2 * math.pi * freq * 2 * t)
             + 0.25 * math.sin(2 * math.pi * freq * 3 * t))
        buf[j] += s * env

def main(out_dir):
    buf = [0.0] * (RATE * SECONDS)
    for c in range(int(SECONDS / CYCLE)):
        base = c * CYCLE
        for burst in (0.0, 0.75):
            for k, f in enumerate(NOTES):
                note(buf, base + burst + k * 0.17, f)
    # Loudness: drive into a soft clipper (raises the average level), then normalise just under full scale.
    driven = [math.tanh(2.6 * x) for x in buf]
    peak = max(abs(x) for x in driven) or 1.0
    gain = 0.85 / peak
    # 30 ms fade at the very end so the file never clicks.
    fade = int(0.03 * RATE)
    for i in range(fade):
        driven[-1 - i] *= i / fade
    os.makedirs(out_dir, exist_ok=True)
    wav_path = os.path.join(out_dir, 'new_order_alarm.wav')
    with wave.open(wav_path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, x * gain)) * 32767)) for x in driven))
    if shutil.which('ffmpeg'):
        ogg_path = os.path.join(out_dir, 'new_order_alarm.ogg')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav_path, '-c:a', 'libvorbis', '-q:a', '4', ogg_path], check=True)
        os.remove(wav_path)
        print(ogg_path)
    else:
        print(wav_path)

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
