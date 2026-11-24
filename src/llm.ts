// Model-call types shared by the researcher and the extension (was in v6's audit.ts, which pi-scout does not ship).
export type Usage = { input: number; output: number };
export type Llm = (system: string, prompt: string, maxTokens: number, signal: AbortSignal | undefined, kind: string, model?: string) => Promise<{ text: string; ms: number; usage?: Usage }>;
export const estTok = (s: string) => Math.ceil(s.length / 3.5);
