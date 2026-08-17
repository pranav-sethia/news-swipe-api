// pgvector returns embedding columns as either a JSON-array string or an
// already-parsed array depending on the query shape - this normalizes both.
const parseVector = (v) => typeof v === 'string' ? JSON.parse(v) : v;

function normalize(vec) {
  let magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) magnitude = 1;
  return vec.map(val => val / magnitude);
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Window-based probabilistic interleave:
// Splits the match pool into N equal windows (one per discovery card).
// Within each window, the discovery card lands at a random position.
// Guarantees: max consecutive matches ≤ windowSize (~4), never back-to-back discoveries,
// and a different pattern every call, no hardcoded rhythm.
function randomizedInterleave(smartRows, dumbRows) {
  if (!dumbRows.length) return [...smartRows];
  if (!smartRows.length) return [...dumbRows];

  const numWindows = dumbRows.length;                            // 3 windows = 3 discovery cards
  const windowSize = Math.floor(smartRows.length / numWindows);  // ~4 matches per window
  const result = [];
  let mi = 0, di = 0;

  for (let w = 0; w < numWindows && mi < smartRows.length; w++) {
    const matchesInWindow = (w < numWindows - 1) ? windowSize : smartRows.length - mi;

    // Random position for discovery within this window.
    // In the last window, avoid placing disc at the very end (user's last card should be a match).
    const maxDiscSlot = (w === numWindows - 1) ? Math.max(0, matchesInWindow - 1) : matchesInWindow;
    const discSlot = Math.floor(Math.random() * (maxDiscSlot + 1));

    for (let j = 0; j < discSlot && mi < smartRows.length; j++) result.push(smartRows[mi++]);
    if (di < dumbRows.length) result.push({ ...dumbRows[di++], match_pct: null });
    for (let j = discSlot; j < matchesInWindow && mi < smartRows.length; j++) result.push(smartRows[mi++]);
  }

  // Safety: flush any remaining cards
  while (mi < smartRows.length) result.push(smartRows[mi++]);
  while (di < dumbRows.length) result.push({ ...dumbRows[di++], match_pct: null });

  return result;
}

module.exports = { cosineSimilarity, randomizedInterleave, parseVector, normalize };
