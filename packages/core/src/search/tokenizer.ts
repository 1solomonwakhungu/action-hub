/**
 * Faithful BERT WordPiece tokenizer for the vendored all-MiniLM-L6-v2
 * (SQ4-R2: WASM-only inference — the @huggingface/transformers runtime is
 * replaced by a direct onnxruntime-web session, so tokenization must be
 * reproduced exactly).
 *
 * Mirrors tokenizer.json: BertNormalizer (clean_text, strip accents,
 * lowercase) -> BertPreTokenizer (whitespace + punctuation split) ->
 * WordPiece (## continuations, [UNK], 100-char cap) -> [CLS] ... [SEP],
 * truncated to the model's 128-token window.
 *
 * Parity with the previous runtime is pinned by test/fixtures/embedding-vectors.json
 * (cosine >= 0.999 per vector over 200 texts).
 */
import { readFileSync } from "node:fs";

const cleanText = (text: string): string =>
  // BertNormalizer.clean_text + handle_chinese_chars: drop control chars,
  // normalize whitespace, pad CJK ideographs with spaces.
  text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u4E00-\u9FFF\u3400-\u4DBF]/gu, (m) => ` ${m} `)
    .replace(/\s+/g, " ");

const stripAccents = (text: string): string => text.normalize("NFD").replace(/[\u0300-\u036F]/g, "");

const isPunctuation = (ch: string): boolean => {
  const code = ch.codePointAt(0)!;
  // ASCII punctuation range used by BERT's tokenizer, plus common Unicode
  // punctuation categories.
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126) ||
    (code >= 0x2000 && code <= 0x206f) ||
    (code >= 0x3000 && code <= 0x303f)
  );
};

const isWhitespace = (ch: string): boolean => {
  const code = ch.codePointAt(0)!;
  return code === 32 || code === 9 || code === 10 || code === 13 || (code >= 0x2000 && code <= 0x200b);
};

/** BertPreTokenizer: split on whitespace, then split out punctuation runs. */
function preTokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    if (chunk.length === 0) continue;
    let current = "";
    for (const ch of chunk) {
      if (isPunctuation(ch)) {
        if (current) tokens.push(current);
        tokens.push(ch);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
  }
  return tokens;
}

export interface TokenizerData {
  vocab: Map<string, number>;
  unkId: number;
  clsId: number;
  sepId: number;
  maxLength: number;
}

/** Loads the pieces we need from the model's tokenizer.json. */
export function loadTokenizer(tokenizerJsonPath: string): TokenizerData {
  const raw = JSON.parse(readFileSync(tokenizerJsonPath, "utf8")) as {
    truncation?: { max_length?: number };
    post_processor?: { single?: { SpecialToken?: { id?: string } }[] };
    model: { vocab: Record<string, number>; unk_token: string };
  };
  const vocab = new Map(Object.entries(raw.model.vocab));
  const unkId = vocab.get(raw.model.unk_token);
  if (unkId === undefined) throw new Error(`tokenizer.json: unk token ${raw.model.unk_token} missing from vocab`);
  const clsToken = raw.post_processor?.single?.find((part) => part.SpecialToken)?.SpecialToken?.id ?? "[CLS]";
  const clsId = vocab.get(clsToken);
  if (clsId === undefined) throw new Error(`tokenizer.json: ${clsToken} missing from vocab`);
  const sepId = vocab.get("[SEP]");
  if (sepId === undefined) throw new Error("tokenizer.json: [SEP] missing from vocab");
  return { vocab, unkId, clsId, sepId, maxLength: raw.truncation?.max_length ?? 128 };
}

/** BertNormalizer + BertPreTokenizer: the raw-word stage of the pipeline. */
export function basicTokenize(text: string): string[] {
  const cleaned = stripAccents(cleanText(text)).toLowerCase();
  return preTokenize(cleaned);
}

/** Greedy longest-match-first WordPiece over the vocab. */
export function wordPiece(word: string, data: TokenizerData): number[] {
  if (word.length > 100) return [data.unkId];
  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let id: number | undefined;
    while (start < end) {
      const piece = (start === 0 ? "" : "##") + word.slice(start, end);
      id = data.vocab.get(piece);
      if (id !== undefined) break;
      end -= 1;
    }
    if (id === undefined) return [data.unkId];
    ids.push(id);
    start = end;
  }
  return ids.length > 0 ? ids : [data.unkId];
}

/** Full pipeline: text -> [CLS] token ids [SEP], truncated to max_length. */
export function encode(text: string, data: TokenizerData): number[] {
  const ids: number[] = [data.clsId];
  for (const word of basicTokenize(text)) {
    // Reserve room for [SEP].
    if (ids.length >= data.maxLength - 1) break;
    ids.push(...wordPiece(word, data));
    if (ids.length > data.maxLength - 1) {
      ids.length = data.maxLength - 1;
    }
  }
  ids.push(data.sepId);
  return ids.slice(0, data.maxLength);
}
