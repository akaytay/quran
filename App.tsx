
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, Type, LiveServerMessage } from '@google/genai';
import { AppState, VerseIdentification, TranscriptionItem } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audio-helpers';
import { Visualizer } from './components/Visualizer';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionItem[]>([]);
  const [verseHistory, setVerseHistory] = useState<VerseIdentification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isVerifyingSequence, setIsVerifyingSequence] = useState<boolean>(false);

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionBufferRef = useRef<{ user: string; model: string }>({ user: '', model: '' });
  const historyEndRef = useRef<HTMLDivElement>(null);
  
  const lastVerseRef = useRef<{ surah: string; ayah: string } | null>(null);

  useEffect(() => {
    if (historyEndRef.current) {
      historyEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [verseHistory]);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    setAppState(AppState.IDLE);
    setIsVerifyingSequence(false);
  }, []);

  const startSession = useCallback(async () => {
    try {
      setError(null);
      setAppState(AppState.CONNECTING);
      setTranscriptions([]);
      setVerseHistory([]);
      lastVerseRef.current = null;
      transcriptionBufferRef.current = { user: '', model: '' };

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputNodeRef.current = outputAudioContextRef.current.createGain();
      outputNodeRef.current.connect(outputAudioContextRef.current.destination);

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setAppState(AppState.LISTENING);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNodeRef.current!);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            if (message.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.user += message.serverContent.inputTranscription.text;
            }

            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'identifyQuranVerse') {
                  const result = fc.args as unknown as VerseIdentification;
                  lastVerseRef.current = { surah: result.surahName, ayah: result.ayahNumber };
                  setIsVerifyingSequence(true);

                  setVerseHistory(prev => {
                    const isDuplicate = prev.some(v => v.surahName === result.surahName && v.ayahNumber === result.ayahNumber);
                    if (isDuplicate) return prev;
                    return [...prev, result];
                  });
                  
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                  }));
                }
              }
            }

            if (message.serverContent?.turnComplete) {
              transcriptionBufferRef.current = { user: '', model: '' };
            }
          },
          onerror: (e) => {
            setError('Stream error. This is often caused by network latency.');
            stopSession();
          },
          onclose: () => {
            setAppState(AppState.IDLE);
            setIsVerifyingSequence(false);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `You are a specialized Quran recognition engine optimized for MINIMAL LATENCY.
          
          URGENT PERFORMANCE GUIDELINE:
          - ONCE A VERSE (S, A) IS DETECTED: Immediately switch to "Next-Verse Prediction Mode".
          - "NEXT-VERSE PREDICTION MODE": For all subsequent audio, assume the user is reciting (S, A+1). Do NOT spend energy on global searching or complex reasoning. If the audio roughly matches the rhythm/text of (S, A+1), trigger 'identifyQuranVerse' for (S, A+1) IMMEDIATELY.
          - ONLY if there is a massive discrepancy (e.g., they stop, skip chapters, or speak English) should you fall back to a full search.
          - SPEED IS PARAMOUNT: It is better to detect the next verse 1 second early than 5 seconds late.
          
          ACCURACY WARNING:
          - Ensure the Ayah number is correct (e.g., Al-Inshiqaq has exactly 25 verses; don't report 22 if it's 25).
          
          STRICT RULES:
          - NEVER say "Sadakallahulaziym".
          - STAY COMPLETELY SILENT while the user recites.
          - Output Arabic transcription, English translation, and Spanish translation for every individual verse.`,
          tools: [{
            functionDeclarations: [{
              name: 'identifyQuranVerse',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  surahName: { type: Type.STRING, description: 'Surah name in English' },
                  ayahNumber: { type: Type.STRING, description: 'Correct Ayah number' },
                  transcription: { type: Type.STRING, description: 'Arabic text' },
                  translationEn: { type: Type.STRING, description: 'English translation' },
                  translationEs: { type: Type.STRING, description: 'Spanish translation' }
                },
                required: ['surahName', 'ayahNumber', 'transcription', 'translationEn', 'translationEs']
              }
            }]
          }],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      setError(err.message || 'Failed to start session.');
      setAppState(AppState.IDLE);
    }
  }, [stopSession]);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 md:py-12 flex flex-col min-h-screen">
          <div style={{ padding: 24, color: "white" }}>
      ÇALIŞIYOR ✅
    </div>
      <header className="text-center mb-8">
        <h1 className="text-4xl font-extrabold mb-2 text-amber-400 tracking-tighter uppercase drop-shadow-lg">Quran Live Stream</h1>
        <p className="text-emerald-100/60 font-medium text-sm tracking-widest">Optimized for Internet Fluctuations • Sequential Detection</p>
      </header>

      <main className="flex-grow flex flex-col gap-6">
        <div className="glass-panel rounded-3xl p-8 flex flex-col items-center justify-center gap-6 relative overflow-hidden transition-all duration-500 shadow-2xl border-white/10">
          <button
            onClick={appState === AppState.IDLE ? startSession : stopSession}
            disabled={appState === AppState.CONNECTING}
            className={`w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 transform active:scale-95 shadow-2xl border-8 ${
              appState === AppState.LISTENING 
                ? 'bg-red-500 border-red-400/30 scale-105' 
                : 'bg-emerald-600 border-emerald-400/20 hover:bg-emerald-500'
            }`}
          >
            {appState === AppState.LISTENING ? (
              <div className="w-10 h-10 bg-white rounded-lg shadow-inner" />
            ) : (
              <svg className="w-16 h-16 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 005.93 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-2.93v-2.07z" clipRule="evenodd" />
              </svg>
            )}
          </button>
          
          <div className="text-center space-y-2">
            <div className="flex items-center justify-center gap-3">
               <span className={`text-xs font-black tracking-widest uppercase transition-colors duration-500 ${appState === AppState.LISTENING ? 'text-amber-400' : 'opacity-20'}`}>
                {appState === AppState.LISTENING ? (isVerifyingSequence ? 'Predicting Next Verse' : 'Global Search Active') : 'Tap to Connect'}
              </span>
              {appState === AppState.LISTENING && (
                <div className="flex gap-1">
                  <div className="w-1 h-1 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
                  <div className="w-1 h-1 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                  <div className="w-1 h-1 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
                </div>
              )}
            </div>
            <Visualizer isActive={appState === AppState.LISTENING} />
          </div>
        </div>

        <div className="flex-grow glass-panel rounded-3xl overflow-hidden flex flex-col border border-white/5 shadow-2xl">
          <div className="bg-white/10 px-6 py-4 border-b border-white/10 flex justify-between items-center backdrop-blur-3xl">
            <h3 className="text-amber-400 font-black uppercase tracking-[0.2em] text-[10px]">Transmission Log</h3>
            <div className="flex items-center gap-3">
               <div className={`w-2 h-2 rounded-full ${appState === AppState.LISTENING ? 'bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.6)]' : 'bg-white/10'}`} />
               <span className="text-[9px] text-emerald-100/50 uppercase font-black">Fast-Path Enabled</span>
            </div>
          </div>

          <div className="flex-grow overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth scrollbar-thin scrollbar-track-transparent scrollbar-thumb-amber-400/20">
            {verseHistory.length === 0 ? (
              <div className="h-full flex items-center justify-center text-emerald-100/10 text-center px-10">
                <div className="max-w-xs flex flex-col items-center gap-6">
                  <div className="w-20 h-20 rounded-full border-2 border-dashed border-white/10 flex items-center justify-center">
                    <svg className="w-8 h-8 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                  <p className="text-base font-light tracking-wide italic leading-relaxed">System is ready. After the first verse, detection will accelerate for sequential recitation.</p>
                </div>
              </div>
            ) : (
              verseHistory.map((verse, index) => (
                <div key={`${verse.surahName}-${verse.ayahNumber}-${index}`} className="animate-in fade-in slide-in-from-bottom-6 duration-500 flex flex-col gap-5 p-6 bg-emerald-950/40 rounded-[2rem] border border-white/5 group hover:border-amber-400/30 transition-all shadow-xl backdrop-blur-sm">
                  <div className="flex justify-between items-center">
                    <span className="bg-amber-400 text-emerald-950 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-xl flex items-center gap-2">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10a7.969 7.969 0 013.5-.804c1.171 0 2.292.253 3.303.708l.286.127.286-.127A9.966 9.966 0 0114.5 14c1.255 0 2.443.29 3.5.804V4.804A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z"/></svg>
                      {verse.surahName} • {verse.ayahNumber}
                    </span>
                    <span className="text-[9px] opacity-20 font-black uppercase tracking-[0.2em]">{index + 1}nd VERSE</span>
                  </div>
                  
                  <div className="py-2">
                    <p className="arabic-text text-3xl md:text-5xl leading-[1.6] text-right text-emerald-50 group-hover:text-white transition-all drop-shadow-sm">
                      {verse.transcription}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-6 border-t border-white/5">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 opacity-30">
                        <span className="text-[9px] font-black uppercase tracking-[0.3em] text-amber-400">English</span>
                        <div className="h-[1px] flex-grow bg-white/20" />
                      </div>
                      <p className="text-emerald-50/90 text-base leading-relaxed font-medium tracking-tight decoration-amber-400/20 underline-offset-4">{verse.translationEn}</p>
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 opacity-30">
                        <span className="text-[9px] font-black uppercase tracking-[0.3em] text-amber-400">Español</span>
                        <div className="h-[1px] flex-grow bg-white/20" />
                      </div>
                      <p className="text-emerald-50/90 text-base leading-relaxed italic font-medium tracking-tight">{verse.translationEs}</p>
                    </div>
                  </div>
                </div>
              ))
            )}
            <div ref={historyEndRef} />
          </div>
        </div>

        <div className="glass-panel rounded-2xl px-6 py-5 flex items-center justify-between text-[9px] font-black uppercase tracking-[0.3em] text-emerald-100/30 border-white/5 backdrop-blur-md shadow-lg">
           <div className="flex items-center gap-5">
             <div className="flex items-center gap-2">
               <span className="opacity-40">Status:</span>
               <span className={appState === AppState.LISTENING ? 'text-green-400' : ''}>{appState}</span>
             </div>
             <div className="w-[1px] h-3 bg-white/10" />
             <div className="flex items-center gap-2">
               <span className="opacity-40">Net:</span>
               <span className="text-emerald-400/60">Streaming</span>
             </div>
           </div>
           <div className="flex items-center gap-6">
             <div className="flex items-center gap-2">
               <span className="opacity-40">Sequential:</span>
               <span className={isVerifyingSequence ? 'text-amber-400 animate-pulse' : ''}>{isVerifyingSequence ? 'Engaged' : 'Searching'}</span>
             </div>
             <div className="w-[1px] h-3 bg-white/10" />
             <span className="text-amber-400/80">{verseHistory.length} Verses Tracked</span>
           </div>
        </div>
      </main>

      {error && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-red-600/90 shadow-[0_0_40px_rgba(220,38,38,0.4)] text-white px-10 py-5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] z-50 animate-in slide-in-from-bottom-10 duration-500 backdrop-blur-xl border border-white/10">
          <div className="flex items-center gap-3">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd"/></svg>
            {error}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
