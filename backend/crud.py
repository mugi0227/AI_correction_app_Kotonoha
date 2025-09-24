from pathlib import Path
from typing import Dict
import json
import datetime
import os
from google.cloud import storage

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploaded_pdfs"
STATE_DIR = BASE_DIR / "processing_state"
QUALITY_DIR = BASE_DIR / "processing_cache"
REVIEWS_DIR = BASE_DIR / "processing_reviews"

# --- 状態管理 (インメモリDB) ---
answers_db: Dict[str, Dict] = {}

# --- GCS設定 ---
GCS_BUCKET_NAME = "auto-correction"
storage_client = None
bucket = None
if GCS_BUCKET_NAME:
    storage_client = storage.Client()
    bucket = storage_client.bucket(GCS_BUCKET_NAME)


def _load_json(path: Path):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return None


def _ts_to_iso(ts: float) -> str:
    try:
        return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()
    except Exception:
        return datetime.datetime.utcfromtimestamp(ts).isoformat() if ts else ""

def sync_db_with_filesystem():
    """
    GCSバケットの状態をインメモリDBに同期します。
    - `uploaded_pdfs/` に存在するPDFをDBに追加
    - 削除されたPDFをDBから削除
    """
    global answers_db
    if bucket:
        print(f"--- Syncing DB with GCS bucket: {GCS_BUCKET_NAME} ---")
        try:
            blobs = storage_client.list_blobs(GCS_BUCKET_NAME, prefix="uploaded_pdfs/")
            files_on_gcs = {Path(blob.name).name for blob in blobs if blob.name.lower().endswith(".pdf")}

            print(f"Found files in GCS: {files_on_gcs}")
            db_keys = set(answers_db.keys())

            # 削除されたファイルをDBから除去
            for filename in db_keys - files_on_gcs:
                print(f"Removing deleted file from DB: {filename}")
                del answers_db[filename]

            # すべてのGCS上のPDFについて状態を反映（新規/既存問わず）
            for filename in sorted(files_on_gcs):
                if filename not in answers_db:
                    print(f"Adding new file to DB: {filename}")
                    answers_db[filename] = {"status": "未処理"}

                # uploaded_at
                try:
                    blob = bucket.blob(f"uploaded_pdfs/{filename}")
                    blob.reload()
                    answers_db[filename]["uploaded_at"] = blob.updated.isoformat(timespec='seconds')
                except Exception:
                    pass

                stem = Path(filename).stem
                # GCS上の状態ファイルから復元（status/quality/details/problem_path/review_path/exam_type）
                try:
                    state_blob = bucket.blob(f"processing_state/{stem}.json")
                    if state_blob.exists():
                        state = json.loads(state_blob.download_as_text())
                        if isinstance(state, dict):
                            for k in ["status", "quality", "details", "problem_path", "review_path", "exam_type", "editing_time_seconds"]:
                                if k in state and state[k] is not None:
                                    answers_db[filename][k] = state[k]
                except Exception as e:
                    print(f"[sync] 状態復元失敗: {e}")

                # 仕分け結果（quality）がキャッシュにある場合は反映
                try:
                    q_blob = bucket.blob(f"processing_cache/{stem}.quality.json")
                    if q_blob.exists():
                        q_text = q_blob.download_as_text()
                        q = json.loads(q_text)
                        if isinstance(q, dict):
                            answers_db[filename]["quality"] = q
                            status_text = str(answers_db[filename].get("status") or "").strip()
                            if not status_text or status_text == "未処理":
                                answers_db[filename]["status"] = "仕分済 (要手動確認)" if (q.get("label") == "NG") else "仕分済 (自動可)"
                except Exception as e:
                    print(f"[sync] quality復元失敗: {e}")

                # レビュー成果物が存在する場合は経路を補完し、ステータスをAI完了寄りに調整
                try:
                    review_blob = bucket.blob(f"processing_reviews/{stem}.json")
                    if review_blob.exists():
                        answers_db[filename].setdefault("review_path", f"gs://{GCS_BUCKET_NAME}/{review_blob.name}")
                        status_text = str(answers_db[filename].get("status") or "").strip()
                        is_terminal = status_text in {"添削完了", "AI添削完了"}
                        is_busy = any(x in status_text for x in ("処理中", "再処理中", "エラー"))
                        if not is_terminal and not is_busy:
                            answers_db[filename]["status"] = "AI添削完了"
                except Exception as e:
                    print(f"[sync] review復元失敗: {e}")

                # problem_path から exam_type を推定（不足時）
                try:
                    pp = answers_db[filename].get("problem_path")
                    if pp and not answers_db[filename].get("exam_type"):
                        # 例: gs://bucket/problems/<university>/<exam_type>/...
                        parts = str(pp).strip().split("/")
                        idx = None
                        for i, p in enumerate(parts):
                            if p == "problems" and i + 2 < len(parts):
                                idx = i
                                break
                        if idx is not None:
                            answers_db[filename]["exam_type"] = parts[idx + 2].strip()
                except Exception:
                    pass

        except Exception as e:
            print(f"Error during sync_db_with_filesystem: {e}")
        print(f"Current DB state: {answers_db}")
        print("--- Sync finished ---")
        return

    # --- ローカルファイルシステム運用（開発環境など） ---
    try:
        upload_files = {p.name: p for p in UPLOAD_DIR.glob("*.pdf")}
        db_keys = set(answers_db.keys())

        # 削除されたファイルをDBから除去
        for filename in db_keys - set(upload_files.keys()):
            try:
                print(f"Removing deleted file from DB: {filename}")
                del answers_db[filename]
            except Exception:
                pass

        for filename, pdf_path in sorted(upload_files.items()):
            entry = answers_db.setdefault(filename, {"status": "未処理"})

            # アップロード日時 (ファイル更新時刻)
            try:
                entry["uploaded_at"] = _ts_to_iso(pdf_path.stat().st_mtime)
            except Exception:
                pass

            stem = pdf_path.stem

            state_path = STATE_DIR / f"{stem}.json"
            state = _load_json(state_path) if state_path.exists() else None
            if isinstance(state, dict):
                for key in ["status", "quality", "details", "problem_path", "review_path", "exam_type", "editing_time_seconds"]:
                    if key in state and state[key] is not None:
                        entry[key] = state[key]

            # 仕分け結果（quality）がキャッシュにある場合は反映
            quality_path = QUALITY_DIR / f"{stem}.quality.json"
            quality = _load_json(quality_path) if quality_path.exists() else None
            if isinstance(quality, dict):
                entry["quality"] = quality
                status_text = str(entry.get("status") or "").strip()
                if not status_text or status_text == "未処理":
                    entry["status"] = "仕分済 (要手動確認)" if (quality.get("label") == "NG") else "仕分済 (自動可)"

            # レビュー成果物が存在する場合は経路を補完し、ステータスをAI完了に寄せる
            review_path = REVIEWS_DIR / f"{stem}.json"
            if review_path.exists():
                entry.setdefault("review_path", str(review_path))
                status_text = str(entry.get("status") or "").strip()
                is_terminal = status_text in {"添削完了", "AI添削完了"}
                is_busy = any(x in status_text for x in ("処理中", "再処理中", "エラー"))
                if not is_terminal and not is_busy:
                    entry["status"] = "AI添削完了"

            # problem_path から exam_type を推定（不足時）
            try:
                pp = entry.get("problem_path")
                if pp and not entry.get("exam_type"):
                    parts = str(pp).strip().split("/")
                    idx = None
                    for i, part in enumerate(parts):
                        if part == "problems" and i + 2 < len(parts):
                            idx = i
                            break
                        if part == "problems" and i + 2 < len(parts):
                            idx = i
                            break
                    if idx is not None:
                        entry["exam_type"] = parts[idx + 2].strip()
            except Exception:
                pass

    except Exception as e:
        print(f"Error during local sync_db_with_filesystem: {e}")
