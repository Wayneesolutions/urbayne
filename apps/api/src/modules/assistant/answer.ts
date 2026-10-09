/**
 * AI Campaign Assistant. Answers ONLY from the campaign's approved content.
 * - Voting logistics (dates, booths, where to vote) always point to the official source.
 * - No confident match -> hand-off to the team, never a made-up answer.
 * - With ANTHROPIC_API_KEY set, Claude rephrases from the matched sources and must cite one;
 *   an answer without a valid citation is replaced by a hand-off.
 */

export interface Source { id: string; title: string; body: string; locale: string }
export type Outcome = 'answered' | 'handoff' | 'official_link';
export interface Answer { outcome: Outcome; answer: string; source?: { id: string; title: string }; officialUrl?: string | null }

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'what', 'your', 'you', 'for', 'and', 'of', 'to', 'in', 'on', 'do', 'does', 'will', 'how', 'about', 'plan', 'ki', 'ka', 'ke', 'hai', 'kya', 'ਕੀ', 'ਹੈ', 'ਦਾ', 'ਦੀ', 'ਦੇ', 'ਲਈ', 'क्या', 'है', 'का', 'की', 'के', 'में', 'लिए']);

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

const LOGISTICS = [/\b(vote|voting|poll(ing)?|booth|ballot|advance voting|election day|where do i vote)\b/i, /ਵੋਟ|ਬੂਥ|ਪੋਲਿੰਗ/, /वोट|मतदान|बूथ/,
  /\b(voter|scrutin|bureau de vote|vote par anticipation|jour du scrutin|où voter)\b/i, /\b(boto|bumoto|botohan|presinto|halalan)\b/i];

const TEXT: Record<string, { handoff: string; official: string; disclosure: string }> = {
  en: {
    handoff: "I don't have an approved answer to that yet. Leave your number and someone from the team will call you back.",
    official: 'For voting dates, places and your booth, please check the official election website:',
    disclosure: "I'm an AI assistant. I only share information the campaign has approved.",
  },
  pa: {
    handoff: 'ਇਸ ਸਵਾਲ ਦਾ ਮਨਜ਼ੂਰਸ਼ੁਦਾ ਜਵਾਬ ਹਾਲੇ ਮੇਰੇ ਕੋਲ ਨਹੀਂ ਹੈ। ਆਪਣਾ ਨੰਬਰ ਛੱਡੋ, ਟੀਮ ਤੁਹਾਨੂੰ ਫ਼ੋਨ ਕਰੇਗੀ।',
    official: 'ਵੋਟ ਦੀ ਤਾਰੀਖ਼, ਥਾਂ ਅਤੇ ਤੁਹਾਡੇ ਬੂਥ ਲਈ ਚੋਣ ਕਮਿਸ਼ਨ ਦੀ ਅਧਿਕਾਰਤ ਵੈੱਬਸਾਈਟ ਵੇਖੋ:',
    disclosure: 'ਮੈਂ ਇੱਕ AI ਸਹਾਇਕ ਹਾਂ। ਮੈਂ ਸਿਰਫ਼ ਮੁਹਿੰਮ ਵੱਲੋਂ ਮਨਜ਼ੂਰ ਜਾਣਕਾਰੀ ਦਿੰਦਾ ਹਾਂ।',
  },
  hi: {
    handoff: 'इस सवाल का स्वीकृत जवाब अभी मेरे पास नहीं है। अपना नंबर छोड़ें, टीम आपको कॉल करेगी।',
    official: 'वोट की तारीख, जगह और अपने बूथ के लिए चुनाव आयोग की आधिकारिक वेबसाइट देखें:',
    disclosure: 'मैं एक AI सहायक हूँ। मैं सिर्फ़ अभियान द्वारा स्वीकृत जानकारी देता हूँ।',
  },
  // French and Tagalog (Canada). Have a native speaker review these before a live campaign uses them.
  fr: {
    handoff: "Je n'ai pas encore de réponse approuvée à cette question. Laissez votre numéro et quelqu'un de l'équipe vous rappellera.",
    official: 'Pour les dates, les lieux et votre bureau de vote, consultez le site officiel des élections :',
    disclosure: "Je suis un assistant IA. Je ne partage que les renseignements approuvés par la campagne.",
  },
  tl: {
    handoff: 'Wala pa akong aprubadong sagot sa tanong na iyan. Iwan ang inyong numero at may tatawag sa inyo mula sa team.',
    official: 'Para sa petsa, lugar ng botohan at inyong presinto, tingnan ang opisyal na website ng halalan:',
    disclosure: 'Isa akong AI assistant. Ibinabahagi ko lamang ang impormasyong inaprubahan ng kampanya.',
  },
};
export const assistantText = (locale: string) => TEXT[locale] ?? TEXT.en!;

export function rank(question: string, sources: Source[]): { source: Source; score: number }[] {
  const q = new Set(tokens(question));
  if (!q.size) return [];
  return sources
    .map((source) => {
      const doc = new Set(tokens(`${source.title} ${source.title} ${source.body}`));
      let hit = 0;
      for (const t of q) if (doc.has(t)) hit += t.length >= 4 ? 1 : 0.5;
      return { source, score: hit / Math.sqrt(q.size) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

export interface LlmConfig { apiKey?: string; model: string; fetchImpl?: typeof fetch }

export async function answer(question: string, locale: string, sources: Source[], officialUrl: string | null, llm: LlmConfig): Promise<Answer> {
  const text = assistantText(locale);
  if (LOGISTICS.some((re) => re.test(question))) {
    return { outcome: 'official_link', answer: `${text.official} ${officialUrl ?? ''}`.trim(), officialUrl };
  }
  const ranked = rank(question, sources);
  const top = ranked[0];
  if (!top || top.score < 0.5) return { outcome: 'handoff', answer: text.handoff };

  if (llm.apiKey) {
    const candidates = ranked.slice(0, 3).map((r) => r.source);
    try {
      const out = await askClaude(question, locale, candidates, llm);
      const cited = candidates.find((c) => c.id === out.source_id);
      if (out.answer && cited) return { outcome: 'answered', answer: out.answer, source: { id: cited.id, title: cited.title } };
      return { outcome: 'handoff', answer: text.handoff };
    } catch {
      // fall through to extractive answer
    }
  }
  const body = top.source.body.length > 500 ? `${top.source.body.slice(0, 500)}…` : top.source.body;
  return { outcome: 'answered', answer: body, source: { id: top.source.id, title: top.source.title } };
}

async function askClaude(question: string, locale: string, sources: Source[], llm: LlmConfig): Promise<{ answer?: string; source_id?: string | null }> {
  const f = llm.fetchImpl ?? fetch;
  const system = [
    'You answer voter questions for an election campaign.',
    'Use ONLY the sources provided. Do not add facts, numbers, promises or opinions that are not in the sources.',
    'Never give voting dates, polling places or booth information.',
    `Reply in the language with code "${locale}". Keep it under 80 words, simple words.`,
    'Respond with JSON only: {"answer": string, "source_id": string|null}. If the sources do not answer the question, return {"answer": "", "source_id": null}.',
  ].join('\n');
  const user = `Sources:\n${sources.map((s) => `[${s.id}] ${s.title}\n${s.body}`).join('\n\n')}\n\nQuestion: ${question}`;
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': llm.apiKey!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: llm.model, max_tokens: 400, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const raw = (data.content ?? []).map((c) => c.text ?? '').join('').replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}
