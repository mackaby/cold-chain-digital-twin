"""Bridge between the edge ML code (hackJunction2026) and this dashboard.

Replays one of the recorded CSVs through the saved LightGBM models, using the
feature code in hackJunction2026/demo_gui/inference.py unchanged, and POSTs the
result to the twin's /ingest route in the twin's own data contract.

The lab rig has one freezer (LT) case, one chilled (MT) case and a shared gas
cooler, so it drives two units of the store; the simulator keeps the rest.

With no recordings named it plays the baseline recording and switches to a fault
recording when one is injected from the dashboard, at the same time of day. The
requested scenario comes back in the response to the bridge's own POST, so the
bridge still accepts no inbound connections.

    edge/.venv/bin/python edge/ml_bridge.py                 # dashboard buttons choose the fault
    edge/.venv/bin/python edge/ml_bridge.py BaselineTestE Fault4_MTEvapFanFailure --minutes 120 --loop
"""

import argparse
import json
import os
import pickle
import re
import sys
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TWIN_ROOT = Path(__file__).resolve().parents[1]
HEARTBEAT_S = 2.0  # the twin hands a unit back to the simulator after 10 s of silence
UNCLASSIFIED = "unclassified_anomaly"


def slug(label):
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")


def f_to_c(value):
    """The recordings and the models use degrees Fahrenheit; the twin uses Celsius."""
    return None if value != value else round((float(value) - 32) * 5 / 9, 2)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("recordings", nargs="*",
                        help="CSV names in the ML repo's data/ folder, played in order. Omit to let the dashboard inject faults")
    parser.add_argument("--baseline", default="BaselineTestE", help="recording played while no fault is injected")
    parser.add_argument("--url", default=os.getenv("TWIN_URL", "http://localhost:4310"), help="dashboard base URL")
    parser.add_argument("--ml-repo", default=os.getenv("ML_REPO", str(TWIN_ROOT.parent / "hackJunction2026")))
    parser.add_argument("--lt-unit", default="FZ-01", help="store unit that shows the rig's freezer case")
    parser.add_argument("--mt-unit", default="CH-01", help="store unit that shows the rig's chilled case")
    parser.add_argument("--speed", type=float, default=60, help="recorded seconds per real second (60 = one minute per second)")
    # BaselineTestE crosses the saved threshold only in its first 2.5 hours (60 minutes in all).
    parser.add_argument("--start", type=int, default=180, help="first recorded minute to play (default 03:00)")
    parser.add_argument("--minutes", type=int, default=0, help="recorded minutes to play per recording (0 = all)")
    parser.add_argument("--confirm", type=int, default=10,
                        help="consecutive minutes over (or under) the threshold before a fault is raised (or cleared)")
    parser.add_argument("--loop", action="store_true", help="start again after the last recording")
    args = parser.parse_args()
    if args.speed <= 0 or args.confirm < 1:
        parser.error("--speed must be positive and --confirm at least 1")
    return args


def load_inference(ml_repo):
    """Import the ML repo's own inference module so features and models match it exactly."""
    demo = Path(ml_repo) / "demo_gui"
    if not (demo / "inference.py").is_file():
        sys.exit(f"Cannot find {demo / 'inference.py'}. Set --ml-repo or ML_REPO.")
    sys.path.insert(0, str(demo))
    sys.dont_write_bytecode = True  # leave no files behind in the ML repo
    try:
        import inference
    except ImportError as error:
        sys.exit(f"{error}. Install the bridge requirements: see edge/requirements.txt.")
    return inference


class Poster:
    def __init__(self, url):
        self.endpoint = url.rstrip("/") + "/ingest"
        self.token = os.getenv("INGEST_TOKEN", "")
        self.down = False
        self.scenario = None  # fault the dashboard asked for, from the last response

    def send(self, payload):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(self.endpoint, data=json.dumps(payload, allow_nan=False).encode(), headers=headers, method="POST")
        try:
            with urlopen(request, timeout=5) as response:
                self.scenario = json.load(response).get("scenario")
            if self.down:
                print("Dashboard reachable again.", flush=True)
            self.down = False
        except HTTPError as error:
            sys.exit(f"Dashboard rejected the data: HTTP {error.code} {error.read().decode(errors='replace')[:200]}")
        except (URLError, TimeoutError, OSError) as error:
            if not self.down:
                print(f"Dashboard not reachable at {self.endpoint} ({error}). Retrying.", flush=True)
            self.down = True


class Detector:
    """Turns per-minute model scores into the fault list the twin expects.

    The saved threshold flags short runs of minutes in normal operation (60 of
    1440 in BaselineTestE), so an alert is raised only after `confirm` consecutive
    minutes over it; ten minutes gives no alert on that file. The fault type is
    judged over such a sustained run and kept until the alert clears, which needs
    at least 80% of the last `confirm` minutes under the threshold.
    """

    def __init__(self, inf, args):
        self.labels = inf.fault_settings["labels"]
        self.threshold = inf.binary_settings["threshold"]
        self.confirm = args.confirm
        lt, mt = args.lt_unit, args.mt_unit
        # Fault classes in the order of the fault model's labels (class 0 is Baseline).
        self.units_for = dict(zip(self.labels[1:], ([lt], [lt], [lt], [mt], [lt, mt], [mt])))
        self.all_units = [lt, mt]
        self.reset()

    def reset(self):
        self.over = 0
        self.flags = []
        self.active = False
        self.recent = []
        self.held = {}
        self.shown = {}  # (unit, type) -> severity
        self.texted = set()

    def all_types(self):
        return [slug(label) for label in self.labels[1:]] + [UNCLASSIFIED]

    def step(self, score, class_scores, where):
        alert = score >= self.threshold
        self.over = self.over + 1 if alert else 0
        self.flags = (self.flags + [alert])[-self.confirm:]
        sustained = self.over >= self.confirm
        if sustained:
            self.active = True
        elif self.active and len(self.flags) == self.confirm and sum(self.flags) <= 0.2 * self.confirm:
            self.active = False
        self.recent = (self.recent + [class_scores])[-self.confirm:]
        mean = [sum(column) / len(self.recent) for column in zip(*self.recent)]
        best = max(range(len(mean)), key=mean.__getitem__)
        label, confidence = self.labels[best], mean[best]

        wanted = {}
        if self.active and self.held and not sustained:
            wanted = self.held  # keep showing what was detected until the alert clears
        elif self.active:
            detail = f"Anomaly score {score:.2f} against a threshold of {self.threshold:.3f}. {where}"
            if best == 0:
                for unit in self.all_units:
                    wanted[(unit, UNCLASSIFIED)] = ("warning", None, f"Anomaly detector alerting; the fault model sees no known fault. {detail}")
            else:
                severity = "critical" if confidence >= 0.5 else "warning"
                for unit in self.units_for[label]:
                    wanted[(unit, slug(label))] = (severity, confidence, f"Fault model: {label} ({confidence:.0%}). {detail}")

        self.held = wanted
        faults = []
        for (unit, kind), (severity, sure, message) in wanted.items():
            fault = {"unit_id": unit, "type": kind, "status": "active", "severity": severity,
                     "message": message, "model": "LightGBM"}
            if sure is not None:
                fault["confidence"] = round(sure, 3)
            if severity == "critical" and unit not in self.texted:
                fault["sms_sent"] = True  # one text per unit per incident, as the simulator does
                self.texted.add(unit)
            faults.append(fault)
        for unit, kind in self.shown.keys() - wanted.keys():
            faults.append({"unit_id": unit, "type": kind, "status": "cleared"})
        self.shown = {key: value[0] for key, value in wanted.items()}
        if not wanted:
            self.texted.clear()
        # The reading itself reports this minute's own fault-model output.
        now = max(range(len(class_scores)), key=class_scores.__getitem__)
        return faults, self.labels[now], class_scores[now]


def clear_all(poster, detector):
    faults = [{"unit_id": unit, "type": kind, "status": "cleared"}
              for unit in detector.all_units for kind in detector.all_types()]
    poster.send({"device_id": "edge-ml-replay", "ts": int(time.time() * 1000), "readings": [], "faults": faults})


class Recording:
    def __init__(self, stem, medians, binary_scores, fault_scores):
        self.stem, self.medians = stem, medians
        self.binary_scores, self.fault_scores = binary_scores, fault_scores

    def __len__(self):
        return len(self.medians)


class Library:
    """Scores recordings with the ML repo's own code and keeps the result on disk.

    Reading a recording takes several seconds, so scored minutes are cached under
    edge/.cache and reused until the CSV or a model file changes.
    """

    def __init__(self, inf, ml_repo):
        self.inf = inf
        self.data = Path(ml_repo) / "data"
        self.cache = TWIN_ROOT / "edge" / ".cache"
        self.loaded = {}
        self.lock = threading.Lock()
        models = sorted((Path(ml_repo) / "models").glob("*"))
        self.models_key = [(m.name, m.stat().st_mtime_ns, m.stat().st_size) for m in models]

    def path(self, name):
        return self.data / (name if name.endswith(".csv") else name + ".csv")

    def get(self, name):
        with self.lock:
            return self.loaded.get(self.path(name).stem)

    def ready(self):
        with self.lock:
            return sorted(self.loaded)

    def load(self, name):
        path = self.path(name)
        if not path.is_file():
            sys.exit(f"No recording at {path}")
        if recording := self.get(name):
            return recording
        stat = path.stat()
        key = [path.name, stat.st_mtime_ns, stat.st_size, self.models_key]
        cached = self.cache / f"{path.stem}.pkl"
        try:
            saved = pickle.loads(cached.read_bytes())
        except (OSError, pickle.UnpicklingError, EOFError):
            saved = None
        if not saved or saved["key"] != key:
            print(f"Scoring {path.name} ...", flush=True)
            inf = self.inf
            _, features = inf.make_windows(path)
            if features.empty:
                sys.exit(f"{path.name} has no complete one-minute windows.")
            # Features are selected by name, in each model's own order.
            saved = {
                "key": key,
                "medians": features[[f"{channel} median" for channel in inf.AIR]],
                "binary": inf.binary.predict(features[inf.binary_settings["feature_names"]], num_threads=2),
                "fault": inf.fault.predict(features[inf.fault_settings["feature_names"]], num_threads=2),
            }
            self.cache.mkdir(exist_ok=True)
            cached.write_bytes(pickle.dumps(saved))
        recording = Recording(path.stem, saved["medians"], saved["binary"], saved["fault"])
        with self.lock:
            self.loaded[path.stem] = recording
        return recording


def post_minute(recording, position, inf, args, poster, detector, extra=None):
    """Send one recorded minute, then wait until the next one is due."""
    row = recording.medians.iloc[position]
    at = recording.medians.index[position]
    score = float(recording.binary_scores[position])
    where = f"Replay of {recording.stem} at {at:%Y-%m-%d %H:%M}."
    was_active = detector.active
    faults, label, confidence = detector.step(score, recording.fault_scores[position].tolist(), where)
    lt_ret, lt_sup, mt_ret, mt_sup, gc_in, gc_out = inf.AIR
    gas_in, gas_out = f_to_c(row[f"{gc_in} median"]), f_to_c(row[f"{gc_out} median"])

    readings = []
    for unit, supply_name, return_name in ((args.lt_unit, lt_sup, lt_ret), (args.mt_unit, mt_sup, mt_ret)):
        supply, back = f_to_c(row[f"{supply_name} median"]), f_to_c(row[f"{return_name} median"])
        if supply is None or back is None:
            continue
        readings.append({
            "unit_id": unit,
            # Supply air is the case temperature shown. Return air is only reported:
            # in BaselineTestE it reads about 34 C all day against about 7 C elsewhere.
            "temp_c": supply,
            "ml": {
                "anomaly_score": round(score, 4), "threshold": detector.threshold,
                "fault": label, "fault_confidence": round(confidence, 3),
                "supply_air_c": supply, "return_air_c": back,
                "gas_cooler_in_c": gas_in, "gas_cooler_out_c": gas_out,
                "recording": recording.stem, "recorded_at": at.isoformat(timespec="minutes"),
            },
        })

    if detector.active != was_active:
        state = f"alert confirmed: {label} ({confidence:.0%}), score {score:.2f}" if detector.active else "alert cleared"
        print(f"  {at:%H:%M} {state}", flush=True)

    deadline = time.monotonic() + 60 / args.speed
    while True:
        payload = {"device_id": "edge-ml-replay", "ts": int(time.time() * 1000), "readings": readings, "faults": faults}
        poster.send({**payload, **(extra() if extra else {})})
        faults = []  # state changes are sent once; repeats only keep the units alive
        wait = deadline - time.monotonic()
        if wait <= 0:
            break
        time.sleep(min(wait, HEARTBEAT_S))
        if deadline - time.monotonic() <= 0.01:
            break


def play_list(args, inf, library, poster, detector):
    while True:
        for name in args.recordings:
            recording = library.load(name)
            stop = len(recording) if args.minutes <= 0 else min(len(recording), args.start + args.minutes)
            print(f"Replaying minutes {args.start}-{stop - 1} of {recording.stem}", flush=True)
            for position in range(args.start, stop):
                post_minute(recording, position, inf, args, poster, detector)
        if not args.loop:
            break


def play_injected(args, inf, library, poster, detector):
    """Baseline until the dashboard injects a fault, then that fault's recording."""
    labels = inf.fault_settings["labels"]
    scenarios = []
    for path in sorted(library.data.glob("Fault*.csv")):
        match = re.match(r"Fault(\d+)_", path.stem)
        if match and 0 < int(match[1]) < len(labels):
            label = labels[int(match[1])]
            scenarios.append({"id": path.stem, "label": label, "units": detector.units_for[label]})
    baseline = current = library.load(args.baseline)
    # Fault recordings are scored in the background; a fault starts once its recording is ready.
    threading.Thread(target=lambda: [library.load(s["id"]) for s in scenarios], daemon=True).start()

    def announce():
        return {"ml_bridge": {"scenarios": scenarios, "ready": library.ready(),
                              "playing": "" if current is baseline else current.stem}}

    print(f"Playing {baseline.stem}. Inject faults from the dashboard.", flush=True)
    position = args.start
    while True:
        wanted = poster.scenario if any(s["id"] == poster.scenario for s in scenarios) else None
        target = (library.get(wanted) or current) if wanted else baseline
        if target is not current:
            print(f"Switching to {target.stem}", flush=True)
            current = target
        # Same minute of the day in every recording, so daily cycles such as defrost stay aligned.
        post_minute(current, position % len(current), inf, args, poster, detector, announce)
        position += 1


def main():
    args = parse_args()
    inf = load_inference(args.ml_repo)
    poster = Poster(args.url)
    detector = Detector(inf, args)
    library = Library(inf, args.ml_repo)
    print(f"Feeding {args.lt_unit} (freezer case) and {args.mt_unit} (chilled case) at {poster.endpoint}, "
          f"one recorded minute every {60 / args.speed:g} s", flush=True)
    clear_all(poster, detector)
    try:
        (play_list if args.recordings else play_injected)(args, inf, library, poster, detector)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        clear_all(poster, detector)


if __name__ == "__main__":
    main()
