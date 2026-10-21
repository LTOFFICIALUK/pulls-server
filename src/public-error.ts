export const publicMessage = (err: unknown) => {
  const raw = err instanceof Error ? err.message : "This needs another try.";
  if (/secret|private key|api-key|api_key/i.test(raw)) return "This needs another try.";
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line) return "This needs another try.";
  return line.length > 280 ? `${line.slice(0, 277)}...` : line;
};
