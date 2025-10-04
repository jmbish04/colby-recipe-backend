#!/usr/bin/env python3
"""
Extract text from a PDF; if extraction fails (empty/low-content), run OCR.

Usage:
  Single file:
    scripts/extract_text_with_ocr.py input.pdf output.txt [--lang LANG] [--keep-ocr-pdf]

  Batch (directory or glob):
    scripts/extract_text_with_ocr.py --input-dir DIR [--output-dir DIR] [--glob "*.pdf"] [--lang LANG] [--keep-ocr-pdf]
    scripts/extract_text_with_ocr.py --glob "path/to/pdfs/*.pdf" [--output-dir DIR] [--lang LANG] [--keep-ocr-pdf]

Behavior:
- Tries `pdftotext` first to get raw text.
- If text length is too small (default threshold 200 chars), considers it failed.
- Attempts OCR using, in order of preference:
  1) ocrmypdf (if available) with Tesseract backend
  2) tesseract CLI directly to produce an OCR’ed PDF
- Re-extracts text after OCR and writes to output.txt
- If `--keep-ocr-pdf` is provided, also keeps the OCR’d PDF alongside output as `<basename>.ocr.pdf`.

Requirements:
- `pdftotext` (poppler-utils) on PATH
- Either `ocrmypdf` or `tesseract` on PATH

Exit codes:
  0 success
  1 argument/usage error
  2 missing tools
  3 processing error
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile


def which(cmd: str) -> str | None:
    return shutil.which(cmd)


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def ensure_tool(name: str) -> bool:
    return which(name) is not None


def extract_with_pdftotext(pdf_path: str, out_txt: str) -> bool:
    proc = run(["pdftotext", pdf_path, out_txt])
    return proc.returncode == 0 and os.path.exists(out_txt)


def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception:
        return ""


def ocr_with_ocrmypdf(src_pdf: str, dst_pdf: str, lang: str | None) -> bool:
    cmd = ["ocrmypdf", "--force-ocr", "--optimize", "3", "--output-type", "pdf"]
    if lang:
        cmd += ["-l", lang]
    cmd += [src_pdf, dst_pdf]
    proc = run(cmd)
    return proc.returncode == 0 and os.path.exists(dst_pdf)


def ocr_with_tesseract(src_pdf: str, dst_pdf: str, lang: str | None) -> bool:
    # tesseract input.pdf outputbase -l eng pdf
    base, _ = os.path.splitext(dst_pdf)
    cmd = ["tesseract", src_pdf, base]
    if lang:
        cmd += ["-l", lang]
    cmd += ["pdf"]
    proc = run(cmd)
    return proc.returncode == 0 and os.path.exists(dst_pdf)


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract text with OCR fallback")
    # Mutually exclusive single-file vs batch
    group = parser.add_mutually_exclusive_group()
    group.add_argument("input_pdf", nargs="?", help="Path to input PDF")
    parser.add_argument("output_txt", nargs="?", help="Path to output text file (single mode)")
    group.add_argument("--input-dir", help="Directory containing PDFs to process")
    parser.add_argument("--output-dir", help="Directory to write .txt (defaults to input-dir or current dir)")
    parser.add_argument("--glob", help="Glob pattern of PDFs to process (e.g., 'data/*.pdf')")
    parser.add_argument("--lang", default=None, help="OCR language code for Tesseract (e.g., 'eng')")
    parser.add_argument("--threshold", type=int, default=200, help="Min chars to consider extraction successful")
    parser.add_argument("--keep-ocr-pdf", action="store_true", help="Keep OCR’d PDF alongside output")
    args = parser.parse_args()

    input_pdf = args.input_pdf
    output_txt = args.output_txt
    lang = args.lang
    threshold = args.threshold
    keep_ocr_pdf = args.keep_ocr_pdf

    if not ensure_tool("pdftotext"):
        print("Missing required tool: pdftotext (poppler-utils)", file=sys.stderr)
        return 2

    def process_one(pdf_path: str, out_txt_path: str) -> int:
        if not os.path.isfile(pdf_path):
            print(f"Input PDF not found: {pdf_path}", file=sys.stderr)
            return 1

        # First attempt: direct text extraction
        os.makedirs(os.path.dirname(out_txt_path) or ".", exist_ok=True)
        if not extract_with_pdftotext(pdf_path, out_txt_path):
            print(f"[{os.path.basename(pdf_path)}] pdftotext failed; proceeding to OCR fallback", file=sys.stderr)
            first_text_local = ""
        else:
            first_text_local = read_text(out_txt_path)

        if len(first_text_local.strip()) >= threshold:
            return 0

        # Need OCR fallback
        have_ocrmypdf = ensure_tool("ocrmypdf")
        have_tesseract = ensure_tool("tesseract")

        if not (have_ocrmypdf or have_tesseract):
            print("Missing OCR tools: need either 'ocrmypdf' or 'tesseract' on PATH.", file=sys.stderr)
            return 2

        base_out_local = os.path.splitext(out_txt_path)[0]
        ocr_pdf_local = f"{base_out_local}.ocr.pdf"

        tmp_dir_local = tempfile.mkdtemp(prefix="ocr_")
        tmp_ocr_pdf_local = os.path.join(tmp_dir_local, "ocr.pdf")
        target_pdf_path_local = ocr_pdf_local if keep_ocr_pdf else tmp_ocr_pdf_local

        ocr_ok_local = False
        if have_ocrmypdf:
            ocr_ok_local = ocr_with_ocrmypdf(pdf_path, target_pdf_path_local, lang)
        if not ocr_ok_local and have_tesseract:
            ocr_ok_local = ocr_with_tesseract(pdf_path, target_pdf_path_local, lang)

        if not ocr_ok_local:
            print(f"[{os.path.basename(pdf_path)}] OCR step failed with available tools.", file=sys.stderr)
            return 3

        if not extract_with_pdftotext(target_pdf_path_local, out_txt_path):
            print(f"[{os.path.basename(pdf_path)}] Failed to extract text after OCR.", file=sys.stderr)
            return 3

        if keep_ocr_pdf and target_pdf_path_local != ocr_pdf_local:
            try:
                shutil.move(target_pdf_path_local, ocr_pdf_local)
            except Exception as e:
                print(f"[{os.path.basename(pdf_path)}] Warning: failed to keep OCR PDF: {e}", file=sys.stderr)

        final_text_local = read_text(out_txt_path)
        if len(final_text_local.strip()) < threshold:
            print(f"[{os.path.basename(pdf_path)}] Warning: OCR completed but text is still small.", file=sys.stderr)
        return 0

    # Single-file mode
    if input_pdf and output_txt:
        return process_one(input_pdf, output_txt)

    # Batch mode
    pdfs: list[str] = []
    if args.input_dir:
        for name in sorted(os.listdir(args.input_dir)):
            if name.lower().endswith('.pdf'):
                pdfs.append(os.path.join(args.input_dir, name))
    if args.glob:
        import glob as _glob
        pdfs.extend(_glob.glob(args.glob))

    if not pdfs:
        print("No PDFs found to process. Provide input_pdf/output_txt or use --input-dir/--glob.", file=sys.stderr)
        return 1

    # Deduplicate while preserving order
    seen = set()
    ordered = []
    for p in pdfs:
        if p not in seen:
            seen.add(p)
            ordered.append(p)

    out_dir = args.output_dir or args.input_dir or os.getcwd()
    os.makedirs(out_dir, exist_ok=True)

    failures = 0
    for pdf in ordered:
        base = os.path.splitext(os.path.basename(pdf))[0]
        out_txt_path = os.path.join(out_dir, f"{base}.txt")
        code = process_one(pdf, out_txt_path)
        if code != 0:
            failures += 1

    if failures:
        print(f"Completed with {failures} failures out of {len(ordered)} PDFs.", file=sys.stderr)
        return 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
