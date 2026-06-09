from flask import Flask, render_template, jsonify, request, send_from_directory
from pathlib import Path
import json
import time

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
GT_FILE = ROOT / "ground_truth.json"
RESULTS_FILE = ROOT / "results.json"

app = Flask(__name__, static_folder=str(ROOT / "static"), template_folder=str(ROOT / "templates"))


def load_ground_truth():
    with open(GT_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_results():
    if RESULTS_FILE.exists():
        with open(RESULTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_results(results):
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/questions")
def questions():
    data = load_ground_truth()
    return jsonify(data)


@app.route("/api/results")
def results():
    return jsonify(load_results())


@app.route("/api/submit", methods=["POST"])
def submit():
    payload = request.get_json()
    idx = str(payload.get("index"))
    status = payload.get("status")
    note = payload.get("note", "")
    results = load_results()
    results[idx] = {"status": status, "note": note, "ts": time.time()}
    save_results(results)
    return jsonify({"ok": True})


@app.route('/data/<path:filename>')
def data_files(filename):
    return send_from_directory(DATA_DIR, filename)


@app.route('/api/reset', methods=["POST"]) 
def reset_results():
    if RESULTS_FILE.exists():
        try:
            RESULTS_FILE.unlink()
        except Exception:
            pass
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7860, debug=True)
