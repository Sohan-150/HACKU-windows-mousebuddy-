// Which value goes in which field, and when a message may be sent. Ported from the Mac version (compile.ts), where
// it was found on WhatsApp runs; nothing in it is specific to one app.
//   "Open WhatsApp, message Sohan "hi"" -> quoted ["hi"], names ["Sohan"], targets ["Sohan"]: a search or recipient
//   field gets "Sohan", the message field gets "hi", and only because the goal asks to send something.

/** the concrete values a goal gives: quoted text, names (capitalised words that aren't the first word or the app it
 *  is told to use), and the TARGETS among them: what a verb of reaching asks to get to ("message Sohan", "reply to
 *  Sohan's text", "open the chat with Mum"). `app` (the app the part works in) is never a target. */
export function goalValues(goal: string, app = ""): { quoted: string[]; names: string[]; targets: string[] } {
  const QUOTE = /["“]([^"”]{1,300})["”]|(?<=^|[\s:(,])['‘]([^'’]{2,300})['’](?=$|[\s,.!?:;)])/g;
  const quoted = [...goal.matchAll(QUOTE)].map(q => (q[1] ?? q[2])!.trim()).filter(Boolean);
  const rest = goal.replace(QUOTE, " , ");
  const appWords = app.toLowerCase().replace(/\.exe$/, "").replace(/\b(windows|microsoft|desktop)\b/g, "").trim();
  const names: string[] = [];
  for (const m of rest.matchAll(/\b([A-Z][\p{L}\p{N}'’&-]*(?:\s+[A-Z][\p{L}\p{N}'’&-]*){0,2})/gu)) {
    const before = rest.slice(0, m.index).trimEnd();
    if (!before || /[.!?:;]$/.test(before)) continue; // the first word of a sentence
    if (/\b(open|in|on|using|via|launch|start|use|go to|switch to)$/i.test(before)) continue; // the app to use ("open WhatsApp", "in Discord")
    const n = m[1]!.replace(/[’']s$/, "");
    if (appWords && n.toLowerCase().includes(appWords)) continue;
    if (!names.includes(n) && !quoted.some(q => q.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  const REACH = /\b(?:message|text|dm|email|call|ring|reply(?:ing)? to|respond(?:ing)? to|answer|chat with|write to|talk to|open|go to|switch to|select|join)\s+(?:the\s+)?(?:(?:chat|conversation|thread|group)\s+(?:with\s+|called\s+|named\s+)?)?(?:(?:last|latest|newest|most recent)\s+)?(?:(?:message|text)\s+from\s+)?["“'‘]?$/i;
  // quoted text right after "the message" / "a text" / "saying" is what to SAY, never who to reach
  // ("The message 'you are crazy man' has been sent to Mohit": Mohit is the target, the quote is the message)
  const SAID = /\b(?:(?:the|a|an|this|that|my|your)\s+(?:message|text|reply|note|dm)|saying|says|that says)\s*:?\s*["“'‘]?$/i;
  const targets = [...quoted, ...names].filter(v => {
    const at = goal.indexOf(v);
    if (at <= 0 || (appWords && v.toLowerCase().includes(appWords))) return false;
    const before = goal.slice(0, at);
    return REACH.test(before) && !(quoted.includes(v) && SAID.test(before));
  });
  // typed in lower case ("message mohit you are crazy"): the word right after the verb of reaching
  if (!targets.length) {
    const m = rest.match(/\b(?:message|text|dm|tell|reply to|chat with|write to|call)\s+(?:my\s+)?([\p{L}][\p{L}\p{N}'’-]*)/iu);
    const w = m?.[1];
    if (w && !/^(a|an|the|him|her|them|me|us|someone|somebody|everyone|it|that|this|back|saying|to|on|in|via|and)$/i.test(w) && !(appWords && w.toLowerCase().includes(appWords))) {
      names.push(w); targets.push(w);
    }
  }
  // "... sent to Mohit", "a message for Mum": the person after "to/for" when a message is being sent
  for (const n of names) {
    if (targets.includes(n)) continue;
    const before = goal.slice(0, goal.indexOf(n));
    if (/\b(?:message|text|reply|dm|email)\b.*\b(?:sent|send|goes|go)\s+to\s*$|\b(?:sent|send|reply|write)\s+(?:it\s+)?to\s*$/i.test(before) && !(appWords && n.toLowerCase().includes(appWords))) targets.push(n);
  }
  return { quoted, names, targets };
}

/** a field for what to SAY (a message, a reply), and a field for WHO or WHAT to find (search, recipient, name) */
export const MESSAGE_FIELD = /\b(message|compose|reply|imessage|write a|type a|say something|chat)\b/i;
export const FIND_FIELD = /\b(search|find|name|number|username|recipient|to:|contact)\b/i;
/** the goal asks to SEND something: only then may a message field be filled and Enter / Send pressed in it */
export const SEND_INTENT = /\b(send|message|text|reply|respond|tell|say|post|dm|answer|write to|e-?mail)\b/i;

export const isMessageField = (label: string) => MESSAGE_FIELD.test(label) && !FIND_FIELD.test(label);
export const isFindField = (label: string) => FIND_FIELD.test(label);

/** "message Mohit hi", "send a message to Mum saying I'm late", "text Sam "on my way"": who, and what to say */
export function messageOf(part: string, app = ""): { to?: string; text?: string } {
  const { quoted, targets } = goalValues(part, app);
  const said = part.match(/\b(?:saying|that says|which says|with the text|telling (?:him|her|them))\s*:?\s*["“]?(.+?)["”]?\s*[.!]?$/i)?.[1]?.trim();
  let text = quoted.find(q => !targets.includes(q)) ?? said;
  const to = targets.find(t => t !== text);
  if (!text && to) {
    // "message Mohit hi": what follows the name, only when a verb of sending is right before the name
    const before = part.slice(0, part.indexOf(to));
    const after = part.slice(part.indexOf(to) + to.length).replace(/^[\s,:]+/, "").replace(/\s+(?:on|in|via|using)\s+\S+\s*$/i, "").replace(/[.!]+$/, "").trim();
    if (after && /\b(?:message|text|dm|tell|reply to|write to)\s*$/i.test(before) && /^[\p{L}\p{N}]/u.test(after) && !/^(and|then|on|in|via|has|have|is|was)\b/i.test(after)) text = after;
  }
  return { to, text: text || undefined };
}
