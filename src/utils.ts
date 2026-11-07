/** Разбирает «/cmd@bot аргументы» -> { cmd: "cmd", args: "аргументы" }. */
export function parseCommand(text: string): { cmd: string; args: string } | null {
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { cmd: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : null;
}
