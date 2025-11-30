// Microtonal Touch Grid

/* ====== グローバル変数（DOM参照は init 内で代入） ====== */
let errEl;
let mainModeEls, scaleModeEls;
let soundSelectEl, octDownBtn, octUpBtn, octLabelEl;
let recordBtn, recordStatus, clearRecsBtn, fsBtn;
let gridEl, noteRowEl, centLabelsEl, recordingsSec, hudEl;

/* ====== 音階定義 ====== */
const NOTE_NAMES_7  = ["C","D","E","F","G","A","B"];
const NOTE_STEPS_7  = [0,2,4,5,7,9,11];
const NOTE_NAMES_12 = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTE_STEPS_12 = [0,1,2,3,4,5,6,7,8,9,10,11];

/* ====== Audio 関係 ====== */
let audioCtx=null, masterGain=null, comp=null;
let useWorklet=false, recorderNode=null, scriptNode=null;
let osc=null, gainNode=null, currentNoteInfo=null;
let chordVoices = new Map(); // step -> {osc,gain,cents}
let octaveOffset = 0;
let isPointerDown=false;

let isRecording=false, recLeft=null, recRight=null, recSR=48000, recCount=0;

const CENT_MIN=-100, CENT_MAX=100;

/* ====== 共通エラー表示 ====== */
function showErr(msg){
  if (errEl) errEl.textContent = `⚠ ${msg}`;
  console.error(msg);
}

/* ====== Worklet ソース作成 ====== */
function createRecorderWorkletURL() {
  const code = `
    class RecorderProcessor extends AudioWorkletProcessor {
      constructor(){
        super();
        this.isRecording = false;
        this._L = new Float32Array(0);
        this._R = new Float32Array(0);
        this.port.onmessage = (e)=>{
          if(e.data === 'rec-start'){
            this.isRecording = true;
            this._L = new Float32Array(0);
            this._R = new Float32Array(0);
          } else if(e.data === 'rec-stop'){
            this.isRecording = false;
            this.port.postMessage(
              { type:'dump', left:this._L, right:this._R },
              [this._L.buffer, this._R.buffer]
            );
            this._L = new Float32Array(0);
            this._R = new Float32Array(0);
          }
        };
      }
      _append(dst, src){
        const out = new Float32Array(dst.length + src.length);
        out.set(dst, 0); out.set(src, dst.length);
        return out;
      }
      process(inputs, outputs){
        const input = inputs[0], output = outputs[0];
        for (let ch=0; ch<output.length; ch++){
          if (input[ch]) output[ch].set(input[ch]);
        }
        if (this.isRecording && input[0]){
          const L = input[0], R = input[1] || input[0];
          this._L = this._append(this._L, L);
          this._R = this._append(this._R, R);
        }
        return true;
      }
    }
    registerProcessor('recorder-processor', RecorderProcessor);
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

/* ====== 初期化 ====== */
function init(){
  // --- DOM をここでまとめて取得 ---
  errEl          = document.getElementById('err');
  mainModeEls    = document.querySelectorAll('input[name="mainMode"]');
  scaleModeEls   = document.querySelectorAll('input[name="scaleMode"]');
  soundSelectEl  = document.getElementById("sound-select");
  octDownBtn     = document.getElementById("oct-down");
  octUpBtn       = document.getElementById("oct-up");
  octLabelEl     = document.getElementById("oct-label");
  recordBtn      = document.getElementById("record-btn");
  recordStatus   = document.getElementById("record-status");
  clearRecsBtn   = document.getElementById("clear-recs");
  fsBtn          = document.getElementById("fs-btn");
  gridEl         = document.getElementById("pitch-grid");
  noteRowEl      = document.getElementById("note-label-row");
  centLabelsEl   = document.getElementById("cent-labels");
  recordingsSec  = document.getElementById("recordings");
  hudEl          = document.getElementById("touch-hud");

  if (!gridEl || !noteRowEl){
    showErr("pitch-grid か note-label-row が見つかりません。HTMLのIDを確認してください。");
    return;
  }

  buildGrid();
  attachEvents();
  updatePanels();
  updateOct();
  updateRecUI();

  // モバイル：最初のタッチで AudioContext 解錠
  window.addEventListener('touchstart', async function unlockOnce(){
    try{ await ensureAudio(); await audioCtx.resume(); }
    catch(e){ showErr(`Audio unlock失敗: ${e?.message||e}`); }
    window.removeEventListener('touchstart', unlockOnce, {passive:true});
  }, {passive:true});
}

// DOM 構築完了後に init 実行
window.addEventListener('DOMContentLoaded', init);

/* ====== モード / スケール ====== */
function getMainMode(){
  const r = Array.from(mainModeEls).find(x=>x.checked);
  return r ? r.value : 'grid';
}
function getScaleDefs(){
  const r = Array.from(scaleModeEls).find(x=>x.checked);
  const mode = r ? r.value : '12';
  return mode === '7'
    ? { names: NOTE_NAMES_7,  steps: NOTE_STEPS_7  }
    : { names: NOTE_NAMES_12, steps: NOTE_STEPS_12 };
}
function updatePanels(){
  const mode = getMainMode();
  // 12平均律モードではセン値ラベルを隠す
  if (centLabelsEl) centLabelsEl.hidden = (mode === 'tet12');
  stopNote();
  stopAllChord();
  hudHide();
}

/* ====== グリッド生成 ====== */
function buildGrid(){
  const {names} = getScaleDefs();
  gridEl.innerHTML = '';
  noteRowEl.innerHTML = '';
  names.forEach(name=>{
    const col = document.createElement('div');
    col.className = 'note-column';
    gridEl.appendChild(col);
    const label = document.createElement('div');
    label.className = 'note-name';
    label.textContent = name;
    noteRowEl.appendChild(label);
  });
}

/* ====== Audio Graph 構築 ====== */
async function ensureAudio(){
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(!masterGain){
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.6;

    comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    recSR = audioCtx.sampleRate;

    try{
      if(audioCtx.audioWorklet){
        const url = createRecorderWorkletURL();
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        recorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor',
          { numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[2] });

        masterGain.connect(comp);
        comp.connect(recorderNode);
        recorderNode.connect(audioCtx.destination);

        recorderNode.port.onmessage = (e)=>{
          if(e.data?.type === 'dump'){
            const wav = encodeWav([e.data.left, e.data.right], recSR);
            pushRecording(wav);
          }
        };
        useWorklet = true;
      } else {
        throw new Error("AudioWorklet 未対応");
      }
    }catch(err){
      showErr(`Worklet未使用で録音にフォールバック: ${err?.message||err}`);
      scriptNode = audioCtx.createScriptProcessor(1024, 2, 2);
      scriptNode.onaudioprocess = (ev)=>{
        const inL = ev.inputBuffer.getChannelData(0);
        const inR = ev.inputBuffer.numberOfChannels>1 ? ev.inputBuffer.getChannelData(1) : inL;
        ev.outputBuffer.getChannelData(0).set(inL);
        ev.outputBuffer.getChannelData(1).set(inR);
        if(isRecording){
          recLeft  = appendF32(recLeft,  inL);
          recRight = appendF32(recRight, inR);
        }
      };
      masterGain.connect(comp);
      comp.connect(scriptNode);
      scriptNode.connect(audioCtx.destination);
      useWorklet=false;
    }
  }
}
function appendF32(dst, src){
  if(!dst || dst.length===0) return new Float32Array(src);
  const out = new Float32Array(dst.length + src.length);
  out.set(dst,0); out.set(src,dst.length);
  return out;
}

/* ====== グリッド操作 ====== */
// 通常：押している間だけ発音 & 上下で ±100 ct
function gridPointerNormal(e, phase){
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if(x<0||x>rect.width||y<0||y>rect.height){
    if(phase!=='end') stopNote();
    hudHide();
    return;
  }
  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx];
  const step = steps[idx];

  const ratioY = y/rect.height;
  const cents = Math.round(CENT_MAX - (CENT_MAX - CENT_MIN)*ratioY);

  document.querySelectorAll('.note-column')
    .forEach((c,i)=>c.classList.toggle('active', i===idx && isPointerDown));
  hudShow(`${name}  ${cents>=0?'+':''}${cents} ct`, x, y);

  const info = {name, step, cents};
  if(phase==='start')      startNote(info);
  else if(phase==='move')  updateNote(info);
  else if(phase==='end'){  stopNote(); hudHide(); }
}

// 12平均律：0 ct 固定
function gridPointerTet12(e, phase){
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if(x<0||x>rect.width||y<0||y>rect.height){
    if(phase!=='end') stopNote();
    hudHide();
    return;
  }
  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx];
  const step = steps[idx];

  document.querySelectorAll('.note-column')
    .forEach((c,i)=>c.classList.toggle('active', i===idx && isPointerDown));
  hudShow(`${name}`, x, y);

  const info = {name, step, cents:0};
  if(phase==='start')      startNote(info);
  else if(phase==='move')  updateNote(info);
  else if(phase==='end'){  stopNote(); hudHide(); }
}

// コードモード：タップで ON/OFF（縦位置がその列の cent）
function gridChordTap(e){
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if(x<0||x>rect.width||y<0||y>rect.height){
    hudHide();
    return;
  }
  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx];
  const step = steps[idx];

  const ratioY = y/rect.height;
  const cents = Math.round(CENT_MAX - (CENT_MAX - CENT_MIN)*ratioY);

  const cols = document.querySelectorAll('.note-column');

  if (chordVoices.has(step)){
    const v = chordVoices.get(step);
    v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.06);
    v.osc.stop(audioCtx.currentTime + 0.07);
    chordVoices.delete(step);
    cols[idx].classList.remove('active');
  } else {
    startChordVoice(step, cents);
    cols[idx].classList.add('active');
  }
  hudShow(`${name}  ${cents>=0?'+':''}${cents} ct`, x, y);
}

/* ====== 単音 / コード ====== */

// ★ タッチ向けにアタック速め＆リリース長め
async function startNote(info){
  try{
    await ensureAudio();
    await audioCtx.resume();
  }catch(e){
    showErr(`Audio開始失敗: ${e?.message||e}`);
    return;
  }
  stopNote(); // 既存ノートをいったん止める

  const t = audioCtx.currentTime;

  osc = audioCtx.createOscillator();
  gainNode = audioCtx.createGain();

  osc.type = soundSelectEl.value;
  osc.frequency.value = calcFreq(info.step, info.cents, octaveOffset);

  // アタック：すぐに鳴り始めるように 5ms で立ち上げ
  gainNode.gain.cancelScheduledValues(t);
  gainNode.gain.setValueAtTime(0, t);
  gainNode.gain.linearRampToValueAtTime(0.55, t + 0.005);

  osc.connect(gainNode).connect(masterGain);
  osc.start(t);

  currentNoteInfo = info;
}

function stopNote(){
  if(!osc) return;

  const t = audioCtx.currentTime;

  // 今の値から少し余韻を残して 0 にフェードアウト（約 0.15 秒）
  gainNode.gain.cancelScheduledValues(t);
  const current = gainNode.gain.value;
  gainNode.gain.setValueAtTime(current, t);
  gainNode.gain.linearRampToValueAtTime(0, t + 0.15);

  osc.stop(t + 0.16);

  osc = null;
  gainNode = null;
  currentNoteInfo = null;

  document.querySelectorAll('.note-column').forEach(c=>c.classList.remove('active'));
}

function updateNote(info){
  if(!osc) return;
  const f = calcFreq(info.step, info.cents, octaveOffset);
  osc.frequency.cancelScheduledValues(audioCtx.currentTime);
  osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
  currentNoteInfo = info;
}


// コード用
function startChordVoice(step, cents){
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = soundSelectEl.value;
  o.frequency.value = calcFreq(step, cents, octaveOffset);
  g.gain.setValueAtTime(0, audioCtx.currentTime);
  g.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.03);
  o.connect(g).connect(masterGain);
  o.start();
  chordVoices.set(step, {osc:o, gain:g, cents});
}
function stopAllChord(){
  for(const [, v] of chordVoices){
    v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
    v.osc.stop(audioCtx.currentTime + 0.06);
  }
  chordVoices.clear();
  document.querySelectorAll('.note-column').forEach(c=>c.classList.remove('active'));
}
function retuneAllChordAfterOct(){
  for(const [step, v] of chordVoices){
    const f = calcFreq(step, v.cents, octaveOffset);
    v.osc.frequency.cancelScheduledValues(audioCtx.currentTime);
    v.osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
  }
}

/* ====== Util ====== */
function calcFreq(step, cents, oct){
  const C4 = 261.63;
  const semi = step + oct*12 + cents/100;
  return C4 * Math.pow(2, semi/12);
}
function hudShow(text,x,y){
  hudEl.textContent=text;
  hudEl.hidden=false;
  hudEl.style.transform=`translate(${x+12}px,${y-24}px)`;
}
function hudHide(){
  if (!hudEl) return;
  hudEl.hidden=true;
  hudEl.style.transform='translate(-9999px,-9999px)';
}
function updateOct(){ octLabelEl.textContent = String(octaveOffset); }
function updateRecUI(){
  recordBtn.classList.toggle('recording', isRecording);
  recordStatus.textContent = isRecording ? '録音中…' : '待機中';
}

/* ====== WAV + 録音 ====== */
function encodeWav(chs, sr){
  const N = chs[0].length, C = chs.length;
  const inter = new Float32Array(N*C);
  for(let i=0;i<N;i++) for(let c=0;c<C;c++) inter[i*C+c] = chs[c][i]||0;
  const buf = new ArrayBuffer(44 + inter.length*2);
  const v = new DataView(buf);
  w('RIFF',0); v.setUint32(4,36+inter.length*2,true); w('WAVE',8); w('fmt ',12);
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,C,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*C*2,true); v.setUint16(32,C*2,true); v.setUint16(34,16,true);
  w('data',36); v.setUint32(40,inter.length*2,true);
  let off=44;
  for(let i=0;i<inter.length;i++,off+=2){
    let s=Math.max(-1,Math.min(1,inter[i]));
    v.setInt16(off, s<0?s*0x8000:s*0x7fff, true);
  }
  return new Blob([v],{type:'audio/wav'});
  function w(s,o){ for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); }
}
function pushRecording(wav){
  const url = URL.createObjectURL(wav);
  const list = document.getElementById('recordings-list');
  if (!list) return;

  recordingsSec.hidden = false;

  const item = document.createElement('div');
  item.className='item';
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
  const name = `recording_${(++recCount).toString().padStart(2,'0')}_${stamp}.wav`;

  const audio = document.createElement('audio');
  audio.controls=true;
  audio.src=url;

  const a = document.createElement('a');
  a.href=url;
  a.download=name;
  a.textContent=`📥 ${name}`;

  const open = document.createElement('a');
  open.href=url;
  open.target='_blank';
  open.rel='noopener';
  open.textContent='⤴︎ 新しいタブで開く';

  const del = document.createElement('button');
  del.textContent='削除';
  del.addEventListener('click',()=>{
    URL.revokeObjectURL(url);
    item.remove();
  });

  const meta = document.createElement('span');
  meta.style.fontSize='12px';
  meta.style.color='#666';
  meta.textContent=` (${Math.round(wav.size/1024)} KB)`;

  item.appendChild(audio);
  item.appendChild(a);
  item.appendChild(open);
  item.appendChild(del);
  item.appendChild(meta);
  list.prepend(item);
}
function clearAll(){
  const list=document.getElementById('recordings-list');
  if(!list) return;
  list.querySelectorAll("a[href^='blob:']").forEach(a=>URL.revokeObjectURL(a.href));
  list.innerHTML='';
  recordingsSec.hidden = true;
}

/* ====== イベント ====== */
function attachEvents(){
  mainModeEls.forEach(r=>r.addEventListener('change', updatePanels));
  scaleModeEls.forEach(r=>r.addEventListener('change', ()=>{
    buildGrid();
  }));

  octDownBtn.addEventListener('click', ()=>{
    octaveOffset--;
    updateOct();
    retuneAllChordAfterOct();
  });
  octUpBtn.addEventListener('click', ()=>{
    octaveOffset++;
    updateOct();
    retuneAllChordAfterOct();
  });

  recordBtn.addEventListener('click', async ()=>{
    try{
      await ensureAudio();
      await audioCtx.resume();
      isRecording=!isRecording;
      if(isRecording){
        if(useWorklet) recorderNode.port.postMessage('rec-start');
        else { recLeft=new Float32Array(0); recRight=new Float32Array(0); }
      }else{
        if(useWorklet) recorderNode.port.postMessage('rec-stop');
        else {
          const wav = encodeWav(
            [recLeft||new Float32Array(0), recRight||new Float32Array(0)],
            recSR
          );
          pushRecording(wav);
        }
      }
      updateRecUI();
    }catch(e){
      showErr(`録音切替失敗: ${e?.message||e}`);
    }
  });
  clearRecsBtn.addEventListener('click', clearAll);

  // グリッド操作
  gridEl.addEventListener('pointerdown', async e=>{
    const mode = getMainMode();
    e.preventDefault();
    gridEl.setPointerCapture(e.pointerId);
    isPointerDown = true;
    await ensureAudio();
    await audioCtx.resume();
    if (mode === 'grid'){
      gridPointerNormal(e,'start');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'start');
    } else {
      // コードモード：タップでON/OFF
      gridChordTap(e);
    }
  }, {passive:false});

  gridEl.addEventListener('pointermove', e=>{
    if (!isPointerDown) return;
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'move');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'move');
    }
  });

  gridEl.addEventListener('pointerup', e=>{
    if (!isPointerDown) return;
    isPointerDown = false;
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'end');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'end');
    } else {
      hudHide();
    }
  });

  gridEl.addEventListener('pointercancel', e=>{
    if (!isPointerDown) return;
    isPointerDown = false;
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'end');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'end');
    } else {
      hudHide();
    }
  });

  fsBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFSUI);
  document.addEventListener('webkitfullscreenchange', updateFSUI);
  document.addEventListener('msfullscreenchange', updateFSUI);
}

/* ====== 全画面 ====== */
function fullscreenSupported(){
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
}
async function toggleFullscreen(){
  try{
    await ensureAudio();
    await audioCtx?.resume();
  }catch(e){}
  if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen)?.call(document);
    document.body.classList.remove('fullscreen');
  } else {
    if (fullscreenSupported()){
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);
      document.body.classList.add('fullscreen');
    }
  }
}
function updateFSUI(){
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  fsBtn.classList.toggle('active', on);
  fsBtn.textContent = on ? '⛶ 終了' : '⛶ 全画面';
  document.body.classList.toggle('fullscreen', on);
}
