const { pipeline } = require('@xenova/transformers');
async function run() {
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
  
  const t1 = "Show HN: HackerSwipe, a Tinder-like UI for discovering Hacker News tech articles and startup news";
  const t2 = "A deep dive into building Tinder's swiping animation in React Native and Node";
  const t3 = "Dairy Farming Statistics in 2025: A complete overview";
  
  const o1 = await embedder(t1, { pooling: 'mean', normalize: true });
  const o2 = await embedder(t2, { pooling: 'mean', normalize: true });
  const o3 = await embedder(t3, { pooling: 'mean', normalize: true });
  
  const v1 = Array.from(o1.data);
  const v2 = Array.from(o2.data);
  const v3 = Array.from(o3.data);
  
  const dot = (a, b) => a.map((x, i) => x * b[i]).reduce((m, n) => m + n);
  
  console.log("Similarity Highly Related (t1 vs t2):", dot(v1, v2));
  console.log("Similarity Unrelated (t1 vs t3):", dot(v1, v3));
}
run();
