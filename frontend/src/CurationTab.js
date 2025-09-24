import React, { useState, useEffect, useCallback, useRef } from 'react';
import MarkdownPreview from './MarkdownPreview';

const BACKEND_BASE = process.env.REACT_APP_API_BASE_URL || 'https://backend-service-o4pkfgmopa-uc.a.run.app';
const DEFAULT_SIGNATURE = { name: 'name.png', url: '/assets/stamps/name.png', builtin: true };

function CurationTab({ notify }) {
  const [problemIndex, setProblemIndex] = useState({});
  const [selectedUniversity, setSelectedUniversity] = useState('');
  const [selectedExamType, setSelectedExamType] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newExamType, setNewExamType] = useState('');
  const [assets, setAssets] = useState([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [coverage, setCoverage] = useState({});
  const [deletingExam, setDeletingExam] = useState(false);
  const [deletingAssets, setDeletingAssets] = useState({});

  const [files, setFiles] = useState([]);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isDragActive, setIsDragActive] = useState(false);

  // Build MD (Answer.md / Answer_Qn.md)
  const [mdTitle, setMdTitle] = useState('');
  const [mdQuestion, setMdQuestion] = useState('');
  const [building, setBuilding] = useState(false);
  const [builtFile, setBuiltFile] = useState('');
  const [builtPreview, setBuiltPreview] = useState('');
  const [useAI, setUseAI] = useState(true);

  // Batch build state
  const [batchScope, setBatchScope] = useState('all'); // 'all' | 'university' | 'custom'
  const [batchQuestions, setBatchQuestions] = useState(''); // e.g., 1,2,3
  const [batchConcurrency, setBatchConcurrency] = useState(2);
  const [batchDryRun, setBatchDryRun] = useState(false);
  const [customTargetsJson, setCustomTargetsJson] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [showCoverage, setShowCoverage] = useState(false);
  const [signatures, setSignatures] = useState([DEFAULT_SIGNATURE]);
  const [loadingSignatures, setLoadingSignatures] = useState(false);
  const [signatureUploading, setSignatureUploading] = useState(false);
  const [signatureDeleting, setSignatureDeleting] = useState({});
  const signatureInputRef = useRef(null);

  // Per-exam build queue with concurrency 2
  const [buildStatuses, setBuildStatuses] = useState({}); // key: `${uni}:::${et}` -> { state: 'idle'|'queued'|'running'|'done'|'error', msg?: string }
  const [buildQueue, setBuildQueue] = useState([]); // array of keys
  const [runningKeys, setRunningKeys] = useState([]); // array of keys currently running
  const concurrency = 2;

  const keyOf = (u, e) => `${u}:::${e}`;
  const parseKey = (k) => { const [u, e] = String(k).split(':::'); return { u, e }; };
  const statusOf = (u, e) => (buildStatuses[keyOf(u, e)] || { state: 'idle' });

  const enqueueBuild = (u, e) => {
    const k = keyOf(u, e);
    const cur = buildStatuses[k]?.state || 'idle';
    if (cur === 'queued' || cur === 'running') return; // already scheduled/running
    setBuildStatuses(prev => ({ ...prev, [k]: { state: 'queued' } }));
    setBuildQueue(prev => (prev.includes(k) ? prev : [...prev, k]));
  };

  // Scheduler: keep up to 'concurrency' running
  useEffect(() => {
    if (!buildQueue.length) return;
    if (runningKeys.length >= concurrency) return;
    // Dequeue next
    const k = buildQueue[0];
    setBuildQueue(prev => prev.slice(1));
    setRunningKeys(prev => [...prev, k]);
    const { u, e } = parseKey(k);
    // Start task
    (async () => {
      setBuildStatuses(prev => ({ ...prev, [k]: { state: 'running' } }));
      try {
        const payload = { university: u, exam_type: e, mode: 'merge', use_ai: true };
        const res = await fetch(`${BACKEND_BASE}/curation/build_md`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '生成に失敗しました');
        setBuildStatuses(prev => ({ ...prev, [k]: { state: 'done', msg: data.output_file || 'OK' } }));
        // Refresh coverage for this university to reflect Answer.md presence
        try {
          const covRes = await fetch(`${BACKEND_BASE}/curation/coverage?university=${encodeURIComponent(u)}`);
          const covData = await covRes.json();
          setCoverage((covData && covData.coverage) || {});
        } catch {}
      } catch (err) {
        setBuildStatuses(prev => ({ ...prev, [k]: { state: 'error', msg: String(err.message || err) } }));
        notify(`${u}/${e}: 生成に失敗しました`, 'error');
      } finally {
        setRunningKeys(prev => prev.filter(x => x !== k));
      }
    })();
  }, [buildQueue, runningKeys, notify]);

  const fetchProblemIndex = useCallback(() => {
    fetch(`${BACKEND_BASE}/problems/index`)
      .then(res => res.json())
      .then(data => {
        setProblemIndex(data.universities || {});
      })
      .catch(err => console.error("Failed to fetch problem index:", err));
  }, []);

  useEffect(() => {
    fetchProblemIndex();
  }, [fetchProblemIndex]);

  const loadAssets = useCallback(() => {
    if (selectedUniversity && selectedExamType) {
      setLoadingAssets(true);
      fetch(`${BACKEND_BASE}/curation/assets?university=${encodeURIComponent(selectedUniversity)}&exam_type=${encodeURIComponent(selectedExamType)}`)
        .then(res => res.json())
        .then(data => {
          setAssets(data.assets || []);
        })
        .catch(err => {
          console.error("Failed to fetch assets:", err);
          setAssets([]);
        })
        .finally(() => setLoadingAssets(false));
    } else {
      setAssets([]);
    }
  }, [selectedUniversity, selectedExamType]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  const refreshCoverage = useCallback((uni) => {
    if (!uni) {
      setCoverage({});
      return;
    }
    fetch(`${BACKEND_BASE}/curation/coverage?university=${encodeURIComponent(uni)}`)
      .then(res => res.json())
      .then(data => setCoverage((data && data.coverage) || {}))
      .catch(() => setCoverage({}));
  }, []);

  const loadSignatures = useCallback(() => {
    setLoadingSignatures(true);
    fetch(`${BACKEND_BASE}/signatures`)
      .then(res => res.json())
      .then(data => {
        const fetched = Array.isArray(data.signatures) ? data.signatures : [];
        const mapped = fetched.map(sig => ({ ...sig, builtin: false })).filter(sig => sig.name !== DEFAULT_SIGNATURE.name);
        setSignatures([DEFAULT_SIGNATURE, ...mapped]);
      })
      .catch(() => setSignatures([DEFAULT_SIGNATURE]))
      .finally(() => setLoadingSignatures(false));
  }, []);

  useEffect(() => {
    loadSignatures();
  }, [loadSignatures]);

  // Fetch coverage as soon as a university is selected (independent from exam_type)
  useEffect(() => {
    refreshCoverage(selectedUniversity);
  }, [selectedUniversity, refreshCoverage]);

  const handleUniversityChange = (e) => {
    setSelectedUniversity(e.target.value);
    setSelectedExamType('');
    setNewExamType('');
  };

  const handleCreateExamType = async () => {
    const category = (newCategory && newCategory.trim()) || selectedUniversity;
    if (!category || !newExamType.trim()) {
      notify('カテゴリーと試験種名を入力してください', 'error');
      return;
    }
    try {
      const res = await fetch(`${BACKEND_BASE}/curation/exam_type`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ university: category, exam_type: newExamType }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || '作成に失敗しました');
      }
      notify(data.message, 'success');
      setNewExamType('');
      fetchProblemIndex(); // Refresh the index
      setSelectedUniversity(category);
      setSelectedExamType(newExamType); // Select the newly created type
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const handleDeleteExamType = async () => {
    if (!selectedUniversity || !selectedExamType) return;
    if (!window.confirm(`試験種「${selectedUniversity} / ${selectedExamType}」を削除します。よろしいですか？`)) return;
    setDeletingExam(true);
    try {
      const res = await fetch(`${BACKEND_BASE}/curation/exam_type`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ university: selectedUniversity, exam_type: selectedExamType }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || '削除に失敗しました');
      }
      notify(data.message || '試験種を削除しました', 'success');
      const remaining = (problemIndex[selectedUniversity] || []).filter(et => et !== selectedExamType);
      setProblemIndex(prev => {
        const next = { ...prev };
        if (next[selectedUniversity]) {
          next[selectedUniversity] = next[selectedUniversity].filter(et => et !== selectedExamType);
          if (!next[selectedUniversity].length) {
            delete next[selectedUniversity];
          }
        }
        return next;
      });
      setSelectedExamType('');
      if (!remaining.length) {
        setSelectedUniversity('');
        refreshCoverage('');
      } else {
        refreshCoverage(selectedUniversity);
      }
      setAssets([]);
      setDeletingAssets({});
      fetchProblemIndex();
    } catch (err) {
      notify(err.message || '削除に失敗しました', 'error');
    } finally {
      setDeletingExam(false);
    }
  };

  const handleDeleteAsset = async (name) => {
    if (!selectedUniversity || !selectedExamType) return;
    if (!window.confirm(`ファイル「${name}」を削除しますか？`)) return;
    setDeletingAssets(prev => ({ ...prev, [name]: true }));
    try {
      const res = await fetch(`${BACKEND_BASE}/curation/asset`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ university: selectedUniversity, exam_type: selectedExamType, filename: name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || '削除に失敗しました');
      }
      notify(data.message || `${name} を削除しました`, 'success');
      setAssets(prev => prev.filter(asset => asset.name !== name));
      refreshCoverage(selectedUniversity);
      loadAssets();
    } catch (err) {
      notify(err.message || '削除に失敗しました', 'error');
    } finally {
      setDeletingAssets(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  const handleDrag = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "dragenter" || event.type === "dragover") setIsDragActive(true);
    else if (event.type === "dragleave") setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);
    if (event.dataTransfer.files?.[0]) {
      setFiles(prev => [...prev, ...Array.from(event.dataTransfer.files)]);
    }
  }, []);

  const handleFileSelect = (event) => {
    if (event.target.files?.[0]) {
      setFiles(prev => [...prev, ...Array.from(event.target.files)]);
    }
  };

  const handleSignatureUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSignatureUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${BACKEND_BASE}/signatures`, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || '署名の登録に失敗しました');
      }
      notify(data.message || '署名を登録しました', 'success');
      if (signatureInputRef.current) signatureInputRef.current.value = '';
      loadSignatures();
    } catch (err) {
      notify(err.message || '署名の登録に失敗しました', 'error');
    } finally {
      setSignatureUploading(false);
    }
  };

  const handleDeleteSignature = async (sig) => {
    if (!sig || sig.builtin) {
      notify('既定の署名は削除できません', 'info');
      return;
    }
    if (!window.confirm(`署名「${sig.name}」を削除しますか？`)) return;
    setSignatureDeleting(prev => ({ ...prev, [sig.name]: true }));
    try {
      const res = await fetch(`${BACKEND_BASE}/signatures/${encodeURIComponent(sig.name)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || '署名の削除に失敗しました');
      }
      notify(data.message || '署名を削除しました', 'success');
      loadSignatures();
    } catch (err) {
      notify(err.message || '署名の削除に失敗しました', 'error');
    } finally {
      setSignatureDeleting(prev => { const next = { ...prev }; delete next[sig.name]; return next; });
    }
  };

  const resolveSignatureUrl = useCallback((sig) => {
    if (!sig || !sig.url) return DEFAULT_SIGNATURE.url;
    const url = sig.url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/assets/')) return url;
    return `${BACKEND_BASE}${url}`;
  }, []);

  const handleUpload = () => {
    if (files.length === 0) return;
    if (!selectedUniversity || !selectedExamType) {
        notify('アップロード先のカテゴリーと試験種を選択してください', 'error');
        return;
    }
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    formData.append('university', selectedUniversity);
    formData.append('exam_type', selectedExamType);

    setUploadStatus('アップロード中...');
    fetch(`${BACKEND_BASE}/curation/upload`, { method: 'POST', body: formData })
      .then(res => res.json())
      .then(data => {
        if (!data.message) throw new Error("Upload failed");
        setUploadStatus(data.message);
        setFiles([]);
        notify(`${data.uploaded_files.length}件のファイルをアップロードしました`, 'success');
        // Refresh asset list
        loadAssets();
        refreshCoverage(selectedUniversity);
      })
      .catch(err => {
        console.error(err);
        setUploadStatus("アップロードに失敗しました。");
        notify("アップロードに失敗しました。", 'error');
      });
  };

  const handleBuildMd = async () => {
    if (!selectedUniversity || !selectedExamType) {
      notify('カテゴリーと試験種を選択してください', 'error');
      return;
    }
    const qn = mdQuestion.trim();
    const payload = {
      university: selectedUniversity,
      exam_type: selectedExamType,
      mode: 'merge',
      title: mdTitle.trim() || undefined,
      question: qn ? Number(qn) : undefined,
      use_ai: !!useAI,
    };
    if (payload.question != null && Number.isNaN(payload.question)) {
      notify('大問番号は数値で入力してください', 'error');
      return;
    }
    try {
      setBuilding(true);
      setBuiltFile('');
      setBuiltPreview('');
      const res = await fetch(`${BACKEND_BASE}/curation/build_md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '生成に失敗しました');
      setBuiltFile(data.output_file);
      notify(data.message, 'success');
      // Refresh asset list and fetch preview
      fetch(`${BACKEND_BASE}/curation/assets?university=${encodeURIComponent(selectedUniversity)}&exam_type=${encodeURIComponent(selectedExamType)}`)
        .then(res => res.json())
        .then(d => setAssets(d.assets || []))
        .catch(() => {});
      // Try preview
      const url = `${BACKEND_BASE}/static/problems/${encodeURIComponent(selectedUniversity)}/${encodeURIComponent(selectedExamType)}/${encodeURIComponent(data.output_file)}`;
      fetch(url)
        .then(r => r.text())
        .then(t => setBuiltPreview(t))
        .catch(() => setBuiltPreview(''))
        .finally(() => setBuilding(false));
    } catch (err) {
      setBuilding(false);
      notify(err.message, 'error');
    }
  };

  const universityOptions = Object.keys(problemIndex).sort();
  const examTypeOptions = selectedUniversity ? (problemIndex[selectedUniversity] || []) : [];
  const isTargetSelected = selectedUniversity && selectedExamType;

  const parseQuestionsCSV = (s) => {
    if (!s) return null;
    try {
      const arr = s.split(',').map(x => x.trim()).filter(Boolean).map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0);
      return arr.length ? arr : null;
    } catch { return null; }
  };

  const handleBatchBuild = async () => {
    try {
      setBatchRunning(true);
      setBatchResult(null);
      const payload = { use_ai: !!useAI, concurrency: Number(batchConcurrency) || 2 };
      const qs = parseQuestionsCSV(batchQuestions);
      if (batchScope === 'all') {
        // No targets -> backend enumerates all
      } else if (batchScope === 'university') {
        if (!selectedUniversity) { notify('カテゴリーを選択してください', 'error'); setBatchRunning(false); return; }
        const ets = (problemIndex[selectedUniversity] || []);
        payload.targets = ets.map(et => ({ university: selectedUniversity, exam_type: et, questions: qs || undefined }));
      } else if (batchScope === 'custom') {
        if (!customTargetsJson.trim()) { notify('カスタムターゲット(JSON)を入力してください', 'error'); setBatchRunning(false); return; }
        try {
          const arr = JSON.parse(customTargetsJson);
          if (!Array.isArray(arr)) throw new Error('JSONは配列である必要があります');
          payload.targets = arr;
        } catch (e) {
          notify(`JSONの解析に失敗: ${e.message}`, 'error'); setBatchRunning(false); return;
        }
      }
      if (batchDryRun) payload.dry_run = true;
      const res = await fetch(`${BACKEND_BASE}/curation/batch_build_md`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '一括生成に失敗しました');
      setBatchResult(data);
      notify(data.message || '一括生成が完了しました', 'success');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBatchRunning(false);
    }
  };

  return (
    <div className="curation-container" style={{ padding: '1rem 2rem' }}>
      <div className="curation-header">
        <h3>1. 試験種の選択または作成</h3>
        <div className="curation-controls two-col">
          <div className="curation-panel">
            <div style={{fontWeight:700, marginBottom:8}}>既存の試験種を選択</div>
            <div className="control-group" style={{marginBottom:8}}>
              <label htmlFor="university-select">カテゴリー</label>
              {universityOptions.length > 0 ? (
                <select id="university-select" value={selectedUniversity} onChange={handleUniversityChange}>
                  <option value="">選択してください</option>
                  {universityOptions.map(uni => (
                    <option key={uni} value={uni}>{uni}</option>
                  ))}
                </select>
              ) : (
                <input id="university-select" value={selectedUniversity} onChange={handleUniversityChange} placeholder="カテゴリー名を入力" />
              )}
            </div>
            <div className="control-group" style={{marginBottom:4}}>
              <label htmlFor="exam-type-select">試験種</label>
              <select id="exam-type-select" value={selectedExamType} onChange={e => setSelectedExamType(e.target.value)} disabled={!selectedUniversity}>
                <option value="">{selectedUniversity ? '選択してください' : 'カテゴリーを先に選択'}</option>
                {examTypeOptions.map(et => (
                  <option key={et} value={et}>{et}</option>
                ))}
              </select>
            </div>
            <div style={{fontSize:'0.9rem', color:'#475569', marginTop:6, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
              {selectedUniversity && selectedExamType ? (
                <>
                  <span>{`選択中: ${selectedUniversity} / ${selectedExamType}`}</span>
                  <button
                    className="small-button"
                    style={{ background: '#fee2e2', border: '1px solid #f87171', color: '#b91c1c' }}
                    onClick={handleDeleteExamType}
                    disabled={deletingExam}
                  >
                    {deletingExam ? '削除中...' : '試験種を削除'}
                  </button>
                </>
              ) : 'カテゴリーと試験種を選択してください'}
            </div>
          </div>
          <div className="curation-panel">
            <div style={{fontWeight:700, marginBottom:8}}>新しい試験種を作成</div>
            <div className="control-group" style={{marginBottom:8}}>
              <label htmlFor="new-category">カテゴリー</label>
              <input id="new-category" type="text" value={newCategory} onChange={e=>setNewCategory(e.target.value)} placeholder="例: 新カテゴリー名（大学/学年/中間考査など）" />
            </div>
            <div className="control-group" style={{marginBottom:8}}>
              <label htmlFor="new-exam-type-input">試験種名</label>
              <input id="new-exam-type-input" type="text" value={newExamType} onChange={e => setNewExamType(e.target.value)} placeholder="例: 25年理系 " disabled={!((newCategory && newCategory.trim()) || selectedUniversity)} />
            </div>
            <div>
              <button onClick={handleCreateExamType} disabled={!(((newCategory && newCategory.trim()) || selectedUniversity) && newExamType.trim())} className="small-button">作成</button>
            </div>
          </div>
        </div>
        {selectedUniversity && (
          <div style={{ marginTop: '-0.25rem', marginBottom: '1rem', fontSize: '.9rem' }}>
            <div style={{ color: '#374151', marginBottom: 6, display:'flex', alignItems:'center', gap:8 }}>
              <span>MD整備状況（{selectedUniversity}）</span>
              <button className="small-button" onClick={()=>setShowCoverage(v=>!v)}>{showCoverage ? 'CLOSE' : 'OPEN'}</button>
            </div>
            {showCoverage && (
            <div style={{ display:'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              {(problemIndex[selectedUniversity] || []).map(et => {
                const info = (coverage[selectedUniversity] || {})[et] || { answer_md: false, answers_q: [] };
                const st = statusOf(selectedUniversity, et);
                const running = st.state === 'running';
                const queued = st.state === 'queued';
                return (
                  <div key={et} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, padding:'8px' }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                      <div style={{ fontWeight:600 }}>{et}</div>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        {st.state !== 'idle' && (
                          <span className="badge" style={{ background: queued ? '#fff7ed' : running ? '#dcfce7' : st.state==='done' ? '#dbeafe' : '#fee2e2', border:'1px solid #e5e7eb' }}>
                            {queued ? '待機中' : running ? '作成中…' : st.state==='done' ? '完了' : '失敗'}
                          </span>
                        )}
                        <button className="small-button" disabled={queued || running} onClick={() => enqueueBuild(selectedUniversity, et)}>
                          {info.answer_md ? '再生成' : 'MD作成'}
                        </button>
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:6 }}>
                      <span className="badge" style={{ background: info.answer_md ? '#dcfce7' : '#f1f5f9', border:'1px solid #e5e7eb' }}>
                        {info.answer_md ? 'Answer.md あり' : 'Answer.md なし'}
                      </span>
                      {info.answers_q && info.answers_q.length > 0 && (
                        <span className="badge" style={{ background:'#eff6ff', border:'1px solid #bfdbfe' }}>
                          Q: {info.answers_q.join(',')}
                        </span>
                      )}
                      {st.msg && st.state !== 'idle' && (
                        <span className="badge" style={{ background:'#f8fafc', border:'1px solid #e5e7eb', color:'#475569' }}>{st.msg}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </div>
        )}
      </div>

      <div className={`curation-content ${!isTargetSelected ? 'disabled' : ''}`}>
        <h3>2. 登録済みファイル</h3>
        {isTargetSelected ? (
          loadingAssets ? <p>読み込み中...</p> : (
            <div className="asset-list-container">
              {assets.length > 0 ? (
                <ul className="asset-list">
                  {assets.map(asset => (
                    <li
                      key={asset.name}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <a href={`${BACKEND_BASE}${asset.url}`} target="_blank" rel="noopener noreferrer">
                          {asset.name}
                        </a>
                        <span className={`asset-type ${asset.type}`}>{asset.type}</span>
                      </div>
                      <button
                        className="small-button"
                        style={{ background: '#fee2e2', border: '1px solid #f87171', color: '#b91c1c' }}
                        onClick={() => handleDeleteAsset(asset.name)}
                        disabled={!!deletingAssets[asset.name]}
                      >
                        {deletingAssets[asset.name] ? '削除中…' : '削除'}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p>この試験種にはまだファイルが登録されていません。</p>}
            </div>
          )
      ) : <p style={{ color: '#666' }}>カテゴリーと試験種を選択すると、登録済みのファイルが表示されます。</p>}

      <h3 style={{ marginTop: '2rem' }}>3. ファイルのアップロード</h3>
        <p style={{ color: '#666', marginTop: '-0.5rem', marginBottom: '1rem' }}>
          選択された試験種 (<strong>{selectedUniversity} / {selectedExamType}</strong>) に、問題・採点基準・解答例のPDFやMarkdownを追加します。
        </p>
        <div className={`dropzone ${isDragActive ? 'active' : ''}`}
          onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
          onClick={() => document.getElementById('curationFileInput')?.click()}>
          <p>ここにファイルをドラッグ＆ドロップ or クリックして選択</p>
          <input id="curationFileInput" type="file" multiple onChange={handleFileSelect} style={{ display: 'none' }} />
        </div>
        {files.length > 0 && (
          <>
            <div className="file-list">
              <h4>選択中のファイル ({files.length}件):</h4>
              <ul>{files.map((file, i) => <li key={i}>{file.name}</li>)}</ul>
            </div>
            <button onClick={handleUpload} className="upload-button">{files.length}件のファイルをアップロード</button>
          </>
        )}
        {uploadStatus && <p className="status-message">{uploadStatus}</p>}

        <h3 style={{ marginTop: '2rem' }}>4. Answer.md（参照MD）の生成</h3>
        <p style={{ color: '#666', marginTop: '-0.5rem', marginBottom: '1rem' }}>
          登録済みのPDF/MD/TXTをもとに、AI入力向けの参照Markdown（雛形）を自動生成します。
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end' }}>
          <div className="control-group">
            <label htmlFor="md-title">タイトル（任意）</label>
            <input id="md-title" type="text" value={mdTitle} onChange={e => setMdTitle(e.target.value)} placeholder={`${selectedUniversity} ${selectedExamType} 参照用Markdown`} />
          </div>
          <div className="control-group">
            <label htmlFor="md-question">大問番号（任意: 入力時は Answer_Qn.md）</label>
            <input id="md-question" type="number" min="1" value={mdQuestion} onChange={e => setMdQuestion(e.target.value)} placeholder="例: 6" style={{ width: '100px' }} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={useAI} onChange={()=>setUseAI(v=>!v)} /> AIを使用（整形・統合）
          </label>
          <button onClick={handleBuildMd} disabled={!isTargetSelected || building} className="upload-button">
            {building ? '生成中...' : (mdQuestion ? `Answer_Q${mdQuestion}.md を生成` : 'Answer.md を生成')}
          </button>
        </div>
        {builtFile && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <strong>生成ファイル:</strong>
              <a href={`${BACKEND_BASE}/static/problems/${encodeURIComponent(selectedUniversity)}/${encodeURIComponent(selectedExamType)}/${encodeURIComponent(builtFile)}`} target="_blank" rel="noopener noreferrer">{builtFile}</a>
            </div>
            {builtPreview && (
              <div style={{ marginTop: '0.5rem', border: '1px solid #e5e7eb', borderRadius: 6, padding: '0.75rem', maxHeight: 360, overflow: 'auto', background: '#fff' }}>
                <MarkdownPreview markdown={builtPreview} />
              </div>
            )}
          </div>
        )}

        <h3 style={{ marginTop: '2rem' }}>5. 一括生成（大量の試験種に対して）</h3>
        <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: '1fr' }}>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name="batch-scope" checked={batchScope==='all'} onChange={()=>setBatchScope('all')} /> 全カテゴリー・全試験種
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name="batch-scope" checked={batchScope==='university'} onChange={()=>setBatchScope('university')} /> 選択中のカテゴリーの全試験種
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name="batch-scope" checked={batchScope==='custom'} onChange={()=>setBatchScope('custom')} /> カスタムターゲット(JSON)
            </label>
          </div>

          {batchScope === 'custom' && (
            <textarea
              value={customTargetsJson}
              onChange={e=>setCustomTargetsJson(e.target.value)}
              placeholder='例: [{"university":"一橋カテゴリー","exam_type":"24年文系","questions":[1,2,3]}]'
              style={{ width:'100%', minHeight: 120, fontFamily:'monospace', border:'1px solid #e5e7eb', borderRadius:8, padding:'0.5rem' }}
            />
          )}

          <div style={{ display:'flex', gap:'1rem', alignItems:'center', flexWrap:'wrap' }}>
            <div className="control-group">
              <label htmlFor="batch-questions">大問番号（任意・カンマ区切り）</label>
              <input id="batch-questions" type="text" value={batchQuestions} onChange={e=>setBatchQuestions(e.target.value)} placeholder="例: 1,2,3" style={{ width: 180 }} />
            </div>
            <div className="control-group">
              <label htmlFor="batch-concurrency">並列数</label>
              <input id="batch-concurrency" type="number" min="1" max="8" value={batchConcurrency} onChange={e=>setBatchConcurrency(e.target.value)} style={{ width: 100 }} />
            </div>
            <label style={{ display:'flex', gap:6, alignItems:'center' }}>
              <input type="checkbox" checked={batchDryRun} onChange={()=>setBatchDryRun(v=>!v)} /> ドライラン（対象だけ確認）
            </label>
            <label style={{ display:'flex', gap:6, alignItems:'center' }}>
              <input type="checkbox" checked={useAI} onChange={()=>setUseAI(v=>!v)} /> AIを使用（整形・統合）
            </label>
            <button onClick={handleBatchBuild} disabled={batchRunning} className="upload-button">
              {batchRunning ? '一括生成中...' : '一括生成を実行'}
            </button>
          </div>

          {batchResult && (
            <div style={{ marginTop: '0.5rem' }}>
              <div style={{ marginBottom: '0.5rem' }}><strong>{batchResult.message}</strong></div>
              <div className="asset-list-container">
                <ul className="asset-list">
                  {(batchResult.results || []).map((r, i) => (
                    <li key={i}>
                      <span>{r.university} / {r.exam_type}{r.question != null ? ` / Q${r.question}` : ''} — </span>
                      {r.skipped ? (
                        <span className="asset-type text">skipped</span>
                      ) : r.ok ? (
                        r.output_file ? (
                          <a href={`${BACKEND_BASE}/static/problems/${encodeURIComponent(r.university)}/${encodeURIComponent(r.exam_type)}/${encodeURIComponent(r.output_file)}`} target="_blank" rel="noopener noreferrer">OK: {r.output_file}</a>
                        ) : <span className="asset-type text">OK</span>
                      ) : (
                        <span className="asset-type text" style={{ color:'#b91c1c' }}>NG: {String(r.error)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        <h3 style={{ marginTop: '2rem' }}>6. 署名スタンプ管理</h3>
        <p style={{ color: '#666', marginTop: '-0.5rem', marginBottom: '1rem' }}>編集画面で利用できる署名スタンプの追加・削除を行います。</p>
        <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:8, padding:'1rem', display:'flex', flexDirection:'column', gap:'1rem' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'1rem', flexWrap:'wrap' }}>
            <strong>登録済み署名 ({signatures.length})</strong>
            <div style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
              <input
                type="file"
                accept="image/*"
                ref={signatureInputRef}
                onChange={handleSignatureUpload}
                disabled={signatureUploading}
              />
              {signatureUploading && <span style={{ color:'#475569', fontSize:'.85rem' }}>アップロード中...</span>}
            </div>
          </div>
          {loadingSignatures ? (
            <p style={{ color:'#475569' }}>読み込み中...</p>
          ) : (
            <div style={{ display:'grid', gap:'0.75rem', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {signatures.map(sig => (
                <div key={sig.name} style={{ border:'1px solid #e2e8f0', borderRadius:8, padding:'0.75rem', display:'flex', flexDirection:'column', gap:'0.5rem' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:'0.75rem' }}>
                    <div style={{ width:92, height:64, border:'1px solid #dbeafe', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', background:'#fff' }}>
                      <img src={resolveSignatureUrl(sig)} alt={sig.name} style={{ maxWidth:'88px', maxHeight:'60px', objectFit:'contain' }} />
                    </div>
                    <div>
                      <div style={{ fontWeight:600 }}>{sig.name}{sig.builtin ? '（既定）' : ''}</div>
                      {!sig.builtin && <div style={{ fontSize:12, color:'#64748b' }}>クリックすると選択できます（編集画面のボタン）</div>}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                    {!sig.builtin && (
                      <button
                        className="small-button"
                        style={{ background:'#fee2e2', border:'1px solid #f87171', color:'#b91c1c' }}
                        onClick={() => handleDeleteSignature(sig)}
                        disabled={!!signatureDeleting[sig.name]}
                      >
                        {signatureDeleting[sig.name] ? '削除中…' : '削除'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        </div>
      </div>
    </div>
  );
}

export default CurationTab;
