from flask import Flask, render_template, jsonify, request, send_from_directory
from pathlib import Path
import json
import time
import fitz  # PyMuPDF
import base64
import os
import urllib.request
import urllib.error
from werkzeug.utils import secure_filename

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
GT_FILE = ROOT / "ground_truth.json"
RESULTS_FILE = ROOT / "results.json"
SESSION_FILE = ROOT / "session_added.json"

app = Flask(__name__, static_folder=str(ROOT / "static"), template_folder=str(ROOT / "templates"))

def load_ground_truth():
    with open(GT_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def load_session_added():
    if SESSION_FILE.exists():
        with open(SESSION_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def save_session_added(data):
    with open(SESSION_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

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

@app.route('/api/questions')
def questions():
    data = load_ground_truth()
    return jsonify(data)

@app.route('/api/add-question', methods=['POST'])
def add_question():
    try:
        new_q = request.get_json()
        session_data = load_session_added()
        session_data.append(new_q)
        save_session_added(session_data)
        
        gt_len = len(load_ground_truth())
        global_index = gt_len + len(session_data) - 1
        
        return jsonify({"success": True, "global_index": global_index, "question": new_q})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/export-questions', methods=['POST'])
def export_questions():
    try:
        session_data = load_session_added()
        if not session_data:
            return jsonify({"success": True, "count": 0})
            
        gt = load_ground_truth()
        gt.extend(session_data)
        
        with open(GT_FILE, "w", encoding="utf-8") as f:
            json.dump(gt, f, ensure_ascii=False, indent=2)
            
        # Clear session file
        save_session_added([])
        
        return jsonify({"success": True, "count": len(session_data)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
            target_name = Path(filename).name
            found_path = None
            for root, dirs, files in os.walk(DATA_DIR):
                if target_name in files:
                    found_path = Path(root) / target_name
                    break
            if found_path:
                filepath = found_path
            else:
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

@app.route('/api/generate-question', methods=['POST'])
def generate_question():
    try:
        payload = request.get_json()
        filename = payload.get('filename')
        pages_to_render = payload.get('pages')
        
        # Fallback for older single page requests
        if not pages_to_render:
            page_num = payload.get('page_num')
            if page_num is not None:
                pages_to_render = [page_num]
            else:
                return jsonify({"error": "No pages provided"}), 400
                
        filepath = DATA_DIR / filename
        if not filepath.exists():
            target_name = Path(filename).name
            found_path = None
            for root, dirs, files in os.walk(DATA_DIR):
                if target_name in files:
                    found_path = Path(root) / target_name
                    break
            if found_path:
                filepath = found_path
            else:
                return jsonify({"error": "File not found"}), 404
            
        pdf_document = fitz.open(str(filepath))
        
        if len(pages_to_render) > 1:
            prompt = """You are an expert at creating reading comprehension questions based strictly on provided documents. I am providing you with multiple document pages. 

Your task is to create a single, clear, and naturally phrased question that requires combining information from ALL of the provided pages to be answered correctly. 

Strict Style & Formatting Constraints:
1. Natural & Human-Like: The question must sound like a realistic, practical inquiry made by a professional or researcher trying to solve a problem or understand a workflow. Avoid rigid exam-style phrasing like "List all...", "Define X and Y respectively...", or "Find and write...".
2. Single Cohesive Question: Do not string multiple disconnected sub-questions together using "and". Instead, find a natural narrative thread, dependency, or scenario that organically connects the information across the pages (e.g., a workflow where an entity on Page 1 must perform an action defined on Page 2).
3. Grounded in Fact: Every detail required to answer the question must be explicitly stated in the text. Do not extrapolate.
4. Fallback: If the pages do not share an organic, logical connection that can form a natural question, return: NO_VALID_COMBINATION

Return only the question string (or the fallback text), without any quotes or markdown formatting."""
        else:
            prompt = "You are an expert at creating highly detailed, professional reading comprehension questions. Please read this document page and create a single clear, sophisticated question that a user would ask an LLM, where answering it accurately strictly requires referencing the specific regulations, frameworks, definitions, or procedural conditions found on this page. The question must be written in a natural interrogative style ending with suffixes such as '~하는가?', '~사항은?', '~되는가?', or '~절차는?'. Also do not include phrases that explicitly reference the document itself, such as '제시된 자료에 따르면' or '본문에 의하면'. Return only the question string, without any quotes or markdown formatting."
            
        parts = [{"text": prompt}]
        
        for p_num in pages_to_render:
            if p_num < 1 or p_num > pdf_document.page_count:
                pdf_document.close()
                return jsonify({"error": f"Page {p_num} out of range"}), 400
                
            page = pdf_document[p_num - 1]
            mat = fitz.Matrix(2, 2)  # slightly higher res for OCR
            pix = page.get_pixmap(matrix=mat, alpha=False)
            png_data = pix.tobytes("png")
            base64_data = base64.b64encode(png_data).decode('utf-8')
            parts.append({
                "inline_data": {
                    "mime_type": "image/png",
                    "data": base64_data
                }
            })
            
        pdf_document.close()
        
        API_KEY = "AQ.Ab8RN6JlkOp1VnOcmg1VverFWWyXWncJnSSEd1CBs4bfV9Ar3Q"
        # Try requested model first, then fallback
        models_to_try = [
            "gemini-3.5-flash", 
            "gemini-3.1-flash-lite", 
            "gemini-2.5-flash", 
            "gemini-2.0-flash-lite-preview-02-05", 
            "gemini-1.5-flash"
        ]
        
        data = {
            "contents": [{
                "parts": parts
            }]
        }
        
        headers = {"Content-Type": "application/json"}
        last_error = None
        
        for model in models_to_try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}"
            req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), headers=headers, method='POST')
            try:
                with urllib.request.urlopen(req) as response:
                    result = json.loads(response.read().decode('utf-8'))
                    text_response = result['candidates'][0]['content']['parts'][0]['text'].strip()
                    return jsonify({"success": True, "question": text_response})
            except urllib.error.HTTPError as e:
                # If model is not found (404), overloaded (503), or rate limited (429), fallback to the next model
                if e.code in [404, 503, 429]:
                    last_error = f"Model {model} failed with HTTP {e.code}."
                    time.sleep(0.5)  # Brief pause before retrying
                    continue
                else:
                    error_body = e.read().decode('utf-8')
                    return jsonify({"error": f"API HTTPError {e.code} on {model}: {error_body}"}), 500
            except Exception as e:
                return jsonify({"error": f"API Request failed on {model}: {str(e)}"}), 500
                
        return jsonify({"error": f"Failed to generate. Last error: {last_error}"}), 500
        
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
    """List all PDF files in the data folder, grouped by subdirectories."""
    try:
        result = {"folders": {}}
        for root, dirs, files in os.walk(DATA_DIR):
            rel_dir = os.path.relpath(root, DATA_DIR)
            rel_dir = rel_dir.replace('\\', '/')
            key = '/' if rel_dir == '.' else rel_dir
            
            pdfs = sorted([f for f in files if f.lower().endswith('.pdf')])
            if pdfs:
                result["folders"][key] = pdfs
        return jsonify(result)
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
