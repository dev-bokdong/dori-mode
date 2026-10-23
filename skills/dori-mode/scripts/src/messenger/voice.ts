import { type ArgvTemplate, fill } from "../config.ts";
import type { Runner } from "../run.ts";

export class TranscriptionError extends Error {}

export const transcribe = async (run: Runner, hook: ArgvTemplate | undefined, audioPath: string): Promise<string> => {
  if (!hook?.length) throw new TranscriptionError("no hooks.transcribe configured");
  const r = await run(fill(hook, { file: audioPath }));
  const text = r.out.trim();
  if (r.code !== 0 || !text) throw new TranscriptionError(`transcription failed (exit ${r.code}): ${r.err.slice(0, 160)}`);
  return text;
};

export const asOwnerMessage = (transcript: string): string => `[voice] ${transcript}`;
