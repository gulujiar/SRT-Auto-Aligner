/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  FileText, 
  Upload, 
  Download, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle,
  FileCode,
  Table as TableIcon,
  ChevronRight,
  Split,
  Settings,
  Brain
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import mammoth from 'mammoth';

// --- Types ---
interface SubtitleEntry {
  id: string; // The SRT index (e.g. "1")
  timestamp: string; // e.g. "00:00:01,000 --> 00:00:04,000"
  content: string; // The original text content
}

interface AlignedResult {
  id: string;
  content: string;
}

interface AlignmentResponse {
  results: AlignedResult[];
  unusedFragments: string[];
}

// --- Utils ---

const parseSRT = (text: string): SubtitleEntry[] => {
  const blocks = text.trim().split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split('\n');
    const id = lines[0]?.trim();
    const timestamp = lines[1]?.trim();
    const content = lines.slice(2).join(' ').trim();
    return { id, timestamp, content };
  }).filter(item => item.id && item.timestamp);
};

const generateNewSRT = (originals: SubtitleEntry[], results: AlignedResult[]): string => {
  return originals
    .filter(entry => {
      const result = results.find(r => r.id === entry.id);
      return result && result.content.trim() !== '';
    })
    .map((entry, index) => {
      const result = results.find(r => r.id === entry.id);
      // We re-index to 1, 2, 3... for valid SRT format, 
      // but the content and timestamp remain perfectly aligned to the match.
      return `${index + 1}\n${entry.timestamp}\n${result!.content}`;
    })
    .join('\n\n');
};

// --- Component ---

export default function App() {
  const [srtEntries, setSrtEntries] = useState<SubtitleEntry[]>([]);
  const [docxText, setDocxText] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<AlignedResult[]>([]);
  const [unusedFragments, setUnusedFragments] = useState<string[]>([]);
  const [rawAiResponse, setRawAiResponse] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const [deepSeekKey, setDeepSeekKey] = useState<string>(() => localStorage.getItem('deepseek_api_key') || '');
  const [showSettings, setShowSettings] = useState(false);
  const [tempKey, setTempKey] = useState(deepSeekKey);

  const fileInputSrt = useRef<HTMLInputElement>(null);
  const fileInputDocx = useRef<HTMLInputElement>(null);

  const processSrtFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseSRT(text);
    setSrtEntries(parsed);
    setError(null);
  };

  const processDocxFile = async (file: File) => {
    try {
      if (file.name.toLowerCase().endsWith('.txt')) {
        const text = await file.text();
        setDocxText(text);
      } else {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        setDocxText(result.value);
      }
      setError(null);
    } catch (err) {
      console.error(err);
      setError('Failed to read document file');
    }
  };

  const handleSrtUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processSrtFile(file);
  };

  const handleDocxUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processDocxFile(file);
  };

  const handleFileDrop = async (e: React.DragEvent, type: 'srt' | 'docx') => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    if (type === 'srt') {
      if (file.name.toLowerCase().endsWith('.srt')) {
        await processSrtFile(file);
      } else {
        setError('请拖入有效的 .srt 文件');
      }
    } else {
      if (file.name.toLowerCase().endsWith('.docx') || file.name.toLowerCase().endsWith('.txt')) {
        await processDocxFile(file);
      } else {
        setError('请拖入有效的 .docx 或 .txt 文件');
      }
    }
  };

  const handleAlign = async () => {
    if (srtEntries.length === 0 || !docxText) {
      setError('Please upload both SRT and DOCX files first');
      return;
    }

    setIsLoading(true);
    setResults([]);
    setUnusedFragments([]);
    setRawAiResponse('');
    setError(null);

    const srtSummary = srtEntries.map(e => `[ID:${e.id}] ${e.content}`).join('\n');
    const prompt = `你是一位专业的字幕对齐专家。
目标：将 [新文稿docx] 的内容填充到 [原始SRT字幕] 对应的序号中。

输入：
1. 原始SRT列表：包含序号和原始内容。你需要理解内容语义。
2. 新文稿docx：这是之后需要配音的新内容。

规则：
- 严格保持原始序号（ID）。不合并，不拆分序号。
- 根据语义，将docx中的内容映射到对应的SRT序号。
- 如果一段文稿在语义上对应多个SRT序号，你可以将文稿拆分成多个短句填入。
- 如果某SRT序号在docx中没有对应的语义内容（即不需要读了），则该序号的content返回空字符串 ""。
- "对应句子，而不是替换"：即使原字幕读了，但docx里没有相同语义的部分，也不要强行生造，只需返回序号并将内容置空。
- 重要：将docx中完全没有被分配到任何SRT ID的文本片段（可能是多出的句子或废话）单独列在 "unusedFragments" 数组中。
- 必须返回 JSON 对象格式，包含 "results" 数组和 "unusedFragments" 数组。

原始SRT：
${srtSummary}

新文稿docx：
${docxText}
`;

    try {
      let responseText = '';

      if (deepSeekKey) {
        // Use DeepSeek API
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${deepSeekKey}`
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: 'You are a professional subtitle alignment expert.' },
              { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData?.error?.message || 'DeepSeek API error');
        }

        const data = await response.json();
        responseText = data.choices[0].message.content;
      } else {
        // Use Gemini API
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                results: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      content: { type: Type.STRING }
                    },
                    required: ["id", "content"]
                  }
                },
                unusedFragments: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                }
              },
              required: ["results", "unusedFragments"]
            }
          }
        });
        responseText = response.text || '{"results":[], "unusedFragments":[]}';
      }

      setRawAiResponse(responseText);
      const parsed: AlignmentResponse = JSON.parse(responseText);
      setResults(parsed.results);
      setUnusedFragments(parsed.unusedFragments);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'AI alignment failed');
    } finally {
      setIsLoading(false);
    }
  };

  const saveDeepSeekKey = () => {
    setDeepSeekKey(tempKey);
    localStorage.setItem('deepseek_api_key', tempKey);
    setShowSettings(false);
  };

  const downloadSrt = () => {
    if (results.length === 0) return;
    const srtBlob = generateNewSRT(srtEntries, results);
    const blob = new Blob([srtBlob], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aligned_subtitle_${new Date().getTime()}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // --- Drag and Drop Logic ---

  const [draggingFragment, setDraggingFragment] = useState<{content: string, index: number} | null>(null);

  const onDragStart = (content: string, index: number) => {
    setDraggingFragment({ content, index });
  };

  const onDrop = (id: string) => {
    if (!draggingFragment) return;
    
    // Update results
    setResults(prev => {
      const existing = prev.find(r => r.id === id);
      if (existing) {
        const existingTrimmed = existing.content.trim();
        const newContent = existingTrimmed 
          ? `${existingTrimmed} ${draggingFragment.content}` 
          : draggingFragment.content;
        return prev.map(r => r.id === id ? { ...r, content: newContent } : r);
      } else {
        return [...prev, { id, content: draggingFragment.content }];
      }
    });

    // Remove from unused
    setUnusedFragments(prev => prev.filter((_, i) => i !== draggingFragment.index));
    setDraggingFragment(null);
  };

  const handleManualEdit = (id: string, newContent: string) => {
    setResults(prev => {
      const existing = prev.find(r => r.id === id);
      if (existing) {
        return prev.map(r => r.id === id ? { ...r, content: newContent } : r);
      } else {
        return [...prev, { id, content: newContent }];
      }
    });
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault(); // Allow drop
  };

  const removeFromResults = (id: string, content: string) => {
    setResults(prev => prev.map(r => r.id === id ? { ...r, content: '' } : r));
    setUnusedFragments(prev => [...prev, content]);
  };

  return (
    <div className="min-h-screen h-screen flex flex-col bg-brand-bg text-brand-text">
      
      {/* Header */}
      <header className="h-[60px] bg-white border-b border-brand-border flex items-center px-6 justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-extrabold text-[18px] tracking-tighter">
            SRT <span className="text-brand-primary leading-none">Auto-Aligner</span>
          </span>
          <span className="ml-3 text-[12px] text-brand-secondary hidden md:block">
            AI 驱动的字幕语义对齐系统
          </span>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="relative">
             <button 
                onClick={() => setShowSettings(!showSettings)}
                className={`p-2 rounded-md transition-all ${deepSeekKey ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' : 'text-slate-500 hover:bg-slate-100'}`}
                title="DeepSeek API 设置"
              >
                <Settings className="w-5 h-5" />
              </button>

              <AnimatePresence>
                {showSettings && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    className="absolute right-0 mt-2 w-72 bg-white border border-brand-border rounded-lg shadow-xl z-[100] p-4"
                  >
                    <h4 className="text-[13px] font-bold mb-3 flex items-center gap-2">
                       <Brain className="w-4 h-4 text-indigo-500" />
                       DeepSeek 设置
                    </h4>
                    <p className="text-[11px] text-slate-500 mb-4 leading-relaxed">
                      设置 DeepSeek API Key 后，系统将自动切换为使用 DeepSeek 引擎进行对齐（更加精准且支持长文本）。
                    </p>
                    <div className="space-y-3">
                       <div>
                         <label className="block text-[11px] font-bold text-slate-600 mb-1">API KEY</label>
                         <input 
                           type="password" 
                           value={tempKey}
                           onChange={(e) => setTempKey(e.target.value)}
                           placeholder="sk-..."
                           className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[12px] focus:ring-1 focus:ring-indigo-500 outline-none"
                         />
                       </div>
                       <div className="flex gap-2 pt-2">
                         <button 
                           onClick={saveDeepSeekKey}
                           className="flex-1 px-3 py-2 bg-indigo-600 text-white rounded text-[12px] font-medium hover:bg-indigo-700 transition-colors"
                         >
                           保存并启用
                         </button>
                         <button 
                           onClick={() => {
                             setTempKey('');
                             setDeepSeekKey('');
                             localStorage.removeItem('deepseek_api_key');
                             setShowSettings(false);
                           }}
                           className="px-3 py-2 bg-slate-100 text-slate-600 rounded text-[12px] font-medium hover:bg-slate-200 transition-colors"
                         >
                           清空
                         </button>
                       </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
          </div>

          {(srtEntries.length > 0 || docxText) && (
             <button 
              onClick={() => {
                setSrtEntries([]);
                setDocxText('');
                setResults([]);
                setRawAiResponse('');
                setError(null);
              }}
              className="px-4 py-2 border border-slate-300 bg-transparent text-[13px] rounded-md font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              重新上传
            </button>
          )}
          {results.length > 0 ? (
            <button 
              onClick={downloadSrt}
              className="px-4 py-2 bg-brand-primary text-white text-[13px] rounded-md font-medium hover:bg-brand-primary/90 transition-all shadow-sm"
            >
              导出对齐后 SRT
            </button>
          ) : (
            <button 
              onClick={handleAlign}
              disabled={isLoading || srtEntries.length === 0 || !docxText}
              className="px-4 py-2 bg-brand-primary text-white text-[13px] rounded-md font-medium disabled:bg-slate-300 disabled:cursor-not-allowed hover:bg-brand-primary/90 transition-all shadow-sm flex items-center gap-2"
            >
              {isLoading && <RefreshCw className="w-3 h-3 animate-spin" />}
              {isLoading ? '对齐中...' : '开始语义对齐'}
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden p-4 gap-4">
        
        {/* Workspace Panel */}
        <div className="flex-1 flex flex-col bg-white border border-brand-border rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-brand-panel-header border-b border-brand-border flex items-center justify-between flex-shrink-0">
            <h2 className="text-[13px] font-semibold flex items-center gap-2">
              <TableIcon className="w-4 h-4 text-brand-primary" />
              字幕对齐工作区
            </h2>
            <div className="flex gap-4">
              {srtEntries.length > 0 && <span className="text-[11px] text-brand-secondary">条目数: {srtEntries.length}</span>}
              {results.length > 0 && <span className="text-[11px] text-brand-secondary">对齐完成</span>}
            </div>
          </div>

          <div className="flex-1 overflow-auto bg-white">
            {srtEntries.length === 0 || !docxText ? (
              <div className="h-full flex items-center justify-center p-8">
                <div className="max-w-2xl w-full grid grid-cols-1 md:grid-cols-2 gap-8">
                  
                  {/* Upload Dropzones */}
                  <div 
                    onClick={() => fileInputSrt.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => handleFileDrop(e, 'srt')}
                    className={`p-10 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${srtEntries.length > 0 ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 hover:border-brand-primary hover:bg-slate-50'}`}
                  >
                    <input type="file" accept=".srt" ref={fileInputSrt} onChange={handleSrtUpload} className="hidden" />
                    <FileCode className={`w-12 h-12 mb-4 ${srtEntries.length > 0 ? 'text-brand-primary' : 'text-slate-300'}`} />
                    <span className="text-sm font-semibold text-slate-700">1. 上传原始 SRT</span>
                    <p className="text-[11px] text-slate-400 mt-2 text-center">点击或拖入录制的原始字幕文件</p>
                    {srtEntries.length > 0 && <CheckCircle2 className="w-5 h-5 text-emerald-500 mt-3" />}
                  </div>

                  <div 
                    onClick={() => fileInputDocx.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => handleFileDrop(e, 'docx')}
                    className={`p-10 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${docxText ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 hover:border-brand-primary hover:bg-slate-50'}`}
                  >
                    <input type="file" accept=".docx,.txt" ref={fileInputDocx} onChange={handleDocxUpload} className="hidden" />
                    <FileText className={`w-12 h-12 mb-4 ${docxText ? 'text-brand-primary' : 'text-slate-300'}`} />
                    <span className="text-sm font-semibold text-slate-700">2. 上传更新 DOCX / TXT</span>
                    <p className="text-[11px] text-slate-400 mt-2 text-center">点击或拖入精修后的文稿文件</p>
                    {docxText && <CheckCircle2 className="w-5 h-5 text-emerald-500 mt-3" />}
                  </div>

                </div>
              </div>
            ) : (
              <table className="w-full border-collapse font-sans text-[12px]">
                <thead className="sticky top-0 bg-brand-bg z-10">
                  <tr>
                    <th className="w-[60px] text-left px-4 py-3 border-b border-brand-border text-brand-secondary font-bold uppercase tracking-wider">#</th>
                    <th className="text-left px-4 py-3 border-b border-brand-border text-brand-secondary font-bold w-[45%]">原始 SRT 内容 (旧)</th>
                    <th className="text-left px-4 py-3 border-b border-brand-border text-brand-secondary font-bold w-[45%]">语义匹配 DOCX 内容 (新)</th>
                    <th className="text-left px-4 py-3 border-b border-brand-border text-brand-secondary font-bold">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {srtEntries.map((entry) => {
                    const matched = results.find(r => r.id === entry.id);
                    const hasMatch = matched && matched.content.trim() !== '';
                    return (
                      <tr key={entry.id} className={`${results.length > 0 && hasMatch ? 'bg-blue-50/20' : ''} hover:bg-slate-50 transition-colors`}>
                        <td className="px-4 py-3 text-slate-400 font-bold font-mono align-top">{entry.id}</td>
                        <td className="px-4 py-3 text-slate-500 leading-relaxed align-top">{entry.content}</td>
                        <td 
                          className={`px-4 py-3 text-slate-900 font-medium leading-relaxed align-top transition-all ${draggingFragment ? 'bg-orange-50/50 outline-2 outline-dashed outline-orange-200 -outline-offset-2' : ''}`}
                          onDragOver={onDragOver}
                          onDrop={() => onDrop(entry.id)}
                        >
                          {results.length > 0 ? (
                            <div className="flex justify-between items-start group min-h-[1.5em]">
                              <textarea
                                value={matched?.content || ''}
                                onChange={(e) => handleManualEdit(entry.id, e.target.value)}
                                placeholder={draggingFragment ? "松开以追加内容" : "点击进行修改或拖拽入内容"}
                                className="w-full bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-brand-primary/30 rounded resize-none p-0 overflow-hidden font-medium text-[12px] leading-relaxed placeholder:text-slate-300 placeholder:italic"
                                rows={2}
                              />
                              {hasMatch && (
                                <button 
                                  onClick={() => removeFromResults(entry.id, matched.content)}
                                  className="ml-2 opacity-0 group-hover:opacity-100 p-1 hover:bg-slate-200 rounded transition-all text-slate-400 flex-shrink-0"
                                  title="返回待分配"
                                >
                                  <RefreshCw className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-200 italic">等待匹配...</span>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          {results.length > 0 ? (
                            hasMatch ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-md bg-[#DEF7EC] text-[#03543F] font-bold">已对齐</span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 font-bold">忽略内容</span>
                            )
                          ) : (
                            <span className="text-[10px] text-slate-300">待处理</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* AI Log Panel */}
        <aside className="w-[320px] flex flex-col gap-4 flex-shrink-0 overflow-hidden">
          
          {/* Unused Fragments Panel */}
          <div className="flex-[2] flex flex-col bg-white border border-brand-border rounded-lg shadow-sm overflow-hidden min-h-[250px]">
             <div className="px-4 py-3 bg-brand-panel-header border-b border-brand-border flex items-center justify-between flex-shrink-0">
                <h3 className="text-[13px] font-semibold flex items-center gap-2">
                  <Split className="w-3.5 h-3.5 text-orange-500" />
                  未分配片段 (拖拽对齐)
                </h3>
             </div>
             <div className="flex-1 overflow-auto p-3 space-y-2">
                {unusedFragments.length > 0 ? (
                  unusedFragments.map((fragment, idx) => (
                    <div 
                      key={idx}
                      draggable
                      onDragStart={() => onDragStart(fragment, idx)}
                      className="p-3 bg-slate-50 border border-slate-200 rounded-md text-[11px] text-slate-700 cursor-grab active:cursor-grabbing hover:bg-orange-50 hover:border-orange-200 transition-all shadow-sm"
                    >
                      {fragment}
                    </div>
                  ))
                ) : (
                  <div className="h-full flex items-center justify-center text-[11px] text-slate-400 italic text-center p-4">
                    {results.length > 0 ? '所有文稿均已分配' : '对齐后将在此显示未使用的片段'}
                  </div>
                )}
             </div>
          </div>

          {/* AI Log Panel */}
          <div className="flex-[3] flex flex-col bg-white border border-brand-border rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-brand-panel-header border-b border-brand-border flex-shrink-0">
              <h3 className="text-[13px] font-semibold">AI 原始返回日志 (JSON)</h3>
            </div>
            <div className="flex-1 overflow-auto bg-[#1E293B]">
              {rawAiResponse ? (
                <div className="p-4 font-mono text-[11px] leading-relaxed text-[#94A3B8] whitespace-pre-wrap">
                  {rawAiResponse}
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-slate-500 font-mono text-[11px] p-6 text-center italic">
                  {isLoading ? '正在进行语义化背景推理...' : '准备就绪 - 等待对齐开始'}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-brand-border text-[11px] text-brand-secondary bg-slate-50">
              <div className="flex justify-between mb-2">
                <span>处理引擎: {deepSeekKey ? 'DeepSeek-Chat' : 'Gemini 3.1 Pro'}</span>
                <span>{deepSeekKey ? '深度对齐' : '智能对齐'}</span>
              </div>
              <div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden">
                 {isLoading && (
                   <motion.div 
                      initial={{ width: "0%" }}
                      animate={{ width: "100%" }}
                      transition={{ duration: 25, ease: "linear" }}
                      className="h-full bg-brand-primary"
                   />
                 )}
                 {!isLoading && results.length > 0 && <div className="h-full bg-emerald-500 w-full" />}
              </div>
            </div>
          </div>
        </aside>

      </div>

      {/* Error Toast */}
      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 p-4 bg-red-600 text-white rounded-lg shadow-xl flex items-center gap-3"
          >
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm font-semibold">{error}</span>
            <button onClick={() => setError(null)} className="ml-2 bg-white/20 hover:bg-white/30 p-1 rounded">
              <RefreshCw className="w-3 h-3" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
