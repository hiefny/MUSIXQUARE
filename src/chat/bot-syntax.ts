/**
 * Return the user-visible BOT prompt for either supported chat syntax.
 *
 * `/bot request` remains the explicit command form. `//request` is its
 * compact alias; keeping this parser shared prevents the command executor and
 * the P2P typing/result correlation from disagreeing about the same message.
 */
export function extractBotPrompt(text: string): string | null {
  const explicit = /^\/bot(?:\s+)([\s\S]+)$/i.exec(text);
  const compact = explicit ? null : /^\/\/(?!\/)([\s\S]+)$/.exec(text);
  const prompt = (explicit?.[1] ?? compact?.[1] ?? '').trim();
  return prompt ? prompt : null;
}
