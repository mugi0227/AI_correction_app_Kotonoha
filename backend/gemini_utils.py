import os
import re
import json
import textwrap
import google.generativeai as genai
from PIL import Image
from pathlib import Path
from typing import List, Optional, Dict

async def classify_image_quality(image_path: Path) -> Dict[str, str]:
    """
    答案画像の品質を評価し、自動添削に適しているかを判断します。
    戻り値は {"label": "OK"|"NG", "reason": "..."}。
    """
    model = genai.GenerativeModel('gemini-2.5-pro')
    img = Image.open(image_path)
    # 判定をやや甘くする（ボーダーは OK に倒す）
    prompt = (
        "あなたは答案の品質評価アシスタントです。数学答案の画像を次の基準で評価し、"
        "自動添削の可否を判定してください。なお、曖昧な場合は OK としてください。\n\n"
        "[自動添削可能 (Good=OK)]\n"
        "- 文字が概ね読みやすい（多少の乱れ・癖・薄さは許容）。\n"
        "- 筆圧や線の鮮明さが十分、またはやや薄いが判読可能。\n"
        "- スキャン状態が概ね良好。軽微な傾き・影・ノイズ・解像度不足は OK。\n\n"
        "[手動確認推奨 (Bad=NG)]\n"
        "- 全体的に極端に薄い/かすれていて判読が困難。\n"
        "- 文字の判読が困難なレベルで乱雑/ブレが顕著。\n"
        "- 影・ノイズ・傾きが甚大で、重要部分の判読が難しい。\n\n"
        "判定ルール（甘め）:\n"
        "- 迷う場合や部分的に悪い程度なら 'OK'。\n"
        "- 'NG' は上記Badに明確に該当する場合と白紙答案のみ。\n\n"
        "JSONのみで出力してください（日本語）。\n"
        "形式: {\"label\": \"OK|NG\", \"reason\": \"短い説明\"}"
    )
    response = await model.generate_content_async([prompt, img])
    raw = (getattr(response, 'text', '') or '').strip()
    # JSON抽出（コードブロック/素のJSON両対応）
    m = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", raw, re.IGNORECASE)
    if m:
        raw = m.group(1)
    try:
        data = json.loads(raw)
    except Exception:
        # うまくJSONにならなかった場合のフォールバック
        up = raw.upper()
        label = 'OK' if 'OK' in up and 'NG' not in up else ('NG' if 'NG' in up else 'NG')
        reason = raw[:120]
        return {"label": label, "reason": reason}
    label = str(data.get('label', '')).strip().upper()
    if label not in ('OK', 'NG'):
        up = raw.upper()
        label = 'OK' if 'OK' in up and 'NG' not in up else ('NG' if 'NG' in up else 'NG')
    reason = str(data.get('reason', '')).strip() or ("基準に基づく総合判定: " + label)
    return {"label": label, "reason": reason}

async def transcribe_images_to_markdown(image_paths: List[Path]) -> str:
    """
    複数の答案画像をMarkdown形式のテキストに書き起こします。
    環境変数 TRANSCRIBE_MODE=dummy の場合はダミーのMarkdownを生成します。
    """
    mode = os.getenv("TRANSCRIBE_MODE", "real").lower()
    if mode == "dummy":
        parts = []
        for i, img_path in enumerate(image_paths):
            parts.append(f"--- [ページ {i+1}] ---\n\n(ダミー) {img_path.name} を書き起こし\n\n")
        dummy_md = "".join(parts)
        print("[transcribe_images_to_markdown] ダミーモードでMD生成")
        return dummy_md

    model = genai.GenerativeModel('gemini-2.5-pro')
    full_transcription = ""
    for i, img_path in enumerate(image_paths):
        try:
            img = Image.open(img_path)
            prompt = (
                "あなたはプロの文字起こし専門家です。"
                "添付された手書きの数学答案の画像は、間違いを含んでいる可能性があります。これを、**必ず間違いをそのままに**Markdown形式で正確に書き起こしてください。"
                "数式はTeX形式で表現してください。"
                "答案の内容だけでなく、「年度・大学名・種別・第n問」などのヘッダー情報や試験種に関わるヒントも必ず書き起こしてください。"
                "大学名以外にも、科目名（例: 数学ⅠA、物理、英語など）や試験種ラベル（例: 実力テスト、学力テスト、模試、定期テストなど）が記載されている場合は、正確にそのまま書き起こし、カテゴリ名や見出しとして残してください。"
                "略称や装飾も含め、判別可能な文字・記号は省略せず記載してください。"
            )
            response = await model.generate_content_async([prompt, img])
            text = (getattr(response, 'text', '') or '').strip()
            if not text:
                raise RuntimeError("空の応答を受信")
            full_transcription += f"--- [ページ {i+1}] ---\n\n{text}\n\n"
        except Exception as e:
            raise RuntimeError(f"ページ{i+1}の書き起こしに失敗: {e}")
    return full_transcription

async def extract_answer_details(markdown_content: str) -> dict:
    """
    書き起こされたMarkdownから大学名、年度、科目名、大問番号を抽出します。
    """
    # 1) まず規則ベースでの抽出を試みる（AIに頼らずに頑健に）
    def _normalize_subject(s: str) -> Optional[str]:
        if not s:
            return None
        s = s.strip()
        # 数学I/II -> 数学1/2 に正規化
        s = s.replace("Ⅰ", "1").replace("Ⅱ", "2").replace("I", "1").replace("II", "2")
        m = re.search(r"数学\s*([12])", s)
        return f"数学{m.group(1)}" if m else None

    def _parse_details_from_text(text: str) -> Dict[str, str]:
        import unicodedata
        uni = None
        year = None
        subj = None
        q_num = None

        # 年度: 2016年度 等
        m = re.search(r"(20\d{2})\s*年度", text)
        if m:
            year = m.group(1)

        # 科目: 数学1/2 など（I/II含む）
        subj = _normalize_subject(text)

        # 大学名: 「〇〇大学」最初に出るもの
        m = re.search(r"([一-龥ぁ-んァ-ンA-Za-z]+大学)", text)
        if m:
            uni = m.group(1)
        
        # 大問番号: 第2問, 第２問
        m = re.search(r"第\s*([0-9０-９]+)\s*問", text)
        if m:
            # 全角を半角に
            q_num = str(unicodedata.normalize('NFKC', m.group(1)))

        # 表行: "2016年度・北海道大学全学部・数学2・第1問" 形式から分解
        m = re.search(r"(20\d{2})年度・([^・\n]+大学)[^\n]*・([^・\n]*数学[12ⅠⅡI]{1})[^\n]*・第\s*([0-9０-９]+)\s*問", text)
        if m:
            year = year or m.group(1)
            uni = uni or m.group(2)
            subj = subj or _normalize_subject(m.group(3))
            q_num = q_num or str(unicodedata.normalize('NFKC', m.group(4)))

        details: Dict[str, str] = {}
        if uni:
            details["university"] = uni
        if year:
            details["year"] = year
        if subj:
            details["subject"] = subj
        if q_num:
            details["question_number"] = q_num
        return details

    rule_based = _parse_details_from_text(markdown_content)
    # 大問は必須ではないため、チェック対象から外す
    if {"university", "year", "subject"}.issubset(rule_based.keys()):
        print(f"[extract_answer_details] ルール抽出に成功: {rule_based}")
        return rule_based

    # 2) AIに問い合わせ（JSONのみ返させる設定を強化）
    # 互換性重視のため generation_config は使わない（古いSDKで例外の可能性）
    model = genai.GenerativeModel('gemini-2.5-pro')

    prompt_template = textwrap.dedent("""
        次のMarkdownの先頭部分から以下の4項目を抽出し、JSONのみを返してください。
        - university: 大学名（例: 北海道大学）
        - year: 西暦4桁（例: 2016）
        - subject: 数学1 または 数学2（ローマ数字は半角数字に正規化）
        - question_number: 大問の番号（例: \"2\"）。見つからなければ null。

        返答は厳密なJSONのみ。説明・コードブロック・マークダウン装飾は出力しないこと。

        ---
        {content}
        ---
    """)
    prompt = prompt_template.format(content=markdown_content)

    text_response = ""
    try:
        if os.getenv("EXTRACT_USE_AI", "true").lower() == "false":
            raise RuntimeError("AI抽出をスキップ(EXTRACT_USE_AI=false)")
        response = await model.generate_content_async(prompt)
        text_response = (getattr(response, 'text', '') or "").strip()
        print(f"AIからの生の応答 (詳細抽出): {text_response}")  # デバッグ
    except Exception as e:
        print(f"[extract_answer_details] AI抽出スキップ/失敗: {e}")
        # 後続でルール抽出の部分結果を使う

    # 純JSON想定。だめならコードブロック/テキストからサルベージ
    def _try_load_json(s: str) -> Optional[dict]:
        try:
            return json.loads(s)
        except Exception:
            return None

    data = _try_load_json(text_response)
    if not data:
        m = re.search(r"```json\s*(\{.*?\})\s*```", text_response, re.DOTALL)
        if m:
            data = _try_load_json(m.group(1))
    if not data:
        m = re.search(r"(\{[\s\S]*\})", text_response)
        if m:
            data = _try_load_json(m.group(1))

    if not data:
        # ルール抽出の部分成功があれば返す（最低限の情報）
        if rule_based:
            print("[extract_answer_details] AI未使用/失敗のためルール抽出の部分結果を返却", rule_based)
            return rule_based
        raise ValueError("No JSON found in AI response and rule-based parsing failed")

    # 3) 正規化とバリデーション
    uni = str(data.get("university", "")).strip() or rule_based.get("university")
    year = str(data.get("year", "")).strip() or rule_based.get("year")
    subj = _normalize_subject(str(data.get("subject", "")).strip()) or rule_based.get("subject")
    q_num_raw = data.get("question_number")
    q_num = str(q_num_raw).strip() if q_num_raw is not None else None
    q_num = q_num or rule_based.get("question_number")
    if q_num == 'None' or not q_num:
        q_num = None

    if not uni or not year or not subj:
        # ルール抽出が部分的にでもあればそれを返す（処理継続のため）
        partial = {k: v for k, v in {"university": uni, "year": year, "subject": subj}.items() if v}
        if q_num:
            partial["question_number"] = q_num
        if partial:
            print(f"[extract_answer_details] 解析不完全のため部分結果を返却: {partial}")
            return partial
        raise ValueError(f"Extracted details incomplete: university={uni}, year={year}, subject={subj}")

    # 年は数字のみに揃える
    m = re.search(r"(20\d{2})", year)
    if not m:
        raise ValueError(f"Invalid year format: {year}")
    year = m.group(1)

    details = {"university": uni, "year": year, "subject": subj}
    if q_num:
        details["question_number"] = q_num
    print(f"[extract_answer_details] 最終確定: {details}")
    return details



async def generate_review_comments(answer_markdown: str, problem_texts: List[str]) -> Dict:
    """
    添削コメントを生成します。出力は厳密にJSONで、各小問ごとに4大必須要素（①採点、②賞賛、③誤りの指摘、④方針提示）を含めます。
    - answer_markdown: 書き起こし済みの答案Markdown
    - problem_texts: 問題文や採点基準などのテキスト（複数可）
    返却例:
    {
      "summary": {"total_score": 30, "max_score": 50, "notes": "..."},
      "questions": [
        {
          "id": "1",
          "awarded": 8,
          "max": 10,
          "comments": [
            {"type": "score", "text": "> 「○○」に +5点", "points": 5, "target": "式(3行目)"},
            {"type": "praise", "text": "> ✅ 〜ができていて良いです", "target": "方針"},
            {"type": "mistake", "text": "> ❌ 〜の箇所で誤りです（理由: …）", "target": "計算(4行目)"},
            {"type": "guidance", "text": "> 💡 満点に至るには〜", "target": "次の手順"}
          ]
        }
      ]
    }
    """
    model = genai.GenerativeModel('gemini-2.5-pro')

    policy_text = textwrap.dedent("""
    添削ルール（厳守）:
    - 基本理念: 生徒を育てる。丁寧語（です・ます調）。否定的/攻撃的表現は避ける。
    - 4大必須要素（各小問で必ず含める）:
      ① 正誤判定と採点: 採点基準に厳密準拠。加点法。誤った過程の結果は加点しない。別解は正しければ配点相当で加点。
      ② 賞賛: 具体的に良い点をほめる。0点でも必ず1つほめる。満点でも具体的にほめる。
      ③ 誤りの指摘: どこが、なぜ誤りかを具体的に。答案の内容に即して指摘。単なる模範解答の写しは不可。
      ④ 方針提示: 生徒の方針を活かしつつ満点に至るためのヒントや別解を示す。
    - 形式/記法:
      * コメント対象をtargetに明確化。
      * テキスト内に「+n点」の表記は書かない（配点は points フィールドのみで表す）。減点はしない（mistakeで指摘）。
      * 数式は**必ず**TeX形式(例：$\int_a^b f(x)\,\mathrm{d}x$)で出力。ドルマーク2つずつで囲む記法は用いない。
      * 出力はJSONのみ。questionごとに comments の配列に type を付与（score/praise/mistake/guidance）。
      * scoreコメントは“加点箇所ごと”に1要素作成し、テキストは具体的な賞賛内容のみを書く（+n点は書かない）。targetを明記。
      * 同一小問内で、加点ポイントや誤りが複数ある場合は、それぞれ別のコメント要素として“すべて”列挙する（1点につき1要素）。
      * praiseコメントは任意。必要なら小問全体の総評として最大1件のみ（過剰に増やさない）。
      * awarded は scoreコメントの points の合計（加点法）。max は採点基準に合わせ、不明な場合は合理的に仮置きして notes に根拠を記載。
      * 表示テキストは引用記法（>）と絵文字（✅, ❌, 💡）を活用。
    - 特殊ケース:
      * 再提出は前回との差分に言及（前回情報が無い場合は省略可）。
      * 課程外の解法: 原則満点。但し課程内なら通常どおり採点。
      * 不備答案（白紙/判読不能/問題違い）はその旨をnotesに記載し、採点不能とする。
    - 採点基準が明示されない場合は、問題文・解答例から合理的に推定して配点（max）を仮置きし、notesに明記。
    """)

    problems_joined = "\n\n".join(problem_texts[:6])  # 長文対策で最大数を制限
    prompt = textwrap.dedent(f"""
    次の答案Markdownと問題/採点基準テキストに基づき、添削コメントを生成してください。
    出力は必ず厳密なJSONのみで、指定スキーマに従ってください。

    {policy_text}

    [答案Markdown]
    ---
    {answer_markdown}
    ---

    [問題・採点基準テキスト（複数）]
    ---
    {problems_joined}
    ---

    注意:
    - 各テキストの先頭に [FILE:ファイル名] が付いている場合があります。ファイル名に「採点」や「採点基準」を含むものは配点根拠として最優先で参照してください。
    - PDF由来で一部のテキストが欠落している可能性があります。その場合も、利用可能な情報から最も妥当な配点と採点根拠を summary.notes に明記してください。

    JSONスキーマ（厳密）:
    {{
      "summary": {{"total_score": number, "max_score": number, "notes": string}},
      "questions": [
        {{
          "id": string,  // 例: "1", "2(1)" など
          "awarded": number,
          "max": number,
          "comments": [
            {{"type": "score"|"praise"|"mistake"|"guidance", "text": string, "target": string, "points": number|null}}
          ]
        }}
      ]
    }}
    """)

    def _try_parse_json(s: str) -> Optional[dict]:
        try:
            return json.loads(s)
        except Exception:
            return None

    def _fix_invalid_backslashes(s: str) -> str:
        # JSONでは \ の後に認められるのは \ / " b f n r t u のみ。
        # それ以外（例: \frac, \alpha 等）は無効なので \\ にエスケープする。
        return re.sub(r"(?<!\\)\\(?![\\/\"bfnrtu])", r"\\\\", s)

    try:
        resp = await model.generate_content_async(prompt)
        raw = (getattr(resp, 'text', '') or '').strip()
        m = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", raw, re.IGNORECASE)
        if m:
            raw = m.group(1)
        data = _try_parse_json(raw)
        if data is None:
            fixed = _fix_invalid_backslashes(raw)
            data = _try_parse_json(fixed)
        if data is None:
            # さらにコードブロック外から最初の {..} を救出して再試行
            m2 = re.search(r"(\{[\s\S]*\})", raw)
            if m2:
                cand = _fix_invalid_backslashes(m2.group(1))
                data = _try_parse_json(cand)
        if data is None:
            raise ValueError("JSON parse failed after fixes")
        return data
    except Exception as e:
        # 最低限の形で返す
        print(f"[generate_review_comments] 生成失敗: {e}")
        return {
            "summary": {"total_score": 0, "max_score": 0, "notes": f"生成に失敗しました: {e}"},
            "questions": []
        }


def normalize_review_cardinality(review: Dict) -> Dict:
    """
    現方針では、scoreコメント自体に賞賛文言を含めるため自動補完は行わない。
    将来の検証/整形のためのフックとして、そのまま返す。
    """
    return review


async def map_comments_to_blocks(blocks: List[Dict], comments: List[Dict]) -> List[Dict]:
    """
    Map review comments to page text blocks using Gemini. Returns a list of
    { index: int, block_id: string|null } in the same order as input comments.

    - blocks: [{ id, page, x0, y0, x1, y1, text }], where text is short (<=120 chars)
    - comments: [{ index, type, text, target }]
    """
    model = genai.GenerativeModel('gemini-2.5-pro')

    # Cap sizes to control token usage
    max_blocks = int(os.getenv('AUTO_LAYOUT_MAX_BLOCKS', '350'))
    max_text = int(os.getenv('AUTO_LAYOUT_BLOCK_TEXT_CAP', '120'))
    blocks_compact = []
    for b in blocks[:max_blocks]:
        t = (b.get('text') or '').strip()
        if len(t) > max_text:
            t = t[:max_text]
        blocks_compact.append({
            'id': b.get('id'), 'page': b.get('page'),
            'x0': b.get('x0'), 'y0': b.get('y0'), 'x1': b.get('x1'), 'y1': b.get('y1'),
            'text': t,
        })

    comments_compact = []
    for i, c in enumerate(comments):
        comments_compact.append({
            'index': int(c.get('index', i)),
            'type': c.get('type'),
            'text': (c.get('text') or '')[:160],
            'target': (c.get('target') or '')[:120],
            'points': c.get('points', None),
        })

    import json as _json
    prompt = (
        "次のPDFテキストブロック一覧とレビューコメントの対応付けを行います。\n"
        "各コメントに最も適切なブロックidを1つ選び、見つからなければnullにしてください。\n"
        "基準: targetがあれば最優先で一致するブロック、なければ本文の重要語で部分一致。配点(score)は本文の近くで構いません。\n"
        "出力はJSON配列のみ。形式: [{\"index\": number, \"block_id\": string|null}]."
    )
    blocks_json = _json.dumps(blocks_compact, ensure_ascii=False)
    comments_json = _json.dumps(comments_compact, ensure_ascii=False)
    instr = f"{prompt}\n[blocks]\n{blocks_json}\n\n[comments]\n{comments_json}"

    try:
        resp = await model.generate_content_async(instr)
        text = (getattr(resp, 'text', '') or '').strip()
    except Exception as e:
        raise RuntimeError(f"gemini mapping failed: {e}")

    # Try parse JSON list
    import re
    m = re.search(r"```json\s*(\[[\s\S]*?\])\s*```", text, re.IGNORECASE)
    if m:
        text = m.group(1)
    try:
        data = _json.loads(text)
        if isinstance(data, list):
            return data
    except Exception:
        pass
    # Fallback empty mapping
    return [{ 'index': c['index'], 'block_id': None } for c in comments_compact]


async def spatial_locate(items: List[Dict], image_path: Path, *, normalize: bool = True) -> List[Dict]:
    """
    Use Gemini spatial understanding to locate target items on an image.
    items: [{ id: string|number, text: string }] - short, specific target text per item
    Returns: [{ id, x, y, w, h, confidence, reason }]
    Coordinates are normalized to 0..1 if normalize=True, else absolute pixels.
    """
    model = genai.GenerativeModel('gemini-2.5-pro')
    from PIL import Image
    img = Image.open(image_path)
    width, height = img.size

    # Compact items
    import json as _json
    items_compact = []
    for it in items:
        tid = str(it.get('id')) if 'id' in it else str(len(items_compact))
        txt = (it.get('text') or '').strip()
        if not txt:
            continue
        # limit length
        if len(txt) > 140:
            txt = txt[:140]
        items_compact.append({ 'id': tid, 'text': txt })
    if not items_compact:
        return []

    instruction = (
        "次の画像の中から、与えられた各ターゲットテキストに最も対応する領域を1つずつ見つけ、"
        "各領域のバウンディングボックスを返してください。見つからない場合は null。\n"
        "返却は厳密なJSON配列のみ。各要素は {id, x, y, w, h, confidence, reason}。\n"
        f"画像サイズ: width={width}, height={height}。"
    )
    if normalize:
        instruction += "座標は0〜1の正規化（x,yは左上、w,hは幅と高さ）。"
    else:
        instruction += "座標はピクセル（x,yは左上の絶対値、w,hは幅と高さ）。"

    items_json = _json.dumps(items_compact, ensure_ascii=False)
    prompt = (
        instruction + "\n" +
        "[ターゲット一覧]\n" + items_json + "\n" +
        "出力のみをJSONで: [{\"id\": string, \"x\": number|null, \"y\": number|null, \"w\": number|null, \"h\": number|null, \"confidence\": number|null, \"reason\": string}]."
    )

    resp = await model.generate_content_async([prompt, img])
    text = (getattr(resp, 'text', '') or '').strip()
    import re
    m = re.search(r"```json\s*(\[[\s\S]*?\])\s*```", text, re.IGNORECASE)
    if m:
        text = m.group(1)
    try:
        data = _json.loads(text)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    # sanitize
    out = []
    for d in data:
        try:
            tid = str(d.get('id'))
            x = d.get('x'); y = d.get('y'); w = d.get('w'); h = d.get('h')
            conf = d.get('confidence')
            reason = str(d.get('reason') or '')
            if x is None or y is None or w is None or h is None:
                out.append({ 'id': tid, 'x': None, 'y': None, 'w': None, 'h': None, 'confidence': conf, 'reason': reason })
            else:
                out.append({ 'id': tid, 'x': float(x), 'y': float(y), 'w': float(w), 'h': float(h), 'confidence': float(conf) if conf is not None else None, 'reason': reason })
        except Exception:
            continue
    return out

async def generate_curated_answer_md(
    sources: List[Dict[str, str]],
    *,
    university: str,
    exam_type: str,
    question: Optional[int] = None,
    title: Optional[str] = None,
) -> str:
    """
    Curate Answer.md using PDFs directly where possible, with text fallback.
    - sources: list of {name, kind('md'|'txt'|'pdf'), text?, path?}
    """
    model = genai.GenerativeModel('gemini-2.5-pro')

    # Prepare uploads/text
    uploaded_files: List = []
    text_blocks: List[str] = []
    per_item_cap = int(os.getenv('BUILD_MD_PER_ITEM_CAP', '16000'))
    total_text_cap = int(os.getenv('BUILD_MD_MAX_CONTEXT', '48000'))

    for it in sources:
        kind = (it.get('kind') or '').lower()
        name = it.get('name') or 'UNKNOWN'
        path = it.get('path')
        if kind == 'pdf' and path and Path(path).exists():
            try:
                f = genai.upload_file(path=path)
                uploaded_files.append((name, f))
                continue
            except Exception:
                # fall back to text below
                pass
        txt = (it.get('text') or '').strip()
        if txt:
            if len(txt) > per_item_cap:
                txt = txt[:per_item_cap]
            text_blocks.append(f"[FILE:{name}]\n{txt}")

    joined_text = "\n\n".join(text_blocks)[:total_text_cap]

    tgt_title = title or (f"{university} {exam_type} 参照用Markdown" if question is None else f"{university} {exam_type} 大問{question} 参照用Markdown")

    policy = textwrap.dedent(
        """
        目的: 問題と採点基準を余すことなく、正確に添削できる参照用Markdown（Answer.md）を作る。
        厳守事項:
        - 出力はMarkdownのみ。YAML frontmatter + 見出し構造。
        - 与えられたソース以外からの推測・補完や新規内容の創作は一切禁止（ハルシネーション厳禁）。
        - 情報欠落がある箇所は NOTE を明示し、空欄を無理に埋めない。
        - 数式はTeX（インラインは $...$、ブロックは $$...$$）。PDF由来の崩れは極力整形。
        - 大問/小問の構造を明確に。
        - 重要(構成の禁止事項): 全小問の「問題」を先にまとめて羅列したり、章末に「採点基準」を一括でまとめないこと。各小問内で完結させる。
        - 重要(加点の表記): 模範解答のどの部分に対する評価なのかが明確に分かるように、> 【採点】... [+X点] の形式で、対応する解答の直後に記述する。
          さらに小問末尾に「配点まとめ: +2 +3 +5 = 10」のように合計を示す。加点理由もともに示す。根拠が不明なら NOTE を付す。
        - 配点の根拠は、ソース内に「採点」「採点基準」等の文書があれば最優先で反映。
        - ソースファイル名（[FILE:...]）があれば付記して出典関係を保つ。
        - 用語や記号は原文に忠実。曖昧さは NOTE で注記。
        書式:
        - Frontmatter: title/version/source を記載。
        - 章立て: # タイトル -> 小問ごとに ### (1), ### (2), ... と続ける（各小問内で【問題】【解答】【配点まとめ】を完結）。
        - 必要に応じて「参考」節を設けてもよい（出典の断片や補足を箇条書き）。
        出力は、日本語で簡潔・正確・再利用しやすい形にする。
        """
    )

    meta = textwrap.dedent(
        f"""
        [メタ情報]
        - 大学: {university}
        - 試験種: {exam_type}
        - 大問: {question if question is not None else '(全体)'}
        - 出力タイトル: {tgt_title}
        """
    )

    instructions = textwrap.dedent(
        f"""
        あなたは厳密なキュレーション編集者です。以下のソース群（添付PDFとテキスト断片）のみを根拠として、
        採点に使える参照用Markdownを生成してください。外部知識は使わないでください。

        {meta}

        {policy}

        添付PDFは優先的に参照し、テキスト断片は補助として扱ってください。

        指示:
        1) 小問(1),(2),...毎に独立した構成を作る（【問題】→【解答】→配点まとめ）。全小問の問題だけを先に羅列したり、章末に採点を集約しないこと。
        2) 問題文を復元（誤植修正可）。必要に応じて要約・引用を併用。
        3) 模範解答のどの部分に対する評価なのかが明確に分かるように、> 【採点】... [+X点] の形式で、対応する解答の直後に記述する。
        4) 小問末尾に「配点まとめ: +2 +3 +5 = 10」を記載。加点理由も示すこと。根拠が不明な配点は NOTE を付す。
        5) 数式は正しいTeXへ整形。
        6) 最終出力は、frontmatter + 見出し構造のMarkdown本文のみ。
        """
    )

    inputs: List = [instructions]
    for name, f in uploaded_files:
        inputs.append(f)
    if joined_text:
        inputs.append(textwrap.dedent(f"[テキスト断片]\n---\n{joined_text}\n---"))

    if len(inputs) == 1:
        return "# 参照Markdown\n\n（入力ソースが見つかりませんでした）\n"

    try:
        resp = await model.generate_content_async(inputs)
        text = (getattr(resp, 'text', '') or '').strip()
    except Exception:
        # Fallback to text-only prompt
        fallback = textwrap.dedent(
            f"""
            {meta}

            {policy}

            [ソース（テキスト断片のみ）]
            ---
            {joined_text}
            ---

            出力はMarkdown本文のみ。
            """
        )
        resp = await model.generate_content_async(fallback)
        text = (getattr(resp, 'text', '') or '').strip()

    m = re.search(r"```(?:md|markdown)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return text or ""
