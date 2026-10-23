/** Zero-LLM progress read from an omo pane: the in-progress todo item plus the elapsed time of the status line. */
export type Progress = { readonly todo: string; readonly elapsed?: string };

const TODO_ITEM = /^\s*\[•\]\s+(\S.*?)\s*$/;
const STATUS = /(?:Working|Running[^(]*?)\s*\((\d+[hms](?:\s*\d+[ms])?)/;

/**
 * Reads only the last Todo block. The block ends at the status rule line (starting with box-drawing dashes).
 * Without a Todo block or an in-progress item there is nothing to report, so the answer is null, never a guess.
 */
export const extractProgress = (screen: string): Progress | null => {
  const lines = screen.split("\n");
  const head = lines.map((l) => l.trim()).lastIndexOf("Todo");
  if (head < 0) return null;
  let todo: string | undefined;
  let elapsed: string | undefined;
  for (const line of lines.slice(head + 1)) {
    if (line.trimStart().startsWith("──")) {
      elapsed = STATUS.exec(line)?.[1];
      break;
    }
    todo ??= TODO_ITEM.exec(line)?.[1];
  }
  return todo ? { todo, elapsed } : null;
};

/**
 * The thread line, from `template` (config progressTemplate, default the todo text alone, so no language is imposed).
 * `{elapsed}` is empty when the status line shows none. The key is the todo text alone, so a ticking clock never counts as new.
 */
export const progressLine = (p: Progress, scrub: (s: string) => string, template = "{todo}"): { readonly key: string; readonly text: string } => {
  const todo = scrub(p.todo);
  const text = template.replace(/\{(todo|elapsed)\}/g, (_, name: string) => (name === "todo" ? todo : p.elapsed ?? "")).trim();
  return { key: todo, text: text || todo };
};
