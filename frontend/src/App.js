import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import CurationTab from './CurationTab';
import './App.css';
import './ui/tokens.css';
import logo from './assets/stamps/logo.png';
import './ui/button.css';
import Lozenge, { statusToVariant } from './ui/Lozenge';
import KebabMenu from './ui/KebabMenu';
import ColumnsMenu from './ui/ColumnsMenu';
import Button, { IconButton } from './ui/Button';
import { IconImage, IconPencil, IconEraser, IconArrowRight, IconLine, IconTrash, IconUndo, IconRedo, IconSave, IconExport, IconCheck, IconPlusCircle, IconBrain, IconCircle, IconCross, IconBracket, IconPdf, IconSideBySide, IconMerge } from './ui/icons';
import SplitButton from './ui/SplitButton';

// Backend base URL for API calls (configurable via REACT_APP_BACKEND_BASE)
const BACKEND_BASE = process.env.REACT_APP_API_BASE_URL || 'https://backend-service-o4pkfgmopa-uc.a.run.app';
const DEFAULT_SIGNATURE = { name: 'name.png', url: '/assets/stamps/name.png', builtin: true };

// Utility: format seconds to HH:MM:SS
function formatSeconds(total) {
  const s = Math.max(0, parseInt(total || 0, 10));
  const hh = String(Math.floor(s/3600)).padStart(2,'0');
  const mm = String(Math.floor((s%3600)/60)).padStart(2,'0');
  const ss = String(s%60).padStart(2,'0');
  return `${hh}:${mm}:${ss}`;
}

// --- Components ---

function FileUploader({ onUploadSuccess }) {
  // (変更なし)
  const [files, setFiles] = useState([]);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isDragActive, setIsDragActive] = useState(false);
  const [preview, setPreview] = useState(null); // { filename, url }    

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
      const newFiles = Array.from(event.dataTransfer.files).filter(f => f.type === 'application/pdf');
      setFiles(prev => [...prev, ...newFiles]);
    }
  }, []);

  const handleFileSelect = (event) => {
    if (event.target.files?.[0]) {
      const newFiles = Array.from(event.target.files).filter(f => f.type === 'application/pdf');
      setFiles(prev => [...prev, ...newFiles]);
    }
  };

  const handleUpload = () => {
    if (files.length === 0) return;
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    setUploadStatus('アップロード中...');
    fetch(`${BACKEND_BASE}/upload`, { method: 'POST', body: formData })
      .then(res => res.json())
      .then(data => {
        setUploadStatus(data.message);
        setFiles([]);
        onUploadSuccess();
      })
      .catch(err => { console.error(err); setUploadStatus("アップロードに失敗しました。"); });
  };

  return (
    <div className="upload-container">
      <h2>1. 答案PDFを一括アップロード</h2>
      <div className={`dropzone ${isDragActive ? 'active' : ''}`}
        onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
        onClick={() => document.getElementById('fileInput')?.click()}>
        <p>ここにPDFファイルをドラッグ＆ドロップ or クリックして選択</p>
        <input id="fileInput" type="file" accept=".pdf" multiple onChange={handleFileSelect} style={{ display: 'none' }} />
      </div>
      {files.length > 0 && (
        <>
          <div className="file-list">
            <h3>選択中のファイル ({files.length}件):</h3>
            <ul>{files.map((file, i) => <li key={i}>{file.name}</li>)}</ul>
          </div>
          <button onClick={handleUpload} className="upload-button">{files.length}件のファイルをアップロード</button>
        </>
      )}
      {uploadStatus && <p className="status-message">{uploadStatus}</p>}
    </div>
  );
}

function ReviewPanel({ filename, review, onClose }) {
  if (!review) return null;
  const summary = review.summary || { total_score: 0, max_score: 0, notes: '' };
  const questions = review.questions || [];
  return (
    <div className="review-panel">
      <div className="review-header" style={{display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'start', marginBottom:12}}>
        <div className="review-top">
          <h3 style={{margin:0, fontWeight:700, color:'#0f172a', overflowWrap:'anywhere'}}>{filename} のレビュー</h3>
        </div>
        <div className="actions" style={{display:'flex', gap:8}}>
          <button className="btn-ghost-sky" onClick={onClose}>閉じる</button>
        </div>
        <div className="review-summary" style={{display:'flex', gap:8, flexWrap:'wrap', gridColumn:'1 / -1', marginTop:6}}>
          <span className="badge">合計: {summary.total_score} / {summary.max_score}</span>
          {summary.notes ? <span className="badge">備考: {summary.notes}</span> : null}
        </div>
      </div>
      <div>
        {questions.map((q, idx) => (
          <div key={idx} className="question-card">
            <div className="question-title">小問 {q.id} — {q.awarded} / {q.max}</div>
            <div>
              {(q.comments || []).map((c, j) => (
                <div key={j} className={`comment ${c.type}`}>
                  <div>{c.text}</div>
                  {c.points != null && <div style={{opacity: 0.8}}>配点: {c.points}点 / 対象: {c.target}</div>}
                </div>
              ))}
            </div>
            {/* pager is not shown inside ReviewPanel */}
          </div>
        ))}
      </div>
    </div>
  );
}

function AnswerDashboard({ answers, onProcessStart, isProcessing, onDelete, onEdit, notify, confirmToast, refresh }) {
  const [activeTab, setActiveTab] = useState('list');
  const [activeReview, setActiveReview] = useState(null);
  // quick filter: 'all' | 'pending' | 'processing' | 'ai_done' | 'done' | 'error'
  const [statusFilter, setStatusFilter] = useState('all');
  // column visibility
  const [cols, setCols] = useState({ uploaded_at: true, editing_time: true, exam: true, status: true, quality: true });
  useEffect(() => {
    try {
      const raw = localStorage.getItem('answerColumns');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') setCols(prev => ({ ...prev, ...parsed }));
      }
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem('answerColumns', JSON.stringify(cols)); } catch {}
  }, [cols]);

  const handleShowReview = async (filename) => {
    if (activeReview && activeReview.filename === filename) {
      return setActiveReview(null);
    }
    try {
      const found = answers.find(a => a.filename === filename);
      if (found && found.review) {
        setActiveReview({ filename, review: found.review });
        return;
      }
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/review`);
      if (!res.ok) throw new Error('Failed to fetch review');
      const data = await res.json();
      setActiveReview({ filename, review: data.review });
    } catch (e) {
      notify('レビューの取得に失敗しました','error');
    }
  };

  const handleCloseReview = () => setActiveReview(null);

  const getStatusClassName = (status) => {
    // e.g., "仕分済 (自動可)" -> "status-仕分済-自動可"
    return `status-${status.replace(/\s/g, '-').replace(/[()]/g, '')}`;
  };
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [reprocessTarget, setReprocessTarget] = useState(null);
  const [steps, setSteps] = useState({ png:false, quality:false, transcribe:false, identify:false, review:true });
  const [force, setForce] = useState(false);
  const [selected, setSelected] = useState({});
  const [reprocessStatus, setReprocessStatus] = useState('');
  const statusPollRef = useRef(null);
  const [preview, setPreview] = useState(null); // { filename, url }
  // Pager & auto-refresh & hover preview
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshMs, setRefreshMs] = useState(3000);
  const autoRef = useRef(null);
  const [hover, setHover] = useState({ show:false, url:null, x:0, y:0 });
  const hoverTid = useRef(null);
  const mousePosRef = useRef({ x: 0, y: 0 });
  const computePopoverPosAtMouse = (cx, cy) => {
    try {
      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;
      const W = 240, H = 300; // approx preview size
      const x = Math.min(vw - W - 8, Math.max(8, cx + 12));
      const y = Math.min(vh - H - 8, Math.max(8, cy + 12));
      return { x, y };
    } catch {
      return { x: cx + 12, y: cy + 12 };
    }
  };
  const [reasonDialog, setReasonDialog] = useState({ show:false, title:'', reason:'' });

  useEffect(() => { setPage(1); }, [statusFilter]);
  useEffect(() => { setPage(1); }, [answers]);
  useEffect(() => {
    if (!autoRefresh) { if (autoRef.current) { clearInterval(autoRef.current); autoRef.current=null; } return; }
    autoRef.current = setInterval(() => { try { if (typeof refresh==='function') refresh(); } catch {} }, refreshMs);
    return () => { if (autoRef.current) { clearInterval(autoRef.current); autoRef.current=null; } };
  }, [autoRefresh, refreshMs, refresh]);

  const toggleStep = (k) => setSteps(prev => ({...prev, [k]: !prev[k]}));
  const openReprocess = (filename) => {
    if (reprocessOpen && reprocessTarget === filename) {
      setReprocessOpen(false);
      setReprocessTarget(null);
      try { if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null; } } catch {}
    } else {
      setReprocessTarget(filename);
      setReprocessOpen(true);
      try { if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null; } } catch {}
      const ans = answers.find(a => a.filename === filename);
      setReprocessStatus(ans ? (ans.status + (ans.error ? ` — ${ans.error}` : '')) : '');
      // 初期ステップを状態に応じて調整（エラー時は identify + review を提案）
      try {
        const s = (ans && String(ans.status)) || '';
        if (s.includes('エラー')) {
          setSteps({ png:false, quality:false, transcribe:false, identify:true, review:true });
        }
      } catch {}
      statusPollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/status`);
          if (res.ok) {
            const s = await res.json();
            const extra = s.last_step ? ` (${s.last_step})` : '';
            setReprocessStatus((s.status || '-') + extra + (s.last_error ? ` — ${s.last_error}` : ''));
          } else {
            const res2 = await fetch(`${BACKEND_BASE}/answers`);
            const data = await res2.json();
            const ans2 = (data.answers || []).find(a => a.filename === filename);
            if (ans2) setReprocessStatus(ans2.status + (ans2.error ? ` — ${ans2.error}` : ''));
          }
          // 同期的にダッシュボードのステータスも更新
          try { if (typeof refresh === 'function') refresh(); } catch {}
        } catch {}
      }, 1000);
    }
  };
  const runReprocess = async () => {
    if (!reprocessTarget) return;
    const chosen = Object.entries(steps).filter(([k,v])=>v).map(([k])=>k);
    if (chosen.length === 0) { notify('少なくとも1つ選択してください','info'); return; }
    try {
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(reprocessTarget)}/reprocess`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ steps: chosen, force })
      });
      const data = await res.json();
      notify(data.message || '再処理しました','success');
      try { if (typeof refresh === 'function') refresh(); } catch {}
    } catch {
      notify('再処理に失敗しました','error');
    }
  };
  useEffect(() => () => { try { if (statusPollRef.current) clearInterval(statusPollRef.current); } catch {} }, []);

  const openPreview = async (filename) => {
    try {
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/pages`);
      if (!res.ok) throw new Error('pages not found');
      const data = await res.json();
      const first = (data.pages || [])[0] || null;
      if (!first) { notify('プレビューできる画像がありません','info'); return; }
      setPreview({ filename, url: first });
    } catch (e) {
      notify('プレビューの取得に失敗しました','error');
    }
  };

  // Filtered view
  const visibleAnswers = (answers || []).filter(a => {
    const s = String(a.status || '');
    switch (statusFilter) {
      case 'pending':
        return !s || s === '未処理' || s.startsWith('仕分済');
      case 'processing':
        return s.includes('処理中') || s.includes('再処理中');
      case 'ai_done':
        return s === 'AI添削完了';
      case 'done':
        return s === '添削完了';
      case 'error':
        return s.includes('エラー');
      default:
        return true;
    }
  });
  const columnsCount = 2 + (cols.uploaded_at?1:0) + (cols.editing_time?1:0) + (cols.exam?1:0) + (cols.status?1:0) + (cols.quality?1:0) + 1;
  const totalPages = Math.max(1, Math.ceil(visibleAnswers.length / pageSize));
  const pageClamped = Math.min(Math.max(1, page), totalPages);
  const startIdx = (pageClamped - 1) * pageSize;
  const pagedAnswers = visibleAnswers.slice(startIdx, startIdx + pageSize);

  return (
    <div className="dashboard-container">
      <h2>2. 答案一覧と自動処理</h2>
      
      <nav className="inner-nav">
        <button onClick={() => setActiveTab('list')} className={activeTab === 'list' ? 'active' : ''}>
          答案一覧
        </button>
        <button onClick={() => setActiveTab('curation')} className={activeTab === 'curation' ? 'active' : ''}>
          添削資料
        </button>
      </nav>

      {activeTab === 'list' && (
        <>
          <Button appearance="primary" onClick={onProcessStart} disabled={answers.filter(a => a.status === '未処理').length === 0 || isProcessing}>
            {isProcessing ? '処理中...' : '未処理の答案の自動処理を開始'}
          </Button>
          <div className="answer-list">
            <h3 style={{display:'flex', alignItems:'center', gap:12}}>
              <span>アップロード済み答案 ({visibleAnswers.length}件)</span>
              <span style={{fontWeight:400, fontSize:'.9rem', color:'#475569'}}>全体: {answers.length}件</span>
            </h3>
            <div className="toolbar-row">
              <div className="toolbar-left">
                <span style={{fontSize:12, color:'#374151'}}>表示</span>
                <button className={`chip ${statusFilter==='all'?'active':''}`} onClick={()=>setStatusFilter('all')}>すべて</button>
                <button className={`chip ${statusFilter==='pending'?'active':''}`} onClick={()=>setStatusFilter('pending')}>未処理/仕分済</button>
                <button className={`chip ${statusFilter==='processing'?'active':''}`} onClick={()=>setStatusFilter('processing')}>処理中</button>
                <button className={`chip ${statusFilter==='ai_done'?'active':''}`} onClick={()=>setStatusFilter('ai_done')}>AI添削完了</button>
                <button className={`chip ${statusFilter==='done'?'active':''}`} onClick={()=>setStatusFilter('done')}>添削完了</button>
                <button className={`chip ${statusFilter==='error'?'active':''}`} onClick={()=>setStatusFilter('error')}>エラー</button>
              </div>
              <div className="toolbar-right">
                <label className="muted" style={{display:'flex', alignItems:'center', gap:6}}>
                  自動更新
                  <input type="checkbox" checked={autoRefresh} onChange={e=> setAutoRefresh(e.target.checked)} />
                  <select className="select" value={refreshMs} onChange={e=> setRefreshMs(parseInt(e.target.value,10))} disabled={!autoRefresh}>
                    <option value={2000}>2秒</option>
                    <option value={3000}>3秒</option>
                    <option value={5000}>5秒</option>
                  </select>
                </label>
                <div className="divider" />
                <SplitButton
                  label="選択操作"
                  appearance="secondary"
                  onClick={() => {
                    // default action: 一括削除
                    const files = answers.filter(a => selected?.[a.filename]).map(a => a.filename);
                    if (!files.length) { notify('一括削除する答案を選択してください','info'); return; }
                    (async () => {
                      const ok = await (confirmToast ? confirmToast('選択した答案を削除しますか？', '削除', 'キャンセル') : new Promise(r=>r(window.confirm('選択した答案を削除しますか？'))));
                      if (!ok) return;
                      let okCount = 0, failCount = 0;
                      for (const fn of files) {
                        try {
                          const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(fn)}`, { method: 'DELETE' });
                          if (res.ok) okCount++; else failCount++;
                        } catch { failCount++; }
                      }
                      notify(`削除完了: ${okCount}件 / 失敗: ${failCount}件`, failCount? 'error':'success');
                    })();
                  }}
                  items={[
                    { label: '全選択', onClick: () => {
                      const files = visibleAnswers.map(a => a.filename);
                      const next = {}; files.forEach(f => next[f] = true); setSelected(next);
                    }},
                    { label: '全解除', onClick: () => setSelected({}) },
                    { label: '選択を一括削除', danger: true, onClick: () => {
                      const files = answers.filter(a => selected?.[a.filename]).map(a => a.filename);
                      if (!files.length) { notify('一括削除する答案を選択してください','info'); return; }
                      (async () => {
                        const ok = await (confirmToast ? confirmToast('選択した答案を削除しますか？', '削除', 'キャンセル') : new Promise(r=>r(window.confirm('選択した答案を削除しますか？'))));
                        if (!ok) return;
                        let okCount = 0, failCount = 0;
                        for (const fn of files) {
                          try {
                            const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(fn)}`, { method: 'DELETE' });
                            if (res.ok) okCount++; else failCount++;
                          } catch { failCount++; }
                        }
                        notify(`削除完了: ${okCount}件 / 失敗: ${failCount}件`, failCount? 'error':'success');
                      })();
                    }},
                  ]}
                />
                <div className="divider" />
                <ColumnsMenu value={cols} onChange={setCols} />
              </div>
            </div>
            <div className="pager-row">
              <span className="muted">{visibleAnswers.length} 件中 {visibleAnswers.length? (startIdx+1) : 0}–{Math.min(startIdx+pageSize, visibleAnswers.length)} 件</span>
              <label className="muted">1ページあたり
                <select className="select" value={pageSize} onChange={e=> { setPageSize(parseInt(e.target.value,10)); setPage(1); }} style={{marginLeft:6}}>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </label>
              <button className="btn" onClick={()=> setPage(p=> Math.max(1, p-1))} disabled={pageClamped<=1}>前へ</button>
              <span className="muted">{pageClamped} / {totalPages}</span>
              <button className="btn" onClick={()=> setPage(p=> Math.min(totalPages, p+1))} disabled={pageClamped>=totalPages}>次へ</button>
            </div>
            <table className="sticky-head">
              <thead>
                <tr>
                  <th className="col-checkbox"></th>
                  <th className="col-filename">ファイル名</th>
                  {cols.uploaded_at && <th>アップロード日</th>}
                  {cols.editing_time && <th>編集時間</th>}
                  {cols.exam && <th>試験種</th>}
                  {cols.status && <th>ステータス</th>}
                  {cols.quality && <th>仕分け理由</th>}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedAnswers.map((answer, i) => (
                  <React.Fragment key={i}>
                    <tr className={answer.status === '添削完了' ? 'completed' : ''}>
                      <td className="col-checkbox" data-label=""><input type="checkbox" checked={!!(selected && selected[answer.filename])} onChange={(e)=> setSelected(prev => ({...(prev||{}), [answer.filename]: e.target.checked}))} /></td>
                      <td className="col-filename" data-label="ファイル名" onPointerMove={(e)=>{
                        mousePosRef.current = { x: e.clientX, y: e.clientY };
                        if (!hover.show) return;
                        const p = computePopoverPosAtMouse(mousePosRef.current.x, mousePosRef.current.y);
                        setHover(h => ({ ...h, x: p.x, y: p.y }));
                      }} onMouseEnter={async (e)=>{
                        try { if (hoverTid.current) { clearTimeout(hoverTid.current); hoverTid.current=null; } } catch{}
                        const cx = e.clientX, cy = e.clientY;
                        mousePosRef.current = { x: cx, y: cy };
                        const p0 = computePopoverPosAtMouse(cx, cy);
                        setHover({ show:true, url:null, x: p0.x, y: p0.y });
                        try {
                          const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(answer.filename)}/pages`);
                          if (!res.ok) throw new Error('pages');
                          const data = await res.json();
                          const first = (data.pages||[])[0] || null;
                          if (first) {
                            const p = computePopoverPosAtMouse(mousePosRef.current.x, mousePosRef.current.y);
                            setHover({ show:true, url:first, x: p.x, y: p.y });
                          }
                        } catch {}
                      }} onPointerLeave={()=>{
                        try{ if (hoverTid.current) clearTimeout(hoverTid.current);}catch{}
                        hoverTid.current = setTimeout(()=> setHover({ show:false, url:null, x:0, y:0 }), 120);
                      }}><span className="ellipsis">{String(answer.status||'').includes('処理中') ? <span className="spinner" /> : null}{answer.filename}</span></td>
                      {cols.uploaded_at && (<td data-label="アップロード日">{answer.uploaded_at ? new Date(answer.uploaded_at).toLocaleString('ja-JP') : '-'}</td>)}
                      {cols.editing_time && (<td data-label="編集時間">{formatSeconds(answer.editing_time_seconds || 0)}</td>)}
                      {cols.exam && (<td data-label="試験種">
                        {(() => {
                          const baseText = (answer.details?.university || answer.exam_type)
                            ? `${answer.details?.university ? `${answer.details.university}・` : ''}${answer.exam_type || '-'}`
                            : null;
                            
                          const fullText = (baseText && answer.details?.question_number)
                            ? `${baseText}・第${answer.details.question_number}問`
                            : baseText;
    
                          return fullText || '-';
                        })()}
                      </td>)}
                      {cols.status && (<td data-label="ステータス"><Lozenge variant={statusToVariant(answer.status)}>{answer.status || '-'}</Lozenge></td>)}
                      {cols.quality && (<td data-label="仕分け理由">
                        {answer.quality ? (
                          <>
                            <span style={{fontWeight: 'bold'}}>{answer.quality.label}</span>
                            {answer.quality.reason ? <>
                              ：<span className="ellipsis" style={{maxWidth:200}}>{answer.quality.reason}</span>
                              <Button appearance="subtle" size="s" style={{ marginLeft: 6 }} onClick={() => setReasonDialog({ show:true, title: `${answer.filename} — 仕分け理由`, reason: String(answer.quality.reason||'') })}>
                                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{marginRight:4}}>
                                  <path fill="currentColor" d="M12 5c-7.633 0-10 7-10 7s2.367 7 10 7 10-7 10-7-2.367-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>
                                </svg>
                                全文
                              </Button>
                            </> : ''}
                          </>
                        ) : '-' }
                      </td>)}
                      <td data-label="操作">
                        <IconButton appearance="subtle" aria-label="添削" title="添削" onClick={() => onEdit(answer.filename)}>
                          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42L18.37 3.29a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.83z" fill="currentColor"/></svg>
                        </IconButton>
                        <span style={{ marginLeft: 6 }}>
                        <KebabMenu
                          items={[
                              ...(answer.status === 'AI添削完了' || answer.status === '要レビュー' || answer.review ? [{ label: 'AIレビューを見る', onClick: () => handleShowReview(answer.filename) }] : []),
                              ...(answer.quality && answer.quality.reason ? [{ label: '仕分け理由を表示', onClick: () => setReasonDialog({ show:true, title: `${answer.filename} — 仕分け理由`, reason: String(answer.quality.reason||'') }) }] : []),
                              { label: 'プレビュー', onClick: () => openPreview(answer.filename) },
                              { label: '再処理', onClick: () => openReprocess(answer.filename) },
                              { label: '削除', onClick: () => onDelete(answer.filename), danger: true },
                          ]}
                        />
                        </span>
                      </td>
                    </tr>
                    {reprocessTarget === answer.filename && reprocessOpen && (
                      <tr>
                        <td colSpan={columnsCount} style={{padding: '0.5rem 1rem'}}>
                          <div className="reprocess-panel">
                            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
                              <div><strong>再処理対象:</strong> {reprocessTarget}</div>
                              <div>
                                <label><input type="checkbox" checked={force} onChange={()=>setForce(v=>!v)} /> 強制（既存成果物を無視）</label>
                              </div>
                            </div>
                            <div style={{marginTop:6, fontSize:'.9rem', opacity:.95}}>
                              現在のステータス: {reprocessStatus || '-'}
                            </div>
                            <div style={{marginTop:8}}>
                              <label><input type="checkbox" checked={steps.png} onChange={()=>toggleStep('png')} /> PDF→PNG</label>
                              <label><input type="checkbox" checked={steps.quality} onChange={()=>toggleStep('quality')} /> 仕分け</label>
                              <label><input type="checkbox" checked={steps.transcribe} onChange={()=>toggleStep('transcribe')} /> 書き起こし</label>
                              <label><input type="checkbox" checked={steps.identify} onChange={()=>toggleStep('identify')} /> 特定</label>
                              <label><input type="checkbox" checked={steps.review} onChange={()=>toggleStep('review')} /> 添削</label>
                            </div>
                            <div className="toolbar">
                              <button className="small-button" onClick={runReprocess}>実行</button>
                              <button className="small-button" onClick={()=>{ setReprocessOpen(false); try { if (statusPollRef.current) clearInterval(statusPollRef.current); } catch {} }}>閉じる</button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    {activeReview && activeReview.filename === answer.filename && (
                      <tr>
                        <td colSpan={columnsCount}>
                          <ReviewPanel
                            filename={activeReview.filename}
                            review={activeReview.review}
                            onClose={handleCloseReview}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            
            {hover.show && createPortal(
              <div className="hover-thumb" style={{ left: `${hover.x}px`, top: `${hover.y}px` }}>
                {hover.url ? <img src={hover.url} alt="thumb" /> : <div style={{display:'flex', alignItems:'center', justifyContent:'center', width:220, height:180}}><span className="spinner" /></div>}
              </div>, document.body
            )}

            {reasonDialog.show && createPortal(
              <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:2147483646, display:'flex', alignItems:'center', justifyContent:'center'}} onClick={()=>setReasonDialog({ show:false, title:'', reason:'' })}>
                <div style={{background:'#fff', padding:14, borderRadius:10, maxWidth:'92vw', maxHeight:'80vh', width:'640px'}} onClick={(e)=>e.stopPropagation()}>
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
                    <div style={{fontWeight:700, color:'#0f172a'}}>{reasonDialog.title || '仕分け理由'}</div>
                    <button className="small-button" onClick={()=>setReasonDialog({ show:false, title:'', reason:'' })}>閉じる</button>
                  </div>
                  <div style={{whiteSpace:'pre-wrap', overflow:'auto'}}>{reasonDialog.reason || '-'}</div>
                </div>
              </div>, document.body
            )}

            {preview && createPortal(
              <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:2147483646, display:'flex', alignItems:'center', justifyContent:'center'}} onClick={()=>setPreview(null)}>
                <div style={{background:'#fff', padding:12, borderRadius:8, maxWidth:'90vw', maxHeight:'90vh'}} onClick={(e)=>e.stopPropagation()}>
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
                    <div style={{fontWeight:600}}>{preview.filename}</div>
                    <button className="small-button" onClick={()=>setPreview(null)}>閉じる</button>
                  </div>
                  <img src={preview.url} alt="preview" style={{maxWidth:'85vw', maxHeight:'80vh', display:'block'}} />
                </div>
              </div>, document.body
            )}
          </div>
        </>
      )}
      {activeTab === 'curation' && (
        <CurationTab notify={notify} />
      )}
    </div>
  );
}

// --- Main App ---
function Editor({ filename, onClose, onAfterClose, notify, onComplete }) {
  const editorRootRef = useRef(null);
  const [pages, setPages] = useState([]);
  const [current, setCurrent] = useState(0);
  const [review, setReview] = useState(null);
  const [examType, setExamType] = useState('');
  const [university, setUniversity] = useState('');
  const [questionNumber, setQuestionNumber] = useState(null);
  const [boxes, setBoxes] = useState([]); // {id, type:'text'|'score'|'image', page, x,y,w,h,fontSize,fontWeight,text,points,src}
  const [signatures, setSignatures] = useState([DEFAULT_SIGNATURE]);
  const [activeSignature, setActiveSignature] = useState(DEFAULT_SIGNATURE);
  const [showSignatureManager, setShowSignatureManager] = useState(false);
  const [signatureUploading, setSignatureUploading] = useState(false);
  const [signatureDeleting, setSignatureDeleting] = useState({});
  const signatureInputRef = useRef(null);
  const [problemAssets, setProblemAssets] = useState([]);
  const [problemSel, setProblemSel] = useState({ problem_pdf: null, rubric_pdf: null });
  
  // Selector UI for exam type + question
  const [showSelector, setShowSelector] = useState(false);
  const [problemIndex, setProblemIndex] = useState({}); // { [university]: string[] examTypes }
  const [tmpUniversity, setTmpUniversity] = useState('');
  const [tmpExamType, setTmpExamType] = useState('');
  const [tmpQuestion, setTmpQuestion] = useState('');
  const pageRef = useRef(null);
  const [drawMode, setDrawMode] = useState(false);
  const [eraserMode, setEraserMode] = useState(false);
  const drawingRef = useRef({ active: false, id: null });
  const [placeMode, setPlaceMode] = useState(null); // { type, payload }
  const [lastScorePoints, setLastScorePoints] = useState(1);
  const [strokeWidth, setStrokeWidth] = useState(() => {
    if (typeof window === 'undefined') return 4;
    const stored = Number(window.localStorage.getItem('strokeWidth'));
    return Number.isFinite(stored) && stored >= 1 ? stored : 4;
  });
  const [combinePages, setCombinePages] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [hoverEdge, setHoverEdge] = useState({ id: null, edge: null }); // {id, edge:'l'|'r'}
  const textRefs = useRef({});
  const renderRefs = useRef({});
  const resizingRef = useRef(false);
  const markInputRef = useRef(null);
  const canvasRefs = useRef({});
  const imageRefs = useRef({});
  const strokeCacheRef = useRef({});
  const activeStrokeRef = useRef(null);
  const drawQueueRef = useRef([]);
  const resolveSignatureSrc = useCallback((sig) => {
    if (!sig || !sig.url) return DEFAULT_SIGNATURE.url;
    const url = sig.url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/assets/')) return url;
    return `${BACKEND_BASE}${url}`;
  }, []);

  const loadSignatures = useCallback(() => {
    fetch(`${BACKEND_BASE}/signatures`)
      .then(res => {
        if (!res.ok) throw new Error('failed to load signatures');
        return res.json();
      })
      .then(data => {
        const fetched = Array.isArray(data.signatures) ? data.signatures : [];
        const mapped = fetched
          .map(sig => ({ ...sig, builtin: false }))
          .filter(sig => sig.name !== DEFAULT_SIGNATURE.name);
        const list = [DEFAULT_SIGNATURE, ...mapped];
        setSignatures(list);
        setActiveSignature(prev => {
          if (!prev) return list[0];
          const found = list.find(s => s.name === prev.name);
          return found || list[0];
        });
      })
      .catch(err => {
        console.error('Failed to load signatures:', err);
        setSignatures([DEFAULT_SIGNATURE]);
        setActiveSignature(DEFAULT_SIGNATURE);
      });
  }, []);

  useEffect(() => {
    loadSignatures();
  }, [loadSignatures]);

  const signatureMenuItems = useMemo(() => [
    ...signatures.map(sig => ({
      label: activeSignature?.name === sig.name ? `★ ${sig.name}` : sig.name,
      onClick: () => setActiveSignature(sig),
    })),
    { label: '署名を管理…', onClick: () => setShowSignatureManager(true) },
  ], [signatures, activeSignature]);

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
      if (data.signature && data.signature.name) {
        setActiveSignature({ name: data.signature.name, url: data.signature.url || '', builtin: false });
      }
      loadSignatures();
    } catch (err) {
      notify(err.message || '署名の登録に失敗しました', 'error');
    } finally {
      setSignatureUploading(false);
    }
  };

  const handleDeleteSignature = async (sig) => {
    if (sig?.builtin) {
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
      if (activeSignature?.name === sig.name) {
        setActiveSignature(DEFAULT_SIGNATURE);
      }
      loadSignatures();
    } catch (err) {
      notify(err.message || '署名の削除に失敗しました', 'error');
    } finally {
      setSignatureDeleting(prev => {
        const next = { ...prev };
        delete next[sig.name];
        return next;
      });
    }
  };

  const signatureManagerPortal = showSignatureManager ? createPortal(
    (
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
        onClick={() => setShowSignatureManager(false)}
      >
        <div
          style={{ background: '#fff', padding: '1.5rem', borderRadius: 12, width: 'min(520px, 90vw)', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 16px 40px rgba(15,23,42,0.25)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 style={{ marginTop: 0 }}>署名スタンプの管理</h3>
          <p style={{ color: '#475569', fontSize: '.9rem', marginBottom: '1rem' }}>登録済みの署名を選択・削除できます。PNG など透過背景の画像がおすすめです。</p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {signatures.map(sig => (
              <li
                key={sig.name}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <img
                    src={resolveSignatureSrc(sig)}
                    alt={sig.name}
                    style={{ width: 80, height: 60, objectFit: 'contain', border: '1px solid #dbeafe', borderRadius: 6, background: '#fff' }}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>{sig.name}{activeSignature?.name === sig.name ? '（使用中）' : ''}</div>
                    {sig.builtin && <div style={{ fontSize: 12, color: '#64748b' }}>既定の署名</div>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    className="small-button"
                    onClick={() => { setActiveSignature(sig); setShowSignatureManager(false); notify(`署名「${sig.name}」を選択しました`, 'info'); }}
                  >
                    使用する
                  </button>
                  {!sig.builtin && (
                    <button
                      className="small-button"
                      style={{ background: '#fee2e2', border: '1px solid #f87171', color: '#b91c1c' }}
                      onClick={() => handleDeleteSignature(sig)}
                      disabled={!!signatureDeleting[sig.name]}
                    >
                      {signatureDeleting[sig.name] ? '削除中…' : '削除'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: '1rem', borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="signature-upload" style={{ fontWeight: 600 }}>新しい署名を登録</label>
            <input
              id="signature-upload"
              type="file"
              accept="image/*"
              ref={signatureInputRef}
              onChange={handleSignatureUpload}
              disabled={signatureUploading}
            />
            {signatureUploading && <span style={{ color: '#475569', fontSize: '.85rem' }}>アップロード中...</span>}
            <span style={{ color: '#64748b', fontSize: '.8rem' }}>※ 300px 四方程度のPNG推奨です。</span>
          </div>
          <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="small-button" onClick={() => setShowSignatureManager(false)}>閉じる</button>
          </div>
        </div>
      </div>
    ),
    document.body
  ) : null;

  const drawFrameRef = useRef(null);
  // Detect last input device ('mouse' | 'touch' | 'pen') for UX tuning
  const [inputDevice, setInputDevice] = useState('mouse');
  const activePointerRef = useRef(null);
  const stylusBlockRef = useRef(null);
  const penLockRef = useRef(0);
  const setDrawingState = (flag) => {
    try {
      const node = pageRef.current;
      if (!node) return;
      if (flag) node.classList.add('drawing'); else node.classList.remove('drawing');
    } catch {}
  };

  const lockPenScroll = () => {
    try {
      const node = pageRef.current;
      if (!node) return;
      if (penLockRef.current === 0) {
        const handler = (ev) => {
          try {
            const touches = Array.from(ev.touches || []);
            if (touches.some(t => String(t.touchType || '').toLowerCase() === 'stylus')) {
              ev.preventDefault();
            }
          } catch {}
        };
        stylusBlockRef.current = { handler, node };
        node.addEventListener('touchstart', handler, { passive: false });
        node.addEventListener('touchmove', handler, { passive: false });
      }
      penLockRef.current += 1;
    } catch {}
  };

  const unlockPenScroll = () => {
    try {
      if (penLockRef.current > 0) penLockRef.current -= 1;
      if (penLockRef.current <= 0) {
        penLockRef.current = 0;
        const record = stylusBlockRef.current;
        if (record && record.node) {
          const { handler, node } = record;
          node.removeEventListener('touchstart', handler);
          node.removeEventListener('touchmove', handler);
          stylusBlockRef.current = null;
        }
      }
    } catch {}
  };

  const scheduleDrawFlush = useCallback(() => {
    if (drawFrameRef.current !== null) return;
    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = null;
      const queue = drawQueueRef.current;
      drawQueueRef.current = [];
      queue.forEach((segment) => {
        const canvas = canvasRefs.current[segment.page];
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.strokeStyle = '#ff4141';
        ctx.lineWidth = segment.width;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (!segment.from) {
          ctx.fillStyle = '#ff4141';
          ctx.beginPath();
          ctx.arc(segment.to.x, segment.to.y, segment.width / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(segment.from.x, segment.from.y);
          ctx.lineTo(segment.to.x, segment.to.y);
          ctx.stroke();
        }
      });
    });
  }, []);

  const queueDrawSegment = useCallback((page, from, to, width) => {
    drawQueueRef.current.push({ page, from: from ? { ...from } : null, to: { ...to }, width });
    scheduleDrawFlush();
  }, [scheduleDrawFlush]);

  const drawStrokeOnContext = (ctx, stroke) => {
    if (!ctx || !stroke) return;
    const points = stroke.points || [];
    if (!points.length) return;
    const offsetX = stroke.offsetX || 0;
    const offsetY = stroke.offsetY || 0;
    const width = stroke.strokeWidth || 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ff4141';
    ctx.lineWidth = width;
    if (points.length === 1) {
      const p0 = points[0];
      ctx.fillStyle = '#ff4141';
      ctx.beginPath();
      ctx.arc(p0.x + offsetX, p0.y + offsetY, width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x + offsetX, points[0].y + offsetY);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x + offsetX, points[i].y + offsetY);
    }
    ctx.stroke();
  };

  const renderPageCanvas = useCallback((pageIdx) => {
    const canvas = canvasRefs.current[pageIdx];
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const strokes = strokeCacheRef.current[pageIdx] || [];
    strokes.forEach((stroke) => drawStrokeOnContext(ctx, stroke));
    const active = activeStrokeRef.current;
    if (active && active.stroke.page === pageIdx) {
      drawStrokeOnContext(ctx, active.stroke);
    }
  }, []);

  const renderAllCanvases = useCallback(() => {
    pages.forEach((_, idx) => renderPageCanvas(idx));
  }, [pages, renderPageCanvas]);

  const resizeCanvas = useCallback((pageIdx, imgEl) => {
    const canvas = canvasRefs.current[pageIdx];
    if (!canvas || !imgEl) return;
    const rect = imgEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    renderPageCanvas(pageIdx);
  }, [renderPageCanvas]);

  const eraseStrokeAt = useCallback((pageIdx, x, y) => {
    const strokes = strokeCacheRef.current[pageIdx] || [];
    if (!strokes.length) return false;
    const rad = 12; const rad2 = rad * rad;
    const kept = [];
    const removedIds = new Set();
    strokes.forEach((stroke) => {
      const offsetX = stroke.offsetX || 0;
      const offsetY = stroke.offsetY || 0;
      const intersects = (stroke.points || []).some((p) => {
        const dx = (p.x + offsetX) - x;
        const dy = (p.y + offsetY) - y;
        return (dx * dx + dy * dy) <= rad2;
      });
      if (intersects) removedIds.add(stroke.id);
      else kept.push(stroke);
    });
    if (!removedIds.size) return false;
    strokeCacheRef.current[pageIdx] = kept;
    setBoxes((prev) => prev.filter((b) => !(b.type === 'draw' && removedIds.has(b.id))));
    renderPageCanvas(pageIdx);
    return true;
  }, [renderPageCanvas]);

  // Helpers for unified pointer/touch/mouse handling
  const getClientXY = (ev) => {
    try {
      if (typeof ev.clientX === 'number') return { x: ev.clientX, y: ev.clientY };
      if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
      if (ev.changedTouches && ev.changedTouches[0]) return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
    } catch {}
    return { x: 0, y: 0 };
  };
  const detectInputDevice = (ev) => {
    try {
      if (ev.pointerType) return (ev.pointerType === 'pen') ? 'pen' : (ev.pointerType === 'touch' ? 'touch' : 'mouse');
      if (ev.touches && ev.touches[0]) return (ev.touches[0].touchType === 'stylus') ? 'pen' : 'touch';
    } catch {}
    return 'mouse';
  };

  // Smoothly scroll to the editor area when it mounts
  useEffect(() => {
    try {
      editorRootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}
  }, [filename]);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('strokeWidth', String(strokeWidth));
      }
    } catch {}
  }, [strokeWidth]);

  useEffect(() => () => {
    if (drawFrameRef.current !== null) {
      cancelAnimationFrame(drawFrameRef.current);
      drawFrameRef.current = null;
    }
    drawQueueRef.current = [];
  }, []);

  useEffect(() => {
    const map = {};
    boxes.forEach((b) => {
      if (b.type === 'draw') {
        const pageIdx = typeof b.page === 'number' ? b.page : 0;
        if (!map[pageIdx]) map[pageIdx] = [];
        map[pageIdx].push({
          ...b,
          points: (b.points || []).map((p) => ({ x: p.x, y: p.y }))
        });
      }
    });
    strokeCacheRef.current = map;
    renderAllCanvases();
  }, [boxes, renderAllCanvases]);

  useEffect(() => {
    renderAllCanvases();
  }, [pages, renderAllCanvases]);

  useEffect(() => {
    const handleResize = () => {
      Object.keys(imageRefs.current).forEach((key) => {
        const idx = Number(key);
        const img = imageRefs.current[idx];
        if (img) resizeCanvas(idx, img);
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [resizeCanvas]);

  // Globally suppress stylus-driven scrolling (Pencil) so drawing starts immediately
  useEffect(() => {
    const blockStylusTouch = (ev) => {
      try {
        const touches = Array.from(ev.touches || []);
        if (touches.some(t => String(t.touchType || '').toLowerCase() === 'stylus')) {
          ev.preventDefault();
        }
      } catch {}
    };
    const blockStylusPointer = (ev) => {
      try {
        if ((ev.pointerType || '').toLowerCase() === 'pen') {
          ev.preventDefault();
        }
      } catch {}
    };
    window.addEventListener('touchstart', blockStylusTouch, { passive: false });
    window.addEventListener('touchmove', blockStylusTouch, { passive: false });
    window.addEventListener('pointerdown', blockStylusPointer, { passive: false });
    window.addEventListener('pointermove', blockStylusPointer, { passive: false });
    return () => {
      window.removeEventListener('touchstart', blockStylusTouch);
      window.removeEventListener('touchmove', blockStylusTouch);
      window.removeEventListener('pointerdown', blockStylusPointer);
      window.removeEventListener('pointermove', blockStylusPointer);
    };
  }, []);

  // Globally suppress scrolling when Apple Pencil / stylus touches the screen
  // Load problem index when selector opens
  useEffect(() => {
    if (!showSelector) return;
    (async () => {
      try {
        const res = await fetch(`${BACKEND_BASE}/problems/index`);
        const data = await res.json();
        setProblemIndex(data.universities || {});
        // Seed temps from current selection if empty
        setTmpUniversity(prev => prev || university || '');
        setTmpExamType(prev => prev || examType || '');
        setTmpQuestion(prev => (prev!=='' ? prev : (questionNumber ? String(questionNumber) : '')));
      } catch {
        setProblemIndex({});
      }
    })();
  }, [showSelector, university, examType, questionNumber]);

  

  // Fetch pages, review, annotations
  useEffect(() => {
    (async () => {
      try {
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/pages`);
        const data = await res.json();
        const sortedPages = (data.pages || []).sort((a, b) => {
          const pageNumA = parseInt((a.match(/page_(\d+)\.png$/) || [])[1] || '0');
          const pageNumB = parseInt((b.match(/page_(\d+)\.png$/) || [])[1] || '0');
          return pageNumA - pageNumB;
        });
        setPages(sortedPages);
      } catch {}
      try {
        const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/review`);
        if (res.ok) {
          const data = await res.json();
          setReview(data.review);
        }
      } catch {}
      try {
        const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/annotations`);
        if (res.ok) {
          const data = await res.json();
          setBoxes(data.boxes || []);
        }
      } catch {}
      try {
        const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/problem_assets`);
        if (res.ok) {
          const data = await res.json();
          setProblemAssets(data.assets || []);
        }
      } catch {}
      try {
        const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/problem_selection`);
        if (res.ok) {
          const data = await res.json();
          setProblemSel({ problem_pdf: data.problem_pdf || null, rubric_pdf: data.rubric_pdf || null });
          if (data.exam_type) setExamType(data.exam_type);
          if (data.university) setUniversity(data.university);
          if (data.question_number) setQuestionNumber(data.question_number);
        }
      } catch {}
    })();
  }, [filename]);

  // Auto-adjust text box height based on rendered content (both combine ON/OFF)
  useEffect(() => {
    try {
      // Defer until DOM paints
      const tid = setTimeout(() => {
        setBoxes(prev => {
          let changed = false;
          const next = prev.map(b => {
            if (b.type === 'image' || b.fixedHeight) return b;
            const el = renderRefs.current[b.id];
            if (!el) return b;
            const h0 = (typeof b.h === 'number' ? b.h : 0);
            const hEl = Math.max(0, el.scrollHeight || el.offsetHeight || 0);
            const desired = Math.max(32, hEl + 4);
            if (Math.abs(h0 - desired) > 1) { changed = true; return { ...b, h: desired }; }
            return b;
          });
          return changed ? next : prev;
        });
      }, 0);
      return () => clearTimeout(tid);
    } catch {}
  }, [boxes, combinePages, pages]);

  const sanitizeReviewText = (text) => {
    if (!text) return '';
    let t = String(text);
    // remove markdown blockquote markers
    t = t.replace(/^\s*>\s?/gm, '');
    // remove common emojis used in review labels
    t = t.replace(/[✅❌💡]/g, '');
    // trim redundant spaces
    t = t.replace(/\s+$/gm, '').trim();
    return t;
  };

  // Remove any explicit "対象:" lines from a comment text
  const stripTargetFromText = (text) => {
    if (!text) return '';
    let t = String(text);
    // If a line starting with 対象: appears, drop everything from that line to the end
    const m = t.match(/^\s*対象\s*[:：].*$/gmi);
    if (m && m.index !== undefined) {
      const idx = t.search(/^\s*対象\s*[:：]/mi);
      if (idx >= 0) t = t.slice(0, idx);
    } else {
      // Also handle English 'target:' just in case
      const idx2 = t.search(/^\s*target\s*[:：]/mi);
      if (idx2 >= 0) t = t.slice(0, idx2);
    }
    // Remove any residual inline markers like " 対象: ..." at line starts not caught
    t = t.replace(/^\s*対象\s*[:：].*$/gmi, '');
    // Tidy whitespace
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  };

  const addBox = (text, opts = { select: true, edit: false, fontSize: null, fixedHeight: false }) => {
    pushHistory();
    const id = `b_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const vp = viewportPos(40, 40);
    const initFont = (opts && opts.fontSize) ? opts.fontSize : 14;
    const pageInit = (opts && typeof opts.page === 'number') ? opts.page : current;
    const xInit = (opts && typeof opts.x === 'number') ? opts.x : vp.x;
    const yInit = (opts && typeof opts.y === 'number') ? opts.y : vp.y;
    const wInit = (opts && typeof opts.w === 'number') ? opts.w : 240;
    const hInit = (opts && typeof opts.h === 'number') ? opts.h : 100;
    const newBox = { id, page: pageInit, x: xInit, y: yInit, w: wInit, h: hInit, fontSize: initFont, fontWeight: 'bold', text: sanitizeReviewText(text || ''), isEditing: !!opts.edit, fixedHeight: !!(opts && opts.fixedHeight) };
    setBoxes(prev => [...prev, newBox]);
    if (opts.select) {
      setSelectedId(id);
      setSelectedIds([id]);
    }
    if (opts.edit) {
      setTimeout(() => {
        try { textRefs.current[id]?.focus(); } catch {}
      }, 0);
    }
    return id;
  };

  const addScoreMarker = (points = 1, opts = { select: true }) => {
    pushHistory();
    const id = `s_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const fs = 18;
    const vp = viewportPos(60, 60);
    const pageInit = (opts && typeof opts.page === 'number') ? opts.page : current;
    const xInit = (opts && typeof opts.x === 'number') ? opts.x : vp.x;
    const yInit = (opts && typeof opts.y === 'number') ? opts.y : vp.y;
    const newMarker = { id, page: pageInit, type: 'score', x: xInit, y: yInit, w: 60, h: 30, fontSize: fs, fontWeight: 'bold', points: parseInt(points || 1, 10) };
    setBoxes(prev => [...prev, newMarker]);
    if (opts.select) {
      setSelectedId(id);
      setSelectedIds([id]);
    }
    return id;
  };

  // Add an image as a draggable/resizable box
  const addImageBox = (dataUrl, place = 'mark', coords = null, opts = null) => {
    pushHistory();
    const id = `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const img = new Image();
    img.onload = () => {
      const maxW = 220, maxH = 220;
      let w = img.width, h = img.height;
      let scale = Math.min(maxW / w, maxH / h, 1);
      // Custom initial sizing
      if (place === 'mark') {
        scale *= 1.5; // bigger for circle (満点)
      } else if (place === 'sign') {
        scale *= (1/3); // much smaller for signature
      }
      w = Math.max(40, Math.round(w * scale));
      h = Math.max(40, Math.round(h * scale));
      let x = 40, y = 40;
      if (coords && typeof coords.x === 'number' && typeof coords.y === 'number') {
        x = coords.x; y = coords.y;
      }
      try {
        const pv = pageRef.current;
        const imgEl = pv ? pv.querySelector('img.page-image') : null;
        const vw = imgEl ? imgEl.clientWidth : 0;
        const vh = imgEl ? imgEl.clientHeight : 0;
        if (place === 'sign' && vw) {
          const extraLeft = 55; // move a bit more to the left
          x = Math.max(0, vw - w - 40 - extraLeft);
          // place roughly 1/3 down the page image height
          y = Math.max(0, Math.round(vh * 0.18));
        } else if (!coords && place === 'mark' && pv) {
          const st = pv.scrollTop || 0;
          const sl = pv.scrollLeft || 0;
          x = Math.max(0, sl + 24);
          y = Math.max(0, st + 48);
        }
      } catch {}
      const pageOverride = opts && typeof opts.page === 'number' ? opts.page : current;
      const newBox = { id, type:'image', page: pageOverride, x, y, w, h, src: dataUrl };
      setBoxes(prev => [...prev, newBox]);
      setSelectedId(id); setSelectedIds([id]);
    };
    img.src = dataUrl;
  };

  const addDefaultMark = () => {
    addImageBox('/assets/stamps/circle.png', 'mark');
  };
  const addDefaultSign = () => {
    const sig = activeSignature || DEFAULT_SIGNATURE;
    const src = resolveSignatureSrc(sig);
    setPlaceMode({ type: 'image', payload: { src, kind: 'sign', signatureName: sig.name } });
  };

  // Compute initial placement near current viewport if scrolled
  const viewportPos = (defX, defY) => {
    try {
      const pv = pageRef.current;
      if (!pv) return { x: defX, y: defY };
      const st = pv.scrollTop || 0;
      const sl = pv.scrollLeft || 0;
      return { x: Math.max(0, sl + defX), y: Math.max(0, st + defY) };
    } catch { return { x: defX, y: defY }; }
  };

  // Add big glyphs (× / 」) as text boxes with large font
  const addGlyphBox = (glyph, size = 40) => {
    pushHistory();
    const id = `g_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const vp = viewportPos(60, 60);
    const newBox = { id, page: current, x: vp.x, y: vp.y, w: 80, h: 80, fontSize: size, fontWeight: 'bold', text: glyph };
    setBoxes(prev => [...prev, newBox]);
    setSelectedId(id);
    setSelectedIds([id]);
  };
  const addCross = () => addGlyphBox('×', 40);
  const addBracket = () => addGlyphBox('」', 40); // use closing bracket

  // Add straight line (horizontal by default)
  const addLineBox = () => {
    pushHistory();
    const id = `ln_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const vp = viewportPos(80, 120);
    const newBox = { id, type: 'line', page: current, x: vp.x, y: vp.y, w: 240, h: 3 };
    setBoxes(prev => [...prev, newBox]);
    setSelectedId(id);
    setSelectedIds([id]);
  };
  // Line + X set (place X at the right end of the line)
  const addLineXSet = () => {
    pushHistory();
    const vp = viewportPos(80, 160);
    const gid = `grp_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const lineId = `ln_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const x0 = vp.x, y0 = vp.y, w0 = 200, h0 = 3;
    const line = { id: lineId, type: 'line', page: current, x: x0, y: y0, w: w0, h: h0, group: gid };
    const xId = `g_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const fz = 25;
    const glyph = { id: xId, type: 'text', page: current, x: x0 + w0 - 18, y: y0 - Math.round(fz/2) - 17, w: 40, h: 40, fontSize: fz, fontWeight: 'bold', text: '×', group: gid };
    setBoxes(prev => [...prev, line, glyph]);
    setSelectedId(xId);
    setSelectedIds([lineId, xId]);
  };

  // Arrow object: adjustable start/end
  const addArrow = () => {
    pushHistory();
    const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const vp = viewportPos(100, 100);
    const x = vp.x, y = vp.y, len = 140;
    const newBox = { id, type: 'arrow', page: current, x, y, ex: x + len, ey: y, strokeWidth: 3 };
    setBoxes(prev => [...prev, newBox]);
    setSelectedId(id);
    setSelectedIds([id]);
  };

  // Add a target marker from review comment target text
  const addTargetMarker = (targetText = '') => {
    if (!targetText) return;
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const newBox = { id, type: 'target', page: current, x: 24, y: 24, w: 140, h: 28, text: String(targetText), fontSize: 14, fontWeight: 'bold' };
    setBoxes(prev => [...prev, newBox]);
    setSelectedId(id);
    setSelectedIds([id]);
  };

  // Shared handlers for page canvas interactions (mouse/touch/pen)
  const handlePagePointerDown = (e) => {
    const pointerId = (e && typeof e.pointerId === 'number') ? e.pointerId : null;
    const deviceType = detectInputDevice(e);
    setInputDevice(deviceType);
    const drawingIntent = drawMode || eraserMode;
    const isDrawingPointer = (deviceType === 'pen' || deviceType === 'mouse');
    if (deviceType === 'pen') {
      lockPenScroll();
    }
    if (drawingIntent) {
      if (!isDrawingPointer) {
        activePointerRef.current = null;
        setDrawingState(false);
        return;
      }
      pushHistory();
      try { e.preventDefault(); e.stopPropagation(); } catch {}
      const container = pageRef.current;
      const imgs = container ? Array.from(container.querySelectorAll('img.page-image')) : [];
      let imgEl = null; let r = null; let tpi = current;
      for (const el of imgs) {
        const rr = el.getBoundingClientRect();
        const pt = getClientXY(e);
        if (pt.x >= rr.left && pt.x <= rr.right && pt.y >= rr.top && pt.y <= rr.bottom) { imgEl = el; r = rr; const idx = el.getAttribute('data-page-index'); if (idx!=null) tpi = parseInt(idx,10); break; }
      }
      if (!imgEl || !r) return;
      setDrawingState(true);
      if (pointerId !== null) {
        activePointerRef.current = pointerId;
        try { e.currentTarget?.setPointerCapture(pointerId); } catch {}
      } else {
        activePointerRef.current = null;
      }
      const pt0 = getClientXY(e);
      const x = pt0.x - r.left; const y = pt0.y - r.top;
    if (drawMode) {
        const id = `d_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
        let pressure = 0;
        try { pressure = (typeof e.pressure === 'number' ? e.pressure : (e.touches && e.touches[0] && typeof e.touches[0].force === 'number' ? e.touches[0].force : 0)) || 0; } catch {}
        const base = Math.max(1, strokeWidth);
        const pressureFactor = (deviceType === 'pen') ? (0.4 + pressure * 1.6) : 1;
        const sw = Math.max(1, base * pressureFactor);
        const stroke = { id, type: 'draw', page: tpi, points: [{ x, y }], strokeWidth: sw, offsetX: 0, offsetY: 0 };
        activeStrokeRef.current = { stroke };
        drawingRef.current = { active: true, mode: 'draw', page: tpi };
        queueDrawSegment(tpi, null, { x, y }, sw);
      } else {
        eraseStrokeAt(tpi, x, y);
        drawingRef.current = { active: true, mode: 'erase', page: tpi };
      }
      return;
    }
    activePointerRef.current = null;
    if (placeMode) {
      return;
    }
    clearSelection(); setBoxes(prev => prev.map(b => ({...b, isEditing: false})));
    try { const ae = document.activeElement; if (ae && ae.blur) ae.blur(); } catch {}
  };

  const handlePagePointerMove = (e) => {
    const pointerId = (e && typeof e.pointerId === 'number') ? e.pointerId : null;
    if (pointerId !== null && activePointerRef.current !== null && pointerId !== activePointerRef.current) return;
    if (!drawingRef.current.active) return;
    try { e.preventDefault(); } catch {}
    const mode = drawingRef.current.mode;
    if (mode === 'draw') {
      const active = activeStrokeRef.current?.stroke;
      if (!active) return;
      const canvas = canvasRefs.current[active.page];
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const pt = getClientXY(e);
      const x = Math.max(0, Math.min(pt.x - rect.left, rect.width));
      const y = Math.max(0, Math.min(pt.y - rect.top, rect.height));
      const points = active.points;
      const last = points[points.length - 1];
      const threshold = 2.0;
      if (last) {
        const dx = x - last.x;
        const dy = y - last.y;
        if ((dx * dx + dy * dy) < threshold * threshold) return;
      }
      points.push({ x, y });
      queueDrawSegment(active.page, last || null, { x, y }, active.strokeWidth || strokeWidth);
    } else if (mode === 'erase') {
      const pageIdx = drawingRef.current.page ?? current;
      const canvas = canvasRefs.current[pageIdx];
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const pt = getClientXY(e);
      const x = Math.max(0, Math.min(pt.x - rect.left, rect.width));
      const y = Math.max(0, Math.min(pt.y - rect.top, rect.height));
      eraseStrokeAt(pageIdx, x, y);
    }
  };

  const handlePagePointerUp = (e) => {
    const pointerId = (e && typeof e.pointerId === 'number') ? e.pointerId : null;
    if (pointerId !== null && activePointerRef.current !== null && pointerId !== activePointerRef.current) return;
    const mode = drawingRef.current?.mode || null;
    if (mode === 'draw') {
      const activeStroke = activeStrokeRef.current?.stroke;
      if (activeStroke && (activeStroke.points || []).length) {
        strokeCacheRef.current[activeStroke.page] = [
          ...(strokeCacheRef.current[activeStroke.page] || []),
          activeStroke
        ];
        setBoxes(prev => [...prev, activeStroke]);
        renderPageCanvas(activeStroke.page);
      }
      activeStrokeRef.current = null;
      setDrawingState(false);
    }
    if (mode === 'erase') {
      setDrawingState(false);
    }
    if (pointerId !== null) {
      try { e.currentTarget?.releasePointerCapture(pointerId); } catch {}
    }
    if ((e.pointerType || '').toLowerCase() === 'pen') {
      unlockPenScroll();
    }
    activePointerRef.current = null;
    drawingRef.current = { active: false };
  };

  
  const handlePageClick = (e) => {
    if (!placeMode || drawMode || eraserMode) return;
    try { e.preventDefault(); e.stopPropagation(); } catch {}
    pushHistory();
    const container = pageRef.current;
    const imgs = container ? Array.from(container.querySelectorAll('img.page-image')) : [];
    let imgEl = null; let r = null; let tpi = current;
    for (const el of imgs) {
      const rr = el.getBoundingClientRect();
      if (e.clientX >= rr.left && e.clientX <= rr.right && e.clientY >= rr.top && e.clientY <= rr.bottom) {
        imgEl = el; r = rr; const idx = el.getAttribute('data-page-index'); if (idx!=null) tpi = parseInt(idx,10); break;
      }
    }
    if (!imgEl || !r) { setPlaceMode(null); return; }
    const x = Math.max(0, Math.min(e.clientX - r.left, r.width));
    const y = Math.max(0, Math.min(e.clientY - r.top, r.height));
    const pm = placeMode; setPlaceMode(null);
    if (pm.type === 'text') {
      const id = addBox('', { select: true, edit: !!(pm.payload && pm.payload.edit), fontSize: (pm.payload && pm.payload.fontSize) || 14 });
      setBoxes(prev => prev.map(b => b.id===id ? { ...b, page: tpi, x, y } : b));
    } else if (pm.type === 'score') {
      const pts = (pm.payload && pm.payload.points) || 1;
      const id = addScoreMarker(pts, { select: false });
      setBoxes(prev => prev.map(b => b.id===id ? { ...b, page: tpi, x, y } : b));
      setSelectedId(id); setSelectedIds([id]);
    } else if (pm.type === 'line') {
      const id = `ln_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const newBox = { id, type:'line', page: tpi, x: Math.max(0, x-100), y, w: 200, h: 3 };
      setBoxes(prev => [...prev, newBox]); setSelectedId(id); setSelectedIds([id]);
    } else if (pm.type === 'arrow') {
      const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const newBox = { id, type:'arrow', page: tpi, x, y, ex: Math.min(r.width, x+140), ey: y, strokeWidth: 3 };
      setBoxes(prev => [...prev, newBox]); setSelectedId(id); setSelectedIds([id]);
    } else if (pm.type === 'glyph') {
      const g = (pm.payload && pm.payload.glyph) || '×';
      const sz = (pm.payload && pm.payload.size) || 40;
      const id = `g_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const adjX = Math.max(0, x - Math.round(sz/2));
      const adjY = Math.max(0, y - Math.round(sz/2));
      const newBox = { id, page: tpi, x: adjX, y: adjY, w: sz*2, h: sz*2, fontSize: sz, fontWeight: 'bold', text: g };
      setBoxes(prev => [...prev, newBox]);
      setSelectedId(id); setSelectedIds([id]);
    } else if (pm.type === 'linex') {
      const gid = `grp_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const lineId = `ln_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const w0 = 200; const h0 = 3; const x0 = Math.max(0, x - Math.round(w0/2)); const y0 = y;
      const line = { id: lineId, type: 'line', page: tpi, x: x0, y: y0, w: w0, h: h0, group: gid };
      const xId = `g_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const fz = 40; const baselineRatio = 0.93;
      const glyph = { id: xId, type: 'text', page: tpi, x: x0 + w0 - 18, y: y0 - Math.round(fz * baselineRatio), w: 40, h: 40, fontSize: fz, fontWeight: 'bold', text: '×', group: gid };
      setBoxes(prev => [...prev, line, glyph]); setSelectedId(xId); setSelectedIds([lineId, xId]);
    } else if (pm.type === 'combo') {
      const text = (pm.payload && pm.payload.text) || '';
      const points = (pm.payload && pm.payload.points) || null;
      const ids = [];
      const boxW = 240;
      const boxH = 100;
      if (text && text.trim()) {
        const tid = addBox(text, { select: false, edit: false }); ids.push(tid);
        setBoxes(prev => prev.map(b => b.id===tid ? { ...b, page: tpi, x, y } : b));
      }
      if (points != null) {
        const fs = 18;
        const markerH = Math.round(fs * 1.6);
        const sx = Math.max(0, x - 64);
        const sy = Math.max(0, y + boxH - markerH);
        const sid = addScoreMarker(points, { select: false, page: tpi, x: sx, y: sy });
        ids.push(sid);
      }
      if (ids.length) { setSelectedId(ids[ids.length-1]); setSelectedIds(ids); }
    } else if (pm.type === 'image') {
      const src = pm.payload && pm.payload.src;
      const kind = (pm.payload && pm.payload.kind === 'sign') ? 'sign' : 'mark';
      if (src) addImageBox(src, kind, { x, y }, { page: tpi });
    } else if (pm.type === 'qscore') {
      const a = Number((pm.payload && pm.payload.awarded) || 0);
      const m = Number((pm.payload && pm.payload.max) || 0);
      const label = `${a}/${m}`;
      try {
        const tid = addBox(label, { select: true, edit: false, page: tpi, x, y, w: 120, h: 28, fontSize: 16, fixedHeight: true });
        setSelectedId(tid); setSelectedIds([tid]);
      } catch {}
    } else if (pm.type === 'bulk') {
      const payload = pm.payload || {};
      const awarded = Number(payload.awarded || 0);
      const max = Number(payload.max || 0);
      const list = Array.isArray(payload.comments) ? payload.comments : [];
      const placed = [];
      let curY = y;
      const margin = 6;
      const boxW = 360;
      const boxH = 64;
      const fs = 18;
      const markerH = Math.round(fs * 1.6);
      try {
        const label = `${awarded}/${max}`;
        const tid = addBox(label, { select: false, edit: false, page: tpi, x, y: curY, w: boxW, h: 28, fontSize: 16, fixedHeight: true });
        placed.push(tid);
        curY += 28 + margin;
      } catch {}
      for (const c of list) {
        try {
          const txt = stripTargetFromText(sanitizeReviewText(c.text || ''));
          if (txt && txt.trim()) {
            const tid = addBox(txt, { select: false, edit: false, page: tpi, x, y: curY, w: boxW, h: boxH, fixedHeight: true });
            placed.push(tid);
          }
          const pts = (c && c.type === 'score') ? (c.points ?? 1) : null;
          if (pts != null) {
            const sx = x + 4;
            const sy = curY + boxH + 2;
            const sid = addScoreMarker(pts, { select: false, page: tpi, x: sx, y: sy });
            placed.push(sid);
            curY += boxH + markerH + margin;
          } else {
            curY += boxH + margin;
          }
        } catch {}
      }
      if (placed.length) { setSelectedId(placed[placed.length-1]); setSelectedIds(placed); }
    }
  };


  const onPickMark = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPlaceMode({ type: 'image', payload: { src: reader.result } });
    reader.readAsDataURL(f);
    e.target.value = '';
  };
  // Removed: dedicated sign picker. Use generic picker instead.

  const selectOnly = (id) => { setSelectedId(id); setSelectedIds([id]); };
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const has = prev.includes(id);
      const next = has ? prev.filter(x => x !== id) : [...prev, id];
      setSelectedId(id);
      return next;
    });
  };
  const clearSelection = () => { setSelectedId(null); setSelectedIds([]); };

  const onPointerDownBox = (e, id) => {
    try { e.preventDefault(); } catch {}
    try { e.stopPropagation(); } catch {}
    setInputDevice(detectInputDevice(e));
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    const target = boxes.find(b => b.id === id);
    let baseSel = selectedIds.includes(id) ? selectedIds : (multi ? [...selectedIds, id] : [id]);
    if (target && target.type === 'draw') {
      setSelectedId(id);
      setSelectedIds(baseSel);
      return;
    }
    pushHistory();
    // linex グループ: 単独選択時は同グループをまとめて選択
    try {
      if (!multi) {
        const gid = target && target.group;
        if (gid) {
          const grouped = boxes.filter(b => b.group === gid).map(b => b.id);
          if (grouped.length >= 2) baseSel = grouped;
        }
      }
    } catch {}
    const currentSel = baseSel;
    setSelectedId(id);
    setSelectedIds(currentSel);
    if (resizingRef.current) return; // リサイズ中は移動しない
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sp = getClientXY(e);
    const startX = sp.x;
    const startY = sp.y;
    const starts = {};
    boxes.forEach(b => { if (currentSel.includes(b.id)) {
      if (b.type === 'draw') {
        starts[b.id] = { x: (b.offsetX || 0), y: (b.offsetY || 0) };
      } else if (b.type === 'arrow') {
        starts[b.id] = { x: b.x, y: b.y, ex: b.ex, ey: b.ey };
      } else {
        starts[b.id] = { x: b.x, y: b.y };
      }
    }});
    const pointerId = (e && typeof e.pointerId === 'number') ? e.pointerId : null;
    setBoxes(prev => {
      const move = (ev) => {
        if (pointerId !== null && typeof ev.pointerId === 'number' && ev.pointerId !== pointerId) return;
        try { ev.preventDefault(); } catch {}
        const p = getClientXY(ev);
        const dx = p.x - startX;
        const dy = p.y - startY;
        setBoxes(p2 => {
          const arr = [...p2];
          for (const bid of currentSel) {
            const i = arr.findIndex(x => x.id === bid);
            if (i >= 0) {
              const st = starts[bid];
              const nb = { ...arr[i] };
              if (nb.type === 'draw') {
                continue;
              } else if (nb.type === 'arrow') {
                nb.x = Math.max(0, (st.x ?? 0) + dx);
                nb.y = Math.max(0, (st.y ?? 0) + dy);
                nb.ex = Math.max(0, (st.ex ?? 0) + dx);
                nb.ey = Math.max(0, (st.ey ?? 0) + dy);
              } else {
                nb.x = Math.max(0, st.x + dx);
                nb.y = Math.max(0, st.y + dy);
              }
              arr[i] = nb;
            }
          }
          return arr;
        });
      };
      const up = (ev) => {
        if (pointerId !== null && typeof ev.pointerId === 'number' && ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);

        if (combinePages) {
            const container = pageRef.current;
            if (!container) return;

            const imgs = Array.from(container.querySelectorAll('img.page-image'));
            let targetPage = -1;
            let targetImgRect = null;

            for (const img of imgs) {
                const imgRect = img.getBoundingClientRect();
                const upPt = getClientXY(ev);
                if (upPt.y >= imgRect.top && upPt.y <= imgRect.bottom) {
                    targetPage = parseInt(img.getAttribute('data-page-index'), 10);
                    targetImgRect = imgRect;
                    break;
                }
            }

            if (targetPage !== -1) {
                setBoxes(prev => {
                    const next = [...prev];
                    const upPt2 = getClientXY(ev);
                    const dx = upPt2.x - startX;
                    const dy = upPt2.y - startY;

                    for (const bid of currentSel) {
                        const boxIndex = next.findIndex(b => b.id === bid);
                        if (boxIndex < 0) continue;
                        
                        const originalBox = prev.find(b => b.id === bid);
                        if (originalBox && originalBox.type === 'draw') {
                            continue;
                        }
                        const startBox = starts[bid];

                        if (originalBox.page === targetPage) {
                            const newX = Math.max(0, startBox.x + dx);
                            const newY = Math.max(0, startBox.y + dy);
                            next[boxIndex] = { ...next[boxIndex], x: newX, y: newY };
                        } else {
                            const originalImg = imgs.find(img => parseInt(img.getAttribute('data-page-index')) === originalBox.page);
                            if (!originalImg) continue;
                            const originalImgRect = originalImg.getBoundingClientRect();
                            
                            const newX = Math.max(0, startBox.x + dx);
                            const newY = Math.max(0, originalImgRect.top + startBox.y + dy - targetImgRect.top);

                            next[boxIndex] = { ...next[boxIndex], page: targetPage, x: newX, y: newY };
                        }
                    }
                    return next;
                });
            }
        }
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      return prev;
    });
  };

  const onResizeDown = (e, id, corner='br') => {
    e.preventDefault();
    e.stopPropagation();
    setInputDevice(detectInputDevice(e));
    pushHistory();
    resizingRef.current = true;
    const sp = getClientXY(e);
    const startX = sp.x;
    const startY = sp.y;
    const pointerId = (e && typeof e.pointerId === 'number') ? e.pointerId : null;
    setBoxes(prev => {
      const idx0 = prev.findIndex(b => b.id === id);
      if (idx0 < 0) return prev;
      const startBox = prev[idx0];
      const move = (ev) => {
        if (pointerId !== null && typeof ev.pointerId === 'number' && ev.pointerId !== pointerId) return;
        try { ev.preventDefault(); } catch {}
        const p = getClientXY(ev);
        const dx = p.x - startX;
        const dy = p.y - startY;
        setBoxes(p2 => {
          const arr = [...p2];
          const j = arr.findIndex(x => x.id === id);
          if (j < 0) return arr;
          const b = { ...arr[j] };
          // Arrow: drag endpoints instead of box edges
          if (startBox.type === 'arrow') {
            // Use the image element of the same page for proper bounds in combined view
            const pageIdx = (typeof startBox.page === 'number') ? startBox.page : current;
            const imgEl = pageRef.current?.querySelector(`img.page-image[data-page-index="${pageIdx}"]`) || pageRef.current?.querySelector('img.page-image');
            if (!imgEl) return arr;
            const r = imgEl.getBoundingClientRect();
            const pt = getClientXY(ev);
            const cx = Math.max(0, Math.min(pt.x - r.left, r.width));
            const cy = Math.max(0, Math.min(pt.y - r.top, r.height));
            if (corner === 'tl' || corner === 'l') { b.x = cx; b.y = cy; }
            else if (corner === 'br' || corner === 'r') { b.ex = cx; b.ey = cy; }
            arr[j] = b; return arr;
          }
          let nx = startBox.x, ny = startBox.y, nw = startBox.w, nh = startBox.h;
          // Special handling for straight line: keep thickness constant; resize only length horizontally
          if (startBox.type === 'line') {
            const thickness = Math.max(1, startBox.h || 3);
            if (['l','tl','bl'].includes(corner)) {
              nw = startBox.w - dx;
              nx = startBox.x + dx;
            }
            if (['r','tr','br'].includes(corner)) {
              nw = startBox.w + dx;
            }
            // lock vertical metrics
            ny = startBox.y;
            nh = thickness;
            b.x = Math.max(0, nx);
            b.y = Math.max(0, ny);
            b.w = Math.max(10, nw);
            b.h = nh;
            arr[j] = b;
            return arr;
          }
          if (corner === 'br') { nw = startBox.w + dx; nh = startBox.h + dy; }
          if (corner === 'tr') { nw = startBox.w + dx; nh = startBox.h - dy; ny = startBox.y + dy; }
          if (corner === 'bl') { nw = startBox.w - dx; nh = startBox.h + dy; nx = startBox.x + dx; }
          if (corner === 'tl') { nw = startBox.w - dx; nh = startBox.h - dy; nx = startBox.x + dx; ny = startBox.y + dy; }
          if (corner === 'l') { nw = startBox.w - dx; nx = startBox.x + dx; }
          if (corner === 'r') { nw = startBox.w + dx; }
          // For text boxes: vertical edge resize should change width only and keep font size
          const isTextBox = (!startBox.type || startBox.type === 'text');
          if (isTextBox && (corner === 'l' || corner === 'r')) {
            b.x = Math.max(0, nx);
            b.w = Math.max(80, nw);
            b.y = startBox.y;
            b.h = startBox.h;
            if (typeof startBox.fontSize === 'number') b.fontSize = startBox.fontSize;
            arr[j] = b;
            return arr;
          }
          b.x = Math.max(0, nx);
          b.y = Math.max(0, ny);
          nw = Math.max(80, nw);
          nh = Math.max(40, nh);
          if (['tl','tr','bl','br'].includes(corner)) {
            const startW = Math.max(1, startBox.w);
            const startH = Math.max(1, startBox.h);
            const sx = nw / startW;
            const sy = nh / startH;
            const s = Math.max(sx, sy);
            const newW = Math.max(80, startW * s);
            const newH = Math.max(40, startH * s);
            // adjust position for top/left anchors
            if (corner === 'tl' || corner === 'bl') b.x = Math.max(0, startBox.x + (startW - newW));
            if (corner === 'tl' || corner === 'tr') b.y = Math.max(0, startBox.y + (startH - newH));
            b.w = newW;
            b.h = newH;
            if (startBox.type !== 'image') {
              b.fontSize = Math.max(8, Math.round((startBox.fontSize || 16) * s));
            }
          } else {
            b.w = nw;
            b.h = nh;
          }
          arr[j] = b;
          return arr;
        });
      };
      const up = (ev) => {
        if (pointerId !== null && typeof ev.pointerId === 'number' && ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        resizingRef.current = false;
        // リサイズ後にテキスト高さを再合わせ（折返し変化に対応）
        // ただし、左右エッジ（l/r）の場合は幅のみ変更の意図なので高さ自動調整はスキップ
        if (!(corner === 'l' || corner === 'r')) {
          try {
            requestAnimationFrame(() => {
              const ta = textRefs.current[id];
              if (ta) {
                const sh = ta.scrollHeight;
                setBoxes(p2 => p2.map(b => b.id===id ? { ...b, h: Math.max(40, sh + 4) } : b));
              }
            });
          } catch {}
        }
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      return prev;
    });
  };

  const updateText = (id, val) => {
    setBoxes(prev => prev.map(b => b.id === id ? { ...b, text: val } : b));
  };

  const removeBox = (id) => setBoxes(prev => prev.filter(b => b.id !== id));
  const removeSelected = () => { pushHistory(); setBoxes(prev => prev.filter(b => !selectedIds.includes(b.id))); };

  // Font controls
  const changeFontSize = (delta) => {
    if (!selectedIds.length) return;
    setBoxes(prev => prev.map(b => selectedIds.includes(b.id) ? { ...b, fontSize: Math.max(8, (b.fontSize || 16) + delta) } : b));
  };
  const setFontSize = (size) => {
    if (!selectedIds.length) return;
    const n = parseInt(size, 10);
    if (!isNaN(n)) setBoxes(prev => prev.map(b => selectedIds.includes(b.id) ? { ...b, fontSize: Math.max(8, n) } : b));
  };
  const toggleBold = () => {
    if (!selectedIds.length) return;
    setBoxes(prev => prev.map(b => selectedIds.includes(b.id) ? { ...b, fontWeight: (b.fontWeight === 'bold' ? 'normal' : 'bold') } : b));
  };

  const historyRef = useRef([]);
  const redoRef = useRef([]);
  const pushHistory = () => {
    try { historyRef.current.push(JSON.parse(JSON.stringify(boxes))); redoRef.current = []; } catch {}
  };

  // Keyboard shortcuts: placing cancel (ESC), nudge/delete, Cmd/Ctrl+B, Copy/Paste, Undo/Redo
  useEffect(() => {
    const onKey = (e) => {
      // Cancel placing
      if (e.key === 'Escape' && placeMode) { setPlaceMode(null); return; }
      // If a textarea (comment editor) is focused, do not intercept any shortcuts;
      // let the browser handle normal copy/paste/undo/redo/etc.
      const ae = document.activeElement;
      if (ae && ae.tagName === 'TEXTAREA') return;
      if (!selectedIds.length) return;
      // Bold toggle (Cmd/Ctrl+B)
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'b') {
        e.preventDefault();
        toggleBold();
        return;
      }
      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          // Redo
          const next = redoRef.current.pop();
          if (next) { historyRef.current.push(JSON.parse(JSON.stringify(boxes))); setBoxes(next); }
        } else {
          const prev = historyRef.current.pop();
          if (prev) { redoRef.current.push(JSON.parse(JSON.stringify(boxes))); setBoxes(prev); }
        }
        return;
      }
      // Copy
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'c') {
        try {
          const sel = boxes.filter(b => selectedIds.includes(b.id));
          window.__BOX_CLIPBOARD__ = JSON.parse(JSON.stringify(sel));
        } catch {}
        return;
      }
      // Paste
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'v') {
        e.preventDefault();
        try {
          const clip = window.__BOX_CLIPBOARD__ || [];
          if (!clip.length) return;
          const cloned = clip.map(b => {
            const idPrefix = (b.type === 'score') ? 's_' : (b.type === 'image' ? 'img_' : (b.type === 'line' ? 'ln_' : (b.type === 'draw' ? 'd_' : (b.type === 'arrow' ? 'ar_' : 'b_'))));
            const id = `${idPrefix}${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
            const off = 20;
            const nb = JSON.parse(JSON.stringify(b));
            nb.id = id;
            if (nb.type === 'draw') { nb.offsetX = (nb.offsetX||0) + off; nb.offsetY = (nb.offsetY||0) + off; }
            else if (nb.type === 'arrow') { nb.x += off; nb.y += off; nb.ex += off; nb.ey += off; }
            else { nb.x = (nb.x||0) + off; nb.y = (nb.y||0) + off; }
            return nb;
          });
          setBoxes(prev => [...prev, ...cloned]);
          const ids = cloned.map(c => c.id);
          setSelectedId(ids[ids.length-1]);
          setSelectedIds(ids);
        } catch {}
        return;
      }
      // Other movement/delete shortcuts
      const step = e.shiftKey ? 10 : 1;
      if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Delete","Backspace"].includes(e.key)) e.preventDefault();
      if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); return; }
      setBoxes(prev => prev.map(b => {
        if (!selectedIds.includes(b.id)) return b;
        if (e.key === 'ArrowUp') return { ...b, y: Math.max(0, b.y - step) };
        if (e.key === 'ArrowDown') return { ...b, y: b.y + step };
        if (e.key === 'ArrowLeft') return { ...b, x: Math.max(0, b.x - step) };
        if (e.key === 'ArrowRight') return { ...b, x: b.x + step };
        return b;
      }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds]);

  const save = async () => {
    try {
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/annotations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boxes })
      });
      if (!res.ok) throw new Error('save failed');
      notify('保存しました','success');
    } catch {
      notify('保存に失敗しました','error');
    }
  };

  const complete = async () => {
    try {
      // flush unflushed editing time before completing
      try { await flushEditingTimeNow(); } catch {}
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error('complete failed');
      notify('添削完了にしました','success');
      if (onComplete) {
        onComplete(filename);
      }
      // refresh dashboard list to reflect time immediately
      try { if (typeof onAfterClose === 'function') await onAfterClose(); } catch {}
      onClose();
    } catch {
      notify('更新に失敗しました','error');
    }
  };

  // Client-side WYSIWYG PDF export
  const exportClientPDF = async () => {
    try {
      const html2canvasLib = window.html2canvas;
      const jsPDFNS = window.jspdf || window.jsPDF || {};
      const _jsPDF = jsPDFNS.jsPDF || jsPDFNS;
      if (!html2canvasLib || !_jsPDF) {
        notify('PDFライブラリが読み込めていません（html2canvas/jspdf）','error');
        return;
      }
      const canvases = [];
      for (let i = 0; i < pages.length; i++) {
        // 単ページ: 全体をキャプチャ / 結合表示: 対象ページのラッパーをキャプチャ
        setCurrent(i);
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, 250));
        const container = pageRef.current;
        if (!container) continue;
        const target = combinePages
          ? container.querySelector(`.page-wrap[data-page-index="${i}"]`)
          : container;
        if (!target) continue;
        // Hide native textareas and selection/handles
        const hiddenNodes = [];
        container.classList.add('capturing');
        try {
          const taNodes = target.querySelectorAll('textarea');
          taNodes.forEach(el => {
            hiddenNodes.push({ el, vis: el.style.visibility });
            el.style.visibility = 'hidden';
          });
          // temporarily disable placing cursor style
          hiddenNodes.push({ el: container, cls: 'placing' });
          container.classList.remove('placing');
        } catch {}
        // eslint-disable-next-line no-await-in-loop
        const canvas = await html2canvasLib(target, { useCORS: true, backgroundColor: '#ffffff', scale: 2 });
        // Restore
        container.classList.remove('capturing');
        hiddenNodes.forEach((rec) => {
          try {
            if (rec.vis !== undefined) rec.el.style.visibility = rec.vis || '';
            if (rec.cls) rec.el.classList.add(rec.cls);
          } catch {}
        });
        canvases.push(canvas);
      }
      const pdf = new _jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      canvases.forEach((cv, idx) => {
        const imgData = cv.toDataURL('image/jpeg', 0.95);
        const iw = cv.width;
        const ih = cv.height;
        // Anchor to top-left (見たままに近づけるため中央寄せをやめる)
        const scale = Math.min(pageWidth / iw, pageHeight / ih);
        const w = iw * scale;
        const h = ih * scale;
        const x = 0;
        const y = 0;
        if (idx > 0) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', x, y, w, h);
      });
      pdf.save(`${filename.replace(/\.pdf$/i,'')}_annotated.pdf`);
    } catch (e) {
      notify('PDF出力に失敗しました（クライアント）','error');
      console.error(e);
    }
  };

  const comments = (review?.questions || []).flatMap(q => (q.comments || []).map(c => ({ ...c, qid: q.id })));

  // Removed legacy toggles (AI対応付け/OCR/デバッグ)
  const [autoPlacing, setAutoPlacing] = useState(false);
  const [editingSeconds, setEditingSeconds] = useState(0);
  const [unflushedSeconds, setUnflushedSeconds] = useState(0);
  const [timeReady, setTimeReady] = useState(false);
  const [sidebarTab, setSidebarTab] = useState('comments'); // 'comments' | 'favorites'
  const [favorites, setFavorites] = useState({ global: [], problem: [] });
  const [favMenu, setFavMenu] = useState({ show:false, x:0, y:0, text:'' });
  const favMenuRef = useRef(null);
  const [chatHistory, setChatHistory] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  // Floating drawers removed; sidebar is docked only
  const [rightDockWidth, setRightDockWidth] = useState(420); // ドッキング時のコメント欄幅(px)

  // Track unflushed seconds via ref for reliable final flush
  const unflushedRef = useRef(0);
  useEffect(() => { unflushedRef.current = unflushedSeconds; }, [unflushedSeconds]);
  const flushEditingTimeNow = useCallback(async () => {
    const amt = parseInt(unflushedRef.current || 0, 10);
    if (amt > 0) {
      try {
        await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/time/add`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: amt })
        });
        setUnflushedSeconds(0);
      } catch {}
    }
  }, [filename]);
  // Debug result removed from UI; keep minimal state footprint
  const [spatialDebugUrls, setSpatialDebugUrls] = useState([]);
  const [spatialLoading, setSpatialLoading] = useState(false);
  const [spatialRects, setSpatialRects] = useState([]);
  const [showSpatialRects, setShowSpatialRects] = useState(false);

  const runAutoLayout = async () => {
    try {
      setAutoPlacing(true);
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/auto_layout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // AI対応付けは自動配置に内包
        body: JSON.stringify({ use_ai: true })
      });
      if (!res.ok) throw new Error('auto_layout failed');
      const data = await res.json();
      const placements = data.placements || [];
      // debug payload is ignored (UI非表示)
      if (!placements.length) { notify('自動配置候補が見つかりませんでした','info'); return; }
      pushHistory();
      const container = pageRef.current;
      const imgNodes = container ? Array.from(container.querySelectorAll('img.page-image')) : [];
      // Map and place: comment to the right of detected box; per-question score label above first comment (x = page left + 20)
      const firstCommentTopByQ = {}; // { qid: { idx, y, offX } }
      const placedIds = [];
      const margin = 8;
      placements.forEach(p => {
        if (p.type !== 'text') return; // we place score markers tied to comments when ctype==='score'
        const idx = Number(p.page || 0);
        const img = imgNodes.find(el => Number(el.getAttribute('data-page-index')) === idx) || null;
        if (!img) return;
        const r = img.getBoundingClientRect();
        const wrap = container.querySelector(`.page-wrap[data-page-index="${idx}"]`) || img.parentElement;
        const wr = wrap ? wrap.getBoundingClientRect() : r;
        const scaleX = (r.width || img.clientWidth || img.naturalWidth || 1) / (p.page_w || 1);
        const scaleY = (r.height || img.clientHeight || img.naturalHeight || 1) / (p.page_h || 1);
        const bx = (p.x || 0) * scaleX; const by = (p.y || 0) * scaleY;
        const bw = (p.w || 0) * scaleX; const bh = (p.h || 0) * scaleY;
        const offX = r.left - wr.left; const offY = r.top - wr.top;
        let x = offX + bx + Math.max(12, bw + margin);
        let y = offY + by;
        // clamp inside page wrap bounds
        const maxX = (r.width || 0) - 20; const maxY = (r.height || 0) - 20;
        x = Math.max(0, Math.min(x, maxX));
        y = Math.max(0, Math.min(y, maxY));
        // Place comment box
        const id = addBox(String(p.text || ''), { select: false, edit: false });
        setBoxes(prev => prev.map(b => b.id===id ? { ...b, page: idx, x, y, w: 360, h: 100 } : b));
        placedIds.push(id);
        // Track top-most per question
        const qid = (p.qid != null ? String(p.qid) : null);
        if (qid) {
          const cur = firstCommentTopByQ[qid];
          const topY = y;
          if (!cur || topY < cur.y) firstCommentTopByQ[qid] = { idx, y: topY, offX };
        }

        // If this comment is a score-type, add a score marker near the bottom-left of the comment box
        const isScore = (p.ctype === 'score') && (typeof p.points === 'number');
        if (isScore) {
          const fs = 18; // score marker font size
          const markerH = Math.round(fs * 1.6);
          const sx = Math.max(0, x - 64);
          const sy = Math.max(0, y + 100 - markerH);
          const sid = addScoreMarker(p.points, { select: false });
          setBoxes(prev => prev.map(b => b.id===sid ? { ...b, page: idx, x: sx, y: sy, fontSize: fs } : b));
          placedIds.push(sid);
        }
      });

      // Place per-question score label above the first comment
      try {
        const questions = (review?.questions || []);
        Object.entries(firstCommentTopByQ).forEach(([qid, pos]) => {
          const q = questions.find(qq => String(qq.id) === String(qid));
          const awarded = Number(q?.awarded ?? 0);
          const max = Number(q?.max ?? 0);
          const label = `${awarded}/${max}`;
          const idx = pos.idx;
          const y = Math.max(0, pos.y - 26);
          const x = Math.max(0, (pos.offX || 0) + 20); // image左端 + 20px
          const id = addBox(label, { select: false, edit: false });
          setBoxes(prev => prev.map(b => b.id===id ? { ...b, page: idx, x, y, w: 120, h: 24, fontSize: 16, fixedHeight: true } : b));
          placedIds.push(id);
        });
      } catch {}
      notify(`自動配置を適用しました（${placements.length}件）`, 'success');
    } catch (e) {
      console.error(e);
      notify('自動配置に失敗しました','error');
    } finally { setAutoPlacing(false); }
  };

  // --- Editing time tracking (auto count-up while editor open) ---
  useEffect(() => {
    let alive = true;
    // fetch current total seconds
    (async () => {
      try {
        const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/time`);
        if (!res.ok) throw new Error('get time failed');
        const data = await res.json();
        if (!alive) return;
        setEditingSeconds(parseInt(data.seconds || 0, 10));
        setUnflushedSeconds(0);
        setTimeReady(true);
      } catch {
        setEditingSeconds(0);
        setUnflushedSeconds(0);
        setTimeReady(true);
      }
    })();
    return () => { alive = false; };
  }, [filename]);

  useEffect(() => {
    let timer = null;
    let flushTimer = null;
    let lastFlush = 0;
    if (!timeReady) return () => {};
    const tick = () => {
      setEditingSeconds(prev => prev + 1);
      setUnflushedSeconds(prev => prev + 1);
    };
    const flush = async () => {
      // Flush at most every 10s
      const pendingNow = parseInt(unflushedRef.current || 0, 10);
      if (pendingNow <= 0) return;
      const amt = pendingNow;
      lastFlush = amt;
      setUnflushedSeconds(0);
      try {
        await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/time/add`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: amt })
        });
      } catch {
        // swallow; will add on next flush
        setUnflushedSeconds(v => v + lastFlush);
      }
    };
    timer = setInterval(tick, 1000);
    flushTimer = setInterval(flush, 10000);
    return () => {
      if (timer) clearInterval(timer);
      if (flushTimer) clearInterval(flushTimer);
      // final flush on unmount
      const pending = parseInt(unflushedRef.current || 0, 10);
      if (pending > 0) {
        try { fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/time/add`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ seconds: pending }) }); } catch {}
        setUnflushedSeconds(0);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, timeReady]);

  const fetchSpatialDebug = async () => {
    try {
      setSpatialLoading(true);
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/spatial_map`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normalize: true, confidence_min: 0.45, debug: true, debug_images: true })
      });
      const data = await res.json();
      const urls = (data.debug && data.debug.images) || [];
      setSpatialDebugUrls(urls);
      notify(`AIブロック(Spatial) デバッグ画像: ${urls.length}件`, urls.length ? 'success' : 'info');
    } catch (e) {
      notify('AIブロック(Spatial)の取得に失敗しました','error');
    } finally {
      setSpatialLoading(false);
    }
  };

  const fetchSpatialRects = async () => {
    try {
      setSpatialLoading(true);
      const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/spatial_map`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normalize: true, confidence_min: 0.5 })
      });
      if (!res.ok) throw new Error('spatial_map failed');
      const data = await res.json();
      const placements = data.placements || [];
      const container = pageRef.current;
      if (!container) { setSpatialRects([]); setShowSpatialRects(false); return; }
      const imgs = Array.from(container.querySelectorAll('img.page-image'));
      const result = [];
      placements.forEach(p => {
        const idx = Number(p.page || 0);
        const img = imgs.find(el => Number(el.getAttribute('data-page-index')) === idx) || null;
        if (!img) return;
        const r = img.getBoundingClientRect();
        const wrap = container.querySelector(`.page-wrap[data-page-index="${idx}"]`) || img.parentElement;
        const wr = wrap ? wrap.getBoundingClientRect() : r;
        const scaleX = (r.width || img.clientWidth || img.naturalWidth || 1) / (p.page_w || 1);
        const scaleY = (r.height || img.clientHeight || img.naturalHeight || 1) / (p.page_h || 1);
        const offX = r.left - wr.left; const offY = r.top - wr.top;
        const left = offX + (p.x || 0) * scaleX;
        const top  = offY + (p.y || 0) * scaleY;
        const width = (p.w || 0) * scaleX; const height = (p.h || 0) * scaleY;
        result.push({ page: idx, left, top, width, height, text: p.text || '', confidence: p.confidence });
      });
      setSpatialRects(result); setShowSpatialRects(true);
      notify(`AIブロック重ね表示: ${result.length}件`, result.length? 'success':'info');
    } catch (e) {
      notify('AIブロック重ね表示に失敗しました','error');
    } finally {
      setSpatialLoading(false);
    }
  };

  const renderTeX = (text) => {
    const katex = window.katex;
    if (!katex || !text) return text;
    try {
      // naive inline $...$ replacement
      return text.replace(/\$(.+?)\$/g, (_, expr) => {
        try { return katex.renderToString(expr, { throwOnError: false }); } catch { return expr; }
      });
    } catch { return text; }
  };

  const pdfAssets = problemAssets.filter(a=>a.type==='pdf');
  const findUrlByName = (name) => {
    const f = pdfAssets.find(a => a.name === name);
    return f ? f.url : null;
  };
  const findPathByName = (name) => {
    const f = pdfAssets.find(a => a.name === name);
    return f ? f.path : null;
  };
  const autoPick = (mode) => {
    if (mode==='rubric'){
      const r = pdfAssets.find(a => /採点|基準/.test(a.name));
      return r ? r.url : (pdfAssets[1]?.url || pdfAssets[0]?.url || null);
    } else {
      const p = pdfAssets.find(a => !/採点|基準/.test(a.name));
      return p ? p.url : (pdfAssets[0]?.url || null);
    }
  };
  const toFileUrl = (absPath) => absPath ? `file://${absPath}` : null;
  const localProblemPath = findPathByName(problemSel.problem_pdf) || (pdfAssets.find(a=>!/採点|基準/.test(a.name))?.path || pdfAssets[0]?.path || null);
  const localRubricPath  = findPathByName(problemSel.rubric_pdf)  || (pdfAssets.find(a=>/採点|基準/.test(a.name))?.path || (pdfAssets.length>1 ? pdfAssets[1].path : null));

  // Favorites API helpers
  const fetchFavorites = useCallback(async () => {
    try {
      if (!university || !examType) { setFavorites({ global: [], problem: [] }); return; }
      const url = new URL(`${BACKEND_BASE}/favorites`);
      url.searchParams.set('category', university);
      url.searchParams.set('exam_type', examType);
      if (questionNumber) url.searchParams.set('question', String(questionNumber));
      const res = await fetch(url.toString());
      const data = await res.json();
      setFavorites({ global: data.global || [], problem: data.problem || [] });
    } catch { setFavorites({ global: [], problem: [] }); }
  }, [university, examType, questionNumber]);

  const addFavorite = async (scope, text, points) => {
    try {
      const body = { scope, text };
      if (points != null && points !== '') {
        const n = Number(points);
        if (!Number.isFinite(n) || n < 0) throw new Error('配点は0以上の数値で入力してください');
        body.points = Math.round(n);
      }
      if (scope === 'problem') { body.category = university; body.exam_type = examType; }
      const res = await fetch(`${BACKEND_BASE}/favorites/add`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('add favorite failed');
      await fetchFavorites();
      notify('お気に入りに追加しました','success');
    } catch { notify('お気に入り追加に失敗しました','error'); }
  };

  useEffect(() => { fetchFavorites(); }, [fetchFavorites]);

  const deleteFavorite = async (id) => {
    try {
      const res = await fetch(`${BACKEND_BASE}/favorites/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
      if (!res.ok) throw new Error('delete favorite failed');
      await fetchFavorites();
      notify('お気に入りを削除しました','success');
    } catch { notify('お気に入り削除に失敗しました','error'); }
  };

  const updateFavorite = async (id, text, onDone) => {
    try {
      const res = await fetch(`${BACKEND_BASE}/favorites/update`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id, text }) });
      if (!res.ok) throw new Error('update favorite failed');
      await fetchFavorites();
      if (onDone) onDone();
      notify('お気に入りを更新しました','success');
    } catch { notify('お気に入り更新に失敗しました','error'); }
  };
  const updateFavoritePoints = async (id, points) => {
    try {
      const n = Number(points);
      if (!Number.isFinite(n) || n < 0) throw new Error('配点は0以上の数値で入力してください');
      const res = await fetch(`${BACKEND_BASE}/favorites/update`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id, points: Math.round(n) }) });
      if (!res.ok) throw new Error('update favorite failed');
      await fetchFavorites();
      notify('配点を更新しました','success');
    } catch (e) { notify(e.message || '配点の更新に失敗しました','error'); }
  };
  const clearFavoritePoints = async (id) => {
    try {
      const res = await fetch(`${BACKEND_BASE}/favorites/update`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id, points: null }) });
      if (!res.ok) throw new Error('update favorite failed');
      await fetchFavorites();
      notify('配点を削除しました','success');
    } catch (e) { notify('配点の削除に失敗しました','error'); }
  };

  // Close context menu on outside click
  useEffect(() => {
    const onDoc = (e) => {
      if (!favMenu.show) return;
      const el = favMenuRef.current;
      if (el && el.contains(e.target)) return;
      setFavMenu({ show:false, x:0, y:0, text:'' });
    };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [favMenu.show]);
  const serverProblemUrl = findUrlByName(problemSel.problem_pdf) || (pdfAssets.find(a=>!/採点|基準/.test(a.name))?.url || pdfAssets[0]?.url || null);
  const serverRubricUrl  = findUrlByName(problemSel.rubric_pdf)  || (pdfAssets.find(a=>/採点|基準/.test(a.name))?.url || (pdfAssets.length>1 ? pdfAssets[1].url : null));
  const openLocalOrServer = (localPath, serverUrl, label) => {
    if (localPath) {
      const f = toFileUrl(localPath);
      try { window.open(f, '_blank'); return; } catch {}
    }
    if (serverUrl) {
      const abs = new URL(serverUrl, window.location.origin).toString();
      window.open(abs, '_blank');
      return;
    }
    notify(`${label} が見つかりません`,'error');
  };
  // Use global BACKEND_BASE defined at top
  // const BACKEND_BASE = (process && process.env && process.env.REACT_APP_BACKEND_BASE)
  //   || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8000` : 'http://127.0.0.1:8000');
  const openInWindow = (url, name) => {
    const features = 'noopener,noreferrer,width=1000,height=1200,toolbar=0,menubar=0,location=0,status=0,scrollbars=1,resizable=1';
    const w = window.open(url, name || '_blank', features);
    if (!w) notify('ポップアップがブロックされました。許可してください','info');
  };
  const openProblemBtn = () => {
    const pdfs = pdfAssets;
    if (!pdfs || pdfs.length === 0) { notify('問題PDFが見つかりません','error'); return; }
    const sel = problemSel.problem_pdf;
    const chosen = sel ? pdfs.find(a => a.name === sel) : (pdfs.find(a => !/採点|基準/.test(a.name)) || pdfs[0]);
    if (!chosen) { notify('問題PDFが見つかりません','error'); return; }
    const abs = chosen.url.startsWith('/') ? `${BACKEND_BASE}${chosen.url}` : chosen.url;
    openInWindow(abs, 'problem_pdf');
  };
  const openRubricBtn = () => {
    const pdfs = pdfAssets;
    if (!pdfs || pdfs.length === 0) { notify('採点基準PDFが見つかりません','error'); return; }
    const sel = problemSel.rubric_pdf;
    const chosen = sel ? pdfs.find(a => a.name === sel) : (pdfs.find(a => /採点|基準/.test(a.name)) || pdfs[1] || pdfs[0]);
    if (!chosen) { notify('採点基準PDFが見つかりません','error'); return; }
    const abs = chosen.url.startsWith('/') ? `${BACKEND_BASE}${chosen.url}` : chosen.url;
    openInWindow(abs, 'rubric_pdf');
  };

  // Open problem and rubric PDFs side-by-side in a separate window(s)
  const openRefsSideBySide = () => {
    const pdfs = pdfAssets || [];
    if (!pdfs.length) { notify('参照PDFがまだ読み込まれていません','info'); return; }
    const pickProblem = () => {
      const sel = problemSel.problem_pdf;
      const chosen = sel ? pdfs.find(a => a.name === sel) : (pdfs.find(a => !/採点|基準/.test(a.name)) || pdfs[0]);
      if (!chosen) return null;
      return chosen.url.startsWith('/') ? `${BACKEND_BASE}${chosen.url}` : chosen.url;
    };
    const pickRubric = () => {
      const sel = problemSel.rubric_pdf;
      const chosen = sel ? pdfs.find(a => a.name === sel) : (pdfs.find(a => /採点|基準/.test(a.name)) || pdfs[1] || pdfs[0]);
      if (!chosen) return null;
      return chosen.url.startsWith('/') ? `${BACKEND_BASE}${chosen.url}` : chosen.url;
    };
    const urlL = pickProblem();
    const urlR = pickRubric();
    if (!urlL || !urlR) { notify('問題PDFまたは採点基準PDFが見つかりません','error'); return; }

    // Open immediately during user gesture
    const sw = window.screen?.availWidth || 1200;
    const sh = window.screen?.availHeight || 900;
    const sl = (window.screen?.availLeft || window.screenX || 0);
    const st = (window.screen?.availTop || window.screenY || 0);
    const half = Math.max(400, Math.floor(sw/2));
    const featL = `left=${sl},top=${st},width=${half},height=${sh},toolbar=0,menubar=0,location=0,status=0,scrollbars=1,resizable=1`;
    const featR = `left=${sl+half},top=${st},width=${Math.max(400, sw-half)},height=${sh},toolbar=0,menubar=0,location=0,status=0,scrollbars=1,resizable=1`;
    const winL = window.open(urlL, 'pdf_left', featL);
    const winR = window.open(urlR, 'pdf_right', featR);
    if (!winL || !winR) { notify('ポップアップがブロックされました。許可してください','info'); return; }

    // Try to move to secondary display if available (requires permission; best-effort)
    setTimeout(async () => {
      try {
        if ('getScreenDetails' in window && typeof window.getScreenDetails === 'function') {
          // @ts-ignore experimental API
          const details = await window.getScreenDetails();
          const ext = (details.screens || []).find(s => !s.isPrimary) || details.currentScreen;
          if (ext && winL && winR) {
            const aw = ext.availWidth || sw;
            const ah = ext.availHeight || sh;
            const ax = ext.availLeft ?? sl;
            const ay = ext.availTop ?? st;
            const h2 = Math.floor(aw/2);
            try { winL.moveTo(ax, ay); winL.resizeTo(h2, ah); } catch {}
            try { winR.moveTo(ax + h2, ay); winR.resizeTo(aw - h2, ah); } catch {}
          }
        }
      } catch {}
    }, 0);
  };

  const [showChat, setShowChat] = useState(false);
  const [chatAttachments, setChatAttachments] = useState([]); // [{ id, file, url }]
  const chatFileInputRef = useRef(null);

  const addChatFiles = (files) => {
    if (!files || !files.length) return;
    const items = Array.from(files).filter(f => /^image\//.test(f.type));
    if (!items.length) return;
    const now = Date.now();
    const mapped = items.map((f, i) => ({ id: `att_${now}_${i}_${Math.random().toString(36).slice(2,7)}`, file: f, url: URL.createObjectURL(f) }));
    setChatAttachments(prev => [...prev, ...mapped]);
  };
  const removeChatAttachment = (id) => setChatAttachments(prev => prev.filter(x => x.id !== id));

  const sendChat = async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    // optimistic append
    const userMsg = { role: 'user', text: msg, images: chatAttachments.map(a => a.url) };
    setChatHistory(h => [...h, userMsg]);
    setChatLoading(true);
    setChatInput('');
    try {
      let res, data;
      if (chatAttachments.length > 0) {
        const fd = new FormData();
        fd.append('message', msg);
        chatAttachments.forEach(a => fd.append('images', a.file, a.file.name || 'image.png'));
        res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/chat`, { method:'POST', body: fd });
      } else {
        res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/chat`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: msg }) });
      }
      data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'chat failed');
      setChatHistory(h => [...h, { role:'assistant', text: data.reply || '(空)' }]);
    } catch (e) {
      setChatHistory(h => [...h, { role:'assistant', text: 'エラーが発生しました。' }]);
    } finally {
      // Keep previews in chat history; clear pending attachments area only
      setChatAttachments([]);
      setChatLoading(false);
    }
  };
  return (
    <div className={`editor-container ${showChat ? '' : 'chat-hidden'}`} ref={editorRootRef}>
      <button className="close-editor-btn" onClick={async ()=>{ await flushEditingTimeNow(); try { if (typeof onAfterClose === 'function') onAfterClose(); } catch {} onClose(); }}>
        <span role="img" aria-label="Back">⬅️</span> ダッシュボードに戻る
      </button>
      {showChat && (
      <div className="left-rail">
        <div className="chat-panel">
          <div className="chat-header">
            <div className="chat-title"><IconBrain /> AIヘルプ</div>
            <div>{chatLoading && <span className="spinner" />}</div>
          </div>
          <div className="chat-log chat-bubbles" onPaste={(e)=>{
            try {
              const items = e.clipboardData && e.clipboardData.items;
              if (items) {
                const files = [];
                for (let i=0;i<items.length;i++) {
                  const it = items[i];
                  if (it.kind === 'file') {
                    const f = it.getAsFile();
                    if (f && /^image\//.test(f.type)) files.push(f);
                  }
                }
                if (files.length) { e.preventDefault(); addChatFiles(files); }
              }
            } catch {}
          }}>
            {(!chatHistory || chatHistory.length===0) && (
              <div className="chat-empty">この答案について質問してください（書き起こし/Answer.md/レビューを参照して回答します）。</div>
            )}
            {(chatHistory||[]).map((m,i)=> (
              <div key={i} className={`chat-msg ${m.role}`}>
                <div className="chat-avatar">{m.role==='user' ? '👤' : '🤖'}</div>
                <div className={`chat-bubble ${m.role}`}>
                  {Array.isArray(m.images) && m.images.length>0 && (
                    <div className="chat-images">
                      {m.images.map((u,idx)=>(<img key={idx} src={u} alt="att" />))}
                    </div>
                  )}
                  <div className="chat-text" dangerouslySetInnerHTML={{__html: renderTeX(m.text || '')}} />
                </div>
              </div>
            ))}
          </div>
          {chatAttachments.length>0 && (
            <div className="chat-attachments">
              {chatAttachments.map(a => (
                <div key={a.id} className="attach-thumb"><img src={a.url} alt="att" /><button title="削除" onClick={()=>removeChatAttachment(a.id)}>×</button></div>
              ))}
            </div>
          )}
            <div className="chat-input">
            <IconButton title="画像を添付" onClick={()=> chatFileInputRef.current && chatFileInputRef.current.click()}><svg width="18" height="18" viewBox="0 0 24 24"><path d="M8 12l7-7a4 4 0 1 1 6 6l-9 9a6 6 0 0 1-8.5-8.5l8-8" stroke="currentColor"/></svg></IconButton>
            <input ref={chatFileInputRef} type="file" accept="image/*" multiple style={{display:'none'}} onChange={(e)=>{ addChatFiles(e.target.files); e.target.value=''; }} />
            <input type="text" value={chatInput} onChange={(e)=>setChatInput(e.target.value)} placeholder="質問を入力...（Ctrl+Vで画像貼り付け）" onKeyDown={(e)=>{ if (e.key==='Enter') { e.preventDefault(); sendChat(); } }} onPaste={(e)=>{
              // In text input: prefer normal text paste if any textual data exists.
              try {
                const dt = e.clipboardData;
                const hasText = dt && (dt.getData && (dt.getData('text/plain') || dt.getData('text') || '')).trim().length > 0;
                const items = dt && dt.items;
                const files = [];
                if (items) {
                  for (let i=0;i<items.length;i++) {
                    const it = items[i];
                    if (it && it.kind === 'file') {
                      const f = it.getAsFile();
                      if (f && /^image\//.test(f.type)) files.push(f);
                    }
                  }
                }
                if (!hasText && files.length) {
                  e.preventDefault();
                  addChatFiles(files);
                }
              } catch {}
            }} />
            <IconButton title="送信" onClick={sendChat} disabled={chatLoading || !chatInput.trim()}><IconArrowRight /></IconButton>
          </div>
        </div>
      </div>
      )}
      <div className="canvas">
        <div className="page-toolbar ds-toolbar" style={{marginBottom:8}}>
          <div className="ds-group" aria-label="ページ移動">
            <IconButton title="前のページ" onClick={() => setCurrent(c => Math.max(0, c-1))} disabled={current===0}><svg width="16" height="16" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2"/></svg></IconButton>
            <div style={{fontWeight:600, minWidth: '110px', textAlign:'center'}}>{pages.length ? `ページ ${current+1} / ${pages.length}` : 'ページなし'}</div>
            <IconButton title="次のページ" onClick={() => setCurrent(c => Math.min((pages.length-1)||0, c+1))} disabled={current>=(pages.length-1)}><svg width="16" height="16" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2"/></svg></IconButton>
          </div>
          <div className="ds-group" aria-label="種別">
            {(examType || university) ? (
              <div style={{opacity:0.85}}>
                種別: {university ? `${university}・` : ''}{examType || '-'}{questionNumber ? `・第${questionNumber}問` : ''}
              </div>
            ) : null}
            <Button appearance="subtle" size="s" onClick={()=> setShowSelector(v=>!v)}>{showSelector ? '設定を閉じる' : '種別設定'}</Button>
          </div>
          <div className="ds-group" style={{marginLeft:'auto'}} aria-label="状態とAI">
            <span className="time-badge">{formatSeconds(editingSeconds)}</span>
            <IconButton
              title="ページ結合表示 (上下に連結)"
              aria-label="ページ結合表示"
              appearance={combinePages ? 'secondary' : 'subtle'}
              onClick={()=> setCombinePages(v=>!v)}
            >
              <IconMerge />
            </IconButton>
            <IconButton title={showChat ? 'AIを閉じる' : 'AIヘルプ'} aria-label="AI" onClick={()=>setShowChat(v=>!v)}><IconBrain /></IconButton>
          </div>
          {showSelector && (
            <div className="selector-panel" style={{display:'flex', gap:8, alignItems:'center', padding:'6px 8px', background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:8, margin:'8px 0'}}>
              <div>
                <label style={{fontSize:12, display:'block', color:'#334155'}}>カテゴリー</label>
                <select value={tmpUniversity} onChange={(e)=>{ setTmpUniversity(e.target.value); setTmpExamType(''); }}>
                  <option value="">(選択)</option>
                  {Object.keys(problemIndex).map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{fontSize:12, display:'block', color:'#334155'}}>試験種</label>
                <select value={tmpExamType} onChange={(e)=> setTmpExamType(e.target.value)} disabled={!tmpUniversity}>
                  <option value="">(選択)</option>
                  {(problemIndex[tmpUniversity] || []).map(et => (
                    <option key={et} value={et}>{et}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{fontSize:12, display:'block', color:'#334155'}}>第n問</label>
                <select value={tmpQuestion} onChange={(e)=> setTmpQuestion(e.target.value)}>
                  <option value="">(指定なし)</option>
                  {[1,2,3,4,5,6].map(n => <option key={n} value={String(n)}>{n}</option>)}
                </select>
              </div>
              <div style={{marginLeft:'auto', display:'flex', gap:8}}>
                <button className="small-button" onClick={()=>{
                  setTmpUniversity(university||''); setTmpExamType(examType||''); setTmpQuestion(questionNumber?String(questionNumber):'');
                }}>リセット</button>
                <button className="small-button" onClick={async ()=>{
                  if (!tmpUniversity || !tmpExamType) { notify('カテゴリーと試験種を選択してください','error'); return; }
                  try {
                    const body = { university: tmpUniversity, exam_type: tmpExamType };
                    if (tmpQuestion !== '') body.question_number = Number(tmpQuestion);
                    const res = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/problem_selection`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.detail || '保存に失敗しました');
                    setUniversity(tmpUniversity); setExamType(tmpExamType); setQuestionNumber(data.question_number || (tmpQuestion!==''? Number(tmpQuestion): null));
                    // Refresh assets for the new selection
                    try {
                      const res2 = await fetch(`${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/problem_assets`);
                      const d2 = await res2.json();
                      setProblemAssets(d2.assets || []);
                    } catch {}
                    notify('種別を保存しました','success');
                  } catch (e) {
                    notify(e.message || '保存に失敗しました','error');
                  }
                }}>保存</button>
              </div>
            </div>
          )}
          <div className="toolbar group-separated ds-toolbar">
            <div className="group ds-group" aria-label="挿入">
              <IconButton title="テキストS" onClick={()=> setPlaceMode({ type:'text', payload:{ edit:true, fontSize:14 }})}>S</IconButton>
              <IconButton title="テキストM" onClick={()=> setPlaceMode({ type:'text', payload:{ edit:true, fontSize:18 }})}>M</IconButton>
              <IconButton title="テキストL" onClick={()=> setPlaceMode({ type:'text', payload:{ edit:true, fontSize:30 }})}>L</IconButton>
              <div className="ds-sep" />
              <div className="ds-group nowrap" aria-label="フォント" style={{display:'flex', alignItems:'center', gap:6}}>
                <IconButton title="フォント大" onClick={()=>changeFontSize(1)}>A+</IconButton>
                <input type="number" aria-label="フォントサイズ" value={(selectedIds.length===1 ? (boxes.find(b=>b.id===selectedId)?.fontSize || 16) : '')} onChange={(e)=>setFontSize(e.target.value)} style={{width:56, padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:6}} />
                <IconButton title="フォント小" onClick={()=>changeFontSize(-1)}>A−</IconButton>
                <IconButton title="太字" onClick={toggleBold}><strong>B</strong></IconButton>
              </div>
              <IconButton title="画像を追加" onClick={()=> markInputRef.current && markInputRef.current.click()}><IconImage /></IconButton>
              <IconButton title="満点丸スタンプ（クリックで配置）" onClick={()=> setPlaceMode({ type: 'image', payload: { src: '/assets/stamps/circle.png' }})}><IconCircle /></IconButton>
              <SplitButton
                label=""
                appearance="subtle"
                iconBefore={<span style={{ fontWeight: 600 }}>名</span>}
                onClick={addDefaultSign}
                items={signatureMenuItems}
              />
              <IconButton title="×（大）を配置" onClick={()=> setPlaceMode({ type: 'glyph', payload: { glyph: '×', size: 25 }})}><IconCross /></IconButton>
              <IconButton title="閉じ括弧（大）を配置" onClick={()=> setPlaceMode({ type: 'glyph', payload: { glyph: '」', size: 40 }})}>」</IconButton>
              <IconButton title="直線を配置" onClick={()=> setPlaceMode({ type: 'line' })}><IconLine /></IconButton>
              <IconButton title="直線+× を配置" onClick={()=> setPlaceMode({ type: 'linex' })}>╴×</IconButton>
              <IconButton title="矢印を配置" onClick={()=> setPlaceMode({ type: 'arrow' })}><IconArrowRight /></IconButton>
              <IconButton title="フリードロー切替" onClick={()=> setDrawMode(v=>{ const nv=!v; if (nv) setEraserMode(false); return nv; })} style={{outline: drawMode? '2px solid #0c66e4':'none'}}><IconPencil /></IconButton>
              <IconButton title="消しゴム切替" onClick={()=> setEraserMode(v=>{ const nv=!v; if (nv) setDrawMode(false); return nv; })} style={{outline: eraserMode? '2px solid #0c66e4':'none'}}><IconEraser /></IconButton>
              <label className="stroke-width-control" title="線の太さ">
                <span>線</span>
                <input
                  type="range"
                  min="1"
                  max="12"
                  step="0.5"
                  value={strokeWidth}
                  onChange={(e)=>{
                    const v = parseFloat(e.target.value);
                    if (!Number.isNaN(v)) setStrokeWidth(Math.max(1, v));
                  }}
                />
                <span>{strokeWidth.toFixed(1)}</span>
              </label>
              <input ref={markInputRef} type="file" accept="image/*" style={{display:'none'}} onChange={onPickMark} />
            </div>
            
            <div className="group ds-group" aria-label="加点">
              <SplitButton
                label=""
                appearance="subtle"
                iconBefore={<IconPlusCircle />}
                onClick={()=> setPlaceMode({ type:'score', payload:{ points:lastScorePoints }})}
                items={Array.from({length:50}, (_,i)=>({ label: `+${i+1}`, onClick: ()=> { setLastScorePoints(i+1); setPlaceMode({ type:'score', payload:{ points:i+1 }}); } }))}
              />
            </div>
            <div className="ds-sep" />
            <div className="group ds-group" aria-label="編集">
              <IconButton title="元に戻す (Cmd/Ctrl+Z)" onClick={(e)=>{ e.preventDefault(); const prev = historyRef.current.pop(); if (prev) { redoRef.current.push(JSON.parse(JSON.stringify(boxes))); setBoxes(prev); } }}><IconUndo /></IconButton>
              <IconButton title="やり直し (Shift+Cmd/Ctrl+Z / Ctrl+Y)" onClick={(e)=>{ e.preventDefault(); const next = redoRef.current.pop(); if (next) { historyRef.current.push(JSON.parse(JSON.stringify(boxes))); setBoxes(next); } }}><IconRedo /></IconButton>
              <IconButton appearance="danger" title="選択を削除" onClick={removeSelected}><IconTrash /></IconButton>
            </div>
            <div className="ds-sep" />
            <div className="group ds-group" aria-label="参照">
              <Button appearance="subtle" size="s" title="問題PDFを開く" onClick={openProblemBtn} iconBefore={<IconPdf />}>問題PDF</Button>
              <Button appearance="subtle" size="s" title="採点基準PDFを開く" onClick={openRubricBtn} iconBefore={<IconPdf />}>採点基準PDF</Button>
              <Button appearance="subtle" size="s" title="左右に並べて開く（別ウィンドウ）" onClick={openRefsSideBySide} iconBefore={<IconSideBySide />}>並べて表示</Button>
            </div>
            <div className="ds-sep" />
            <div className="group ds-group" aria-label="保存・出力">
              <IconButton appearance="primary" title="保存" aria-label="保存" onClick={save}><IconSave /></IconButton>
              <IconButton appearance="secondary" title="エクスポート" aria-label="エクスポート" onClick={exportClientPDF}><IconExport /></IconButton>
              <IconButton appearance="success" title="完了" aria-label="完了" onClick={complete}><IconCheck /></IconButton>
            </div>
          </div>
        </div>
        <div
          className={`page-view ${placeMode ? 'placing' : ''}`}
          ref={pageRef}
          onPointerDown={handlePagePointerDown}
          onPointerMove={handlePagePointerMove}
          onPointerUp={handlePagePointerUp}
          onPointerCancel={handlePagePointerUp}
          onClick={handlePageClick}
        >
          {combinePages ? (
            pages.map((src, i) => (
              <div className="page-wrap" key={i} data-page-index={i}>
                <img
                  src={src}
                  alt={`page_${i+1}`}
                  className="page-image"
                  data-page-index={i}
                  crossOrigin="anonymous"
                  ref={(el) => {
                    if (el) {
                      imageRefs.current[i] = el;
                      resizeCanvas(i, el);
                    } else {
                      delete imageRefs.current[i];
                    }
                  }}
                  onLoad={(event) => resizeCanvas(i, event.currentTarget)}
                />
                <canvas
                  className="draw-canvas"
                  ref={(el) => {
                    if (el) {
                      canvasRefs.current[i] = el;
                      const img = imageRefs.current[i];
                      if (img) resizeCanvas(i, img);
                      renderPageCanvas(i);
                    } else {
                      delete canvasRefs.current[i];
                    }
                  }}
                />
                {showSpatialRects && spatialRects.filter(r=>r.page===i).map((r,idx)=> (
                  <div key={`srect_${i}_${idx}`} className="ai-rect" style={{ position:'absolute', left:r.left, top:r.top, width:r.width, height:r.height, border:'2px solid rgba(38,198,84,0.9)', borderRadius:2, background:'transparent', pointerEvents:'none', zIndex:3 }} title={`${(r.confidence!=null?r.confidence.toFixed(2):'?')} ${r.text||''}`}>
                    <div style={{ position:'absolute', left:0, top:-18, background:'rgba(38,198,84,0.9)', color:'#fff', fontSize:11, padding:'1px 4px', borderRadius:3, pointerEvents:'none' }}>
                      {(r.confidence!=null?r.confidence.toFixed(2):'?')} {r.text || ''}
                    </div>
                  </div>
                ))}
                {boxes.filter(b => b.page === i && b.type !== 'draw').map(b => (
            b.type === 'score' ? (
              <div key={b.id} className="score-marker" style={{left:b.x, top:b.y, fontSize: b.fontSize, outline: selectedIds.includes(b.id)? '1px dashed rgba(255,65,65,0.8)' : 'none' }} onPointerDown={(e)=>{ e.stopPropagation(); onPointerDownBox(e,b.id); }} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}}>
                <span className="score-bracket">」</span>
                <span className="score-chip" style={{ fontSize: Math.round(b.fontSize*0.95) }}>{`+${b.points??1}`}</span>
                {selectedId===b.id && (
                  <div style={{position:'absolute', right:-6, top:-26, fontSize:12, opacity:.9}}>
                    <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                  </div>
                )}
              </div>
            ) : b.type === 'line' ? (
              <div key={b.id} className={`box ${selectedIds.includes(b.id)?'selected':''}`} style={{left:b.x, top:b.y, width:b.w, height:b.h, cursor: (hoverEdge.id===b.id && (hoverEdge.edge==='l'||hoverEdge.edge==='r')) ? 'ew-resize' : 'move'}} onPointerDown={(e)=>{ e.stopPropagation();
                // Edge grab: treat near-left/right border as resize without requiring tiny handles
                try {
                  if (selectedIds.includes(b.id) && selectedIds.length===1) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const relX = e.clientX - rect.left;
                    const edge = 10; // px threshold
                    if (relX <= edge) { onResizeDown(e, b.id, 'l'); return; }
                    if (relX >= rect.width - edge) { onResizeDown(e, b.id, 'r'); return; }
                  }
                } catch {}
                onPointerDownBox(e,b.id);
              }} onPointerMove={(e)=>{
                const rect = e.currentTarget.getBoundingClientRect();
                const relX = e.clientX - rect.left;
                const edge = 10;
                if (relX <= edge) {
                  e.currentTarget.style.cursor = 'w-resize';
                  setHoverEdge({ id: b.id, edge: 'l' });
                } else if (relX >= rect.width - edge) {
                  e.currentTarget.style.cursor = 'e-resize';
                  setHoverEdge({ id: b.id, edge: 'r' });
                } else {
                  if (hoverEdge.id===b.id) setHoverEdge({ id: null, edge: null });
                  e.currentTarget.style.cursor = 'move';
                }
              }} onPointerLeave={(e)=>{ e.currentTarget.style.cursor='move'; if (hoverEdge.id===b.id) setHoverEdge({ id:null, edge:null }); }} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}}>
                <div style={{position:'absolute', left:0, top:0, width:'100%', height:'100%', background:'#ff4141'}} />
                {selectedIds.includes(b.id) && selectedIds.length===1 && (
                  <>
                    {(hoverEdge.id===b.id && hoverEdge.edge==='l') && <div className="edge-highlight l" />}
                    {(hoverEdge.id===b.id && hoverEdge.edge==='r') && <div className="edge-highlight r" />}
                    <div className="resize-handle tl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tl'); }} />
                    <div className="resize-handle tr" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tr'); }} />
                    <div className="resize-handle bl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'bl'); }} />
                    <div className="resize-handle br" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'br'); }} />
                    <div className="edge-handle l" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'l'); }} />
                    <div className="edge-handle r" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'r'); }} />
                    <div style={{position:'absolute', right:4, top:4, fontSize:12, opacity:.9}}>
                      <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                    </div>
                  </>
                )}
              </div>
            ) : b.type === 'arrow' ? (
              <svg key={b.id} style={{position:'absolute', left:0, top:0, width:'100%', height:'100%', pointerEvents:'none'}}>
                <defs>
                  <marker id={`ah-${b.id}`} markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="#ff4141" />
                  </marker>
                </defs>
                <line x1={b.x} y1={b.y} x2={b.ex} y2={b.ey}
                  stroke="#ff4141" strokeWidth={b.strokeWidth||3}
                  markerEnd={`url(#ah-${b.id})`}
                  style={{ pointerEvents: 'stroke' }}
                  onPointerDown={(e)=>{ e.stopPropagation(); onPointerDownBox(e,b.id); }}
                  onClick={(e)=>{ e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id); }}
                />
                {selectedIds.includes(b.id) && (
                  <>
                    <circle cx={b.x} cy={b.y} r={6} fill="#fff" stroke="#ff4141" strokeWidth={2} style={{pointerEvents:'all'}} onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'l'); }} />
                    <circle cx={b.ex} cy={b.ey} r={6} fill="#fff" stroke="#ff4141" strokeWidth={2} style={{pointerEvents:'all'}} onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'r'); }} />
                  </>
                )}
              </svg>
            ) : b.type === 'target' ? (
              <div key={b.id} className={`box ${selectedIds.includes(b.id)?'selected':''}`} style={{left:b.x, top:b.y, width:b.w, height:b.h}} onPointerDown={(e)=>onPointerDownBox(e,b.id)} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}}>
                <div style={{
                  position:'absolute', left:0, top:0, width:'100%', height:'100%',
                  display:'inline-flex', alignItems:'center', justifyContent:'center',
                  color:'#ff4141', border:'2px solid #ff4141', borderRadius: '9999px',
                  background:'rgba(255,255,255,0.6)', fontSize: (b.fontSize||14), fontWeight: (b.fontWeight||'bold'),
                  padding:'0 10px',
                }}
                dangerouslySetInnerHTML={{__html: `対象: ${(() => { const k=window.katex; const t=String(b.text||''); try { return k ? t.replace(/\$(.+?)\$/g, (_, expr) => { try { return k.renderToString(expr,{throwOnError:false}); } catch { return expr; } }) : t; } catch { return t; } })()}`}} />
                {selectedIds.includes(b.id) && selectedIds.length===1 && (
                  <div style={{position:'absolute', right:4, top:4, fontSize:12, opacity:.9}}>
                    <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                  </div>
                )}
              </div>
            ) : b.type === 'draw' ? (
              <svg key={b.id} style={{position:'absolute', left:0, top:0, width:'100%', height:'100%', pointerEvents:'none'}}>
                <g transform={`translate(${b.offsetX||0},${b.offsetY||0})`}>
                  <polyline
                    points={(b.points||[]).map(p=>`${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke="#ff4141"
                    strokeWidth={b.strokeWidth||3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ pointerEvents: 'stroke' }}
                    onPointerDown={(e)=>{ e.stopPropagation(); onPointerDownBox(e,b.id); }}
                    onClick={(e)=>{ e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id); }}
                  />
                </g>
              </svg>
            ) : (
              <div key={b.id} className={`box ${selectedIds.includes(b.id)?'selected':''}`} style={{left:b.x, top:b.y, width:b.w, height:b.h}} onPointerDown={(e)=>{ e.stopPropagation();
                try {
                  if (selectedIds.includes(b.id) && selectedIds.length===1) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const relX = e.clientX - rect.left;
                    const edge = 10;
                    if (relX <= edge) { onResizeDown(e, b.id, 'l'); return; }
                    if (relX >= rect.width - edge) { onResizeDown(e, b.id, 'r'); return; }
                  }
                } catch {}
                onPointerDownBox(e,b.id);
              }} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}} onDoubleClick={(e)=>{ e.stopPropagation(); selectOnly(b.id); setBoxes(prev => prev.map(x => x.id===b.id ? {...x, isEditing: true} : x)); setTimeout(()=>{ try { textRefs.current[b.id]?.focus(); } catch {} }, 0); }} onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); if (b.type==='text') setFavMenu({ show:true, x: e.clientX, y: e.clientY, text: b.text || ''}); }}>
                {b.type === 'image' ? (
                  <img src={b.src} alt="img" style={{width:'100%', height:'100%', objectFit:'contain', pointerEvents:'none'}} />
                ) :
                b.isEditing ? (
                  <textarea
                    ref={el => (textRefs.current[b.id] = el)}
                    value={b.text || ''}
                    onPointerDown={(e)=>{ e.stopPropagation(); }}
                    onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); setFavMenu({ show:true, x: e.clientX, y: e.clientY, text: (b.text || '')}); }}
                    onChange={(e)=>{
                      updateText(b.id, e.target.value);
                      try {
                        e.target.style.height = 'auto';
                        e.target.style.height = (e.target.scrollHeight)+'px';
                        setBoxes(prev => prev.map(x => x.id===b.id ? {...x, h: Math.max(40, e.target.scrollHeight+4)} : x));
                      } catch {}
                    }}
                    style={{
                      fontSize: b.fontSize || 16,
                      fontWeight: b.fontWeight || 'normal',
                      background: 'transparent',
                      color: '#ff4141',
                      width: '100%',
                      height: '100%',
                      pointerEvents: 'auto'
                    }}
                  />
                ) : (
                  <div ref={el => (renderRefs.current[b.id] = el)} className="render-box" style={{fontSize: b.fontSize || 16, fontWeight: b.fontWeight || 'normal'}} dangerouslySetInnerHTML={{__html: renderTeX(b.text || '')}} />
                )}
                {selectedIds.includes(b.id) && selectedIds.length===1 && (
                  <>
                    <div className="resize-handle tl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tl'); }} />
                    <div className="resize-handle tr" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tr'); }} />
                    <div className="resize-handle bl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'bl'); }} />
                    <div className="resize-handle br" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'br'); }} />
                    <div style={{position:'absolute', right:4, top:4, fontSize:12, opacity:.9}}>
                      <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                    </div>
                  </>
                )}
              </div>
            )
          ))}
              </div>
            ))
          ) : (
            <div className="page-wrap" data-page-index={current}>
              {pages[current] && (
                <img
                  src={pages[current]}
                  alt="page"
                  className="page-image"
                  data-page-index={current}
                  crossOrigin="anonymous"
                  ref={(el) => {
                    if (el) {
                      imageRefs.current[current] = el;
                      resizeCanvas(current, el);
                    } else {
                      delete imageRefs.current[current];
                    }
                  }}
                  onLoad={(event) => resizeCanvas(current, event.currentTarget)}
                />
              )}
              <canvas
                className="draw-canvas"
                ref={(el) => {
                  if (el) {
                    canvasRefs.current[current] = el;
                    const img = imageRefs.current[current];
                    if (img) resizeCanvas(current, img);
                    renderPageCanvas(current);
                  } else {
                    delete canvasRefs.current[current];
                  }
                }}
              />
              {showSpatialRects && spatialRects.filter(r=>r.page===current).map((r,idx)=> (
                <div key={`srect_${current}_${idx}`} className="ai-rect" style={{ position:'absolute', left:r.left, top:r.top, width:r.width, height:r.height, border:'2px solid rgba(38,198,84,0.9)', borderRadius:2, background:'transparent', pointerEvents:'none', zIndex:3 }} title={`${(r.confidence!=null?r.confidence.toFixed(2):'?')} ${r.text||''}`}>
                  <div style={{ position:'absolute', left:0, top:-18, background:'rgba(38,198,84,0.9)', color:'#fff', fontSize:11, padding:'1px 4px', borderRadius:3, pointerEvents:'none' }}>
                    {(r.confidence!=null?r.confidence.toFixed(2):'?')} {r.text || ''}
                  </div>
                </div>
              ))}
              {boxes.filter(b => b.page === current && b.type !== 'draw').map(b => (
            b.type === 'score' ? (
              <div key={b.id} className="score-marker" style={{left:b.x, top:b.y, fontSize: b.fontSize, outline: selectedIds.includes(b.id)? '1px dashed rgba(255,65,65,0.8)' : 'none' }} onPointerDown={(e)=>{ e.stopPropagation(); onPointerDownBox(e,b.id); }} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}}>
                <span className="score-bracket">」</span>
                <span className="score-chip" style={{ fontSize: Math.round(b.fontSize*0.95) }}>{`+${b.points??1}`}</span>
                {selectedId===b.id && (
                  <div style={{position:'absolute', right:-6, top:-26, fontSize:12, opacity:.9}}>
                    <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                  </div>
                )}
              </div>
            ) : b.type === 'line' ? (
              <div key={b.id} className={`box ${selectedIds.includes(b.id)?'selected':''}`} style={{left:b.x, top:b.y, width:b.w, height:b.h}} onPointerDown={(e)=>{ e.stopPropagation();
                if (b.isEditing) return;
                try {
                  if (selectedIds.includes(b.id) && selectedIds.length===1) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const relX = e.clientX - rect.left;
                    const edge = 10;
                    if (relX <= edge) { onResizeDown(e, b.id, 'l'); return; }
                    if (relX >= rect.width - edge) { onResizeDown(e, b.id, 'r'); return; }
                  }
                } catch {}
                onPointerDownBox(e,b.id);
              }} onPointerMove={(e)=>{
                try {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = e.clientX - rect.left;
                  const edge = 10;
                  if (relX <= edge) {
                    e.currentTarget.style.cursor = 'w-resize';
                  } else if (relX >= rect.width - edge) {
                    e.currentTarget.style.cursor = 'e-resize';
                  } else {
                    e.currentTarget.style.cursor = 'move';
                  }
                } catch { /* noop */ }
              }} onPointerLeave={(e)=>{ try { e.currentTarget.style.cursor = 'move'; } catch {} }} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}}>
                <div style={{position:'absolute', left:0, top:0, width:'100%', height:'100%', background:'#ff4141'}} />
                {selectedIds.includes(b.id) && selectedIds.length===1 && (
                  <>
                    {(hoverEdge.id===b.id && hoverEdge.edge==='l') && <div className="edge-highlight l" />}
                    {(hoverEdge.id===b.id && hoverEdge.edge==='r') && <div className="edge-highlight r" />}
                    <div className="resize-handle tl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tl'); }} />
                    <div className="resize-handle tr" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tr'); }} />
                    <div className="resize-handle bl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'bl'); }} />
                    <div className="resize-handle br" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'br'); }} />
                    <div className="edge-handle l" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'l'); }} />
                    <div className="edge-handle r" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'r'); }} />
                    <div style={{position:'absolute', right:4, top:4, fontSize:12, opacity:.9}}>
                      <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                    </div>
                  </>
                )}
              </div>
            ) : b.type === 'arrow' ? (
              <svg key={b.id} style={{position:'absolute', left:0, top:0, width:'100%', height:'100%', pointerEvents:'none'}}>
                <defs>
                  <marker id={`ah-${b.id}`} markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="#ff4141" />
                  </marker>
                </defs>
                <line x1={b.x} y1={b.y} x2={b.ex} y2={b.ey}
                  stroke="#ff4141" strokeWidth={b.strokeWidth||3}
                  markerEnd={`url(#ah-${b.id})`}
                  style={{ pointerEvents: 'stroke' }}
                  onPointerDown={(e)=>{ e.stopPropagation(); onPointerDownBox(e,b.id); }}
                  onClick={(e)=>{ e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id); }}
                />
                {selectedIds.includes(b.id) && (
                  <>
                    <circle cx={b.x} cy={b.y} r={6} fill="#fff" stroke="#ff4141" strokeWidth={2} style={{pointerEvents:'all'}} onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'l'); }} />
                    <circle cx={b.ex} cy={b.ey} r={6} fill="#fff" stroke="#ff4141" strokeWidth={2} style={{pointerEvents:'all'}} onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'r'); }} />
                  </>
                )}
              </svg>
            ) : b.type === 'target' ? (
              <div key={b.id} className={`box ${selectedIds.includes(b.id)?'selected':''}`} style={{left:b.x, top:b.y, width:b.w, height:b.h}} onPointerDown={(e)=>onPointerDownBox(e,b.id)} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}}>
                <div style={{
                  position:'absolute', left:0, top:0, width:'100%', height:'100%',
                  display:'inline-flex', alignItems:'center', justifyContent:'center',
                  color:'#ff4141', border:'2px solid #ff4141', borderRadius: '9999px',
                  background:'rgba(255,255,255,0.6)', fontSize: (b.fontSize||14), fontWeight: (b.fontWeight||'bold'),
                  padding:'0 10px',
                }}
                dangerouslySetInnerHTML={{__html: `対象: ${(() => { const k=window.katex; const t=String(b.text||''); try { return k ? t.replace(/\$(.+?)\$/g, (_, expr) => { try { return k.renderToString(expr,{throwOnError:false}); } catch { return expr; } }) : t; } catch { return t; } })()}`}} />
                {selectedIds.includes(b.id) && selectedIds.length===1 && (
                  <div style={{position:'absolute', right:4, top:4, fontSize:12, opacity:.9}}>
                    <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                  </div>
                )}
              </div>
            ) : b.type === 'draw' ? (
              <svg key={b.id} style={{position:'absolute', left:0, top:0, width:'100%', height:'100%', pointerEvents:'none'}}>
                <g transform={`translate(${b.offsetX||0},${b.offsetY||0})`}>
                  <polyline
                    points={(b.points||[]).map(p=>`${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke="#ff4141"
                    strokeWidth={b.strokeWidth||3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ pointerEvents: 'stroke' }}
                    onPointerDown={(e)=>{ e.stopPropagation(); onPointerDownBox(e,b.id); }}
                    onClick={(e)=>{ e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id); }}
                  />
                </g>
              </svg>
            ) : (
              <div key={b.id} className={`box ${selectedIds.includes(b.id)?'selected':''}`} style={{left:b.x, top:b.y, width:b.w, height:b.h}} onPointerDown={(e)=>{ e.stopPropagation();
                try {
                  if (selectedIds.includes(b.id) && selectedIds.length===1) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const relX = e.clientX - rect.left;
                    const edge = 10;
                    if (relX <= edge) { onResizeDown(e, b.id, 'l'); return; }
                    if (relX >= rect.width - edge) { onResizeDown(e, b.id, 'r'); return; }
                  }
                } catch {}
                onPointerDownBox(e,b.id);
              }} onClick={(e)=>{e.stopPropagation(); (e.shiftKey||e.metaKey||e.ctrlKey)? toggleSelect(b.id) : selectOnly(b.id);}} onDoubleClick={(e)=>{ e.stopPropagation(); selectOnly(b.id); setBoxes(prev => prev.map(x => x.id===b.id ? {...x, isEditing: true} : x)); setTimeout(()=>{ try { textRefs.current[b.id]?.focus(); } catch {} }, 0); }} onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); if (b.type==='text') setFavMenu({ show:true, x: e.clientX, y: e.clientY, text: b.text || ''}); }}>
                {b.type === 'image' ? (
                  <img src={b.src} alt="img" style={{width:'100%', height:'100%', objectFit:'contain', pointerEvents:'none'}} />
                ) :
                b.isEditing ? (
                  <textarea
                    ref={el => (textRefs.current[b.id] = el)}
                    value={b.text} 
                    onPointerDown={(e)=>{ e.stopPropagation(); }}
                    onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); setFavMenu({ show:true, x: e.clientX, y: e.clientY, text: (b.text || '')}); }}
                    onChange={(e)=>{
                      updateText(b.id, e.target.value);
                      try {
                        e.target.style.height = 'auto';
                        e.target.style.height = (e.target.scrollHeight)+'px';
                        setBoxes(prev => prev.map(x => x.id===b.id ? {...x, h: Math.max(40, e.target.scrollHeight+4)} : x));
                      } catch {}
                    }}
                    style={{
                      fontSize: b.fontSize || 16,
                      fontWeight: b.fontWeight || 'normal',
                      background: 'transparent',
                      color: '#ff4141',
                      width: '100%',
                      height: '100%',
                      pointerEvents: 'auto'
                    }}
                  />
                ) : (
                  <div ref={el => (renderRefs.current[b.id] = el)} className="render-box" style={{fontSize: b.fontSize || 16, fontWeight: b.fontWeight || 'normal'}} dangerouslySetInnerHTML={{__html: renderTeX(b.text || '')}} />
                )}
                {selectedIds.includes(b.id) && selectedIds.length===1 && (
                  <>
                    <div className="resize-handle tl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tl'); }} />
                    <div className="resize-handle tr" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'tr'); }} />
                    <div className="resize-handle bl" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'bl'); }} />
                    <div className="resize-handle br" onPointerDown={(e)=>{ e.stopPropagation(); onResizeDown(e,b.id,'br'); }} />
                    <div style={{position:'absolute', right:4, top:4, fontSize:12, opacity:.9}}>
                      <button className="small-button" onPointerDown={(e)=>{e.stopPropagation();}} onClick={(e)=>{e.stopPropagation(); removeBox(b.id);}}>削除</button>
                    </div>
                  </>
                )}
              </div>
            )
          ))}
            </div>
          )}
        </div>
      </div>
      <div className="sidebar" style={{ width: rightDockWidth, marginLeft: 20 }} onClick={()=>{ if (favMenu && favMenu.show) setFavMenu({show:false, x:0, y:0, text:''}); }}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap: 8, flexWrap:'wrap'}}>
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <h4 style={{margin:0}}>{sidebarTab==='favorites' ? 'お気に入り' : 'コメント一覧（クリックで配置）'}</h4>
            <div style={{marginLeft:'auto', display:'flex', gap:6}}>
              <button className="small-button" onClick={()=>setSidebarTab('comments')} disabled={sidebarTab==='comments'}>コメント</button>
              <button className="small-button" onClick={()=>{ setSidebarTab('favorites'); fetchFavorites(); }} disabled={sidebarTab==='favorites'}>お気に入り</button>
            </div>
          </div>
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', width:'100%', justifyContent:'space-between'}}>
            <div style={{display:'flex', alignItems:'center', gap:6}}>
              <label style={{fontSize:12, color:'#374151'}}>幅</label>
              <input type="range" min="300" max="680" step="20" value={rightDockWidth} onChange={e=> setRightDockWidth(parseInt(e.target.value,10))} />
              <span style={{fontSize:12, color:'#6b7280', minWidth:48, textAlign:'right'}}>{rightDockWidth}px</span>
            </div>
            <button className="small-button" onClick={runAutoLayout} disabled={autoPlacing}>
              {autoPlacing ? 'AI自動配置中...' : 'AI自動配置(β)'}
            </button>
          </div>
        </div>
        
        {autoPlacing && (
          <div style={{ marginTop: 8, display:'flex', alignItems:'center', gap:8 }}>
            <span className="spinner" />
            <span style={{ color:'#374151' }}>AI自動配置を実行中...</span>
          </div>
        )}
        {sidebarTab==='comments' && review && review.summary && (
          <div style={{padding: '8px', margin: '0 0 12px', background: '#e0f2fe', borderRadius: 8, fontWeight: 'bold'}}>
            合計点: {review.summary.total_score} / {review.summary.max_score}
          </div>
        )}
        {sidebarTab==='comments' && (
        <div style={{marginBottom:10}}>
          {(review?.questions || []).map((q, qi) => (
            <div key={qi} style={{marginBottom:12, padding:8, background:'#fff', border:'1px solid #bae6fd', borderRadius:8}}>
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6}}>
                <div style={{fontWeight:700}}>小問 {q.id} {q.awarded ?? 0} / {q.max ?? 0}</div>
                <div style={{display:'flex', gap:6}}>
                  <button className="small-button" onClick={(e)=>{ e.stopPropagation(); setPlaceMode({ type:'qscore', payload:{ awarded:q.awarded ?? 0, max:q.max ?? 0 }}); notify('点数を置きたい位置をクリックしてください','info'); }}>点数配置</button>
                  <button className="small-button" onClick={(e)=>{ e.stopPropagation(); setPlaceMode({ type:'bulk', payload:{ qid:q.id, awarded:q.awarded ?? 0, max:q.max ?? 0, comments:q.comments || [] }}); notify('配置したい場所をクリックしてください','info'); }}>全部配置</button>
                </div>
              </div>
              {(q.comments || []).map((c, idx) => {
                const typeMap = {
                  score: { label: '加点', emoji: '➕' },
                  praise: { label: '賞賛', emoji: '✨' },
                  mistake: { label: '指摘', emoji: '⚠️' },
                  guidance: { label: '方針', emoji: '💡' },
                };
                const info = typeMap[c.type] || { label: c.type, emoji: '' };
                return (
                  <div key={idx} className="comment-item" onClick={()=> {
                    const txt = stripTargetFromText(sanitizeReviewText(c.text || ''));
                    const points = (c.type === 'score') ? (c.points ?? 1) : null;
                    if (points != null) setPlaceMode({ type: 'combo', payload: { text: txt, points } });
                    else setPlaceMode({ type: 'combo', payload: { text: txt } });
                  }}>
                    <div style={{fontWeight:'bold'}}>{info.emoji} {info.label}</div>
                    <div style={{whiteSpace:'pre-wrap', background:'#ffffff', border:'1px solid #bae6fd', borderRadius:8, padding:'6px 8px'}} dangerouslySetInnerHTML={{__html: renderTeX(c.text || '')}} />
                    <div style={{display:'flex', gap:8, marginTop:6, flexWrap:'wrap'}}>
                      {c.points != null && <span style={{background:'#eefdf3', color:'#065f46', border:'1px solid #d1fae5', borderRadius:999, padding:'2px 8px'}}>配点: {c.points}点</span>}
                      {c.target && (
                        <span style={{background:'#fff7ed', color:'#7c2d12', border:'1px solid #fed7aa', borderRadius:6, padding:'2px 8px', display:'inline-block'}} dangerouslySetInnerHTML={{__html: '対象: ' + renderTeX(c.target || '')}} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        )}
      

        {sidebarTab==='favorites' && (
          <div style={{marginTop:8}}>
            <div style={{fontWeight:700, marginBottom:6}}>お気に入り（この試験種）</div>
            {(favorites.problem||[]).length ? (
              <div style={{display:'grid', gap:6}}>
                {favorites.problem.map((f, idx)=> (
                  <div key={`pf_${idx}`} className="comment-item">
                    <div style={{whiteSpace:'pre-wrap'}} onClick={()=>{ setPlaceMode({ type:'combo', payload:{ text: f.text, ...(f.points!=null? { points: f.points } : {}) } }); notify('配置したい場所をクリックしてください','info'); }}>{f.text}</div>
                    {f.points != null && <div style={{marginTop:4}}><span style={{background:'#eefdf3', color:'#065f46', border:'1px solid #d1fae5', borderRadius:999, padding:'2px 8px'}}>配点: {f.points}点</span></div>}
                    <div style={{display:'flex', gap:6, marginTop:4}}>
                      <button className="small-button" onClick={()=>{ const t = prompt('お気に入りの本文を編集', f.text); if (t!=null) updateFavorite(f.id, t); }}>本文</button>
                      <button className="small-button" onClick={()=>{ const p = prompt('配点を入力（空欄で削除）', (f.points!=null? String(f.points): '')); if (p===null) return; if (p.trim()==='') { clearFavoritePoints(f.id); } else { updateFavoritePoints(f.id, p); } }}>配点</button>
                      <button className="small-button" onClick={()=> deleteFavorite(f.id)}>削除</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : <div style={{opacity:.7}}>なし</div>}
            <div style={{display:'flex', gap:6, marginTop:8, alignItems:'center'}}>
              <input id="fav-problem-text" type="text" placeholder="新規お気に入り（この試験種）" style={{flex:1}} onKeyDown={(e)=>{ if (e.key==='Enter') { const v = e.target.value.trim(); const p = document.getElementById('fav-problem-pts'); const pts = p ? p.value : ''; if (v) { addFavorite('problem', v, pts); e.target.value=''; if (p) p.value=''; } } }} />
              <input id="fav-problem-pts" type="number" inputMode="numeric" min="0" placeholder="配点" style={{width:80}} />
              <button className="small-button" onClick={(e)=>{ const inp = document.getElementById('fav-problem-text'); const pinp = document.getElementById('fav-problem-pts'); const v = (inp && inp.value || '').trim(); const pts = pinp ? pinp.value : ''; if (v) { addFavorite('problem', v, pts); if (inp) inp.value=''; if (pinp) pinp.value=''; } }}>追加</button>
            </div>
            <div style={{fontWeight:700, margin:'10px 0 6px'}}>お気に入り（全体）</div>
            {(favorites.global||[]).length ? (
              <div style={{display:'grid', gap:6}}>
                {favorites.global.map((f, idx)=> (
                  <div key={`gf_${idx}`} className="comment-item">
                    <div style={{whiteSpace:'pre-wrap'}} onClick={()=>{ setPlaceMode({ type:'combo', payload:{ text: f.text, ...(f.points!=null? { points: f.points } : {}) } }); notify('配置したい場所をクリックしてください','info'); }}>{f.text}</div>
                    {f.points != null && <div style={{marginTop:4}}><span style={{background:'#eefdf3', color:'#065f46', border:'1px solid #d1fae5', borderRadius:999, padding:'2px 8px'}}>配点: {f.points}点</span></div>}
                    <div style={{display:'flex', gap:6, marginTop:4}}>
                      <button className="small-button" onClick={()=>{ const t = prompt('お気に入りの本文を編集', f.text); if (t!=null) updateFavorite(f.id, t); }}>本文</button>
                      <button className="small-button" onClick={()=>{ const p = prompt('配点を入力（空欄で削除）', (f.points!=null? String(f.points): '')); if (p===null) return; if (p.trim()==='') { clearFavoritePoints(f.id); } else { updateFavoritePoints(f.id, p); } }}>配点</button>
                      <button className="small-button" onClick={()=> deleteFavorite(f.id)}>削除</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : <div style={{opacity:.7}}>なし</div>}
            <div style={{display:'flex', gap:6, marginTop:8, alignItems:'center'}}>
              <input id="fav-global-text" type="text" placeholder="新規お気に入り（全体）" style={{flex:1}} onKeyDown={(e)=>{ if (e.key==='Enter') { const v = e.target.value.trim(); const p = document.getElementById('fav-global-pts'); const pts = p ? p.value : ''; if (v) { addFavorite('global', v, pts); e.target.value=''; if (p) p.value=''; } } }} />
              <input id="fav-global-pts" type="number" inputMode="numeric" min="0" placeholder="配点" style={{width:80}} />
              <button className="small-button" onClick={(e)=>{ const inp = document.getElementById('fav-global-text'); const pinp = document.getElementById('fav-global-pts'); const v = (inp && inp.value || '').trim(); const pts = pinp ? pinp.value : ''; if (v) { addFavorite('global', v, pts); if (inp) inp.value=''; if (pinp) pinp.value=''; } }}>追加</button>
            </div>
          </div>
        )}
      </div>
      
      {/* Floating right drawer removed: docked sidebar is used */}
      {favMenu && favMenu.show && (
        <div ref={favMenuRef} style={{ position:'fixed', left: favMenu.x, top: favMenu.y, zIndex: 2147483646, background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, boxShadow:'0 4px 16px rgba(0,0,0,0.12)' }} onClick={(e)=>e.stopPropagation()} onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); }}>
          <div style={{ padding:'8px 10px', borderBottom:'1px solid #f1f5f9', fontWeight:700 }}>お気に入り登録</div>
          <button className="small-button" style={{ display:'block', width:'100%', border:'none', borderRadius:0, textAlign:'left' }} onClick={()=>{ addFavorite('problem', favMenu.text); setFavMenu({show:false,x:0,y:0,text:''}); }}>この試験種に追加</button>
          <button className="small-button" style={{ display:'block', width:'100%', border:'none', borderRadius:0, textAlign:'left' }} onClick={()=>{ const p = prompt('配点を入力（省略可）',''); addFavorite('problem', favMenu.text, p); setFavMenu({show:false,x:0,y:0,text:''}); }}>この試験種に追加（配点…）</button>
          <hr style={{margin:'6px 0', border:'none', borderTop:'1px solid #f1f5f9'}} />
          <button className="small-button" style={{ display:'block', width:'100%', border:'none', borderRadius:0, textAlign:'left' }} onClick={()=>{ addFavorite('global', favMenu.text); setFavMenu({show:false,x:0,y:0,text:''}); }}>全体に追加</button>
          <button className="small-button" style={{ display:'block', width:'100%', border:'none', borderRadius:0, textAlign:'left' }} onClick={()=>{ const p = prompt('配点を入力（省略可）',''); addFavorite('global', favMenu.text, p); setFavMenu({show:false,x:0,y:0,text:''}); }}>全体に追加（配点…）</button>
        </div>
      )}
      {signatureManagerPortal}
    </div>
  );
}

function App() {
  
  // Toast notifications (top-left)
  const [toasts, setToasts] = useState([]);
  const notify = (message, type = 'info', opts = {}) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const timeout = opts.timeout ?? (type === 'error' ? 5000 : 3000);
    const toast = { id, message, type, actions: opts.actions || null };
    setToasts(prev => [...prev, toast]);
    if (!toast.actions) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, timeout);
    }
    return id;
  };
  const dismissToast = (id) => setToasts(prev => prev.filter(t => t.id !== id));
  const confirmToast = (message, confirmLabel = 'OK', cancelLabel = 'キャンセル') => {
    return new Promise((resolve) => {
      const id = `t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const onConfirm = () => { dismissToast(id); resolve(true); };
      const onCancel  = () => { dismissToast(id); resolve(false); };
      const toast = { id, message, type: 'info', actions: [
        { label: cancelLabel, onClick: onCancel },
        { label: confirmLabel, onClick: onConfirm },
      ]};
      setToasts(prev => [...prev, toast]);
    });
  };

  const [answers, setAnswers] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const pollingIntervalRef = useRef(null);
  const [editing, setEditing] = useState(null); // filename

  const fetchAnswers = useCallback(() => {
    fetch(`${BACKEND_BASE}/answers`)
      .then(res => res.json())
      .then(data => setAnswers(data.answers.sort((a, b) => a.filename.localeCompare(b.filename))))
      .catch(err => console.error('Error fetching answers:', err));
  }, []);

  useEffect(() => {
    fetchAnswers();
  }, [fetchAnswers]);

  //ポーリングを停止する関数
  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  };

  const handleProcessStart = () => {
    setIsProcessing(true);

    // まず処理を開始するリクエストを投げる
    fetch(`${BACKEND_BASE}/process`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        // 処理完了のレスポンスが来たらポーリングを停止し、最終結果を更新
        stopPolling();
        notify(data.message || '処理が完了しました','success');
        fetchAnswers();
      })
      .catch(err => {
        stopPolling();
        notify('処理中にエラーが発生しました','error');
      })
      .finally(() => {
        setIsProcessing(false);
      });

    // リクエストを投げた直後から、2秒ごとに進捗を確認するポーリングを開始
    pollingIntervalRef.current = setInterval(() => {
      fetchAnswers();
    }, 2000);
  };

  
  const handleExport = (filename) => {
    const url = `${BACKEND_BASE}/answers/${encodeURIComponent(filename)}/export`;
    window.open(url, '_blank');
  };
  // 一括PDF出力/一括見たままPDFは削除（仕様変更）

  const handleEdit = (filename) => setEditing(filename);
  const handleCloseEditor = () => setEditing(null);

  const handleDelete = (filename) => {
    confirmToast(`${filename} を削除しますか？`, '削除', 'キャンセル').then((ok) => {
      if (!ok) return;
      fetch(`${BACKEND_BASE}/answers/${filename}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
          notify(data.message || '削除しました','success');
          fetchAnswers();
        })
        .catch(err => notify('削除中にエラーが発生しました','error'));
    });
  };

  const handleComplete = (filename) => {
    setAnswers(prev => prev.map(a => a.filename === filename ? {...a, status: '添削完了'} : a));
  };
  
  // コンポーネントがアンマウントされるときにポーリングをクリーンアップ
  useEffect(() => {
    return () => stopPolling();
  }, []);

  return (
    <div className="App">
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <div>{t.message}</div>
            {t.actions && (
              <div className="actions">
                {t.actions.map((a, i) => (
                  <button key={i} className="btn" onClick={a.onClick}>{a.label}</button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <header className="App-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img src={logo} alt="アプリロゴ" style={{ height: 40, width: "auto" }} />
          <h1 style={{ margin: 0 }}>添削AI 言の葉</h1>
        </div>
      </header>
      <main key={editing ? 'editor' : 'dashboard'} className="view-fade-in">
        {editing ? (
          <Editor filename={editing} onClose={handleCloseEditor} onAfterClose={fetchAnswers} notify={notify} onComplete={handleComplete} />
        ) : (
          <>
            <FileUploader onUploadSuccess={fetchAnswers} notify={notify} />
            <AnswerDashboard
              answers={answers}
              onProcessStart={handleProcessStart}
              isProcessing={isProcessing}
              onDelete={handleDelete}
              onEdit={handleEdit}
              onExport={handleExport}
              notify={notify}
              confirmToast={confirmToast}
              refresh={fetchAnswers}
            />
          </>
        )}
      </main>
    </div>
  );
}

export default App;
