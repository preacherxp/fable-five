// worker.js: one model replica on its own CPU core. Given the current weights it either trains on random
// windows for a time box and sends back the summed gradient, or writes a sample and scores held-out text.
importScripts('gpt.js');
let model, train, val;

onmessage = ({ data: m }) => {
  if (m.cfg) { model = TinyGPT.GPT(m.cfg); train = m.train; val = m.val; return; }
  model.W.set(m.w);
  const ctx = model.ctx;
  if (m.sample) {
    const ids = model.sample(m.prompt, m.sample), { P, T } = TinyGPT.lastAttention();
    const attn = P.slice(0, T * T);                // first head of the last layer, over the last window it read
    let held = 0;
    for (let i = 0; i < 32; i++) { const a = (val.length - ctx - 1) * i / 32 | 0; held += model.evaluate(val.subarray(a, a + ctx), val.subarray(a + 1, a + ctx + 1)); }
    postMessage({ ids, attn, T, held: held / 32, step: m.step });
    return;
  }
  // A time box instead of a fixed batch: fast cores do more windows, slow cores fewer, nobody waits long.
  const t = performance.now(); let n = 0, loss = 0;
  do { loss += model.grad(train, [Math.random() * (train.length - ctx - 1) | 0]); n++; } while (performance.now() - t < m.ms);
  const g = model.G.slice(); model.G.fill(0);
  postMessage({ g, n, loss }, [g.buffer]);
};
