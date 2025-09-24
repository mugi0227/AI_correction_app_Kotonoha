import asyncio
import traceback
import re
import fitz
import os
from pathlib import Path
from typing import List, Optional, Dict, Tuple, Set
import tempfile
import shutil
from google.cloud import storage

import unicodedata
from difflib import SequenceMatcher

# 他の自作モジュールから関数や変数をインポート
from crud import answers_db
from gemini_utils import (
    classify_image_quality,
    transcribe_images_to_markdown,
    extract_answer_details,
    generate_review_comments
)

# --- GCS設定 ---
GCS_BUCKET_NAME = os.getenv("GCS_BUCKET_NAME")
storage_client = None
bucket = None
if GCS_BUCKET_NAME:
    storage_client = storage.Client()
    bucket = storage_client.bucket(GCS_BUCKET_NAME)

PROBLEMS_PREFIX = "problems"

SPECIAL_EXAM_TYPE = "学力テスト・数学ⅠA"
SPECIAL_TRANSCRIPT_MARKER = "【実力テスト】数学ⅠA実力テスト"

LABEL_SYNONYM_REPLACEMENTS = {
    "学力テスト": "実力テスト",
    "実力テスト": "実力テスト",
}

CATEGORY_KEYWORDS = [
    "実力テスト",
    "学力テスト",
    "模擬試験",
    "模試",
    "定期テスト",
    "中間テスト",
    "期末テスト",
    "共通テスト",
    "入試",
]

SUBJECT_KEYWORDS = [
    "数学",
    "英語",
    "国語",
    "理科",
    "社会",
    "物理",
    "化学",
    "生物",
    "地理",
    "日本史",
    "世界史",
    "現代文",
    "古文",
    "漢文",
    "倫理",
    "政治",
    "経済",
]

CATEGORY_PATTERNS = [
    re.compile(r"カテ(?:ゴリ)?ー?[：:]\s*(?P<value>.+)")
]

EXAM_PATTERNS = [
    re.compile(r"試験(?:種|名)?[：:]\s*(?P<value>.+)"),
    re.compile(r"科目[：:]\s*(?P<value>.+)"),
]

async def delete_gcs_prefix(prefix: str) -> None:
    if not bucket:
        return

    def _delete():
        blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix)
        for blob in blobs:
            try:
                blob.delete()
            except Exception:
                continue

    await asyncio.to_thread(_delete)

def _normalize_subject_hint(text: str) -> Optional[str]:
    if not text:
        return None
    t = unicodedata.normalize('NFKC', text)
    t = t.replace('Ⅰ', '1').replace('Ⅱ', '2').replace('III', '3').replace('IV', '4')
    t = t.replace('I', '1').replace('II', '2').replace('III', '3').replace('IV', '4')
    m = re.search(r"数学\s*([12])", t)
    if m:
        return f"数学{m.group(1)}"
    return None

def _normalize_label(text: str) -> str:
    if not text:
        return ''
    norm = unicodedata.normalize('NFKC', text)
    norm = re.sub(r'[\s　\-_/・【】\[\]（）()\n]+', '', norm)
    norm = norm.replace('Ⅰ', '1').replace('Ⅱ', '2').replace('Ⅲ', '3').replace('Ⅳ', '4')
    norm = norm.replace('I', '1').replace('II', '2').replace('III', '3').replace('IV', '4')
    norm = norm.replace('l', '1').replace('L', '1').replace('|', '1').replace('｜', '1')
    for src, dest in LABEL_SYNONYM_REPLACEMENTS.items():
        norm = norm.replace(src, dest)
    return norm.lower()

def _looks_like_subject_label(text: str) -> bool:
    if not text:
        return False
    return any(keyword in text for keyword in SUBJECT_KEYWORDS)

def _extract_category_exam_from_line(line: str) -> Optional[Tuple[str, str]]:
    if not line:
        return None
    for keyword in CATEGORY_KEYWORDS:
        if keyword not in line:
            continue
        before, _, after = line.partition(keyword)
        candidate = before.strip(' ・:：-‐–—')
        if not candidate:
            candidate = after.strip(' ・:：-‐–—')
        if candidate and _looks_like_subject_label(candidate):
            return keyword, candidate
    return None

def _extract_exam_hints(details: Dict[str, object], markdown: str) -> Dict[str, object]:
    category = (details or {}).get('category') or (details or {}).get('exam_category')
    exam_label = (details or {}).get('exam_type') or (details or {}).get('exam_label')
    tokens: Set[str] = set()

    def _add_token(token: Optional[str]):
        if token:
            tokens.add(token.strip())

    _add_token(category)
    _add_token(exam_label)
    subject = (details or {}).get('subject')
    _add_token(subject)
    title = (details or {}).get('title')
    _add_token(title)

    lines = [line.strip() for line in (markdown or '').splitlines() if line.strip()]
    for line in lines[:20]:
        if not category:
            for pattern in CATEGORY_PATTERNS:
                m = pattern.search(line)
                if m:
                    candidate = m.group('value').strip()
                    if candidate:
                        category = candidate
                        _add_token(candidate)
                        break
        if not exam_label:
            for pattern in EXAM_PATTERNS:
                m = pattern.search(line)
                if m:
                    candidate = m.group('value').strip()
                    if candidate:
                        exam_label = candidate
                        _add_token(candidate)
                        break
        if not category or not exam_label:
            combo = _extract_category_exam_from_line(line)
            if combo:
                cat_candidate, exam_candidate = combo
                if cat_candidate and not category:
                    category = cat_candidate
                    _add_token(cat_candidate)
                if exam_candidate and not exam_label:
                    exam_label = exam_candidate
                    _add_token(exam_candidate)

    category_norm = _normalize_label(category) if category else ''
    exam_norm = _normalize_label(exam_label) if exam_label else ''
    combined_norm = ''
    if category or exam_label:
        combined_norm = _normalize_label(f"{category or ''}{exam_label or ''}")
    tokens_norm = {_normalize_label(token) for token in tokens if token}
    tokens_norm.discard('')
    transcript_norm = _normalize_label((markdown or '')[:800])

    return {
        'category': category,
        'exam_label': exam_label,
        'category_norm': category_norm,
        'exam_norm': exam_norm,
        'combined_norm': combined_norm,
        'tokens_norm': tokens_norm,
        'transcript_norm': transcript_norm,
    }

def _tokenize_exam_type_tokens(exam_type: str) -> Set[str]:
    if not exam_type:
        return set()
    raw_tokens = re.split(r'[・/／,，、\s　\-]+', exam_type)
    tokens = {_normalize_label(token) for token in raw_tokens if token and token.strip()}
    tokens.discard('')
    return tokens

def _score_exam_entry(entry: Dict[str, object], hints: Dict[str, object]) -> float:
    exam_type = entry.get('exam_type') or ''
    exam_type_norm = _normalize_label(exam_type)
    entry_tokens = _tokenize_exam_type_tokens(exam_type)
    score = 0.0

    if hints.get('university') and entry.get('university') == hints['university']:
        score += 12

    year_short = hints.get('year_short')
    if year_short and (f"{year_short}年" in exam_type or year_short in exam_type):
        score += 5

    prefer_faculty = hints.get('prefer_faculty')
    if prefer_faculty and prefer_faculty in exam_type:
        score += 4

    subject_norm = hints.get('subject_norm')
    if subject_norm and subject_norm in exam_type_norm:
        score += 5

    subject_hint_norm = hints.get('subject_hint_norm')
    if subject_hint_norm and subject_hint_norm in exam_type_norm:
        score += 3

    category_norm = hints.get('category_norm')
    if category_norm and category_norm in exam_type_norm:
        score += 6

    exam_norm = hints.get('exam_norm')
    if exam_norm and exam_norm in exam_type_norm:
        score += 6

    combined_norm = hints.get('combined_norm')
    if combined_norm and combined_norm in exam_type_norm:
        score += 8

    hint_tokens: Set[str] = hints.get('hint_tokens', set())
    if hint_tokens:
        matches = len(entry_tokens & hint_tokens)
        score += matches * 5
        if entry_tokens and matches == len(entry_tokens) and matches > 0:
            score += 5

    for text_norm in hints.get('hint_text_norms', []):
        ratio = SequenceMatcher(None, exam_type_norm, text_norm).ratio()
        if ratio > 0.45:
            score += ratio * 8

    transcript_norm = hints.get('transcript_norm')
    if transcript_norm:
        ratio_t = SequenceMatcher(None, exam_type_norm, transcript_norm).ratio()
        if ratio_t > 0.4:
            score += ratio_t * 5

    return score

def _entry_has_available_assets(entry: Dict[str, object]) -> bool:
    if bucket and entry.get('gcs_prefix'):
        return True
    local_path = entry.get('local_path')
    if isinstance(local_path, Path):
        try:
            return local_path.exists()
        except Exception:
            return False
    return False

def _select_best_exam_entry(catalog: List[Dict[str, object]], hints: Dict[str, object]) -> Optional[Dict[str, object]]:
    scored: List[Tuple[float, Dict[str, object]]] = []
    for entry in catalog:
        if not entry.get('exam_type'):
            continue
        score = _score_exam_entry(entry, hints)
        if score <= 0:
            continue
        scored.append((score, entry))

    if not scored:
        return None

    scored.sort(key=lambda x: x[0], reverse=True)
    for _, entry in scored:
        if _entry_has_available_assets(entry):
            return entry

    return scored[0][1]

async def _list_all_exam_types(problem_dir: Optional[Path]) -> List[Dict[str, object]]:
    results: List[Dict[str, object]] = []

    if problem_dir and await asyncio.to_thread(problem_dir.exists):
        def _collect_local():
            out = []
            for uni_path in problem_dir.iterdir():
                if not uni_path.is_dir():
                    continue
                for et_path in uni_path.iterdir():
                    if not et_path.is_dir():
                        continue
                    out.append({"university": uni_path.name, "exam_type": et_path.name, "local_path": et_path, "gcs_prefix": None})
            return out
        local_entries = await asyncio.to_thread(_collect_local)
        results.extend(local_entries)

    if bucket:
        def _collect_gcs():
            mapping = {}
            blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=f"{PROBLEMS_PREFIX}/")
            for blob in blobs:
                name = blob.name
                if not name.startswith(f"{PROBLEMS_PREFIX}/"):
                    continue
                rel = name[len(f"{PROBLEMS_PREFIX}/"):]
                if not rel:
                    continue
                parts = rel.split('/')
                if len(parts) < 2:
                    continue
                uni, exam = parts[0], parts[1]
                mapping[(uni, exam)] = True
            return list(mapping.keys())
        gcs_entries = await asyncio.to_thread(_collect_gcs)
        for uni, exam in gcs_entries:
            prefix = f"{PROBLEMS_PREFIX}/{uni}/{exam}/"
            existing = next((r for r in results if r['university'] == uni and r['exam_type'] == exam), None)
            if existing:
                existing['gcs_prefix'] = prefix
            else:
                local_path = problem_dir / uni / exam if problem_dir else None
                results.append({"university": uni, "exam_type": exam, "local_path": local_path, "gcs_prefix": prefix})

    return results

async def _find_exam_entry_by_name(exam_type: str, problem_dir: Optional[Path]) -> Optional[Dict[str, object]]:
    """Return the first exam entry that matches the given exam_type name."""
    catalog = await _list_all_exam_types(problem_dir)
    matches = [entry for entry in catalog if entry.get("exam_type") == exam_type]
    if not matches:
        return None

    def _score(entry: Dict[str, object]) -> Tuple[int, int]:
        return (
            1 if entry.get("gcs_prefix") else 0,
            1 if entry.get("local_path") else 0,
        )

    matches.sort(key=_score, reverse=True)
    return matches[0]

async def download_blob_to_temp(blob_name: str) -> Path:
    """GCSからファイルをダウンロードして一時ファイルのパスを返す"""
    if not bucket:
        raise ValueError("GCS bucket is not configured.")
    
    blob = bucket.blob(blob_name)
    
    # ファイル名から拡張子を取得
    _, ext = os.path.splitext(blob_name)
    
    # 一時ファイルを作成
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_file:
        await asyncio.to_thread(blob.download_to_filename, temp_file.name)
        return Path(temp_file.name)

async def upload_file_to_gcs(local_path: Path, gcs_path: str):
    """ローカルファイルをGCSにアップロードする"""
    if not bucket:
        raise ValueError("GCS bucket is not configured.")
    
    blob = bucket.blob(gcs_path)
    await asyncio.to_thread(blob.upload_from_filename, str(local_path))

async def upload_content_to_gcs(content: bytes, gcs_path: str, content_type: str):
    """コンテンツ(bytes)をGCSにアップロードする"""
    if not bucket:
        raise ValueError("GCS bucket is not configured.")

    if content_type.startswith("text/") and "charset=" not in content_type.lower():
        content_type = f"{content_type}; charset=utf-8"

    blob = bucket.blob(gcs_path)
    await asyncio.to_thread(blob.upload_from_string, content, content_type=content_type)

# --- ディレクトリ設定 (main.pyから渡される) ---
# このファイル内で直接定義するのではなく、process_single_answerの引数として受け取る

def convert_pdf_to_png_sync(pdf_path: Path, output_dir: Path):
    """
    PDFファイルをページごとにPNG画像に変換する同期処理。
    """
    doc = fitz.open(pdf_path)
    # 高解像度レンダリング（環境変数 PNG_SCALE で拡大率を調整、既定2.0）
    try:
        scale = float(os.getenv("PNG_SCALE", "2.0"))
    except Exception:
        scale = 2.0
    mat = fitz.Matrix(scale, scale)
    for page_num in range(len(doc)):
        page = doc.load_page(page_num)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        output_png_path = output_dir / f"page_{page_num + 1}.png"
        pix.save(output_png_path)
    doc.close()

def extract_text_from_pdf_sync(pdf_path: Path, max_chars: int = 12000) -> str:
    """PDFのテキストを抽出（PyMuPDF）。画像のみPDFは空になることがあります。"""
    try:
        doc = fitz.open(pdf_path)
        parts: List[str] = []
        for page in doc:
            txt = page.get_text("text") or ""
            if txt:
                parts.append(txt)
            if sum(len(p) for p in parts) >= max_chars:
                break
        doc.close()
        text = "\n".join(parts)
        # 正規化（連続空行の圧縮）
        text = "\n".join([line.rstrip() for line in text.splitlines()])
        return text[:max_chars]
    except Exception as e:
        return ""

async def extract_text_from_gcs_pdf(blob_name: str, max_chars: int = 12000) -> str:
    """GCS上のPDFからテキストを抽出"""
    local_pdf_path = await download_blob_to_temp(blob_name)
    try:
        text = await asyncio.to_thread(extract_text_from_pdf_sync, local_pdf_path, max_chars)
        return text
    finally:
        local_pdf_path.unlink()

def write_state_sync(stem: str, data: dict):
    """処理状態を processing_state/<stem>.json に保存"""
    try:
        state_dir = Path(__file__).parent / "processing_state"
        state_dir.mkdir(exist_ok=True)
        import json
        path = state_dir / f"{stem}.json"
        base = {}
        if path.exists():
            try:
                base = json.loads(path.read_text("utf-8"))
            except Exception:
                base = {}
        base.update(data)
        text = json.dumps(base, ensure_ascii=False, indent=2)
        path.write_text(text, "utf-8")
    except Exception as e:
        print(f"[write_state] 失敗: {e}")

async def process_single_answer(filename: str, dirs: dict):
    """
    単一の答案ファイルを処理するメインロジック。
    GCSからPDFをダウンロードし、成果物をGCSにアップロードする。
    """
    problem_dir: Optional[Path] = dirs.get("PROBLEM_DIR") if dirs else None

    # ローカルの一時ディレクトリを処理全体で使用
    with tempfile.TemporaryDirectory() as temp_dir_str:
        temp_dir = Path(temp_dir_str)
        pdf_stem = Path(filename).stem
        
        # GCS上のパス定義
        gcs_pdf_path = f"uploaded_pdfs/{filename}"
        gcs_png_prefix = f"processing_pngs/{pdf_stem}/"
        gcs_md_path = f"processing_mds/{pdf_stem}.md"
        gcs_quality_cache_path = f"processing_cache/{pdf_stem}.quality.json"
        gcs_review_path = f"processing_reviews/{pdf_stem}.json"

        try:
            # ステップ1: PDFをGCSからダウンロード & PNG変換 & GCSにアップロード
            answers_db[filename]["status"] = "処理中(PNG変換)"
            write_state_sync(pdf_stem, {"status": answers_db[filename]["status"]})

            local_pdf_path = await download_blob_to_temp(gcs_pdf_path)
            
            local_png_output_dir = temp_dir / "pngs"
            local_png_output_dir.mkdir()
            
            await asyncio.to_thread(convert_pdf_to_png_sync, local_pdf_path, local_png_output_dir)

            # 生成されたPNGをGCSにアップロード
            png_files = sorted(list(local_png_output_dir.glob("page_*.png")))
            for png_path in png_files:
                gcs_png_path = f"{gcs_png_prefix}{png_path.name}"
                await upload_file_to_gcs(png_path, gcs_png_path)

            # 一時PDFはここで不要になるので削除
            local_pdf_path.unlink()

            # ステップ2: 仕分け（再利用可能ならスキップ）
            answers_db[filename]["status"] = "処理中(仕分け)"
            write_state_sync(pdf_stem, {"status": answers_db[filename]["status"]})
            
            if not png_files:
                raise FileNotFoundError("PNG conversion failed or produced no files.")
            first_page_path = png_files[0]

            # 1) GCSキャッシュ確認
            import json
            quality = None
            try:
                blob = bucket.blob(gcs_quality_cache_path)
                if await asyncio.to_thread(blob.exists):
                    cached_text = await asyncio.to_thread(blob.download_as_text)
                    quality = json.loads(cached_text)
            except Exception:
                quality = None

            # 2) メモリ確認
            if quality is None:
                quality = answers_db.get(filename, {}).get("quality")

            # 3) 仕分けが未実施ならモデルで実行し、キャッシュ保存
            if not quality or not isinstance(quality, dict) or "label" not in quality:
                # GCSから最初のページをダウンロードして処理
                local_first_page_path = await download_blob_to_temp(f"{gcs_png_prefix}{first_page_path.name}")
                quality_result = await classify_image_quality(local_first_page_path)
                local_first_page_path.unlink() # 一時ファイルを削除

                if isinstance(quality_result, str):
                    quality = {"label": quality_result, "reason": ""}
                else:
                    quality = quality_result
                answers_db[filename]["quality"] = quality
                # GCSに保存
                try:
                    await upload_content_to_gcs(
                        json.dumps(quality, ensure_ascii=False, indent=2).encode("utf-8"),
                        gcs_quality_cache_path,
                        "application/json"
                    )
                except Exception:
                    pass
            else:
                answers_db[filename]["quality"] = quality

            if quality.get("label") == "NG":
                answers_db[filename]["status"] = "仕分済 (要手動確認)"
                write_state_sync(pdf_stem, {"status": answers_db[filename]["status"], "quality": quality})
                return

            # ステップ3: 書き起こし
            # GCSからPNGリストを取得
            blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=gcs_png_prefix)
            image_blob_names = sorted([blob.name for blob in blobs if blob.name.endswith(".png")])
            
            if not image_blob_names:
                raise FileNotFoundError(f"No PNG pages found in GCS for {filename}")

            # GCSのMDをチェック
            md_blob = bucket.blob(gcs_md_path)
            if await asyncio.to_thread(md_blob.exists):
                answers_db[filename]["status"] = "書き起こし済(既存利用)"
                markdown_content = await asyncio.to_thread(md_blob.download_as_text)
            else:
                answers_db[filename]["status"] = "処理中(書き起こし)"
                write_state_sync(pdf_stem, {"status": answers_db[filename]["status"]})
                
                # PNGを一時ファイルにダウンロード
                local_image_paths = []
                for blob_name in image_blob_names:
                    local_path = await download_blob_to_temp(blob_name)
                    local_image_paths.append(local_path)

                try:
                    markdown_content = await transcribe_images_to_markdown(local_image_paths)
                except Exception as e:
                    answers_db[filename]["status"] = "エラー(書き起こし失敗)"
                    write_state_sync(pdf_stem, {"status": answers_db[filename]["status"]})
                    print(f"Transcription failed for {filename}: {e}")
                    return
                finally:
                    # 一時ファイルをクリーンアップ
                    for p in local_image_paths:
                        p.unlink()

                if not markdown_content.strip():
                    answers_db[filename]["status"] = "エラー(書き起こし空)"
                    write_state_sync(pdf_stem, {"status": answers_db[filename]["status"]})
                    return
                
                # MDをGCSにアップロード
                await upload_content_to_gcs(markdown_content.encode("utf-8"), gcs_md_path, "text/markdown")

            # ステップ4: 特定
            answers_db[filename]["status"] = "処理中(特定)"
            write_state_sync(pdf_stem, {"status": answers_db[filename]["status"]})
            content_header = markdown_content[:1200]
            details = await extract_answer_details(content_header)
            answers_db[filename]["details"] = details

            chosen_prefix: Optional[str] = None
            chosen_exam_type: Optional[str] = None
            if SPECIAL_TRANSCRIPT_MARKER in markdown_content:
                # This marker indicates a special test type. Force the category.
                details['university'] = "実力テスト"
                answers_db[filename]["details"]["university"] = "実力テスト"

            uni = details.get("university", "").strip()
            subj = details.get("subject", "").strip()
            year = details.get("year", "").strip()
            year_short = year[-2:] if len(year) >= 2 else ""
            prefer_faculty = "理系" if "2" in subj else ("文系" if "1" in subj else None)
            subject_hint_label = _normalize_subject_hint(subj)

            exam_hint_raw = details.get('exam_type') or details.get('exam_label')
            if not exam_hint_raw and content_header:
                first_line = content_header.splitlines()[0].strip() if content_header.splitlines() else ''
                exam_hint_raw = first_line or None
            if not exam_hint_raw and markdown_content:
                exam_hint_raw = markdown_content.splitlines()[0].strip() if markdown_content.splitlines() else None
            exam_hint_norm = _normalize_label(exam_hint_raw) if exam_hint_raw else ''

            exam_hints = _extract_exam_hints(details, markdown_content)
            if exam_hints.get('category') and not details.get('exam_category'):
                details['exam_category'] = exam_hints['category']
            if exam_hints.get('exam_label') and not details.get('exam_type'):
                details.setdefault('exam_type_hint', exam_hints['exam_label'])

            hint_tokens: Set[str] = set(exam_hints.get('tokens_norm') or set())
            subject_norm_full = _normalize_label(subj) if subj else ''
            subject_hint_norm = _normalize_label(subject_hint_label) if subject_hint_label else ''
            for extra in [subject_norm_full, subject_hint_norm, exam_hint_norm]:
                if extra:
                    hint_tokens.add(extra)

            hint_text_norms = []
            seen_norms = set()
            for candidate in [exam_hint_norm, exam_hints.get('combined_norm'), exam_hints.get('category_norm'), exam_hints.get('exam_norm'), subject_norm_full, subject_hint_norm]:
                if candidate and candidate not in seen_norms:
                    hint_text_norms.append(candidate)
                    seen_norms.add(candidate)

            selection_hints = {
                'university': uni,
                'year': year,
                'year_short': year_short,
                'prefer_faculty': prefer_faculty,
                'subject_norm': subject_norm_full,
                'subject_hint_norm': subject_hint_norm,
                'exam_hint_norm': exam_hint_norm,
                'category_norm': exam_hints.get('category_norm'),
                'exam_norm': exam_hints.get('exam_norm'),
                'combined_norm': exam_hints.get('combined_norm'),
                'transcript_norm': exam_hints.get('transcript_norm'),
                'hint_tokens': hint_tokens,
                'hint_text_norms': hint_text_norms,
            }

            candidates: List[str] = []
            if not chosen_prefix and uni and year_short:
                gcs_problem_base = f"problems/{uni}/"
                if prefer_faculty:
                    candidates.append(f"{gcs_problem_base}{year_short}年{prefer_faculty}/")
                    alt = "文系" if prefer_faculty == "理系" else "理系"
                    candidates.append(f"{gcs_problem_base}{year_short}年{alt}/")
                else:
                    candidates.extend([
                        f"{gcs_problem_base}{year_short}年理系/",
                        f"{gcs_problem_base}{year_short}年文系/",
                    ])

            if not chosen_prefix:
                for prefix in candidates:
                    blobs = list(storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix, max_results=1))
                    if blobs:
                        chosen_prefix = prefix
                        break

            if not chosen_prefix:
                catalog = await _list_all_exam_types(problem_dir)
                best_entry = _select_best_exam_entry(catalog, selection_hints)
                if best_entry:
                    # The university/category is determined by the best matching entry in our catalog.
                    # This overrides any potentially incorrect value from the LLM.
                    uni_from_catalog = best_entry.get("university")
                    if uni_from_catalog:
                        details["university"] = uni_from_catalog
                        answers_db[filename]["details"]["university"] = uni_from_catalog
                    
                    if bucket and best_entry.get('gcs_prefix'):
                        chosen_prefix = best_entry['gcs_prefix']
                        chosen_exam_type = best_entry.get('exam_type')
                if chosen_prefix is None:
                    answers_db[filename]["status"] = "エラー(問題なし)"
                    write_state_sync(pdf_stem, {"status": answers_db[filename]["status"], "details": answers_db[filename].get("details")})
                    return

            if chosen_prefix is None:
                answers_db[filename]["status"] = "エラー(問題なし)"
                write_state_sync(pdf_stem, {"status": answers_db[filename]["status"], "details": answers_db[filename].get("details")})
                return

            answers_db[filename]["problem_path"] = f"gs://{GCS_BUCKET_NAME}/{chosen_prefix}"
            answers_db[filename]["exam_type"] = chosen_exam_type or chosen_prefix.strip('/').split('/')[-1]
            answers_db[filename]["status"] = "特定済"
            # ... (state writing)

            # ステップ5: 添削コメント生成
            answers_db[filename]["status"] = "処理中(添削)"
            # ... (state writing) 
            
            problem_texts: List[str] = []
            collected_files: List[str] = []
            try:
                blobs = list(storage_client.list_blobs(GCS_BUCKET_NAME, prefix=chosen_prefix))
                # ... (sorting logic can be adapted here if needed)

                for blob in blobs:
                    blob_name = blob.name
                    file_name = Path(blob_name).name
                    ext = Path(file_name).suffix.lower()
                    try:
                        if ext in {'.md', '.txt'}:
                            txt = (await asyncio.to_thread(blob.download_as_text))[:6000]
                            if txt.strip():
                                problem_texts.append(f"[FILE:{file_name}]\n{txt}")
                                collected_files.append(file_name)
                        elif ext == ".pdf":
                            txt = await extract_text_from_gcs_pdf(blob_name)
                            if txt.strip():
                                problem_texts.append(f"[FILE:{file_name}]\n{txt}")
                                collected_files.append(file_name)
                            else:
                                note = "[NOTE] このPDFは画像ベースの可能性があり、テキスト抽出できませんでした。"
                                if ("採点" in file_name or "基準" in file_name or "解答" in file_name or "模範" in file_name):
                                    problem_texts.append(f"[FILE:{file_name}]\n{note}")
                                    collected_files.append(file_name)
                    except Exception:
                        pass
            except Exception:
                pass

            review = await generate_review_comments(markdown_content, problem_texts)
            # ... (add collected files to review notes)
            
            answers_db[filename]["review"] = review
            # レビューをGCSに保存
            try:
                import json
                review_content = json.dumps(review, ensure_ascii=False, indent=2)
                await upload_content_to_gcs(review_content.encode('utf-8'), gcs_review_path, "application/json")
                answers_db[filename]["review_path"] = f"gs://{GCS_BUCKET_NAME}/{gcs_review_path}"
            except Exception as e:
                print(f"[process_single_answer] レビュー保存失敗: {e}")

            answers_db[filename]["status"] = "AI添削完了"
            # ... (final state writing)

        except Exception as e:
            # ... (error handling)
            print(traceback.format_exc())
        finally:
            # 一時ディレクトリをクリーンアップ
            pass

async def reprocess_answer(filename: str, dirs: dict, steps: List[str], force: bool = False) -> dict:
    """
    指定ステップのみ再処理。
    steps: ["png","quality","transcribe","identify","review"]
    force: 既存成果を無視
    """
    UPLOAD_DIR = dirs["UPLOAD_DIR"]
    PNG_DIR = dirs["PNG_DIR"]
    MD_DIR = dirs["MD_DIR"]
    PROBLEM_DIR = dirs["PROBLEM_DIR"]
    CACHE_DIR = dirs.get("CACHE_DIR", Path(__file__).parent / "processing_cache")

    pdf_path = UPLOAD_DIR / filename
    stem = pdf_path.stem
    out_dir = PNG_DIR / stem
    md_path = MD_DIR / f"{stem}.md"

    gcs_pdf_blob = f"uploaded_pdfs/{filename}"
    gcs_png_prefix = f"processing_pngs/{stem}/"
    gcs_md_blob = f"processing_mds/{stem}.md"
    gcs_quality_blob = f"processing_cache/{stem}.quality.json"
    gcs_review_blob = f"processing_reviews/{stem}.json"

    done: List[str] = []
    errors: List[dict] = []
    timeline: dict = {}
    temp_files: List[Path] = []
    temp_dirs: List[Path] = []

    import datetime
    import json

    async def ensure_local_pdf() -> Path:
        if pdf_path.exists():
            return pdf_path
        if not bucket:
            raise FileNotFoundError("PDF not found")
        tmp = await download_blob_to_temp(gcs_pdf_blob)
        temp_files.append(tmp)
        return tmp

    async def ensure_local_md():
        if md_path.exists() or not bucket:
            return
        blob = bucket.blob(gcs_md_blob)
        if await asyncio.to_thread(blob.exists):
            text_md = await asyncio.to_thread(blob.download_as_text)
            await asyncio.to_thread(md_path.write_text, text_md, "utf-8")

    def mark_start(step: str):
        timeline.setdefault(step, {})['start'] = datetime.datetime.now().isoformat(timespec='seconds')
        try:
            answers_db.setdefault(filename, {})['status'] = f"再処理中({step})"
            write_state_sync(stem, {"status": answers_db[filename]['status'], "last_step": step, "timeline": timeline})
        except Exception:
            pass

    def mark_end(step: str, ok: bool, err: Exception | None = None):
        timeline.setdefault(step, {})['end'] = datetime.datetime.now().isoformat(timespec='seconds')
        if not ok and err is not None:
            msg = str(err)
            errors.append({"step": step, "error": msg})
            try:
                answers_db.setdefault(filename, {})['status'] = f"エラー({step})"
                answers_db[filename]['error'] = msg
                write_state_sync(stem, {"status": answers_db[filename]['status'], "last_step": step, "last_error": msg, "timeline": timeline})
            except Exception:
                pass

    try:
        if "png" in steps:
            mark_start("png")
            try:
                local_pdf = await ensure_local_pdf()
                out_dir.mkdir(parents=True, exist_ok=True)
                if force:
                    for p in out_dir.glob("page_*.png"):
                        try:
                            p.unlink()
                        except Exception:
                            pass
                    if bucket:
                        await delete_gcs_prefix(gcs_png_prefix)
                await asyncio.to_thread(convert_pdf_to_png_sync, local_pdf, out_dir)
                png_files = sorted(out_dir.glob("page_*.png"))
                if bucket:
                    for png_path in png_files:
                        await upload_file_to_gcs(png_path, f"{gcs_png_prefix}{png_path.name}")
                done.append("png")
                answers_db.setdefault(filename, {})["status"] = "PNG変換済"
                write_state_sync(stem, {"status": answers_db[filename]["status"]})
                mark_end("png", True)
            except Exception as e:
                mark_end("png", False, e)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}

        if "quality" in steps:
            mark_start("quality")
            first_local_path: Path | None = out_dir / "page_1.png"
            if not first_local_path.exists():
                first_local_path = None
                if bucket:
                    try:
                        tmp_png = await download_blob_to_temp(f"{gcs_png_prefix}page_1.png")
                        temp_files.append(tmp_png)
                        first_local_path = tmp_png
                    except Exception:
                        first_local_path = None
                if first_local_path is None:
                    out_dir.mkdir(parents=True, exist_ok=True)
                    local_pdf = await ensure_local_pdf()
                    await asyncio.to_thread(convert_pdf_to_png_sync, local_pdf, out_dir)
                    first_local_path = out_dir / "page_1.png"
                    if bucket:
                        for png_path in sorted(out_dir.glob("page_*.png")):
                            await upload_file_to_gcs(png_path, f"{gcs_png_prefix}{png_path.name}")
            if not first_local_path or not Path(first_local_path).exists():
                err = FileNotFoundError("page_1.png not found")
                mark_end("quality", False, err)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
            cache_path = CACHE_DIR / f"{stem}.quality.json"
            if force and cache_path.exists():
                try:
                    cache_path.unlink()
                except Exception:
                    pass
            try:
                result = await classify_image_quality(Path(first_local_path))
            except Exception as e:
                mark_end("quality", False, e)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
            quality = {"label": result, "reason": ""} if isinstance(result, str) else result
            answers_db.setdefault(filename, {})["quality"] = quality
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(cache_path.write_text, json.dumps(quality, ensure_ascii=False, indent=2), "utf-8")
                if bucket:
                    await upload_content_to_gcs(json.dumps(quality, ensure_ascii=False, indent=2).encode("utf-8"), gcs_quality_blob, "application/json")
            except Exception:
                pass
            done.append("quality")
            if (quality or {}).get("label") == "NG":
                answers_db[filename]["status"] = "仕分済 (要手動確認)"
            else:
                answers_db[filename]["status"] = "仕分済 (自動可)"
            write_state_sync(stem, {"status": answers_db[filename]["status"], "quality": quality})
            mark_end("quality", True)

        if "transcribe" in steps:
            mark_start("transcribe")
            if force and md_path.exists():
                try:
                    md_path.unlink()
                except Exception:
                    pass
            imgs = sorted(out_dir.glob("page_*.png"))
            if not imgs and bucket:
                tmp_dir = Path(tempfile.mkdtemp())
                temp_dirs.append(tmp_dir)
                blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=gcs_png_prefix)
                for blob in blobs:
                    if not blob.name.lower().endswith('.png'):
                        continue
                    local_file = tmp_dir / Path(blob.name).name
                    await asyncio.to_thread(blob.download_to_filename, str(local_file))
                imgs = sorted(tmp_dir.glob("page_*.png"))
            if not imgs:
                out_dir.mkdir(parents=True, exist_ok=True)
                local_pdf = await ensure_local_pdf()
                await asyncio.to_thread(convert_pdf_to_png_sync, local_pdf, out_dir)
                imgs = sorted(out_dir.glob("page_*.png"))
                if bucket:
                    for png_path in imgs:
                        await upload_file_to_gcs(png_path, f"{gcs_png_prefix}{png_path.name}")
            if not imgs:
                err = FileNotFoundError("PNG conversion failed or produced no files.")
                mark_end("transcribe", False, err)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
            try:
                content = await transcribe_images_to_markdown(list(imgs))
                md_path.parent.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(md_path.write_text, content, "utf-8")
                if bucket:
                    await upload_content_to_gcs(content.encode("utf-8"), gcs_md_blob, "text/markdown")
            except Exception as e:
                mark_end("transcribe", False, e)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
            done.append("transcribe")
            answers_db.setdefault(filename, {})["status"] = "書き起こし済"
            write_state_sync(stem, {"status": answers_db[filename]["status"]})
            mark_end("transcribe", True)

        if "identify" in steps:
            mark_start("identify")
            await ensure_local_md()
            if not md_path.exists():
                err = FileNotFoundError("Markdown not found for identify")
                mark_end("identify", False, err)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
            md = await asyncio.to_thread(md_path.read_text, "utf-8")
            header = md[:1200]
            try:
                details = await extract_answer_details(header)
            except Exception as e:
                mark_end("identify", False, e)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
            answers_db.setdefault(filename, {})["details"] = details
            uni = (details.get("university") or "").strip()
            subj = (details.get("subject") or "").strip()
            year = (details.get("year") or "").strip()
            year_short = year[-2:] if len(year) >= 2 else ""
            prefer_faculty = "理系" if "2" in subj else ("文系" if "1" in subj else None)
            subject_hint = _normalize_subject_hint(subj)
            exam_hint_raw = details.get('exam_type') or details.get('exam_label') or (header.splitlines()[0] if header else '')
            if not exam_hint_raw and header:
                exam_hint_raw = header[:80]
            exam_hint_norm = _normalize_label(exam_hint_raw)

            exam_hints = _extract_exam_hints(details, md)
            if exam_hints.get('category') and not details.get('exam_category'):
                details['exam_category'] = exam_hints['category']
            if exam_hints.get('exam_label') and not details.get('exam_type'):
                details.setdefault('exam_type_hint', exam_hints['exam_label'])

            hint_tokens: Set[str] = set(exam_hints.get('tokens_norm') or set())
            subject_norm_full = _normalize_label(subj) if subj else ''
            subject_hint_norm = _normalize_label(subject_hint) if subject_hint else ''
            for extra in [subject_norm_full, subject_hint_norm, exam_hint_norm]:
                if extra:
                    hint_tokens.add(extra)

            hint_text_norms = []
            seen_norms = set()
            for candidate in [exam_hint_norm, exam_hints.get('combined_norm'), exam_hints.get('category_norm'), exam_hints.get('exam_norm'), subject_norm_full, subject_hint_norm]:
                if candidate and candidate not in seen_norms:
                    hint_text_norms.append(candidate)
                    seen_norms.add(candidate)

            selection_hints = {
                'university': uni,
                'year': year,
                'year_short': year_short,
                'prefer_faculty': prefer_faculty,
                'subject_norm': subject_norm_full,
                'subject_hint_norm': subject_hint_norm,
                'exam_hint_norm': exam_hint_norm,
                'category_norm': exam_hints.get('category_norm'),
                'exam_norm': exam_hints.get('exam_norm'),
                'combined_norm': exam_hints.get('combined_norm'),
                'transcript_norm': exam_hints.get('transcript_norm'),
                'hint_tokens': hint_tokens,
                'hint_text_norms': hint_text_norms,
            }

            chosen_local_dir: Optional[Path] = None
            chosen_gcs_prefix: Optional[str] = None
            chosen_university: Optional[str] = None
            chosen_exam_type: Optional[str] = None

            forced_special_exam = False
            if SPECIAL_TRANSCRIPT_MARKER in md:
                details['university'] = "実力テスト"
                answers_db.setdefault(filename, {}).setdefault("details", {})["university"] = "実力テスト"


            if not forced_special_exam and uni and year_short:
                local_base = PROBLEM_DIR / uni
                local_candidates = []
                if prefer_faculty:
                    local_candidates.append(local_base / f"{year_short}年{prefer_faculty}")
                    alt_fac = "文系" if prefer_faculty == "理系" else "理系"
                    local_candidates.append(local_base / f"{year_short}年{alt_fac}")
                else:
                    local_candidates.extend([
                        local_base / f"{year_short}年理系",
                        local_base / f"{year_short}年文系",
                    ])
                for candidate in local_candidates:
                    if await asyncio.to_thread(candidate.exists):
                        chosen_local_dir = candidate
                        chosen_university = uni
                        chosen_exam_type = candidate.name
                        break
                if chosen_local_dir is None and bucket:
                    gcs_base = f"{PROBLEMS_PREFIX}/{uni}/"
                    prefixes = []
                    if prefer_faculty:
                        prefixes.append(f"{gcs_base}{year_short}年{prefer_faculty}/")
                        alt_fac = "文系" if prefer_faculty == "理系" else "理系"
                        prefixes.append(f"{gcs_base}{year_short}年{alt_fac}/")
                    else:
                        prefixes.extend([
                            f"{gcs_base}{year_short}年理系/",
                            f"{gcs_base}{year_short}年文系/",
                        ])
                    for prefix in prefixes:
                        blobs = list(storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix, max_results=1))
                        if blobs:
                            chosen_gcs_prefix = prefix
                            chosen_university = uni
                            chosen_exam_type = prefix.rstrip('/').split('/')[-1]
                            break

            if not chosen_local_dir and not chosen_gcs_prefix:
                catalog = await _list_all_exam_types(PROBLEM_DIR)
                best_entry = _select_best_exam_entry(catalog, selection_hints)
                if best_entry:
                    # The university/category is determined by the best matching entry in our catalog.
                    # This overrides any potentially incorrect value from the LLM.
                    uni_from_catalog = best_entry.get("university")
                    if uni_from_catalog:
                        chosen_university = uni_from_catalog
                        answers_db.setdefault(filename, {}).setdefault("details", {})["university"] = chosen_university
                    
                    if not chosen_exam_type and best_entry.get("exam_type"):
                        chosen_exam_type = best_entry.get("exam_type")

                    local_path = best_entry.get("local_path")
                    if local_path and await asyncio.to_thread(local_path.exists):
                        chosen_local_dir = local_path
                    gcs_prefix = best_entry.get("gcs_prefix")
                    if bucket and gcs_prefix:
                        chosen_gcs_prefix = gcs_prefix

            if not chosen_local_dir and not chosen_gcs_prefix:
                answers_db.setdefault(filename, {})["status"] = "エラー(問題なし)"
                write_state_sync(stem, {"status": answers_db[filename]["status"], "details": answers_db[filename].get("details")})
                mark_end("identify", False, FileNotFoundError("problem assets not found"))
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}

            if chosen_gcs_prefix:
                answers_db[filename]["problem_path"] = f"gs://{GCS_BUCKET_NAME}/{chosen_gcs_prefix}"
            elif chosen_local_dir is not None:
                answers_db[filename]["problem_path"] = str(chosen_local_dir)

            if chosen_exam_type:
                answers_db[filename]["exam_type"] = chosen_exam_type
            elif chosen_local_dir is not None:
                answers_db[filename]["exam_type"] = chosen_local_dir.name

            answers_db[filename]["status"] = "特定済"
            
            # Ensure the final state reflects the identified university and exam type
            final_details = answers_db[filename].get("details", {})
            if isinstance(final_details, dict) and chosen_university:
                final_details["university"] = chosen_university

            write_state_sync(stem, {
                "status": answers_db[filename]["status"], 
                "details": final_details, 
                "problem_path": answers_db[filename].get("problem_path"),
                "exam_type": answers_db[filename].get("exam_type")
            })
            done.append("identify")
            mark_end("identify", True)


        if "review" in steps:
            mark_start("review")
            await ensure_local_md()
            if not md_path.exists():
                err = FileNotFoundError("Markdown not found for review")
                mark_end("review", False, err)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
            markdown_content = await asyncio.to_thread(md_path.read_text, "utf-8")
            problem_texts: List[str] = []
            try:
                problem_path = answers_db.get(filename, {}).get("problem_path")
                if problem_path and problem_path.startswith("gs://") and bucket:
                    prefix = problem_path.replace(f"gs://{GCS_BUCKET_NAME}/", "")
                    blobs = list(storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix))
                    for blob in blobs:
                        name = Path(blob.name).name
                        ext = Path(name).suffix.lower()
                        try:
                            if ext in {'.md', '.txt'}:
                                txt = await asyncio.to_thread(blob.download_as_text)
                                if txt.strip():
                                    problem_texts.append(f"[FILE:{name}]\n{txt}")
                            elif ext == '.pdf':
                                txt = await extract_text_from_gcs_pdf(blob.name)
                                if txt.strip():
                                    problem_texts.append(f"[FILE:{name}]\n{txt}")
                        except Exception:
                            continue
                elif problem_path:
                    local_dir = Path(problem_path)
                    if await asyncio.to_thread(local_dir.exists):
                        files = await asyncio.to_thread(lambda: sorted([p for p in local_dir.iterdir() if p.is_file()]))
                        for p in files:
                            ext = p.suffix.lower()
                            try:
                                if ext in {'.md', '.txt'}:
                                    txt = await asyncio.to_thread(p.read_text, "utf-8")
                                    if txt.strip():
                                        problem_texts.append(f"[FILE:{p.name}]\n{txt}")
                                elif ext == '.pdf':
                                    txt = await asyncio.to_thread(extract_text_from_pdf_sync, p, 4000)
                                    if txt.strip():
                                        problem_texts.append(f"[FILE:{p.name}]\n{txt}")
                            except Exception:
                                continue
            except Exception:
                pass
            try:
                review = await generate_review_comments(markdown_content, problem_texts)
                answers_db.setdefault(filename, {})["review"] = review
                review_json = json.dumps(review, ensure_ascii=False, indent=2)
                if bucket:
                    await upload_content_to_gcs(review_json.encode('utf-8'), gcs_review_blob, "application/json")
                    answers_db[filename]["review_path"] = f"gs://{GCS_BUCKET_NAME}/{gcs_review_blob}"
                else:
                    review_dir = Path(__file__).parent / "processing_reviews"
                    review_dir.mkdir(parents=True, exist_ok=True)
                    review_file = review_dir / f"{stem}.json"
                    await asyncio.to_thread(review_file.write_text, review_json, "utf-8")
                    answers_db[filename]["review_path"] = str(review_file)
                answers_db[filename]["status"] = "AI添削完了"
                write_state_sync(stem, {"status": answers_db[filename]["status"], "review_path": answers_db[filename].get("review_path")})
                done.append("review")
                mark_end("review", True)
            except Exception as e:
                mark_end("review", False, e)
                return {"message": "Reprocess failed", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}

        return {"message": "Reprocess done", "done": done, "errors": errors, "status": answers_db.get(filename, {}).get("status"), "timeline": timeline}
    finally:
        for p in temp_files:
            try:
                if p.exists():
                    p.unlink()
            except Exception:
                pass
        for d in temp_dirs:
            try:
                shutil.rmtree(d, ignore_errors=True)
            except Exception:
                pass
