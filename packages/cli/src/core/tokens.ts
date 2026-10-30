const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 粗略估算 token：一个汉字约 1 token，四个英文字符约 1 token，
 * 其余按四个字符一组。只用于裁剪预算，不追求精确。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

export function truncateByTokens(
  text: string,
  budget: number,
): { text: string; truncatedTokens: number } {
  if (budget <= 0) return { text: "", truncatedTokens: estimateTokens(text) };
  const total = estimateTokens(text);
  if (total <= budget) return { text, truncatedTokens: 0 };
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(chars.slice(0, mid).join("")) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const kept = chars.slice(0, lo).join("");
  const keptTokens = estimateTokens(kept);
  return { text: kept, truncatedTokens: total - keptTokens };
}
