// stereo pass-through + capture
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    this._L = new Float32Array(0);
    this._R = new Float32Array(0);

    this.port.onmessage = (e) => {
      if (e.data === "rec-start") {
        this.isRecording = true;
        this._L = new Float32Array(0);
        this._R = new Float32Array(0);
      } else if (e.data === "rec-stop") {
        this.isRecording = false;
        this.port.postMessage({ type: "dump", left: this._L, right: this._R }, [this._L.buffer, this._R.buffer]);
        this._L = new Float32Array(0);
        this._R = new Float32Array(0);
      }
    };
  }

  _append(dst, src) {
    const out = new Float32Array(dst.length + src.length);
    out.set(dst, 0); out.set(src, dst.length);
    return out;
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    for (let ch = 0; ch < output.length; ch++) {
      if (input[ch]) output[ch].set(input[ch]);
    }
    if (this.isRecording && input[0]) {
      const L = input[0]; const R = input[1] || input[0];
      this._L = this._append(this._L, L);
      this._R = this._append(this._R, R);
    }
    return true;
  }
}
registerProcessor("recorder-processor", RecorderProcessor);
