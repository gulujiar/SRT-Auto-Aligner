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
  const [volcKey, setVolcKey] = useState<string>(() => localStorage.getItem('volc_api_key') || '');
  const [volcModel, setVolcModel] = useState<string>(() => localStorage.getItem('volc_model_id') || 'ark-code-latest');
  const [volcBaseUrl, setVolcBaseUrl] = useState<string>(() => localStorage.getItem('volc_base_url') || 'https://ark.cn-beijing.volces.com/api/coding/v3');
  const [activeProvider, setActiveProvider] = useState<'gemini' | 'deepseek' | 'volc'>(() => {
    const stored = localStorage.getItem('active_provider');
    if (stored === 'deepseek' || stored === 'volc') return stored;
    return 'gemini';
  });

  const [showSettings, setShowSettings] = useState(false);
  const [tempDeepSeekKey, setTempDeepSeekKey] = useState(deepSeekKey);
  const [tempVolcKey, setTempVolcKey] = useState(volcKey);
  const [tempVolcModel, setTempVolcModel] = useState(volcModel);
  const [tempVolcBaseUrl, setTempVolcBaseUrl] = useState(volcBaseUrl);
  const [settingsTab, setSettingsTab] = useState<'deepseek' | 'volc'>('deepseek');

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

      if (activeProvider === 'deepseek' && deepSeekKey) {
        // Use Proxy for DeepSeek API
        const response = await fetch('/api/proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: 'https://api.deepseek.com/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${deepSeekKey}`
            },
            body: {
              model: 'deepseek-chat',
              messages: [
                { role: 'system', content: 'You are a professional subtitle alignment expert. You always return full, valid JSON. If the content is too long, prioritize essential results.' },
                { role: 'user', content: prompt }
              ],
              response_format: { type: 'json_object' },
              max_tokens: 8192
            }
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData?.error || errData?.details || 'DeepSeek API error');
        }

        const data = await response.json();
        responseText = data.choices[0].message.content;
      } else if (activeProvider === 'volc' && volcKey) {
        // Use Proxy for Volcano Engine (Ark) API
        const baseUrl = volcBaseUrl.endsWith('/') ? volcBaseUrl.slice(0, -1) : volcBaseUrl;
        
        // Some Ark models do not support response_format: { type: 'json_object' }
        // We will pass it but wrap in a try-catch for the specific error if it happens
        // Note: For 'coding' models, it's safer to rely on the prompt for JSON
        const response = await fetch('/api/proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: `${baseUrl}/chat/completions`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${volcKey}`
            },
            body: {
              model: volcModel,
              messages: [
                { role: 'system', content: 'You are a professional subtitle alignment expert. You must ALWAYS return a valid JSON object.' },
                { role: 'user', content: prompt }
              ],
              // Remove response_format for Volc as it's often not supported on coding models
              // and can cause 400 errors.
              temperature: 0.1,
              max_tokens: 8192
            }
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          const detail = errData?.error?.message || errData?.error || errData?.details || '火山引擎 API 错误';
          throw new Error(detail);
        }

        const data = await response.json();
        responseText = data.choices[0].message.content;
        
        // Sanitize responseText if it contains markdown code blocks
        if (responseText.includes('```json')) {
          responseText = responseText.split('```json')[1].split('```')[0].trim();
        } else if (responseText.includes('```')) {
          responseText = responseText.split('```')[1].split('```')[0].trim();
        }
      } else {
        // Use Gemini API
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
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
      
      let parsed: AlignmentResponse;
      try {
        parsed = JSON.parse(responseText);
      } catch (jsonErr) {
        console.error('JSON Parse Error:', jsonErr);
        // Attempt to fix simple truncation (experimental)
        if (responseText.trim().endsWith(',') || responseText.trim().endsWith('}')) {
           throw new Error('AI 返回内容不完整（可能触发了 Token 限制）。请尝试分段处理文稿，或换用支持更长上下文的模型。');
        }
        throw new Error('解析 AI 回复失败，格式不正确或被截断。');
      }

      // Normalize IDs to strings to match SubtitleEntry.id
      const normalizedResults = (parsed.results || []).map(r => ({
        ...r,
        id: String(r.id)
      }));

      setResults(normalizedResults);
      setUnusedFragments(parsed.unusedFragments || []);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'AI alignment failed');
    } finally {
      setIsLoading(false);
    }
  };

  const saveSettings = () => {
    // DeepSeek
    setDeepSeekKey(tempDeepSeekKey);
    localStorage.setItem('deepseek_api_key', tempDeepSeekKey);

    // Volc
    setVolcKey(tempVolcKey);
    setVolcModel(tempVolcModel);
    setVolcBaseUrl(tempVolcBaseUrl);
    localStorage.setItem('volc_api_key', tempVolcKey);
    localStorage.setItem('volc_model_id', tempVolcModel);
    localStorage.setItem('volc_base_url', tempVolcBaseUrl);

    // Logic to auto-switch provider if key is newly set and others aren't
    if (tempDeepSeekKey && !deepSeekKey) {
      setActiveProvider('deepseek');
      localStorage.setItem('active_provider', 'deepseek');
    } else if (tempVolcKey && !volcKey) {
      setActiveProvider('volc');
      localStorage.setItem('active_provider', 'volc');
    }

    setShowSettings(false);
  };

  const switchProvider = (provider: 'gemini' | 'deepseek' | 'volc') => {
    setActiveProvider(provider);
    localStorage.setItem('active_provider', provider);
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
                className={`p-2 rounded-md transition-all ${(deepSeekKey || volcKey) ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' : 'text-slate-500 hover:bg-slate-100'}`}
                title="AI 引擎设置"
              >
                <Settings className="w-5 h-5" />
              </button>

              <AnimatePresence>
                {showSettings && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    className="absolute right-0 mt-2 w-80 bg-white border border-brand-border rounded-lg shadow-xl z-[100] overflow-hidden"
                  >
                    <div className="px-4 py-3 bg-brand-panel-header border-b border-brand-border flex items-center justify-between">
                      <h4 className="text-[13px] font-bold flex items-center gap-2">
                         <Settings className="w-4 h-4 text-slate-500" />
                         AI 引擎配置
                      </h4>
                    </div>

                    <div className="flex border-b border-brand-border">
                       <button 
                         onClick={() => setSettingsTab('deepseek')}
                         className={`flex-1 py-2 text-[11px] font-bold transition-colors ${settingsTab === 'deepseek' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-500 hover:bg-slate-50'}`}
                       >
                         DeepSeek
                       </button>
                       <button 
                         onClick={() => setSettingsTab('volc')}
                         className={`flex-1 py-2 text-[11px] font-bold transition-colors ${settingsTab === 'volc' ? 'text-orange-600 border-b-2 border-orange-600' : 'text-slate-500 hover:bg-slate-50'}`}
                       >
                         火山引擎 (Ark)
                       </button>
                    </div>

                    <div className="p-4 space-y-4">
                       {settingsTab === 'deepseek' ? (
                         <div className="space-y-3">
                            <p className="text-[11px] text-slate-500 leading-relaxed italic">
                              DeepSeek 引擎在语义理解和长文本分析上具有极高性能。
                            </p>
                            <div>
                              <label className="block text-[11px] font-bold text-slate-600 mb-1">DeepSeek API KEY</label>
                              <input 
                                type="password" 
                                value={tempDeepSeekKey}
                                onChange={(e) => setTempDeepSeekKey(e.target.value)}
                                placeholder="sk-..."
                                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[12px] focus:ring-1 focus:ring-indigo-500 outline-none"
                              />
                            </div>
                            <button 
                              onClick={() => switchProvider('deepseek')}
                              disabled={!tempDeepSeekKey && !deepSeekKey}
                              className={`w-full py-2 rounded text-[11px] font-bold transition-all ${activeProvider === 'deepseek' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                              {activeProvider === 'deepseek' ? '当前正在使用' : '切换为此引擎'}
                            </button>
                         </div>
                       ) : (
                         <div className="space-y-3">
                            <p className="text-[11px] text-slate-500 leading-relaxed italic">
                              火山引擎 (方舟) 提供稳定的企业级大模型服务。
                              <br/>
                              <span className="text-orange-600 font-bold">提示：Coding 模式支持直接使用模型名称</span>
                            </p>
                            <div>
                               <label className="block text-[11px] font-bold text-slate-600 mb-1">Base URL</label>
                               <input 
                                 type="text" 
                                 value={tempVolcBaseUrl}
                                 onChange={(e) => setTempVolcBaseUrl(e.target.value)}
                                 placeholder="https://ark.cn-beijing.volces.com/api/coding/v3"
                                 className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[12px] focus:ring-1 focus:ring-orange-500 outline-none"
                               />
                            </div>
                            <div>
                               <label className="block text-[11px] font-bold text-slate-600 mb-1">Ark API KEY</label>
                               <input 
                                 type="password" 
                                 value={tempVolcKey}
                                 onChange={(e) => setTempVolcKey(e.target.value)}
                                 placeholder="API Key"
                                 className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[12px] focus:ring-1 focus:ring-orange-500 outline-none"
                               />
                            </div>
                            <div>
                               <label className="block text-[11px] font-bold text-slate-600 mb-1">模型名称 (Model ID)</label>
                               <input 
                                 type="text" 
                                 value={tempVolcModel}
                                 onChange={(e) => setTempVolcModel(e.target.value)}
                                 placeholder="例如 ark-code-latest"
                                 className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[12px] focus:ring-1 focus:ring-orange-500 outline-none"
                               />
                            </div>
                            <button 
                              onClick={() => switchProvider('volc')}
                              disabled={!tempVolcKey && !volcKey}
                              className={`w-full py-2 rounded text-[11px] font-bold transition-all ${activeProvider === 'volc' ? 'bg-orange-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                              {activeProvider === 'volc' ? '当前正在使用' : '切换为此引擎'}
                            </button>
                         </div>
                       )}

                       <div className="pt-2 border-t border-brand-border flex flex-col gap-2">
                          <button 
                            onClick={() => switchProvider('gemini')}
                            className={`w-full py-2 rounded text-[11px] font-bold transition-all ${activeProvider === 'gemini' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                          >
                            {activeProvider === 'gemini' ? '当前使用 Gemini (默认)' : '切换回 Gemini (默认)'}
                          </button>
                          
                          <div className="flex gap-2">
                            <button 
                              onClick={saveSettings}
                              className="flex-1 px-3 py-2 bg-slate-800 text-white rounded text-[12px] font-medium hover:bg-slate-900 transition-colors"
                            >
                              保存所有更改
                            </button>
                            <button 
                              onClick={() => {
                                setTempDeepSeekKey('');
                                setDeepSeekKey('');
                                setTempVolcKey('');
                                setVolcKey('');
                                localStorage.removeItem('deepseek_api_key');
                                localStorage.removeItem('volc_api_key');
                                setActiveProvider('gemini');
                                localStorage.setItem('active_provider', 'gemini');
                                setShowSettings(false);
                              }}
                              className="px-3 py-2 bg-red-50 text-red-600 rounded text-[12px] font-medium hover:bg-red-100 transition-colors"
                            >
                              清空
                            </button>
                          </div>
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
          {results.length > 0 && !isLoading && (
            <button 
              onClick={handleAlign}
              className="px-4 py-2 bg-slate-100 text-slate-700 text-[13px] rounded-md font-medium hover:bg-slate-200 transition-all flex items-center gap-2 border border-slate-200"
            >
              <RefreshCw className="w-3 h-3" />
              重新对齐
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
                <span>处理引擎: {
                  activeProvider === 'deepseek' ? 'DeepSeek-Chat' : 
                  activeProvider === 'volc' ? '火山引擎 (Ark)' : 
                  'Gemini 3.1 Pro'
                }</span>
                <span>{activeProvider !== 'gemini' ? '深度对齐' : '智能对齐'}</span>
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
            <div className="flex items-center gap-2 ml-4">
              <button 
                onClick={() => {
                  setError(null);
                  handleAlign();
                }} 
                className="bg-white text-red-600 px-3 py-1 rounded text-xs font-bold hover:bg-white/90 transition-colors"
              >
                重试
              </button>
              <button onClick={() => setError(null)} className="bg-white/20 hover:bg-white/30 p-1.5 rounded transition-colors">
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
