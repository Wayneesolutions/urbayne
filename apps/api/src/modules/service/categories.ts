import { schema } from '@cs/db';

export type Category = (typeof schema.TICKET_CATEGORIES)[number];
export type Status = (typeof schema.TICKET_STATUSES)[number];
export const CATEGORIES = schema.TICKET_CATEGORIES;

/** Names shown to residents and staff, in the three languages of the platform. */
export const CATEGORY_LABELS: Record<Category, { en: string; pa: string; hi: string }> = {
  water: { en: 'Water', pa: 'ਪਾਣੀ', hi: 'पानी' },
  roads: { en: 'Roads', pa: 'ਸੜਕਾਂ', hi: 'सड़कें' },
  electricity: { en: 'Electricity', pa: 'ਬਿਜਲੀ', hi: 'बिजली' },
  sanitation: { en: 'Sanitation and drains', pa: 'ਸਫ਼ਾਈ ਅਤੇ ਨਾਲੀਆਂ', hi: 'सफ़ाई और नालियाँ' },
  health: { en: 'Health', pa: 'ਸਿਹਤ', hi: 'स्वास्थ्य' },
  welfare: { en: 'Pension and welfare schemes', pa: 'ਪੈਨਸ਼ਨ ਅਤੇ ਭਲਾਈ ਸਕੀਮਾਂ', hi: 'पेंशन और कल्याण योजनाएँ' },
  education: { en: 'Education', pa: 'ਸਿੱਖਿਆ', hi: 'शिक्षा' },
  safety: { en: 'Safety and police', pa: 'ਸੁਰੱਖਿਆ ਅਤੇ ਪੁਲਿਸ', hi: 'सुरक्षा और पुलिस' },
  other: { en: 'Something else', pa: 'ਹੋਰ', hi: 'कुछ और' },
};

/** Words people use in text messages and on calls (English, Hinglish, Punjabi, Hindi). Used to guess a category when none is given. */
const KEYWORDS: Record<Exclude<Category, 'other'>, string[]> = {
  water: ['water', 'pani', 'paani', 'tap', 'tubewell', 'ਪਾਣੀ', 'पानी'],
  roads: ['road', 'sadak', 'pothole', 'street', 'bridge', 'ਸੜਕ', 'सड़क', 'गड्ढा', 'ਟੋਇਆ'],
  electricity: ['electricity', 'light', 'bijli', 'power', 'transformer', 'pole', 'ਬਿਜਲੀ', 'बिजली', 'बत्ती'],
  sanitation: ['drain', 'sewer', 'sewage', 'garbage', 'waste', 'safai', 'nali', 'sanitation', 'ਸਫ਼ਾਈ', 'ਨਾਲੀ', 'सफाई', 'नाली', 'कूड़ा'],
  health: ['health', 'hospital', 'doctor', 'dispensary', 'medicine', 'ਹਸਪਤਾਲ', 'ਸਿਹਤ', 'अस्पताल', 'स्वास्थ्य', 'दवा'],
  welfare: ['pension', 'ration', 'scheme', 'card', 'subsidy', 'ਪੈਨਸ਼ਨ', 'ਰਾਸ਼ਨ', 'पेंशन', 'राशन', 'योजना'],
  education: ['school', 'teacher', 'college', 'education', 'scholarship', 'ਸਕੂਲ', 'ਸਿੱਖਿਆ', 'स्कूल', 'शिक्षा'],
  safety: ['police', 'theft', 'crime', 'safety', 'fight', 'ਪੁਲਿਸ', 'ਚੋਰੀ', 'पुलिस', 'चोरी'],
};

const norm = (s: string) => s.toLowerCase();

/** Exact category key or label ("water", "Pani") to a category, else a keyword guess, else null. */
export function guessCategory(text: string): Category | null {
  const t = norm(text);
  for (const c of CATEGORIES) if (t.trim() === c) return c;
  // Latin words must match whole words ("waterfall" is not "water"). Gurmukhi and Devanagari words are matched at the start of
  // a word, so endings and suffixes still match, but a short word inside a longer one does not (जल inside बिजली).
  const tokens = t.split(/[\s,.;:!?()/-]+/).filter(Boolean);
  for (const [cat, words] of Object.entries(KEYWORDS) as [Exclude<Category, 'other'>, string[]][]) {
    if (words.some((w) => (/^[\x00-\x7f]+$/.test(w) ? tokens.includes(w) : tokens.some((x) => x.startsWith(w))))) return cat;
  }
  return null;
}

/** Which status can follow which. A resolved ticket can be reopened; closed and rejected are final. */
export const NEXT_STATUS: Record<Status, Status[]> = {
  new: ['assigned', 'in_progress', 'resolved', 'rejected'],
  assigned: ['in_progress', 'resolved', 'rejected', 'new'],
  in_progress: ['resolved', 'rejected', 'assigned'],
  resolved: ['closed', 'in_progress'],
  closed: [],
  rejected: [],
};

/** Plain words for status updates (texts go out in this wording because DLT templates fix the sentence, not the status). */
export const STATUS_WORDS: Record<Status, string> = {
  new: 'received', assigned: 'assigned to our team', in_progress: 'being worked on', resolved: 'resolved', closed: 'closed', rejected: 'not accepted',
};
