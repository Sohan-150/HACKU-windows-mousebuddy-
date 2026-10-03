// Guardrails enforced in code, whatever a model decides:
//  - a click on anything that looks irreversible (send, pay, delete, submit, ...) waits for the user's approval
//  - the agent never types into password / card / ID fields; those steps go back to the user
import type { Item } from "./contracts";

const IRREVERSIBLE = /\b(buy|purchase|pay|payment|checkout|check out|place (the )?order|order now|send|submit|delete|remove|discard|erase|transfer|withdraw|publish|post|share|tweet|reply all|sign out|log ?out|uninstall|format|reset|empty (the )?(trash|recycle bin)|confirm|accept|agree|subscribe|unsubscribe|book now|reserve|save|overwrite|replace)\b/i;
const SECRET_FIELD = /pass(word|code|phrase)|\bpin\b|card ?number|credit card|\bcvv\b|\bcvc\b|security code|expiry|social security|\bssn\b|passport|\bhkid\b|one[- ]time code|\botp\b/i;

// Accepting cookies / terms in other languages (sites pick the language from the IP address, e.g. "Godta alle").
const ACCEPT_OTHER = /^(godta( alle)?|acceptera( alla)?|accepter( alle| tout)?|tout accepter|alle akzeptieren|akzeptieren|zustimmen|aceptar( todo| todas)?|accetta( tutto| tutti)?|alles accepteren|accepteren|aceitar( tudo)?|zaakceptuj( wszystkie)?|hyväksy( kaikki)?|全部接受|接受全部|同意|すべて同意|同意する)$/i;

/** Returns why a click needs approval, or null. */
export function clickNeedsApproval(it: Item): string | null {
  if (ACCEPT_OTHER.test(it.text.trim())) return `'${it.text}' looks like it accepts cookies or terms`;
  const m = it.text.match(IRREVERSIBLE);
  if (!m) return null;
  const w = m[0];
  const what = /send|submit|post|publish|share|reply|tweet/i.test(w) ? "sends something on your behalf"
    : /buy|purchase|pay|checkout|order|book|reserve|transfer|withdraw|subscribe/i.test(w) ? "spends money or commits you"
    : /save|overwrite|replace/i.test(w) ? "writes or overwrites a file on your computer"
    : "cannot be undone";
  return `'${it.text}' looks like it ${what}`;
}

/** Returns why typing into this field is not allowed, or null. */
export function typingForbidden(it: Item): string | null {
  return SECRET_FIELD.test(it.text) ? `'${it.text}' asks for a secret (password, card or ID). The agent never types those; please do this part yourself.` : null;
}

const PERSONAL_FIELD = /\b(first|last|given|family|full|middle) ?name\b|\bsurname\b|\bname of (the )?(passenger|traveller|traveler|guest)\b|\be-?mail\b|\bphone\b|\bmobile\b|\btelephone\b|\bdate of birth\b|\bbirth ?date\b|\bdob\b|\bstreet\b|\baddress\b|\bpost ?code\b|\bzip\b|\bnationality\b|\bgender\b|\btitle \(mr/i;

/**
 * A form asking for personal details (booking a flight, signing up): the agent fills them only with text the user
 * gave in the instruction, never with text a model made up. Otherwise it stops there: the step before paying.
 */
export function personalDetailsMissing(it: Item, text: string, instruction: string): string | null {
  if (!PERSONAL_FIELD.test(it.text)) return null;
  if (text.trim() && instruction.toLowerCase().includes(text.trim().toLowerCase())) return null;
  return `'${it.text}' asks for your personal details. I stop here so you can fill them in and pay yourself; everything before this step is done.`;
}
