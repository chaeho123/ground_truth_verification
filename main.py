from flask import Flask, render_template, jsonify, request, send_from_directory
from pathlib import Path
import json
import time
import fitz  # PyMuPDF
import base64
import os
from werkzeug.utils import secure_filename

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


@app.route('/api/pdf-page/<path:filename>/<int:page_num>')
def render_pdf_page(filename, page_num):
    """Render a single PDF page as a PNG image and return as base64."""
    try:
        filepath = DATA_DIR / filename
        if not filepath.exists():
            return jsonify({"error": "File not found"}), 404
        
        # Open PDF with PyMuPDF
        pdf_document = fitz.open(str(filepath))
        
        # Get page (page_num is 1-indexed from frontend)
        if page_num < 1 or page_num > pdf_document.page_count:
            return jsonify({"error": "Page out of range"}), 400
        
        page = pdf_document[page_num - 1]
        
        # Render page to pixmap at normal zoom (1x)
        mat = fitz.Matrix(1, 1)  # 1x zoom for full-page view
        pix = page.get_pixmap(matrix=mat, alpha=False)
        
        # Convert pixmap directly to PNG bytes using PyMuPDF
        png_data = pix.tobytes("png")
        
        # Return as base64-encoded PNG
        base64_data = base64.b64encode(png_data).decode('utf-8')
        
        pdf_document.close()
        
        return jsonify({
            "success": True,
            "image": f"data:image/png;base64,{base64_data}"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/reset', methods=["POST"]) 
def reset_results():
    if RESULTS_FILE.exists():
        try:
            RESULTS_FILE.unlink()
        except Exception:
            pass
    return jsonify({"ok": True})

@app.route('/api/delete-denied', methods=['POST'])
def delete_denied():
    try:
        results = load_results()
        gt = load_ground_truth()
        
        # Identify indices to delete
        denied_indices = set()
        for k, v in results.items():
            if v.get("status") == "denied":
                denied_indices.add(int(k))
        
        if not denied_indices:
            return jsonify({"success": True, "deleted_count": 0})
            
        # Rebuild ground truth
        new_gt = []
        old_to_new_mapping = {}
        new_index = 0
        
        for old_index, item in enumerate(gt):
            if old_index not in denied_indices:
                new_gt.append(item)
                old_to_new_mapping[old_index] = new_index
                new_index += 1
                
        # Rebuild results
        new_results = {}
        for old_k_str, v in results.items():
            old_k = int(old_k_str)
            if old_k in old_to_new_mapping:
                new_k_str = str(old_to_new_mapping[old_k])
                new_results[new_k_str] = v
                
        # Save both
        with open(GT_FILE, "w", encoding="utf-8") as f:
            json.dump(new_gt, f, ensure_ascii=False, indent=2)
            
        save_results(new_results)
        
        return jsonify({"success": True, "deleted_count": len(denied_indices)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/pdf-list')
def list_pdfs():
    """List all PDF files in the data folder."""
    try:
        files = [f for f in os.listdir(DATA_DIR) if f.lower().endswith('.pdf')]
        return jsonify({"files": sorted(files)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/upload-pdf', methods=['POST'])
def upload_pdf():
    """Upload PDF files to the data folder."""
    try:
        if 'files' not in request.files:
            return jsonify({"error": "No files provided"}), 400
        
        files = request.files.getlist('files')
        uploaded = []
        
        for file in files:
            if file and file.filename.lower().endswith('.pdf'):
                filename = secure_filename(file.filename)
                filepath = DATA_DIR / filename
                file.save(str(filepath))
                uploaded.append(filename)
        
        if not uploaded:
            return jsonify({"error": "No valid PDF files uploaded"}), 400
        
        return jsonify({"success": True, "uploaded": uploaded})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7860, debug=True)
