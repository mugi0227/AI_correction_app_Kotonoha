import asyncio
import os
import shutil
import time
from typing import List, Dict, Optional
from collections import defaultdict
from pathlib import Path
import mimetypes
import google.generativeai as genai
from fastapi import FastAPI, UploadFile, File, HTTPException, Body, Request, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.staticfiles import StaticFiles
from dotenv import load_dotenv
import google.auth
from google.cloud import storage

"""
重要: .env を読み込んでから自作モジュール(crud/processing)をインポートする。
crud/processing では環境変数(GCS_BUCKET_NAME 等)を import 時に読む箇所があるため、
読み込み順を誤ると値が反映されない。
"""
# --- 初期設定 ---
# CWDに依存せず backend/.env を確実に読み込む
_ENV_LOADED_1 = load_dotenv(dotenv_path=(Path(__file__).parent / ".env"))
# 併せてカレント/親ディレクトリの .env も読み込む（既存値は上書きしない）
_ENV_LOADED_2 = load_dotenv()
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

# 自作モジュールのインポート（.env読み込み後）
from crud import answers_db, sync_db_with_filesystem
from processing import process_single_answer, reprocess_answer, extract_text_from_pdf_sync

# --- GCS設定 ---
GCS_BUCKET_NAME = os.getenv("GCS_BUCKET_NAME")
storage_client = None
bucket = None
# Cloud Run環境で確実な認証情報を取得
credentials, project = google.auth.default()

if GCS_BUCKET_NAME:
    storage_client = storage.Client(credentials=credentials)
    bucket = storage_client.bucket(GCS_BUCKET_NAME)

PROBLEMS_PREFIX = "problems"
SIGNATURE_PREFIX = "signatures"


def _normalize_segment(value: str) -> str:
    v = str(value or "").strip()
    if not v:
        raise ValueError("empty segment")
    if "/" in v or "\\" in v:
        raise ValueError("invalid segment")
    return v


def _safe_filename(name: str) -> str:
    import os as _os
    return _os.path.basename(str(name or "")).strip()


def _gcs_problem_object_path(university: str, exam_type: str, filename: str = "") -> str:
    uni = _normalize_segment(university)
    et = _normalize_segment(exam_type)
    base = f"{PROBLEMS_PREFIX}/{uni}/{et}"
    filename = _safe_filename(filename)
    if filename:
        return f"{base}/{filename}"
    return base


def _gcs_problem_prefix(university: Optional[str] = None, exam_type: Optional[str] = None) -> str:
    parts = [PROBLEMS_PREFIX]
    if university is not None:
        parts.append(_normalize_segment(university))
    if exam_type is not None:
        parts.append(_normalize_segment(exam_type))
    return "/".join(parts) + "/"


async def _ensure_local_problem_dir(university: str, exam_type: str) -> Path:
    target = PROBLEM_DIR / _normalize_segment(university) / _normalize_segment(exam_type)
    await asyncio.to_thread(target.mkdir, parents=True, exist_ok=True)
    return target


async def _sync_problem_dir_from_gcs(university: str, exam_type: str, force: bool = False) -> Path:
    target = await _ensure_local_problem_dir(university, exam_type)
    if not bucket:
        return target

    prefix = _gcs_problem_prefix(university, exam_type)

    def _sync() -> Path:
        blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix)
        for blob in blobs:
            name = blob.name
            if not name.startswith(prefix):
                continue
            relative = name[len(prefix):]
            if not relative or relative.endswith('/'):
                continue
            rel_path = Path(relative)
            if any(part == ".." for part in rel_path.parts):
                continue
            dest = target / rel_path
            if not force and dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            blob.download_to_filename(str(dest))
        return target

    try:
        return await asyncio.to_thread(_sync)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to sync from GCS: {exc}")


async def _upload_problem_bytes_to_gcs(university: str, exam_type: str, filename: str, data: bytes, content_type: Optional[str] = None) -> None:
    if not bucket:
        return

    gcs_path = _gcs_problem_object_path(university, exam_type, filename)

    def _upload():
        blob = bucket.blob(gcs_path)
        blob.upload_from_string(data, content_type=content_type)

    await asyncio.to_thread(_upload)


async def _upload_problem_file_to_gcs(university: str, exam_type: str, local_path: Path, content_type: Optional[str] = None) -> None:
    if not bucket:
        return

    gcs_path = _gcs_problem_object_path(university, exam_type, local_path.name)

    def _upload():
        blob = bucket.blob(gcs_path)
        blob.upload_from_filename(str(local_path), content_type=content_type)

    await asyncio.to_thread(_upload)


async def _ensure_exam_placeholder_on_gcs(university: str, exam_type: str) -> None:
    if not bucket:
        return

    placeholder = _gcs_problem_object_path(university, exam_type, ".keep")

    def _upload():
        blob = bucket.blob(placeholder)
        blob.upload_from_string(b"", content_type="text/plain")

    await asyncio.to_thread(_upload)


async def _load_gcs_problem_manifest(university: Optional[str] = None) -> Dict[str, Dict[str, List[str]]]:
    if not bucket:
        return {}

    prefix = _gcs_problem_prefix(university) if university else f"{PROBLEMS_PREFIX}/"

    def _collect() -> Dict[str, Dict[str, List[str]]]:
        mapping: Dict[str, Dict[str, List[str]]] = defaultdict(dict)
        temp: Dict[str, Dict[str, List[str]]] = defaultdict(lambda: defaultdict(list))
        blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix)
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
            if not uni or not exam:
                continue
            if university and uni != university:
                continue
            remainder = '/'.join(parts[2:]) if len(parts) > 2 else ''
            temp[uni][exam].append(remainder)
        for uni, exams in temp.items():
            mapping[uni] = {et: files[:] for et, files in exams.items()}
        return dict(mapping)

    return await asyncio.to_thread(_collect)


async def _delete_gcs_prefix(prefix: str) -> None:
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


async def _upload_signature_bytes_to_gcs(filename: str, data: bytes, content_type: Optional[str] = None) -> None:
    if not bucket:
        return

    gcs_path = f"{SIGNATURE_PREFIX}/{_safe_filename(filename)}"

    def _upload():
        blob = bucket.blob(gcs_path)
        blob.upload_from_string(data, content_type=content_type)

    await asyncio.to_thread(_upload)


async def _delete_signature_from_gcs(filename: str) -> None:
    if not bucket:
        return

    gcs_path = f"{SIGNATURE_PREFIX}/{_safe_filename(filename)}"

    def _delete():
        blob = bucket.blob(gcs_path)
        try:
            blob.delete()
        except Exception:
            pass

    await asyncio.to_thread(_delete)


async def _sync_signatures_from_gcs(force: bool = False) -> List[Path]:
    SIGNATURE_DIR.mkdir(parents=True, exist_ok=True)
    if not bucket:
        return await asyncio.to_thread(lambda: sorted([p for p in SIGNATURE_DIR.iterdir() if p.is_file()]))

    def _sync() -> List[Path]:
        SIGNATURE_DIR.mkdir(parents=True, exist_ok=True)
        prefix = f"{SIGNATURE_PREFIX}/"
        blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix)
        seen: set[Path] = set()
        for blob in blobs:
            name = blob.name
            if not name or not name.startswith(prefix):
                continue
            relative = name[len(prefix):]
            if not relative or relative.endswith('/'):
                continue
            rel_path = Path(relative)
            if any(part == ".." for part in rel_path.parts):
                continue
            dest = SIGNATURE_DIR / rel_path
            seen.add(dest)
            if not force and dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                blob.download_to_filename(str(dest))
            except Exception:
                try:
                    if dest.exists():
                        dest.unlink()
                except Exception:
                    pass
        return sorted([p for p in SIGNATURE_DIR.iterdir() if p.is_file()])

    return await asyncio.to_thread(_sync)

# --- アプリケーション設定 ---
app = FastAPI()

# CORS設定
# - CORS_ALLOW_ORIGINS にカンマ区切りで許可オリジンを指定
# - CORS_ALLOW_ORIGIN_REGEX に正規表現で指定（どちらか/両方可）
origins_str = os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
allowed_origins = [o.strip() for o in origins_str.split(',') if o.strip()]
origin_regex = os.getenv("CORS_ALLOW_ORIGIN_REGEX", None)

cors_kwargs = dict(
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if origin_regex:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins or [],
        allow_origin_regex=origin_regex,
        **cors_kwargs,
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        **cors_kwargs,
    )

# 補助: 例外時にもCORSヘッダを付与するためのミドルウェア
# （一部の実行時例外でCORSヘッダが欠落し、ブラウザ側が詳細を読めない問題を回避）
import re as _re


def _origin_allowed(origin: Optional[str]) -> bool:
    if not origin:
        return False
    if origin in allowed_origins:
        return True
    if origin_regex:
        try:
            return bool(_re.match(origin_regex, origin))
        except Exception:
            return False
    return False


def _cors_headers_for(request: Request) -> Dict[str, str]:
    origin = request.headers.get("origin")
    if _origin_allowed(origin):
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
        }
    return {}


@app.middleware("http")
async def _ensure_cors_on_exception(request, call_next):
    try:
        response = await call_next(request)
    except Exception:
        from fastapi.responses import JSONResponse
        response = JSONResponse({"detail": "Internal Server Error"}, status_code=500)
    try:
        for k, v in _cors_headers_for(request).items():
            response.headers[k] = v
    except Exception:
        pass
    return response

# --- ディレクトリ設定 (GCS移行後も一部はローカルで利用) ---
BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploaded_pdfs" # GCS移行後は主に一時領域として利用
PNG_DIR = BASE_DIR / "processing_pngs"
MD_DIR = BASE_DIR / "processing_mds"
PROBLEM_DIR = BASE_DIR / "問題_模範解答_オリジナル"
REVIEWS_DIR = BASE_DIR / "processing_reviews"
CACHE_DIR = BASE_DIR / "processing_cache"
ANNO_DIR = BASE_DIR / "annotations"
EXPORTS_DIR = BASE_DIR / "processing_exports"
STATE_DIR = BASE_DIR / "processing_state"
FAV_PATH = BASE_DIR / "favorites.json"
SIGNATURE_DIR = BASE_DIR / "signatures"


def _public_base_url(request: Request) -> str:
    """Reverse-proxy aware base URL builder for absolute links."""
    proto = request.headers.get("X-Forwarded-Proto") or request.url.scheme
    host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host")
    if host:
        port = request.headers.get("X-Forwarded-Port")
        if port and ':' not in host and port not in {"80", "443"}:
            host = f"{host}:{port}"
        return f"{proto}://{host}".rstrip('/')
    return str(request.base_url).rstrip('/')

# 必要なディレクトリを作成
UPLOAD_DIR.mkdir(exist_ok=True)
PNG_DIR.mkdir(exist_ok=True)
MD_DIR.mkdir(exist_ok=True)
REVIEWS_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)
ANNO_DIR.mkdir(exist_ok=True)
STATE_DIR.mkdir(exist_ok=True)
EXPORTS_DIR.mkdir(exist_ok=True)
SIGNATURE_DIR.mkdir(exist_ok=True)
if not FAV_PATH.exists():
    try:
        import json as _json
        FAV_PATH.write_text(_json.dumps({"global": [], "problems": {}}, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass

# 画像（PNG）を静的配信
app.mount("/static/pngs", StaticFiles(directory=str(PNG_DIR), html=False), name="pngs")
# 問題・採点基準を静的配信
app.mount("/static/problems", StaticFiles(directory=str(PROBLEM_DIR), html=False), name="problems")
# 署名スタンプを静的配信
app.mount("/static/signatures", StaticFiles(directory=str(SIGNATURE_DIR), html=False), name="signatures")

# --- サーバー起動時の処理 ---
@app.on_event("startup")
async def on_startup():
    """サーバー起動時にファイルシステムとDBを同期する"""
    await asyncio.to_thread(sync_db_with_filesystem)
    if bucket:
        try:
            manifest = await _load_gcs_problem_manifest()
            for uni, exams in manifest.items():
                for et in exams.keys():
                    await _ensure_local_problem_dir(uni, et)
        except Exception:
            # manifest取得に失敗しても起動は継続する
            pass
    try:
        await _sync_signatures_from_gcs()
    except Exception:
        pass

# -------- Favorites (Comments) --------
def _fav_read():
    import json as _json
    try:
        return _json.loads(FAV_PATH.read_text("utf-8"))
    except Exception:
        return {"global": [], "problems": {}}

def _fav_write(data):
    import json as _json
    try:
        FAV_PATH.write_text(_json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        return True
    except Exception:
        return False

def _fav_new_id():
    import time, random, string
    ts = int(time.time() * 1000)
    rnd = ''.join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"fav_{ts}_{rnd}"

@app.get("/favorites")
async def get_favorites(category: Optional[str] = None, exam_type: Optional[str] = None, question: Optional[str] = None):
    data = _fav_read()
    glb = data.get('global') or []
    prob = []
    if category and exam_type:
        key = f"{category}/{exam_type}"
        prob = (data.get('problems') or {}).get(key, [])
        # Optionally filter by question if provided (currently store without question)
    return { 'global': glb, 'problem': prob }

@app.post("/favorites/add")
async def add_favorite(payload: Dict = Body(...)):
    scope = (payload.get('scope') or 'global').lower()
    text = (payload.get('text') or '').strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    # Optional points for score marker combo
    points = payload.get('points', None)
    if points is not None:
        try:
            points = int(points)
        except Exception:
            raise HTTPException(status_code=400, detail="points must be integer")
        if points < 0 or points > 200:
            raise HTTPException(status_code=400, detail="points must be between 0 and 200")
    data = _fav_read()
    item = { 'id': _fav_new_id(), 'text': text }
    if points is not None:
        item['points'] = points
    if scope == 'global':
        data.setdefault('global', []).append(item)
    else:
        category = payload.get('category')
        exam_type = payload.get('exam_type')
        if not category or not exam_type:
            raise HTTPException(status_code=400, detail="category and exam_type required for problem scope")
        key = f"{category}/{exam_type}"
        probs = data.setdefault('problems', {})
        probs.setdefault(key, []).append(item)
    if not _fav_write(data):
        raise HTTPException(status_code=500, detail="failed to persist favorites")
    return { 'id': item['id'] }

@app.post("/favorites/delete")
async def delete_favorite(payload: Dict = Body(...)):
    fid = payload.get('id')
    if not fid:
        raise HTTPException(status_code=400, detail="id required")
    data = _fav_read()
    changed = False
    # remove from global
    glb = data.get('global') or []
    ng = [it for it in glb if it.get('id') != fid]
    if len(ng) != len(glb):
        data['global'] = ng
        changed = True
    # remove from problems
    probs = data.get('problems') or {}
    for k, arr in list(probs.items()):
        na = [it for it in (arr or []) if it.get('id') != fid]
        if len(na) != len(arr):
            probs[k] = na
            changed = True
    if not changed:
        return { 'deleted': False }
    if not _fav_write(data):
        raise HTTPException(status_code=500, detail="failed to persist favorites")
    return { 'deleted': True }

@app.post("/favorites/update")
async def update_favorite(payload: Dict = Body(...)):
    fid = payload.get('id')
    text_raw = payload.get('text')
    # distinguish between missing vs explicit null
    points_raw = payload.get('points', None)
    if not fid:
        raise HTTPException(status_code=400, detail="id required")
    # Normalize fields; allow updating either or both
    text: Optional[str] = None
    if text_raw is not None:
        text = (str(text_raw) or '').strip()
        if not text:
            raise HTTPException(status_code=400, detail="text must be non-empty when provided")
    has_points_field = ('points' in payload)
    if has_points_field and points_raw is not None:
        try:
            points_val = int(points_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="points must be integer")
        if points_val < 0 or points_val > 200:
            raise HTTPException(status_code=400, detail="points must be between 0 and 200")
    data = _fav_read()
    changed = False
    for it in (data.get('global') or []):
        if it.get('id') == fid:
            if text is not None:
                it['text'] = text
            if has_points_field:
                if points_raw is None:
                    it.pop('points', None)
                else:
                    it['points'] = points_val
            changed = True
            break
    if not changed:
        probs = data.get('problems') or {}
        for k, arr in list(probs.items()):
            for it in (arr or []):
                if it.get('id') == fid:
                    if text is not None:
                        it['text'] = text
                    if has_points_field:
                        if points_raw is None:
                            it.pop('points', None)
                        else:
                            it['points'] = points_val
                    changed = True
                    break
            if changed:
                break
    if not changed:
        raise HTTPException(status_code=404, detail="favorite not found")
    if not _fav_write(data):
        raise HTTPException(status_code=500, detail="failed to persist favorites")
    return { 'updated': True }

# --- APIエンドポイント ---
@app.get("/answers")
async def get_answers():
    """答案のリストを返す"""
    sync_db_with_filesystem()
    # enrich with persisted editing time
    out = []
    for fname, data in answers_db.items():
        try:
            stem = Path(fname).stem
            st = _state_io(stem)
            if isinstance(st, dict) and 'editing_time_seconds' in st:
                data.setdefault('editing_time_seconds', int(st.get('editing_time_seconds') or 0))
            # ローカルstateの情報で不足分を補完
            if isinstance(st, dict):
                for k in ("quality", "details", "problem_path", "review_path", "exam_type"):
                    if k in st and st[k] is not None and not data.get(k):
                        data[k] = st[k]
            # ステータスの自動補正: 既にレビュー成果物があれば「AI添削完了」を優先（完了/処理中/エラー以外）
            status_str = str(data.get('status') or '').strip()
            is_busy = any(k in status_str for k in ("処理中", "再処理中", "エラー"))
            is_done = (status_str == "添削完了")
            review_in_mem = isinstance(data.get('review'), dict)
            review_on_disk = (REVIEWS_DIR / f"{stem}.json").exists()
            if not is_busy and not is_done and (review_in_mem or review_on_disk):
                data['status'] = 'AI添削完了'
        except Exception:
            pass
        out.append({"filename": fname, **data})
    return {"answers": out}

@app.post("/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    """答案ファイルをアップロードする"""
    import datetime
    if not bucket:
        raise HTTPException(status_code=500, detail="GCS bucket is not configured.")

    for file in files:
        try:
            contents = await file.read()
            # GCSにアップロード
            blob = bucket.blob(f"uploaded_pdfs/{file.filename}")
            blob.upload_from_string(contents, content_type=file.content_type)
            
            answers_db[file.filename] = {
                "status": "未処理",
                "uploaded_at": datetime.datetime.now().isoformat(timespec='seconds'),
                "gcs_path": f"gs://{GCS_BUCKET_NAME}/uploaded_pdfs/{file.filename}"
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Could not upload file: {file.filename}, error: {str(e)}")
        finally:
            await file.close()
    return {"message": f"Successfully uploaded {len(files)} files to GCS"}

@app.delete("/answers/{filename}")
async def delete_answer(filename: str):
    """答案ファイルと関連する成果物をGCSから削除する"""
    if not bucket:
        raise HTTPException(status_code=500, detail="GCS bucket is not configured.")

    stem = Path(filename).stem
    
    # 削除対象のGCSプレフィックス/オブジェクト
    paths_to_delete = [
        f"uploaded_pdfs/{filename}",
        f"processing_pngs/{stem}/",
        f"processing_mds/{stem}.md",
        f"annotations/{stem}.json",
        f"processing_reviews/{stem}.json",
        f"processing_state/{stem}.json",
        f"processing_cache/{stem}.quality.json",
        f"processing_exports/{stem}_annotated.pdf",
    ]

    try:
        for path in paths_to_delete:
            if path.endswith('/'): # プレフィックス
                blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=path)
                for blob in blobs:
                    await asyncio.to_thread(blob.delete)
            else: # 単一オブジェクト
                blob = bucket.blob(path)
                if await asyncio.to_thread(blob.exists):
                    await asyncio.to_thread(blob.delete)

        # メモリDBからも削除
        if filename in answers_db:
            del answers_db[filename]
        
        # sync_db_with_filesystem() はGCSベースで再実装が必要なため、一旦コメントアウト
        # sync_db_with_filesystem() 
        
        return {"message": f"Deleted {filename} and related artifacts from GCS"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting files from GCS: {e}")

USE_SIGNED_URLS = (os.getenv("USE_SIGNED_URLS", "true").lower() in {"1","true","yes","on"})

@app.get("/answers/{filename}/pages")
async def get_answer_pages(filename: str, request: Request):
    """答案のページ画像URL一覧を返す。"""
    import datetime
    pdf_stem = Path(filename).stem

    if not bucket:
        target_dir = PNG_DIR / pdf_stem
        if not await asyncio.to_thread(target_dir.exists):
            raise HTTPException(status_code=404, detail="Pages not found")
        files = await asyncio.to_thread(lambda: sorted([p for p in target_dir.glob("*.png") if p.is_file()], key=lambda p: p.name))
        if not files:
            raise HTTPException(status_code=404, detail="Pages not found")
        from urllib.parse import quote
        base = _public_base_url(request)
        urls = [f"{base}/static/pngs/{quote(str(p.relative_to(PNG_DIR)), safe='/')}" for p in files]
        return {"pages": urls}

    prefix = f"processing_pngs/{pdf_stem}/"

    try:
        blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix)
        # ファイル名でソート
        sorted_blobs = sorted(blobs, key=lambda b: b.name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list GCS blobs: {e}")

    urls = []
    # 画像ファイルのみ対象
    png_blobs = [b for b in sorted_blobs if b.name.lower().endswith('.png')]
    try:
        if USE_SIGNED_URLS:
            for blob in png_blobs:
                signed_url = blob.generate_signed_url(
                    version="v4",
                    expiration=datetime.timedelta(minutes=15),
                    method="GET",
                )
                urls.append(signed_url)
        else:
            # 署名なし: バックエンド経由のプロキシURLを返す（並び順維持のためファイル名順）
            base = _public_base_url(request)
            from urllib.parse import quote
            for blob in png_blobs:
                fname = blob.name.split('/')[-1]
                urls.append(f"{base}/answers/{quote(filename)}/page/{quote(fname)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate page URLs: {e}")

    if not urls:
        raise HTTPException(status_code=404, detail="Pages not found in GCS")

    return {"pages": urls}

@app.get("/answers/{filename}/page/{image_name}")
async def get_answer_page_image(filename: str, image_name: str, request: Request):
    """PNG画像をGCSから読み出してストリーミング返却（署名URLを使わないモード用）。"""
    stem = Path(filename).stem
    # セキュリティ: 画像ファイル名はベース名のみ許容
    name = os.path.basename(image_name)
    if not name.lower().endswith('.png'):
        raise HTTPException(status_code=400, detail="Only PNG is supported")
    headers = _cors_headers_for(request)
    if not bucket:
        path = PNG_DIR / stem / name
        if not await asyncio.to_thread(path.exists):
            raise HTTPException(status_code=404, detail="Image not found")
        return FileResponse(path, headers=headers)
    gcs_path = f"processing_pngs/{stem}/{name}"
    try:
        blob = bucket.blob(gcs_path)
        if not await asyncio.to_thread(blob.exists):
            raise HTTPException(status_code=404, detail="Image not found")
        # download as bytes iterator
        data = await asyncio.to_thread(blob.download_as_bytes)
        return StreamingResponse(iter([data]), media_type="image/png", headers=headers)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch image: {e}")

@app.get("/answers/{filename}/annotations")
async def get_annotations(filename: str):
    pdf_stem = Path(filename).stem
    if not bucket:
        import json
        anno_path = ANNO_DIR / f"{pdf_stem}.json"
        if await asyncio.to_thread(anno_path.exists):
            try:
                text = await asyncio.to_thread(anno_path.read_text, "utf-8")
                return json.loads(text)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to read annotations: {e}")
        return {"boxes": []}

    gcs_path = f"annotations/{pdf_stem}.json"

    blob = bucket.blob(gcs_path)
    if await asyncio.to_thread(blob.exists):
        try:
            text = await asyncio.to_thread(blob.download_as_text)
            import json
            data = json.loads(text)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read annotations from GCS: {e}")
    else:
        data = {"boxes": []}
    return data

@app.post("/answers/{filename}/annotations")
async def save_annotations(filename: str, payload: Dict = Body(...)):
    pdf_stem = Path(filename).stem
    if not bucket:
        import json
        anno_path = ANNO_DIR / f"{pdf_stem}.json"
        await asyncio.to_thread(ANNO_DIR.mkdir, parents=True, exist_ok=True)
        try:
            content = json.dumps(payload, ensure_ascii=False, indent=2)
            await asyncio.to_thread(anno_path.write_text, content, "utf-8")
            if filename in answers_db:
                answers_db[filename]["annotations"] = payload
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to save annotations: {e}")
        return {"message": "Saved"}

    gcs_path = f"annotations/{pdf_stem}.json"

    try:
        import json
        content = json.dumps(payload, ensure_ascii=False, indent=2)
        blob = bucket.blob(gcs_path)
        await asyncio.to_thread(blob.upload_from_string, content, content_type="application/json")

        if filename in answers_db:
            answers_db[filename]["annotations"] = payload
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save annotations to GCS: {e}")
    return {"message": "Saved"}

@app.get("/answers/{filename}/problem_assets")
async def get_problem_assets(filename: str):
    """問題・採点基準の資産一覧（PDF/画像/テキスト）を返す。"""
    from pathlib import PurePosixPath
    stem = Path(filename).stem
    if filename not in answers_db or not answers_db[filename].get("problem_path"):
        return {"assets": []}
    base = Path(answers_db[filename]["problem_path"])
    if not await asyncio.to_thread(base.exists):
        return {"assets": []}
    files = await asyncio.to_thread(lambda: sorted([p for p in base.glob("**/*") if p.is_file()]))
    # Answer.mdを最優先、ついでに採点基準/解答/模範を優先
    try:
        def _prio(p: Path):
            n = p.name.lower()
            if n in ("answer.md", "answers.md"):
                return (0, n)
            if ("採点" in p.name or "採点基準" in p.name or "解答" in p.name or "模範" in p.name):
                return (1, n)
            ext = p.suffix.lower()
            if ext in {".md", ".txt"}: return (2, n)
            if ext == ".pdf": return (3, n)
            if ext in {".png", ".jpg", ".jpeg"}: return (4, n)
            return (9, n)
        files.sort(key=_prio)
    except Exception:
        pass
    assets = []
    for p in files:
        ext = p.suffix.lower()
        if ext in {".pdf", ".png", ".jpg", ".jpeg", ".md", ".txt"}:
            try:
                rel = p.resolve().relative_to(PROBLEM_DIR.resolve())
            except Exception:
                # PROBLEM_DIR外は配信しない
                continue
            url = f"/static/problems/{PurePosixPath(rel)}"
            kind = "text" if ext in {".md", ".txt"} else ("image" if ext in {".png", ".jpg", ".jpeg"} else "pdf")
            assets.append({"name": p.name, "url": url, "type": kind, "path": str(p.resolve())})
    return {"assets": assets}

@app.get("/answers/{filename}/problem_text")
async def get_problem_text(filename: str, question: Optional[int] = None):
    """問題・採点基準のテキスト要約（md/txt全文 + PDFテキスト抽出の先頭部分）"""
    from processing import extract_text_from_pdf_sync
    import textwrap
    stem = Path(filename).stem
    if filename not in answers_db or not answers_db[filename].get("problem_path"):
        raise HTTPException(status_code=404, detail="Problem path not set")
    base = Path(answers_db[filename]["problem_path"])
    if not await asyncio.to_thread(base.exists):
        raise HTTPException(status_code=404, detail="Problem directory not found")
    texts = []
    files = await asyncio.to_thread(lambda: sorted([p for p in base.glob("**/*") if p.is_file()]))
    # Prefer curated Answer.md if requesting a specific question
    if question is not None:
        try:
            # Search for Answer_Q{n}.md first
            cand_q = [p for p in files if p.name.lower() in {f"answer_q{question}.md", f"answers_q{question}.md"}]
            if cand_q:
                p = cand_q[0]
                try:
                    txt = await asyncio.to_thread(p.read_text, "utf-8")
                    return {"text": txt[:20000]}
                except Exception:
                    pass
            # Fallback: Answer.md / Answers.md and slice by heading
            cand_all = [p for p in files if p.name.lower() in {"answer.md", "answers.md"}]
            if cand_all:
                mdp = cand_all[0]
                try:
                    md = await asyncio.to_thread(mdp.read_text, "utf-8")
                except Exception:
                    md = ""
                if md:
                    # Slice section for the question by headings like 第6問/大問6/問6/Q6
                    import re
                    q = int(question)
                    lines = md.splitlines()
                    # Build regex for any heading line (# ... or plain) containing the target
                    pat = re.compile(rf"^(#+\s*)?.*?(第\s*{q}\s*問|大問\s*{q}|問\s*{q}|Q\s*{q})\b", re.IGNORECASE)
                    idx = None
                    for i, line in enumerate(lines):
                        if pat.search(line):
                            idx = i
                            break
                    if idx is not None:
                        # Find next heading start (line beginning with # or a line containing 第<k>問 etc for other questions)
                        next_idx = None
                        pat_next = re.compile(r"^(#+\s*.+)|.*?(第\s*\d+\s*問|大問\s*\d+|問\s*\d+|Q\s*\d+)\b", re.IGNORECASE)
                        for j in range(idx+1, len(lines)):
                            if pat_next.search(lines[j]):
                                next_idx = j
                                break
                        section = "\n".join(lines[idx: next_idx if next_idx is not None else len(lines)])
                        return {"text": section[:20000]}
        except Exception:
            # Fall back to generic behavior below
            pass
    for p in files:
        ext = p.suffix.lower()
        try:
            if ext in {".md", ".txt"}:
                txt = await asyncio.to_thread(p.read_text, "utf-8")
                texts.append(f"[FILE:{p.name}]\n{txt}")
            elif ext == ".pdf":
                txt = await asyncio.to_thread(extract_text_from_pdf_sync, p, 4000)
                if txt.strip():
                    texts.append(f"[FILE:{p.name}]\n{txt}")
                else:
                    note = "[NOTE] このPDFは画像ベースの可能性があり、テキスト抽出できませんでした。採点基準/解答例として参照してください。"
                    if ("採点" in p.name or "基準" in p.name or "解答" in p.name or "模範" in p.name):
                        texts.append(f"[FILE:{p.name}]\n{note}")
        except Exception:
            continue
    return {"text": "\n\n".join(texts)[:20000]}

def _state_io(stem: str, update: Dict = None) -> Dict:
    """Load/update processing_state/<stem>.json"""
    state_dir = BASE_DIR / "processing_state"
    state_dir.mkdir(exist_ok=True)
    import json
    p = state_dir / f"{stem}.json"
    data = {}
    if p.exists():
        try:
            data = json.loads(p.read_text("utf-8"))
        except Exception:
            data = {}
    if update:
        data.update(update)
        try:
            p.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        except Exception:
            pass
    return data

@app.get("/problems/index")
async def get_problems_index():
    """利用可能な問題セット（大学/試験種）の一覧を返す"""
    index = defaultdict(set)

    if await asyncio.to_thread(PROBLEM_DIR.exists):
        unis = await asyncio.to_thread(lambda: [p for p in PROBLEM_DIR.iterdir() if p.is_dir()])
        for uni_path in unis:
            exam_types = await asyncio.to_thread(lambda: [p.name for p in uni_path.iterdir() if p.is_dir()])
            for et in exam_types:
                index[uni_path.name].add(et)

    if bucket:
        try:
            manifest = await _load_gcs_problem_manifest()
            for uni, exams in manifest.items():
                if exams:
                    for et in exams.keys():
                        index[uni].add(et)
                else:
                    index.setdefault(uni, set())
        except Exception:
            # GCS列挙に失敗した場合はローカルのみ返す
            pass

    universities = {uni: sorted(exams) for uni, exams in sorted(index.items(), key=lambda x: x[0])}
    return {"universities": universities}


@app.get("/curation/coverage")
async def get_curation_coverage(university: Optional[str] = None):
    """
    問題資産ディレクトリ配下のMD整備状況を返す。
    返却例: { coverage: { <大学>: { <試験種>: { answer_md: bool, answers_q: [int...] } } } }
    """
    import re

    cov: Dict[str, Dict[str, Dict[str, object]]] = {}
    manifest: Dict[str, Dict[str, List[str]]] = {}
    uni_filter: Optional[str] = None

    if university:
        try:
            uni_filter = _normalize_segment(university)
        except ValueError:
            return {"coverage": {}}

    if bucket:
        try:
            manifest = await _load_gcs_problem_manifest(uni_filter)
        except Exception:
            manifest = {}

    local_unis = set()
    if await asyncio.to_thread(PROBLEM_DIR.exists):
        unis = await asyncio.to_thread(lambda: [p for p in PROBLEM_DIR.iterdir() if p.is_dir()])
        local_unis = {p.name for p in unis}

    target_unis = local_unis.union(manifest.keys())
    if uni_filter:
        target_unis = {u for u in target_unis if u == uni_filter}

    for uni_name in sorted(target_unis):
        exam_set = set()
        uni_dir = PROBLEM_DIR / uni_name
        if await asyncio.to_thread(uni_dir.exists):
            local_exam_dirs = await asyncio.to_thread(lambda: [p for p in uni_dir.iterdir() if p.is_dir()])
            exam_set.update(p.name for p in local_exam_dirs)
        exam_set.update((manifest.get(uni_name) or {}).keys())
        if not exam_set:
            continue
        cov.setdefault(uni_name, {})
        for et_name in sorted(exam_set):
            try:
                target_dir = await _sync_problem_dir_from_gcs(uni_name, et_name)
            except HTTPException:
                continue
            if not await asyncio.to_thread(target_dir.exists):
                cov[uni_name][et_name] = {"answer_md": False, "answers_q": []}
                continue
            files = await asyncio.to_thread(lambda: [p.name for p in target_dir.iterdir() if p.is_file()])
            has_answer = any(n.lower() in {"answer.md", "answers.md"} for n in files)
            q_nums = []
            for n in files:
                m = re.search(r"^answer_q(\d+)\.md$", n, re.IGNORECASE)
                if m:
                    try:
                        q_nums.append(int(m.group(1)))
                    except Exception:
                        pass
            q_nums = sorted(set(q_nums))
            cov[uni_name][et_name] = {"answer_md": has_answer, "answers_q": q_nums}
    return {"coverage": cov}


@app.post("/curation/exam_type")
async def create_exam_type(payload: Dict = Body(...)):
    """新しい試験種のディレクトリを作成する（大学に限らない任意のカテゴリ配下）。"""
    # UIでは「カテゴリー」として扱う（従来のuniversity）。
    university = payload.get("university")
    exam_type = payload.get("exam_type")

    if not university or not exam_type:
        raise HTTPException(status_code=400, detail="University(category) and exam_type are required")

    # Basic validation for security: 禁止はパス区切りのみ（/や\）。
    import re
    if not re.match(r"^[^/\\]+$", str(university)) or not re.match(r"^[^/\\]+$", str(exam_type)):
        raise HTTPException(status_code=400, detail="Invalid characters in category or exam_type")

    try:
        uni_norm = _normalize_segment(university)
        exam_norm = _normalize_segment(exam_type)
        target_dir = PROBLEM_DIR / uni_norm / exam_norm
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid category or exam_type")

    exists_locally = await asyncio.to_thread(target_dir.exists)
    exists_on_gcs = False
    if bucket:
        try:
            manifest = await _load_gcs_problem_manifest(uni_norm)
            exists_on_gcs = exam_norm in (manifest.get(uni_norm) or {})
        except Exception:
            exists_on_gcs = False
    if exists_locally or exists_on_gcs:
        raise HTTPException(status_code=409, detail="Exam type already exists")

    try:
        await _ensure_local_problem_dir(university, exam_type)
        await _ensure_exam_placeholder_on_gcs(university, exam_type)
        return {"message": f"Successfully created exam type: {university}/{exam_type}"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create exam type: {e}")


@app.delete("/curation/exam_type")
async def delete_exam_type(payload: Dict = Body(...)):
    university = payload.get("university")
    exam_type = payload.get("exam_type")

    if not university or not exam_type:
        raise HTTPException(status_code=400, detail="University(category) and exam_type are required")

    try:
        uni_norm = _normalize_segment(university)
        exam_norm = _normalize_segment(exam_type)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid category or exam_type")

    target_dir = PROBLEM_DIR / uni_norm / exam_norm
    local_exists = await asyncio.to_thread(target_dir.exists)

    prefix = _gcs_problem_prefix(university, exam_type)
    gcs_exists = False
    if bucket:

        def _check_prefix() -> bool:
            iterator = storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix, max_results=1)
            for _ in iterator:
                return True
            return False

        gcs_exists = await asyncio.to_thread(_check_prefix)

    if not local_exists and not gcs_exists:
        raise HTTPException(status_code=404, detail="Exam type not found")

    if local_exists:
        try:
            await asyncio.to_thread(shutil.rmtree, target_dir)
        except FileNotFoundError:
            pass
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete local exam directory: {e}")
        # Cleanup parent directory if empty
        try:
            parent = target_dir.parent
            if parent.exists() and parent != PROBLEM_DIR and not any(parent.iterdir()):
                await asyncio.to_thread(parent.rmdir)
        except Exception:
            pass

    if bucket:
        await _delete_gcs_prefix(prefix)

    return {"message": f"Deleted exam type: {university}/{exam_type}"}


@app.post("/curation/upload")
async def upload_curation_files(
    files: List[UploadFile] = File(...),
    university: str = File(...),
    exam_type: str = File(...)
):
    """キュレーション対象のファイルを指定の試験種ディレクトリにアップロードする"""
    if not university or not exam_type:
        raise HTTPException(status_code=400, detail="University and exam_type are required")

    try:
        uni_norm = _normalize_segment(university)
        exam_norm = _normalize_segment(exam_type)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid category or exam_type")

    target_dir = PROBLEM_DIR / uni_norm / exam_norm
    exists_locally = await asyncio.to_thread(target_dir.exists)
    exists_on_gcs = False
    if bucket and not exists_locally:
        try:
            manifest = await _load_gcs_problem_manifest(uni_norm)
            exists_on_gcs = exam_norm in (manifest.get(uni_norm) or {})
        except Exception:
            exists_on_gcs = False
    if not exists_locally and not exists_on_gcs:
        try:
            target_dir = await _ensure_local_problem_dir(university, exam_type)
            await _ensure_exam_placeholder_on_gcs(university, exam_type)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to prepare exam type: {e}")
    else:
        target_dir = await _ensure_local_problem_dir(university, exam_type)

    uploaded_files = []
    for file in files:
        filename = _safe_filename(file.filename)
        if not filename:
            await file.close()
            continue
        try:
            contents = await file.read()
            dest = target_dir / filename
            await asyncio.to_thread(dest.parent.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(dest.write_bytes, contents)
            await _upload_problem_bytes_to_gcs(university, exam_type, filename, contents, file.content_type)
            uploaded_files.append(filename)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Could not upload file: {filename}, error: {str(e)}")
        finally:
            await file.close()

    return {"message": f"Successfully uploaded {len(uploaded_files)} files", "uploaded_files": uploaded_files}


@app.delete("/curation/asset")
async def delete_curation_asset(payload: Dict = Body(...)):
    university = payload.get("university")
    exam_type = payload.get("exam_type")
    filename = payload.get("filename")

    if not university or not exam_type or not filename:
        raise HTTPException(status_code=400, detail="University, exam_type and filename are required")

    try:
        uni_norm = _normalize_segment(university)
        exam_norm = _normalize_segment(exam_type)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid university or exam_type")

    safe_name = _safe_filename(filename)
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid filename")

    target_dir = PROBLEM_DIR / uni_norm / exam_norm
    local_path = target_dir / safe_name
    local_exists = await asyncio.to_thread(local_path.exists)

    gcs_exists = False
    gcs_path = _gcs_problem_object_path(university, exam_type, safe_name)
    if bucket:

        def _check_blob() -> bool:
            blob = bucket.blob(gcs_path)
            try:
                return blob.exists()
            except Exception:
                return False

        gcs_exists = await asyncio.to_thread(_check_blob)

    if not local_exists and not gcs_exists:
        raise HTTPException(status_code=404, detail="Asset not found")

    if local_exists:
        try:
            await asyncio.to_thread(local_path.unlink)
        except FileNotFoundError:
            pass
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete local file: {e}")

    if bucket:

        def _delete_blob():
            blob = bucket.blob(gcs_path)
            try:
                blob.delete()
            except Exception:
                pass

        await asyncio.to_thread(_delete_blob)

    # Clean up empty directories locally (exam dir and parent category)
    try:
        def _cleanup():
            if target_dir.exists() and not any(target_dir.iterdir()):
                target_dir.rmdir()
                parent = target_dir.parent
                if parent.exists() and parent != PROBLEM_DIR and not any(parent.iterdir()):
                    parent.rmdir()

        await asyncio.to_thread(_cleanup)
    except Exception:
        pass

    return {"message": f"Deleted asset: {safe_name}"}


@app.post("/curation/build_md")
async def build_curation_md(payload: Dict = Body(...)):
    """
    問題ディレクトリ内のPDF/MD/TXTから参照用Markdown(Answer.md もしくは Answer_Qn.md)の雛形を生成する。
    入力: { university, exam_type, question?: int, mode?: 'merge'|'rubric'|'problem', title?: string }
    出力: { message, output_file }
    """
    import re
    import datetime

    university = payload.get("university")
    exam_type = payload.get("exam_type")
    mode = (payload.get("mode") or "merge").lower()
    use_ai = bool(payload.get("use_ai", False))
    title = payload.get("title")
    question = payload.get("question")

    if not university or not exam_type:
        raise HTTPException(status_code=400, detail="University and exam_type are required")

    try:
        uni_norm = _normalize_segment(university)
        exam_norm = _normalize_segment(exam_type)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid university or exam_type")

    target_dir = PROBLEM_DIR / uni_norm / exam_norm
    exists_locally = await asyncio.to_thread(target_dir.exists)
    exists_on_gcs = False
    if bucket and not exists_locally:
        try:
            manifest = await _load_gcs_problem_manifest(uni_norm)
            exists_on_gcs = exam_norm in (manifest.get(uni_norm) or {})
        except Exception:
            exists_on_gcs = False
    if not exists_locally and not exists_on_gcs:
        raise HTTPException(status_code=404, detail="Target directory not found")

    target_dir = await _sync_problem_dir_from_gcs(university, exam_type)
    files = await asyncio.to_thread(lambda: sorted([p for p in target_dir.iterdir() if p.is_file()]))

    # Decide output filename
    out_name: str
    if isinstance(question, int):
        out_name = f"Answer_Q{question}.md"
    else:
        out_name = "Answer.md"

    # Priority for merging: curated md/txt first, then PDFs
    def _prio(p: Path):
        n = p.name.lower()
        # skip the output file itself to avoid recursion
        if n == out_name.lower():
            return (99, n)
        if re.search(r"answer_q\d+\.md", n):
            return (0, n)
        if n in ("answer.md", "answers.md"):
            return (1, n)
        if ("採点" in p.name or "採点基準" in p.name or "解答" in p.name or "模範" in p.name):
            return (2, n)
        ext = p.suffix.lower()
        if ext in {".md", ".txt"}:
            return (3, n)
        if ext == ".pdf":
            return (4, n)
        return (9, n)

    files.sort(key=_prio)

    # Helper: try slicing a big MD to section for a question number
    def _slice_md_for_question(md_text: str, q: int) -> str:
        try:
            import re as _re
            lines = md_text.splitlines()
            pat = _re.compile(rf"^(#+\s*)?.*?(第\s*{q}\s*問|大問\s*{q}|問\s*{q}|Q\s*{q})\b", _re.IGNORECASE)
            idx = None
            for i, line in enumerate(lines):
                if pat.search(line):
                    idx = i
                    break
            if idx is None:
                return ""
            pat_next = _re.compile(r"^(#+\s*.+)|.*?(第\s*\d+\s*問|大問\s*\d+|問\s*\d+|Q\s*\d+)\b", _re.IGNORECASE)
            next_idx = None
            for j in range(idx+1, len(lines)):
                if pat_next.search(lines[j]):
                    next_idx = j
                    break
            return "\n".join(lines[idx: next_idx if next_idx is not None else len(lines)])
        except Exception:
            return ""

    parts: List[str] = []
    header_title = title or (f"{university} {exam_type} 参照用Markdown" if not isinstance(question, int) else f"{university} {exam_type} 大問{question} 参照用Markdown")
    today = datetime.date.today().isoformat()
    parts.append("---")
    parts.append(f"title: {header_title}")
    parts.append(f"version: {today}")
    parts.append("---\n")
    parts.append(f"# {header_title}\n")
    if isinstance(question, int):
        parts.append(f"## 大問{question}\n")

    # Collect text by priority, applying simple heuristics
    q = int(question) if isinstance(question, int) else None
    collected_for_ai: List[Dict[str, str]] = []
    for p in files:
        # Skip output file and non-text/image
        ext = p.suffix.lower()
        if p.name == out_name:
            continue
        if ext in {".md", ".txt"}:
            try:
                txt = await asyncio.to_thread(p.read_text, "utf-8")
                if q is not None:
                    # If this is a per-question output, try to slice
                    sliced = _slice_md_for_question(txt, q)
                    content = sliced or txt
                else:
                    content = txt
                content = content.strip()
                if content:
                    parts.append(f"## [FILE:{p.name}]\n")
                    parts.append(content + "\n")
                    collected_for_ai.append({
                        "name": p.name,
                        "kind": "md" if ext==".md" else "txt",
                        "text": content,
                        "path": str(p),
                    })
            except Exception:
                continue
        elif ext == ".pdf":
            try:
                # If question specified, only include PDFs likely related to that question
                if q is not None:
                    name = p.name
                    if not re.search(rf"(第{q}問|大問{q}|問{q}|Q\s*{q})", name):
                        # skip unrelated PDFs to keep it short
                        continue
                txt = await asyncio.to_thread(extract_text_from_pdf_sync, p, 16000)
                if txt.strip():
                    parts.append(f"## [FILE:{p.name}]\n")
                    parts.append(txt.strip() + "\n")
                    collected_for_ai.append({
                        "name": p.name,
                        "kind": "pdf",
                        "text": txt,  # fallback if file upload is unavailable
                        "path": str(p),
                    })
                else:
                    # add a note if likely rubric/answer
                    if ("採点" in p.name or "基準" in p.name or "解答" in p.name or "模範" in p.name):
                        parts.append(f"## [FILE:{p.name}]\n")
                        parts.append("[NOTE] このPDFは画像ベースの可能性があり、テキスト抽出できませんでした。内容を参照しつつ必要箇所を手動で補ってください。\n")
                    # Still pass the PDF path to AI for direct ingestion
                    collected_for_ai.append({
                        "name": p.name,
                        "kind": "pdf",
                        "text": "",  # no OCR text
                        "path": str(p),
                    })
            except Exception:
                continue

    # If no body collected, seed with a template
    body = "\n".join(parts).strip()
    if len(body.splitlines()) <= 6:
        # minimal template
        tmpl = [
            "## 問題文 (要約/貼り付け)",
            "",
            "ここに問題文または要約を記載します。",
            "",
            "## 採点基準 / 解答要点",
            "",
            "ここに採点基準や解答要点を記載します。",
        ]
        if isinstance(question, int):
            tmpl.insert(0, f"### 大問{question}")
        body = "\n".join(parts + ["\n"] + tmpl)

    # If AI mode requested, build with Gemini
    if use_ai:
        try:
            from gemini_utils import generate_curated_answer_md
            ai_md = await generate_curated_answer_md(
                collected_for_ai,
                university=university,
                exam_type=exam_type,
                question=q,
                title=title,
            )
            if ai_md and len(ai_md.strip()) > 0:
                body = ai_md
        except Exception as e:
            # Fallback to non-AI body
            print(f"[build_md] AI curation failed: {e}; fallback to heuristic merge.")

    # Write out
    out_path = target_dir / out_name
    try:
        await asyncio.to_thread(out_path.write_text, body, "utf-8")
        await _upload_problem_file_to_gcs(university, exam_type, out_path, content_type="text/markdown")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write {out_name}: {e}")

    return {"message": f"Generated {out_name}", "output_file": out_name}


@app.post("/curation/batch_build_md")
async def batch_build_curation_md(payload: Dict = Body(...)):
    """
    複数の試験種に対して Answer.md / Answer_Qn.md を一括生成する。
    入力例:
    {
      "targets": [
        {"university": "一橋大学", "exam_type": "24年文系", "questions": [1,2,3]},
        {"university": "東北大学", "exam_type": "24年理系"}
      ],
      "use_ai": true,
      "mode": "merge",
      "title": null,
      "concurrency": 2,
      "dry_run": false
    }
    targets を省略した場合、PROBLEM_DIR 配下の全ての <大学>/<試験種> を対象とする。
    questions を省略したターゲットは Answer.md（全体）を生成する。
    """
    use_ai = bool(payload.get("use_ai", True))
    mode = (payload.get("mode") or "merge").lower()
    title = payload.get("title")
    dry_run = bool(payload.get("dry_run", False))
    concurrency = int(payload.get("concurrency", 2) or 2)

    # Build target list
    raw_targets = payload.get("targets")
    targets: list[dict] = []
    if isinstance(raw_targets, list) and raw_targets:
        for t in raw_targets:
            u = (t or {}).get("university"); e = (t or {}).get("exam_type")
            if not u or not e:
                continue
            qs = t.get("questions") if isinstance(t.get("questions"), list) else None
            targets.append({"university": u, "exam_type": e, "questions": qs})
    else:
        all_targets = defaultdict(set)
        try:
            for uni in sorted([p for p in PROBLEM_DIR.iterdir() if p.is_dir()], key=lambda x: x.name):
                for et in sorted([p for p in uni.iterdir() if p.is_dir()], key=lambda x: x.name):
                    all_targets[uni.name].add(et.name)
        except Exception:
            pass
        if bucket:
            try:
                manifest = await _load_gcs_problem_manifest()
                for uni, exams in manifest.items():
                    for et in exams.keys():
                        all_targets[uni].add(et)
            except Exception:
                pass
        for uni in sorted(all_targets.keys()):
            for et in sorted(all_targets[uni]):
                targets.append({"university": uni, "exam_type": et, "questions": None})

    if not targets:
        raise HTTPException(status_code=404, detail="No targets found")

    sem = asyncio.Semaphore(max(1, concurrency))

    async def _run_one(u: str, e: str, q: Optional[int]):
        async with sem:
            if dry_run:
                return {"university": u, "exam_type": e, "question": q, "skipped": True}
            try:
                single_payload: Dict[str, object] = {"university": u, "exam_type": e, "mode": mode, "use_ai": use_ai}
                if title:
                    single_payload["title"] = title
                if isinstance(q, int):
                    single_payload["question"] = q
                res = await build_curation_md(single_payload)  # call handler directly
                return {"university": u, "exam_type": e, "question": q, "ok": True, "output_file": res.get("output_file")}
            except HTTPException as he:
                return {"university": u, "exam_type": e, "question": q, "ok": False, "error": he.detail}
            except Exception as e2:
                return {"university": u, "exam_type": e, "question": q, "ok": False, "error": str(e2)}

    tasks = []
    for t in targets:
        u = t["university"]; e = t["exam_type"]; qs = t.get("questions")
        if isinstance(qs, list) and qs:
            for q in qs:
                try:
                    qi = int(q)
                except Exception:
                    continue
                tasks.append(asyncio.create_task(_run_one(u, e, qi)))
        else:
            tasks.append(asyncio.create_task(_run_one(u, e, None)))

    out = await asyncio.gather(*tasks)
    ok_count = sum(1 for r in out if r.get("ok"))
    return {"message": f"batch done: {ok_count}/{len(out)} succeeded", "results": out}


@app.get("/curation/assets")
async def get_curation_assets(university: str, exam_type: str):
    """指定された試験種のファイル一覧を返す"""
    if not university or not exam_type:
        raise HTTPException(status_code=400, detail="University and exam_type are required")

    try:
        uni_norm = _normalize_segment(university)
        exam_norm = _normalize_segment(exam_type)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid university or exam_type")

    local_dir = PROBLEM_DIR / uni_norm / exam_norm
    exists_locally = await asyncio.to_thread(local_dir.exists)
    exists_on_gcs = False
    if bucket and not exists_locally:
        try:
            manifest = await _load_gcs_problem_manifest(uni_norm)
            exists_on_gcs = exam_norm in (manifest.get(uni_norm) or {})
        except Exception:
            exists_on_gcs = False
    if not exists_locally and not exists_on_gcs:
        raise HTTPException(status_code=404, detail="Target directory not found")

    target_dir = await _sync_problem_dir_from_gcs(university, exam_type)
    from pathlib import PurePosixPath
    files = await asyncio.to_thread(lambda: sorted([p for p in target_dir.iterdir() if p.is_file()]))
    
    assets = []
    for p in files:
        ext = p.suffix.lower()
        if ext in {".pdf", ".png", ".jpg", ".jpeg", ".md", ".txt"}:
            try:
                rel = p.resolve().relative_to(PROBLEM_DIR.resolve())
                url = f"/static/problems/{PurePosixPath(rel)}"
                kind = "text" if ext in {".md", ".txt"} else ("image" if ext in {".png", ".jpg", ".jpeg"} else "pdf")
                assets.append({"name": p.name, "url": url, "type": kind})
            except Exception:
                continue
    return {"assets": assets}


@app.get("/answers/{filename}/problem_selection")
async def get_problem_selection(filename: str):
    stem = Path(filename).stem
    sel = _state_io(stem)
    problem_pdf = sel.get("problem_pdf")
    rubric_pdf = sel.get("rubric_pdf")
    exam_type = sel.get("exam_type")
    
    # Try to determine university label and question number from state
    university = None
    question_number = None
    try:
        d = sel.get("details") or {}
        if isinstance(d, dict):
            university = d.get("university")
            question_number = d.get("question_number")
    except Exception:
        university = None
        question_number = None

    # Heuristic if not set from state file
    if filename in answers_db and answers_db[filename].get("problem_path"):
        base = Path(answers_db[filename]["problem_path"])
        files = await asyncio.to_thread(lambda: sorted([p for p in base.glob("**/*.pdf")]))
        pdf_names = [p.name for p in files]
        # Prefer exact filenames if present
        if not problem_pdf and "問題用紙.pdf" in pdf_names:
            problem_pdf = "問題用紙.pdf"
        if not rubric_pdf and "採点基準.pdf" in pdf_names:
            rubric_pdf = "採点基準.pdf"
        if not problem_pdf and pdf_names:
            # Prefer first non-rubric
            problem_pdf = next((n for n in pdf_names if ("採点" not in n and "基準" not in n)), pdf_names[0])
        if not rubric_pdf:
            rubric_pdf = next((n for n in pdf_names if ("採点" in n or "基準" in n)), None)
        # exam_type: use saved, else use folder name
        if not exam_type:
            try:
                exam_type = Path(answers_db[filename]["problem_path"]).name
            except Exception:
                exam_type = None
        # university: prefer DB details
        if not university:
            try:
                # problem_pathから大学名を逆引き
                problem_path = Path(answers_db[filename]["problem_path"])
                university = problem_path.parent.name
            except Exception:
                university = None
                
    return {"problem_pdf": problem_pdf, "rubric_pdf": rubric_pdf, "exam_type": exam_type, "university": university, "question_number": question_number}

@app.post("/answers/{filename}/problem_selection")
async def set_problem_selection(filename: str, payload: Dict = Body(...)):
    stem = Path(filename).stem
    university = payload.get("university")
    exam_type = payload.get("exam_type")
    # Optional question_number to narrow Answer.md selection and review context
    question_number = payload.get("question_number")

    if not university or not exam_type:
        raise HTTPException(status_code=400, detail="University and exam_type are required")

    try:
        uni_norm = _normalize_segment(university)
        exam_norm = _normalize_segment(exam_type)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid university or exam_type")

    problem_path = PROBLEM_DIR / uni_norm / exam_norm
    exists_locally = await asyncio.to_thread(problem_path.exists)
    exists_on_gcs = False
    if bucket and not exists_locally:
        try:
            manifest = await _load_gcs_problem_manifest(uni_norm)
            exists_on_gcs = exam_norm in (manifest.get(uni_norm) or {})
        except Exception:
            exists_on_gcs = False
    if not exists_locally and not exists_on_gcs:
        raise HTTPException(status_code=404, detail=f"Problem path not found: {problem_path}")

    problem_path = await _sync_problem_dir_from_gcs(university, exam_type)

    # Validate optional question_number (must be 1..6 if provided)
    if question_number is not None:
        try:
            qn = int(question_number)
        except Exception:
            raise HTTPException(status_code=400, detail="question_number must be integer 1..6")
        if qn < 1 or qn > 6:
            raise HTTPException(status_code=400, detail="question_number must be between 1 and 6")
        question_number = qn

    # Update the central DB in memory
    if filename in answers_db:
        answers_db[filename]["problem_path"] = str(problem_path)
        answers_db[filename]["exam_type"] = exam_type
        if "details" not in answers_db[filename] or not isinstance(answers_db[filename]["details"], dict):
            answers_db[filename]["details"] = {}
        answers_db[filename]["details"]["university"] = university
        if question_number is not None:
            answers_db[filename]["details"]["question_number"] = question_number
    
    # Persist the state to disk
    data_to_save = {
        "problem_path": str(problem_path),
        "exam_type": exam_type,
        "details": {"university": university}
    }
    if question_number is not None:
        try:
            # Merge into details
            det = data_to_save.setdefault("details", {})
            det["question_number"] = question_number
        except Exception:
            pass
    _state_io(stem, data_to_save)
    
    return {"message": "selection saved", "question_number": question_number}


@app.get("/signatures")
async def list_signatures():
    from pathlib import PurePosixPath

    try:
        files = await _sync_signatures_from_gcs()
    except Exception:
        files = await asyncio.to_thread(lambda: sorted([p for p in SIGNATURE_DIR.iterdir() if p.is_file()]))

    signatures = []
    for p in files:
        signatures.append({
            "name": p.name,
            "url": f"/static/signatures/{PurePosixPath(p.name)}"
        })
    return {"signatures": signatures}


@app.post("/signatures")
async def upload_signature(
    file: UploadFile = File(...),
    label: Optional[str] = Form(None)
):
    name_hint = label or file.filename or ""
    filename = _safe_filename(name_hint)
    if not filename:
        filename = f"signature_{int(time.time() * 1000)}"

    content_type = file.content_type or mimetypes.guess_type(filename)[0]
    if not content_type or not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Signature must be an image")

    if not Path(filename).suffix:
        guessed_ext = mimetypes.guess_extension(content_type) or ".png"
        filename = f"{filename}{'' if filename.endswith(guessed_ext) else guessed_ext}"

    safe_name = _safe_filename(filename)
    dest = SIGNATURE_DIR / safe_name
    if await asyncio.to_thread(dest.exists):
        raise HTTPException(status_code=409, detail="Signature already exists")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        await asyncio.to_thread(dest.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(dest.write_bytes, contents)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save signature locally: {e}")

    try:
        await _upload_signature_bytes_to_gcs(safe_name, contents, content_type)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to upload signature to storage: {e}")

    return {
        "message": f"Uploaded signature: {safe_name}",
        "signature": {
            "name": safe_name,
            "url": f"/static/signatures/{safe_name}",
        },
    }


@app.delete("/signatures/{name}")
async def delete_signature(name: str):
    safe_name = _safe_filename(name)
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid signature name")

    target = SIGNATURE_DIR / safe_name
    local_exists = await asyncio.to_thread(target.exists)

    gcs_exists = False
    if bucket:

        def _blob_exists() -> bool:
            blob = bucket.blob(f"{SIGNATURE_PREFIX}/{safe_name}")
            try:
                return blob.exists()
            except Exception:
                return False

        gcs_exists = await asyncio.to_thread(_blob_exists)

    if not local_exists and not gcs_exists:
        raise HTTPException(status_code=404, detail="Signature not found")

    if local_exists:
        try:
            await asyncio.to_thread(target.unlink)
        except FileNotFoundError:
            pass
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to delete local signature: {e}")

    try:
        await _delete_signature_from_gcs(safe_name)
    except Exception:
        pass

    return {"message": f"Deleted signature: {safe_name}"}


@app.post("/answers/{filename}/complete")
async def mark_completed(filename: str):
    if filename not in answers_db:
        raise HTTPException(status_code=404, detail="Answer not found")
    answers_db[filename]["status"] = "添削完了"
    # 状態を永続化
    try:
        stem = Path(filename).stem
        # 既存の状態を壊さずにマージ（editing_time_seconds などを保持）
        try:
            st = _state_io(stem)
            if not isinstance(st, dict):
                st = {}
        except Exception:
            st = {}
        st.update({
            "status": "添削完了",
            "quality": answers_db[filename].get("quality"),
            "details": answers_db[filename].get("details"),
            "problem_path": answers_db[filename].get("problem_path"),
            "review_path": answers_db[filename].get("review_path"),
            "exam_type": answers_db[filename].get("exam_type"),
        })
        _state_io(stem, st)
    except Exception as e:
        print(f"[complete] 状態保存失敗: {e}")
    return {"message": "Marked as completed"}

@app.post("/answers/{filename}/reprocess")
async def reprocess(filename: str, payload: Dict = Body(...)):
    steps = payload.get("steps", [])
    force = bool(payload.get("force", False))
    if not isinstance(steps, list) or not all(isinstance(s, str) for s in steps):
        raise HTTPException(status_code=400, detail="steps must be a list of strings")
    dirs = {
        "UPLOAD_DIR": UPLOAD_DIR,
        "PNG_DIR": PNG_DIR,
        "MD_DIR": MD_DIR,
        "PROBLEM_DIR": PROBLEM_DIR,
        "CACHE_DIR": CACHE_DIR,
    }
    # Immediately mark as started to give UI fast feedback
    try:
        answers_db.setdefault(filename, {})['status'] = '再処理開始'
        _state_io(Path(filename).stem, {"status": answers_db[filename]['status'], "last_step": None})
    except Exception:
        pass
    result = await reprocess_answer(filename, dirs, steps, force)
    return result

@app.get("/answers/{filename}/status")
async def get_answer_status(filename: str):
    stem = Path(filename).stem
    info = {
        "filename": filename,
        "status": answers_db.get(filename, {}).get("status"),
        "error": answers_db.get(filename, {}).get("error"),
        "last_step": None,
        "timeline": None,
    }
    try:
        st = _state_io(stem)
        if isinstance(st, dict):
            if 'status' in st:
                info['status'] = st['status']
            info['last_step'] = st.get('last_step')
            info['last_error'] = st.get('last_error')
            info['timeline'] = st.get('timeline')
    except Exception:
        pass
    return info

# -------- Editing time tracking --------
@app.get("/answers/{filename}/time")
async def get_editing_time(filename: str):
    stem = Path(filename).stem
    try:
        st = _state_io(stem)
        secs = int((st or {}).get('editing_time_seconds') or 0)
    except Exception:
        secs = 0
    return { 'seconds': secs }

@app.post("/answers/{filename}/time/add")
async def add_editing_time(filename: str, payload: Dict = Body(...)):
    amount = payload.get('seconds')
    try:
        amount = int(amount)
    except Exception:
        raise HTTPException(status_code=400, detail="seconds must be integer")
    if amount <= 0:
        return { 'seconds': 0 }
    # Clamp to avoid accidental huge increments
    if amount > 3600:
        amount = 3600
    stem = Path(filename).stem
    try:
        st = _state_io(stem)
        cur = int((st or {}).get('editing_time_seconds') or 0)
        total = cur + amount
        _state_io(stem, { 'editing_time_seconds': total })
        # mirror to memory for /answers convenience
        if filename in answers_db:
            answers_db[filename]['editing_time_seconds'] = total
        return { 'seconds': total }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"failed to add time: {e}")

# -------- PDF Export (annotated) --------
from typing import Tuple
from PIL import Image, ImageDraw, ImageFont
import json
import textwrap

def _load_font(size: int) -> ImageFont.FreeTypeFont:
    # Allow override via env
    import os
    fp = os.getenv("ANNO_FONT_PATH")
    if fp:
        try:
            return ImageFont.truetype(fp, size)
        except Exception:
            pass
    # Try common Japanese serif fonts
    candidates = [
        "/System/Library/Fonts/ヒラギノ明朝 ProN W3.otf",
        "/System/Library/Fonts/ヒラギノ明朝 ProN W6.otf",
        "/Library/Fonts/ヒラギノ明朝 ProN W3.otf",
        "/Library/Fonts/ヒラギノ明朝 ProN W6.otf",
        "/Library/Fonts/YuMincho.ttc",
        "/System/Library/Fonts/YuMincho.ttc",
        "/Library/Fonts/NotoSerifCJKjp-Regular.otf",
        "/System/Library/Fonts/NotoSerifCJKjp-Regular.otf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    # Fallback
    return ImageFont.load_default()

def _draw_multiline_text(draw: ImageDraw.ImageDraw, xy: Tuple[int, int], text: str, font: ImageFont.ImageFont, fill: Tuple[int,int,int], max_width: int) -> None:
    # Simple wrapping by character width
    x, y = xy
    if not text:
        return
    lines = []
    for raw_line in text.split("\n"):
        if max_width <= 0:
            lines.append(raw_line)
            continue
        buf = ""
        for ch in raw_line:
            test = buf + ch
            w = draw.textlength(test, font=font)
            if w <= max_width:
                buf = test
            else:
                lines.append(buf)
                buf = ch
        lines.append(buf)
    for i, line in enumerate(lines):
        draw.text((x, y + i* (font.size+2)), line, font=font, fill=fill)

def _draw_score_marker(draw: ImageDraw.ImageDraw, x: int, y: int, points: int, font_size: int, font: ImageFont.ImageFont, color=(255,65,65)):
    # Bracket
    bracket_text = "」"
    draw.text((x, y), bracket_text, font=font, fill=color)
    bw = int(draw.textlength(bracket_text, font=font))
    # Pill
    chip_text = f"+{points}"
    chip_font = font
    text_w = int(draw.textlength(chip_text, font=chip_font))
    chip_h = int(font_size * 1.6)
    pad_x = max(2, int(font_size * 0.35))
    chip_w = text_w + pad_x*2
    rx0, ry0 = x + bw, y
    rx1, ry1 = rx0 + chip_w, ry0 + chip_h
    r = chip_h // 2
    try:
        draw.rounded_rectangle([rx0, ry0, rx1, ry1], radius=r, outline=color, width=2)
    except Exception:
        draw.rectangle([rx0, ry0, rx1, ry1], outline=color, width=2)
    # Center text
    tx = rx0 + (chip_w - text_w)//2
    ty = ry0 + (chip_h - font.size)//2 - 1
    draw.text((tx, ty), chip_text, font=chip_font, fill=color)

@app.get("/answers/{filename}/export")
async def export_annotated_pdf(filename: str):
    path = await _render_annotated_pdf(Path(filename).stem)
    return FileResponse(path=str(path), filename=f"{Path(filename).stem}_annotated.pdf", media_type="application/pdf")

async def _render_annotated_pdf(stem: str) -> Path:
    pages_dir = PNG_DIR / stem
    if not await asyncio.to_thread(pages_dir.exists):
        raise HTTPException(status_code=404, detail="Pages not found")
    page_images = await asyncio.to_thread(lambda: sorted(pages_dir.glob("page_*.png")))
    if not page_images:
        raise HTTPException(status_code=404, detail="No pages")
    # Load annotations
    anno_path = ANNO_DIR / f"{stem}.json"
    boxes = []
    if await asyncio.to_thread(anno_path.exists):
        try:
            data = await asyncio.to_thread(anno_path.read_text, "utf-8")
            j = json.loads(data)
            boxes = j.get("boxes", [])
        except Exception:
            boxes = []
    # Prepare output
    out_pdf = EXPORTS_DIR / f"{stem}_annotated.pdf"
    annotated_imgs = []
    red = (255,65,65)
    for idx, img_path in enumerate(page_images):
        img = Image.open(img_path).convert("RGB")
        draw = ImageDraw.Draw(img)
        # Draw boxes for this page
        for b in boxes:
            if b.get("page", 0) != idx:
                continue
            btype = b.get("type", "text")
            x = int(b.get("x", 0)); y = int(b.get("y", 0)); w = int(b.get("w", 0)); h = int(b.get("h", 0))
            fs = int(b.get("fontSize", 16))
            font = _load_font(fs)
            if btype == "score":
                pts = int(b.get("points", 1) or 1)
                _draw_score_marker(draw, x, y, pts, fs, font, color=red)
            else:
                text = b.get("text", "")
                _draw_multiline_text(draw, (x, y), text, font, red, max_width=w if w>0 else 0)
        annotated_imgs.append(img)
    # Save as PDF
    try:
        annotated_imgs[0].save(out_pdf, save_all=True, append_images=annotated_imgs[1:])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to build PDF: {e}")
    return out_pdf

@app.post("/answers/export_zip")
async def export_zip(payload: Dict = Body(...)):
    filenames = payload.get("filenames", [])
    if not isinstance(filenames, list) or not all(isinstance(x, str) for x in filenames):
        raise HTTPException(status_code=400, detail="filenames must be a list of strings")
    if not filenames:
        raise HTTPException(status_code=400, detail="no filenames provided")
    # Render each PDF
    pdf_paths: list[Path] = []
    errs: Dict[str, str] = {}
    for fn in filenames:
        try:
            p = await _render_annotated_pdf(Path(fn).stem)
            pdf_paths.append(p)
        except HTTPException as he:
            errs[fn] = he.detail if isinstance(he.detail, str) else str(he.detail)
        except Exception as e:
            errs[fn] = str(e)
    if not pdf_paths:
        raise HTTPException(status_code=500, detail={"message": "no pdfs generated", "errors": errs})
    # Build zip
    import zipfile, time
    zip_name = EXPORTS_DIR / f"batch_{int(time.time())}.zip"
    try:
        with zipfile.ZipFile(zip_name, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            for p in pdf_paths:
                zf.write(p, arcname=p.name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to build ZIP: {e}")
    return FileResponse(path=str(zip_name), filename=zip_name.name, media_type="application/zip")

@app.post("/answers/{filename}/auto_layout")
async def auto_layout(filename: str, payload: Dict = Body(default={})):
    """
    PNGページ画像のOCR（pytesseract）から座標を抽出し、レビューコメントの配置候補を返す。
    出力: { placements: [{ type:'text'|'score', text?, points?, page, x, y, page_w, page_h }] }
    x,y は画像ピクセル座標。フロントで画像表示サイズに合わせてスケールする。
    """
    import json as _json
    import re
    import os
    from PIL import Image
    try:
        import pytesseract
        from pytesseract import Output as _TessOutput
    except Exception:
        pytesseract = None
        _TessOutput = None

    # レビュー読み込み
    review = None
    if filename in answers_db and isinstance(answers_db[filename].get("review"), dict):
        review = answers_db[filename]["review"]
    if review is None:
        stem = Path(filename).stem
        rp = REVIEWS_DIR / f"{stem}.json"
        if await asyncio.to_thread(rp.exists):
            try:
                t = await asyncio.to_thread(rp.read_text, "utf-8")
                review = _json.loads(t)
            except Exception:
                review = None
    if not review or not isinstance(review, dict):
        raise HTTPException(status_code=404, detail="review not found")

    # 画像(PNG)を対象にOCRブロックを構築（フォールバック）
    stem = Path(filename).stem
    pages_dir = PNG_DIR / stem
    if not await asyncio.to_thread(pages_dir.exists):
        raise HTTPException(status_code=404, detail="pages not found (png)")

    # Try spatial understanding first (Gemini): map targets -> boxes per page
    placements = []
    try:
        # Prepare items from review targets/texts and preserve comment meta
        items = []
        item_meta: Dict[str, Dict] = {}
        for q in (review.get('questions') or []):
            qid = q.get('id')
            for c in (q.get('comments') or []):
                tgt = (c.get('target') or '').strip()
                base_text = (c.get('text') or '').strip()
                text = tgt if tgt else base_text[:70]
                if not text:
                    continue
                iid = str(len(items))
                items.append({'id': iid, 'text': text})
                item_meta[iid] = {
                    'type': c.get('type') or 'text',
                    'points': c.get('points'),
                    'text': base_text,
                    'qid': qid,
                }
        if items:
            try:
                from gemini_utils import spatial_locate
                page_files = await asyncio.to_thread(lambda: sorted(pages_dir.glob('page_*.png')))
                for pi, img_path in enumerate(page_files):
                    try:
                        w, h = Image.open(img_path).size
                    except Exception:
                        w, h = (1000, 1400)
                    locs = await spatial_locate(items, img_path, normalize=True)
                    for it, loc in zip(items, locs if len(locs)==len(items) else []):
                        try:
                            conf = float(loc.get('confidence') or 0)
                        except Exception:
                            conf = 0.0
                        if conf < 0.45:
                            continue
                        x = loc.get('x'); y = loc.get('y'); bw = loc.get('w'); bh = loc.get('h')
                        if x is None or y is None or bw is None or bh is None:
                            continue
                        ax = float(x) * w; ay = float(y) * h; aw = float(bw) * w; ah = float(bh) * h
                        meta = item_meta.get(str(it.get('id')) or '') or {}
                        ctype = meta.get('type') or 'text'
                        ctext = meta.get('text') or (it.get('text') or '')
                        cpoints = meta.get('points')
                        qid = meta.get('qid')
                        # Always place the comment text near the detected box
                        placements.append({
                            'type': 'text', 'text': ctext,
                            'page': pi, 'x': ax, 'y': ay, 'w': aw, 'h': ah, 'page_w': w, 'page_h': h,
                            'confidence': conf,
                            'qid': qid,
                            'ctype': ctype,
                            'points': int(cpoints) if isinstance(cpoints, (int, float)) else None,
                        })
                        # If this is a score comment, also place a score marker near the bottom-left of the box
                        if ctype == 'score' and isinstance(cpoints, (int, float)):
                            marker_h = max(16.0, ah * 0.22)
                            sx = max(0.0, ax + 4.0)
                            sy = max(0.0, ay + ah - marker_h)
                            placements.append({
                                'type': 'score', 'points': int(cpoints),
                                'page': pi, 'x': sx, 'y': sy, 'page_w': w, 'page_h': h,
                                'confidence': conf,
                                'qid': qid,
                            })
            except Exception:
                pass
    except Exception:
        pass

    if placements:
        return { 'placements': placements }

    use_ocr = bool(payload.get('use_ocr', True))
    # OCR params and helpers
    ocr_debug = []
    try:
        import pytesseract as _pt
        tess_version = str(_pt.get_tesseract_version())
    except Exception:
        tess_version = None
    try:
        ocr_lang = str(payload.get('ocr_lang') or os.getenv('OCR_LANG', 'jpn+eng'))
    except Exception:
        ocr_lang = 'jpn+eng'
    try:
        ocr_psm = int(payload.get('ocr_psm') or os.getenv('OCR_PSM', '6'))
    except Exception:
        ocr_psm = 6
    try:
        ocr_scale = float(payload.get('ocr_scale') or os.getenv('OCR_SCALE', '1.5'))
        if not (0.5 <= ocr_scale <= 4.0):
            ocr_scale = 1.5
    except Exception:
        ocr_scale = 1.5

    from PIL import ImageOps, ImageFilter
    def _prep_image(img: Image.Image) -> Image.Image:
        g = ImageOps.grayscale(img)
        g = ImageOps.autocontrast(g, cutoff=2)
        if abs(ocr_scale - 1.0) > 1e-3:
            w, h = g.size
            g = g.resize((int(w*ocr_scale), int(h*ocr_scale)), Image.LANCZOS)
        g = g.filter(ImageFilter.SHARPEN)
        return g

    def _ocr_pages(dirp: Path):
        files = sorted([p for p in dirp.glob('page_*.png')])
        out = []
        for i, p in enumerate(files):
            try:
                raw = Image.open(p).convert('RGB')
            except Exception:
                continue
            w, h = raw.size
            blocks = []
            if use_ocr and pytesseract is not None and _TessOutput is not None:
                try:
                    img = _prep_image(raw)
                    cfg = f"--oem 1 --psm {ocr_psm}"
                    data = pytesseract.image_to_data(img, lang=ocr_lang, config=cfg, output_type=_TessOutput.DICT)
                    words = 0
                    for j in range(len(data.get('text', []))):
                        txt = (data['text'][j] or '').strip()
                        if not txt:
                            continue
                        try:
                            x = float(data['left'][j]); y = float(data['top'][j]);
                            bw = float(data['width'][j]); bh = float(data['height'][j])
                        except Exception:
                            continue
                        words += 1
                        blocks.append({"x0": x, "y0": y, "x1": x+bw, "y1": y+bh, "text": txt})
                    # Retry with sparse mode if too few words
                    if words < 8:
                        cfg2 = "--oem 1 --psm 11"
                        try:
                            data2 = pytesseract.image_to_data(img, lang=ocr_lang, config=cfg2, output_type=_TessOutput.DICT)
                        except Exception:
                            data2 = None
                        if data2:
                            for j in range(len(data2.get('text', []))):
                                txt = (data2['text'][j] or '').strip()
                                if not txt:
                                    continue
                                try:
                                    x = float(data2['left'][j]); y = float(data2['top'][j]);
                                    bw = float(data2['width'][j]); bh = float(data2['height'][j])
                                except Exception:
                                    continue
                                blocks.append({"x0": x, "y0": y, "x1": x+bw, "y1": y+bh, "text": txt})
                except Exception:
                    # OCR pipeline failure for this page – continue with empty blocks
                    pass
            out.append({"w": float(w), "h": float(h), "blocks": blocks})
            try:
                ocr_debug.append({"page": i, "size": [w, h], "blocks": len(blocks), "lang": ocr_lang, "psm": ocr_psm, "scale": ocr_scale, "tesseract": tess_version})
            except Exception:
                pass
        return out

    if not use_pages_from_anchors:
        pages = await asyncio.to_thread(_ocr_pages, pages_dir)

    placements = []
    # Build comment list
    comment_list = []
    questions = review.get("questions") or []
    for q in questions:
        for c in (q.get("comments") or []):
            comment_list.append({
                "index": len(comment_list),
                "type": c.get("type"),
                "text": (c.get("text") or "").strip(),
                "target": (c.get("target") or "").strip(),
                "points": c.get("points") if c.get("type") == "score" else None,
            })

    # Optional AI mapping
    use_ai = bool(payload.get('use_ai', False))
    debug = bool(payload.get('debug', False))
    debug_images = bool(payload.get('debug_images', False))
    mapping_debug = []
    if use_ai and comment_list:
        try:
            block_table = []
            for pi, pg in enumerate(pages):
                for bi, blk in enumerate(pg['blocks']):
                    bid = f"p{pi}_b{bi}"
                    block_table.append({"id": bid, "page": pi, **blk})
            if block_table:
                from gemini_utils import map_comments_to_blocks
                mapping = await map_comments_to_blocks(block_table, comment_list)
                for m in mapping:
                    try:
                        idx = int(m.get('index'))
                        c = comment_list[idx]
                        tgt = next((b for b in block_table if b['id'] == m.get('block_id')), None)
                        if not tgt:
                            mapping_debug.append({"index": idx, "method": "ai", "block_id": None})
                            continue
                        pl = {"page": tgt['page'], "x": tgt['x0']+4, "y": tgt['y0']+4, "page_w": pages[tgt['page']]['w'], "page_h": pages[tgt['page']]['h']}
                        if c['type'] == 'score' and isinstance(c.get('points'), (int, float)):
                            placements.append({"type": "score", "points": int(c['points']), **pl})
                            mapping_debug.append({"index": idx, "method": "ai", "block_id": tgt['id']})
                        else:
                            placements.append({"type": "text", "text": c.get('text') or '', **pl})
                            mapping_debug.append({"index": idx, "method": "ai", "block_id": tgt['id']})
                    except Exception:
                        continue
        except Exception:
            # ignore AI failures and fall back to heuristic
            pass

    # Heuristic fallback for remaining comments
    mapped = len(placements)
    fb_page = 0
    fb_y_by_page = {i: 80.0 for i in range(len(pages))}
    fb_step = 120.0
    def place_one(idx: int, text: str, target: str, ctype: str, points):
        nonlocal fb_page
        cand = target or (text or '')[:70]
        found = None
        block_id = None
        if cand:
            cand_norm = re.sub(r"\s+", " ", cand).strip().lower()
            for pi, pg in enumerate(pages):
                for bi, blk in enumerate(pg['blocks']):
                    blk_norm = re.sub(r"\s+", " ", blk['text']).strip().lower()
                    if cand_norm and (cand_norm in blk_norm or blk_norm in cand_norm):
                        found = {"page": pi, "x": blk['x0']+4, "y": blk['y0']+4, "page_w": pg['w'], "page_h": pg['h']}
                        block_id = f"p{pi}_b{bi}"
                        break
                if found:
                    break
        if not found and pages:
            pidx = fb_page if (0 <= fb_page < len(pages)) else 0
            py = fb_y_by_page.get(pidx, 80.0)
            found = {"page": pidx, "x": 56.0, "y": py, "page_w": pages[pidx]['w'], "page_h": pages[pidx]['h']}
            py_next = py + fb_step
            limit = (pages[pidx]['h'] or 842.0) - 100.0
            if py_next > limit:
                fb_page = (pidx + 1) % max(1, len(pages))
                fb_y_by_page[pidx] = 80.0
            else:
                fb_y_by_page[pidx] = py_next
        if found:
            if ctype == 'score' and isinstance(points, (int, float)):
                placements.append({"type": "score", "points": int(points), **found})
                mapping_debug.append({"index": idx, "method": "heuristic" if block_id else "fallback", "block_id": block_id})
            else:
                placements.append({"type": "text", "text": text, **found})
                mapping_debug.append({"index": idx, "method": "heuristic" if block_id else "fallback", "block_id": block_id})

    if mapped < len(comment_list):
        for i in range(mapped, len(comment_list)):
            c = comment_list[i]
            place_one(i, c.get('text') or '', c.get('target') or '', c.get('type') or 'text', c.get('points'))
    # Build debug info
    debug_obj = None
    if debug:
        dbg_pages = [{"index": i, "w": pg['w'], "h": pg['h'], "blocks": len(pg['blocks'])} for i, pg in enumerate(pages)]
        debug_obj = {"pages": dbg_pages, "mapping": mapping_debug, "ocr": {"tesseract": tess_version, "params": {"lang": ocr_lang, "psm": ocr_psm, "scale": ocr_scale}, "per_page": ocr_debug}}
        if debug_images:
            try:
                from PIL import Image, ImageDraw, ImageFont
                urls = []
                stem = Path(filename).stem
                pages_dir = PNG_DIR / stem
                for i, pg in enumerate(pages):
                    src = pages_dir / f"page_{i+1}.png"
                    if not src.exists():
                        continue
                    im = Image.open(src).convert('RGB')
                    dr = ImageDraw.Draw(im)
                    # draw blocks (blue)
                    for bi, blk in enumerate(pg['blocks'][:400]):
                        dr.rectangle([(blk['x0'], blk['y0']), (blk['x1'], blk['y1'])], outline=(66,135,245), width=2)
                        dr.text((blk['x0']+2, blk['y0']+2), f"b{bi}", fill=(66,135,245))
                    # draw placements (red) with label
                    for pl in [p for p in placements if p['page'] == i]:
                        x, y = float(pl['x']), float(pl['y'])
                        r = 10
                        dr.ellipse([(x-r, y-r), (x+r, y+r)], outline=(255,64,64), width=3)
                        try:
                            label = f"{pl.get('confidence',0):.2f} " + (pl.get('text') or '')[:22]
                            dr.text((x+6, max(0, y-14)), label, fill=(255,64,64))
                        except Exception:
                            pass
                    outp = pages_dir / f"debug_auto_layout_page_{i+1}.png"
                    im.save(outp)
                    urls.append(f"/static/pngs/{stem}/{outp.name}")
                debug_obj['images'] = urls
            except Exception:
                pass

    return {"placements": placements, **({"debug": debug_obj} if debug_obj else {})}


@app.post("/answers/{filename}/spatial_map")
async def spatial_map(filename: str, payload: Dict = Body(default={})):
    """
    Use Gemini spatial understanding to map review targets to bounding boxes per page.
    Body: { question?: string|int, items?: [{id,text}], normalize?: true, confidence_min?: number, debug?: bool, debug_images?: bool }
    Returns: { placements: [{ type:'text', text, page, x, y, w, h, page_w, page_h, confidence }], debug? }
    Coordinates are absolute image pixels; x,y at the top-left of box.
    """
    from gemini_utils import spatial_locate
    stem = Path(filename).stem
    pages_dir = PNG_DIR / stem
    if not await asyncio.to_thread(pages_dir.exists):
        raise HTTPException(status_code=404, detail="pages not found")

    normalize = bool(payload.get('normalize', True))
    confidence_min = float(payload.get('confidence_min', 0.45))
    debug = bool(payload.get('debug', False))
    debug_images = bool(payload.get('debug_images', False))
    question = payload.get('question')
    items = payload.get('items')

    # If items not provided, build from review targets
    if not items:
        review = None
        if filename in answers_db and isinstance(answers_db[filename].get("review"), dict):
            review = answers_db[filename]["review"]
        if review is None:
            rp = REVIEWS_DIR / f"{stem}.json"
            if await asyncio.to_thread(rp.exists):
                try:
                    txt = await asyncio.to_thread(rp.read_text, 'utf-8')
                    review = json.loads(txt)
                except Exception:
                    review = None
        items = []
        if review:
            qs = review.get('questions') or []
            for q in qs:
                qid = str(q.get('id') or '')
                # filter by question if provided
                if question is not None and str(question) not in qid:
                    continue
                for c in (q.get('comments') or []):
                    tgt = (c.get('target') or '').strip()
                    if not tgt:
                        # fallback to snippet of text
                        txt = (c.get('text') or '').strip()[:70]
                        if not txt:
                            continue
                        items.append({ 'id': f"{qid}:{len(items)}", 'text': txt })
                    else:
                        items.append({ 'id': f"{qid}:{len(items)}", 'text': tgt })

    # Group items into manageable batches per page (here: same items for all pages)
    page_files = await asyncio.to_thread(lambda: sorted(pages_dir.glob('page_*.png')))
    placements = []
    overlay_urls = []

    for pi, img_path in enumerate(page_files):
        # Run spatial locate for this page
        try:
            from PIL import Image
            w, h = Image.open(img_path).size
        except Exception:
            w, h = (1000, 1400)
        try:
            locs = await spatial_locate(items, img_path, normalize=normalize)
        except Exception as e:
            locs = []
        # Convert to absolute pixels and filter by confidence
        for it, loc in zip(items, locs if len(locs)==len(items) else []):
            try:
                conf = float(loc.get('confidence') or 0)
            except Exception:
                conf = 0.0
            if conf < confidence_min:
                continue
            x = loc.get('x'); y = loc.get('y'); bw = loc.get('w'); bh = loc.get('h')
            if x is None or y is None or bw is None or bh is None:
                continue
            if normalize:
                ax = float(x) * w; ay = float(y) * h; aw = float(bw) * w; ah = float(bh) * h
            else:
                ax = float(x); ay = float(y); aw = float(bw); ah = float(bh)
            placements.append({
                'type': 'text', 'text': it.get('text') or '',
                'page': pi, 'x': ax, 'y': ay, 'w': aw, 'h': ah, 'page_w': w, 'page_h': h,
                'confidence': conf,
            })

        # Debug overlay per page
        if debug and debug_images:
            try:
                im = Image.open(img_path).convert('RGB')
                dr = ImageDraw.Draw(im)
                # Try load font for JP text labels
                try:
                    font_path = os.getenv('ANNO_FONT_PATH')
                    font = ImageFont.truetype(font_path, 14) if font_path else ImageFont.load_default()
                except Exception:
                    font = ImageFont.load_default()
                for pl in [p for p in placements if p['page']==pi]:
                    x0, y0, x1, y1 = pl['x'], pl['y'], pl['x']+pl['w'], pl['y']+pl['h']
                    dr.rectangle([(x0, y0), (x1, y1)], outline=(38,198,84), width=3)
                    try:
                        label = f"{pl.get('confidence',0):.2f} " + (pl.get('text') or '')[:22]
                        dr.text((x0+2, max(0, y0-16)), label, fill=(38,198,84), font=font)
                    except Exception:
                        pass
                outp = pages_dir / f"debug_spatial_page_{pi+1}.png"
                im.save(outp)
                overlay_urls.append(f"/static/pngs/{stem}/{outp.name}")
            except Exception:
                pass

    out = { 'placements': placements }
    if debug:
        out['debug'] = { 'images': overlay_urls }
    return out

@app.get("/answers/{filename}/review")
async def get_review(filename: str):
    """添削コメント（レビュー）のJSONを返す（メモリ→ディスクの順で探索）。"""
    pdf_stem = Path(filename).stem
    entry = answers_db.get(filename) or {}

    # メモリ
    if isinstance(entry.get("review"), dict):
        return {"review": entry["review"]}

    review_path = REVIEWS_DIR / f"{pdf_stem}.json"
    # ディスク
    if await asyncio.to_thread(review_path.exists):
        try:
            text = await asyncio.to_thread(review_path.read_text, "utf-8")
            import json
            data = json.loads(text)
            answers_db.setdefault(filename, {})["review"] = data
            return {"review": data}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read review: {e}")

    # GCS から取得
    gcs_blob_path = None
    review_path_hint = entry.get("review_path")
    if isinstance(review_path_hint, str) and review_path_hint.startswith(f"gs://{GCS_BUCKET_NAME}/"):
        gcs_blob_path = review_path_hint.replace(f"gs://{GCS_BUCKET_NAME}/", "", 1)
    if not gcs_blob_path:
        gcs_blob_path = f"processing_reviews/{pdf_stem}.json"

    if bucket and gcs_blob_path:
        blob = bucket.blob(gcs_blob_path)
        try:
            if await asyncio.to_thread(blob.exists):
                text = await asyncio.to_thread(blob.download_as_text)
                import json
                data = json.loads(text)
                # メモリとローカルキャッシュへ格納
                answers_db.setdefault(filename, {})["review"] = data
                try:
                    review_path.parent.mkdir(parents=True, exist_ok=True)
                    await asyncio.to_thread(review_path.write_text, text, "utf-8")
                except Exception:
                    pass
                return {"review": data}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to fetch review from GCS: {e}")
    raise HTTPException(status_code=404, detail="Review not found")

@app.post("/process")
async def process_answers():
    """未処理の答案すべてを処理する"""
    sync_db_with_filesystem()
    
    # processing.pyに渡すためのディレクトリ情報を辞書にまとめる
    dirs = {
        "UPLOAD_DIR": UPLOAD_DIR,
        "PNG_DIR": PNG_DIR,
        "MD_DIR": MD_DIR,
        "PROBLEM_DIR": PROBLEM_DIR,
        "CACHE_DIR": CACHE_DIR,
    }

    processing_tasks = [
        asyncio.create_task(process_single_answer(fname, dirs))
        for fname, data in answers_db.items() if data["status"] == "未処理"
    ]
    
    if not processing_tasks:
        return {"message": "No unprocessed files to process."}
        
    await asyncio.gather(*processing_tasks)
    return {"message": "Processing completed for all unprocessed files."}

# -------- AI Chat Assistant --------
@app.post("/answers/{filename}/chat")
async def chat_assist(filename: str, request: Request):
    """
    Answer chat with context: transcription (MD), curated Answer.md if available, and review JSON.
    Body: { message: string }
    """
    # Accept both JSON and multipart/form-data with optional images
    msg = ''
    images: list[UploadFile] = []
    try:
        ctype = (request.headers.get('content-type') or '').lower()
        if 'multipart/form-data' in ctype:
            form = await request.form()
            msg = str(form.get('message') or '').strip()
            # 'images' may be a list or single
            imgs = form.getlist('images') if hasattr(form, 'getlist') else []
            for it in imgs:
                if isinstance(it, UploadFile):
                    images.append(it)
        else:
            data = await request.json()
            msg = str((data.get('message') or '')).strip()
    except Exception:
        # Fallback: try JSON only
        try:
            data = await request.json()
            msg = str((data.get('message') or '')).strip()
        except Exception:
            msg = ''
    if not msg:
        raise HTTPException(status_code=400, detail="message required")
    stem = Path(filename).stem
    # Collect contexts from GCS
    transcription = ''
    if bucket:
        try:
            md_blob = bucket.blob(f"processing_mds/{stem}.md")
            if await asyncio.to_thread(md_blob.exists):
                transcription = await asyncio.to_thread(md_blob.download_as_text)
        except Exception:
            transcription = ''
    review_text = ''
    if bucket:
        try:
            review_blob = bucket.blob(f"processing_reviews/{stem}.json")
            if await asyncio.to_thread(review_blob.exists):
                review_text = await asyncio.to_thread(review_blob.download_as_text)
        except Exception:
            review_text = ''
    curated = ''
    try:
        # Use assigned problem_path to find Answer.md / Answer_Q*.md
        problem_path_str = answers_db.get(filename, {}).get("problem_path") or ''
        if problem_path_str.startswith("gs://") and bucket:
            prefix = problem_path_str.replace(f"gs://{GCS_BUCKET_NAME}/", "").rstrip('/') + '/'
            blobs = await asyncio.to_thread(list, storage_client.list_blobs(GCS_BUCKET_NAME, prefix=prefix))
            
            am_blob = next((b for b in blobs if b.name.lower().endswith(('/answer.md', '/answers.md'))), None)
            if am_blob:
                curated = await asyncio.to_thread(am_blob.download_as_text)
            else:
                q_blobs = [b for b in blobs if b.name.lower().startswith(f"{prefix}answer_q") and b.name.lower().endswith('.md')]
                parts = []
                for qb in sorted(q_blobs, key=lambda b: b.name):
                    try:
                        parts.append(await asyncio.to_thread(qb.download_as_text))
                    except Exception:
                        continue
                curated = '\n\n'.join(parts)
        elif problem_path_str: # Fallback for local paths
            ppath = Path(problem_path_str)
            if await asyncio.to_thread(ppath.exists):
                files = await asyncio.to_thread(lambda: sorted([p for p in ppath.glob('**/*') if p.is_file()]))
                am = next((p for p in files if p.name.lower() in {'answer.md', 'answers.md'}), None)
                if am:
                    curated = await asyncio.to_thread(am.read_text, 'utf-8')
                else:
                    qs = [p for p in files if p.name.lower().startswith('answer_q') and p.suffix.lower() == '.md']
                    parts = []
                    for qf in sorted(qs):
                        try:
                            parts.append(await asyncio.to_thread(qf.read_text, 'utf-8'))
                        except Exception:
                            continue
                    curated = '\n\n'.join(parts)
    except Exception:
        curated = ''

    # Build prompt
    import textwrap
    from google.generativeai import GenerativeModel
    model = GenerativeModel('gemini-2.5-pro')
    sys = textwrap.dedent(
        """
        あなたは数学答案の編集支援AIです。以下のコンテキストの範囲内で、日本語で丁寧に簡潔に回答してください。
        - 計算・記述は根拠（書き起こし/Answer.md/レビュー）に基づき、憶測は避ける。
        - 数式はTeXで表現（インライン $...$、ブロック $$...$$）。
        - 不足情報がある場合は、その旨を明記して推定は分けて述べる。
        """
    )
    ctx_parts = []
    if transcription:
        ctx_parts.append(f"[書き起こし]\n{transcription[:32000]}")
    if curated:
        ctx_parts.append(f"[Answer.md]\n{curated[:32000]}")
    if review_text:
        ctx_parts.append(f"[レビュー(JSON)]\n{review_text[:32000]}")
    ctx = "\n\n".join(ctx_parts) if ctx_parts else "(コンテキスト未取得)"
    prompt = f"{sys}\n\n[コンテキスト]\n{ctx}\n\n[質問]\n{msg}"
    # Build parts for multimodal: text + images (if provided)
    parts = [prompt]
    if images:
        from PIL import Image
        import io
        max_imgs = 4
        for i, uf in enumerate(images[:max_imgs]):
            try:
                raw = await uf.read()
                if not raw:
                    continue
                img = Image.open(io.BytesIO(raw))
                parts.append(img)
            except Exception:
                continue
    try:
        resp = await model.generate_content_async(parts if len(parts) > 1 else prompt)
        text = (getattr(resp, 'text', '') or '').strip()
        return { 'reply': text }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"chat failed: {e}")
