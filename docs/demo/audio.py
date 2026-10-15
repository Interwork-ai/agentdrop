"""Synthesize and mix the original demo score with Python's stdlib and FFmpeg.

Run from any directory: python3 docs/demo/audio.py
Use --plan and --output to score another demo. Evidence paths are relative to the plan.
"""

import argparse
import array
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import wave

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[1]
OUT = ROOT / "tmp/readme-demo"
PLAN = BASE / "plan.json"
RATE = 24000
ONSET = {"delivered": 0.025, "received": 0.025, "open-message": 0.023}
FREQUENCIES = {
    "delivered": (659.255, 880),
    "received": (523.251, 783.991),
    "open-message": (880,),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(name, samples):
    """Write deterministic little-endian PCM, refusing to hide clipped synthesis."""
    peak = max(abs(value) for value in samples)
    if peak >= 1:
        raise ValueError(f"Clipping before normalization: {name} ({peak})")
    pcm = array.array("h", (round(value * 32767) for value in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(str(OUT / name), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm.tobytes())


def load(name):
    """Mix the actual quantized source files identified in the evidence."""
    with wave.open(str(OUT / name), "rb") as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (RATE, 1, 2):
            raise ValueError(f"Unexpected source format: {name}")
        pcm = array.array("h")
        pcm.frombytes(source.readframes(source.getnframes()))
    if sys.byteorder != "little":
        pcm.byteswap()
    return [value / 32768 for value in pcm]


def add_note(samples, start, frequency, duration, gain):
    first = round(start * RATE)
    for index in range(min(round(duration * RATE), len(samples) - first)):
        elapsed = index / RATE
        envelope = (
            min(1, elapsed / 0.009)
            * math.exp(-elapsed * 3.2)
            * min(1, (duration - elapsed) / 0.12)
        )
        tone = math.sin(math.tau * frequency * elapsed)
        tone += 0.15 * math.sin(math.tau * frequency * 2 * elapsed)
        samples[first + index] += gain * envelope * tone


def ffmpeg(*args):
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-y", *args],
        check=True, capture_output=True, text=True,
    )


def loudness(path):
    result = ffmpeg(
        "-i", str(path), "-af", "loudnorm=I=-16:TP=-1.5:LRA=8:print_format=json",
        "-f", "null", "-",
    )
    start, end = result.stderr.rfind("{"), result.stderr.rfind("}")
    stats = json.loads(result.stderr[start:end + 1])
    for key in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset"):
        if not math.isfinite(float(stats[key])):
            raise ValueError("The audio is silent or has invalid loudness measurements")
    return stats


def asset(name):
    return {"file": relative_asset(name), "sha256": digest(OUT / name)}


def relative_asset(name):
    return Path(os.path.relpath(OUT / name, PLAN.parent)).as_posix()


def planned_score(samples, length, score):
    """Change harmony at editorial boundaries, with an optional beat grid."""
    tempo = float(score["tempoBpm"])
    changes = score["chordChanges"]
    if not math.isfinite(tempo) or not 30 <= tempo <= 240:
        raise ValueError("Score tempoBpm must be between 30 and 240")
    if not changes or changes[0]["at"] != 0:
        raise ValueError("Score chordChanges must begin at zero")
    for index, change in enumerate(changes):
        start = float(change["at"])
        end = float(changes[index + 1]["at"]) if index + 1 < len(changes) else length
        frequencies = change["frequencies"]
        if not 0 <= start < end <= length or not frequencies:
            raise ValueError("Score chordChanges must be ordered and within the timeline")
        if any(not math.isfinite(float(f)) or not 20 <= float(f) <= 4000 for f in frequencies):
            raise ValueError("Score frequencies must be between 20 and 4000 Hz")
        # A boundary chord makes every editorial transition audible; the final
        # chord rings out on its own to leave room for the closing title.
        for frequency in frequencies:
            add_note(samples, start, float(frequency), min(1.95, end - start), 0.055)
        if index + 1 == len(changes):
            continue
        beat_length = 60 / tempo
        for beat in range(math.ceil((end - start) / beat_length)):
            at = start + beat * beat_length
            frequency = float(frequencies[beat % len(frequencies)])
            add_note(samples, at, frequency * (2 if beat % 2 else 1),
                     min(1.6, end - at), 0.10 if beat % 4 == 0 else 0.065)


def attenuation(time, window):
    start, attack_end, hold_end, end = (
        window[key] for key in ("start", "attackEnd", "holdEnd", "end")
    )
    if time < start or time >= end:
        return 1
    if time < attack_end:
        return 1 - 0.5 * (time - start) / (attack_end - start)
    if time <= hold_end:
        return 0.5
    return 0.5 + 0.5 * (time - hold_end) / (end - hold_end)


def main():
    global OUT, PLAN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, default=PLAN)
    parser.add_argument("--output", type=Path, default=OUT, help="Directory for WAV files and mix evidence")
    args = parser.parse_args()
    PLAN, OUT = args.plan.resolve(), args.output.resolve()
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("Install FFmpeg (including ffprobe) before rendering demo audio.")
    OUT.mkdir(parents=True, exist_ok=True)
    plan = json.loads(PLAN.read_text())
    length = float(plan["duration"])
    count = round(RATE * length)
    actions = {
        action["id"]: shot["start"] + action["at"]
        for shot in plan["shots"] for action in shot["actions"]
        if action.get("soundRequired")
    }
    cues = [
        {
            "at": time - ONSET[name], "syncOffset": ONSET[name], "actionId": name,
            "file": relative_asset(f"{name}.wav"), "gain": 1,
            "role": "sfx", "kind": "success",
        }
        for name, time in actions.items()
    ]
    # Keep every other editorial field unchanged; the public plan owns the timeline.
    if (plan["audio"]["cues"] != cues
            or plan["audio"]["music"]["file"] != relative_asset("music.wav")):
        plan["audio"]["cues"] = cues
        plan["audio"]["music"]["file"] = relative_asset("music.wav")
        PLAN.write_text(json.dumps(plan, indent=2) + "\n")
    if plan["audio"]["music"]["gain"] != 0.5:
        raise ValueError("This score expects the plan's music gain to be 0.5")
    if plan["audio"]["ducking"].get("enabled") is not True:
        raise ValueError("This score requires music ducking around action tones")

    music = [0.0] * count
    # Original 96 BPM F-major / D-minor / B-flat / C arpeggios.
    chords = [
        (174.614, 220, 261.626), (146.832, 174.614, 220),
        (116.541, 146.832, 174.614), (130.813, 164.814, 195.998),
    ]
    if "score" in plan["audio"]:
        planned_score(music, length, plan["audio"]["score"])
    else:
        for beat in range(math.floor((length - 2) / 0.625)):
            chord = chords[(beat // 8) % len(chords)]
            add_note(music, beat * 0.625, chord[beat % 3] * (2 if beat % 2 else 1),
                     1.6, 0.10 if beat % 4 == 0 else 0.065)
        for frequency in chords[0]:
            add_note(music, length - 2, frequency, 1.95, 0.055)
    for index in range(count):
        time = index / RATE
        music[index] *= min(1, time / 0.3, (length - time) / 0.8)
    save("music.wav", music)
    for name, frequencies in FREQUENCIES.items():
        tone = [0.0] * round(RATE * 0.7)
        for index, frequency in enumerate(frequencies):
            add_note(tone, 0.02 + index * 0.13, frequency, 0.45, 0.18)
        save(f"{name}.wav", tone)

    windows = [
        {
            "actionId": name, "start": max(0, time - 0.08), "attackEnd": time,
            "holdEnd": min(length, time + 0.65), "end": min(length, time + 0.95),
            "gain": 0.5, "db": round(-20 * math.log10(0.5), 6),
        }
        for name, time in actions.items()
    ]
    music = load("music.wav")
    ducked = [
        value * 0.5 * min((attenuation(index / RATE, window) for window in windows), default=1)
        for index, value in enumerate(music)
    ]
    sfx = [0.0] * count
    for cue in cues:
        first = round(cue["at"] * RATE)
        tone = load(f"{cue['actionId']}.wav")
        for index, value in enumerate(tone):
            if first + index < count:
                sfx[first + index] += value * cue["gain"]
    save("music-ducked.wav", ducked)
    save("sfx-stem.wav", sfx)
    raw = [
        (left + right) * min(1, (length - index / RATE) / 0.8)
        for index, (left, right) in enumerate(zip(load("music-ducked.wav"), load("sfx-stem.wav")))
    ]
    save("mix-before-normalization.wav", raw)
    measured = loudness(OUT / "mix-before-normalization.wav")
    normalization = ":".join([
        "loudnorm=I=-16:TP=-1.5:LRA=8:linear=true",
        f"measured_I={measured['input_i']}", f"measured_TP={measured['input_tp']}",
        f"measured_LRA={measured['input_lra']}",
        f"measured_thresh={measured['input_thresh']}", f"offset={measured['target_offset']}",
        "print_format=json",
    ])
    normalized = ffmpeg(
        "-i", str(OUT / "mix-before-normalization.wav"), "-af", normalization,
        "-t", str(length), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le",
        str(OUT / "loudnorm.wav"),
    )
    norm_stats = json.loads(normalized.stderr[normalized.stderr.rfind("{"):normalized.stderr.rfind("}") + 1])
    # Dynamic loudnorm can miss its integrated target. Use measured remaining peak headroom for a final trim.
    normalized_measurement = loudness(OUT / "loudnorm.wav")
    trim_db = -16 - float(normalized_measurement["input_i"])
    if float(normalized_measurement["input_tp"]) + trim_db > -1.5:
        raise ValueError("The normalized track has insufficient peak headroom for the final loudness trim")
    ffmpeg(
        "-i", str(OUT / "loudnorm.wav"), "-af", f"volume={trim_db:.6f}dB",
        "-c:a", "pcm_s24le", str(OUT / "master.wav"),
    )
    verified = loudness(OUT / "master.wav")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
         str(OUT / "master.wav")], check=True, capture_output=True, text=True,
    )
    duration = float(json.loads(probe.stdout)["format"]["duration"])
    true_peak = float(verified["input_tp"])
    if abs(duration - length) > 1 / 48000 or true_peak > -1.45:
        raise ValueError(f"Master validation failed: duration={duration}, true peak={true_peak}")
    if abs(float(verified["input_i"]) + 16) > 0.3:
        raise ValueError(f"Unexpected integrated loudness: {verified['input_i']}")
    report = {
        "planSha256": digest(PLAN),
        "music": {**plan["audio"]["music"], "sha256": digest(OUT / "music.wav")},
        "cues": [{**cue, "sha256": digest(PLAN.parent / cue["file"])} for cue in cues],
        "master": asset("master.wav"), "sfxStem": asset("sfx-stem.wav"),
        "musicStem": asset("music-ducked.wav"),
        "ducking": {"method": "sample-envelope", "musicGain": 0.5, "windows": windows,
                    "overlap": "lowest-gain-wins"},
        "timing": [
            {"actionId": cue["actionId"], "fileStart": cue["at"],
             "audibleLandmark": cue["at"] + cue["syncOffset"],
             "calibratedSourceOnset": cue["syncOffset"], "actionTime": actions[cue["actionId"]],
             "errorFrames": round((cue["at"] + cue["syncOffset"] - actions[cue["actionId"]]) * plan["fps"], 6)}
            for cue in cues
        ],
        "normalization": {"requested": {"integratedLufs": -16, "truePeakDbtp": -1.5},
                          "measurement": measured, "output": norm_stats,
                          "beforeTrim": normalized_measurement, "finalTrimDb": trim_db,
                          "verification": verified},
        "validation": {"durationSeconds": duration, "truePeakDbtp": true_peak,
                       "clippingDetected": true_peak >= 0},
        "tailFade": {"startSeconds": length - 0.8, "durationSeconds": 0.8},
        "provenance": "Original additive synthesis in docs/demo/audio.py; no downloaded audio.",
        "listeningStatus": "Not auditioned by script; numerical validation does not assess musical quality.",
    }
    (OUT / "audio-mix.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"durationSeconds": duration, "integratedLufs": float(verified["input_i"]),
                      "truePeakDbtp": true_peak,
                      "report": Path(os.path.relpath(OUT / "audio-mix.json", ROOT)).as_posix()}))


if __name__ == "__main__":
    main()
