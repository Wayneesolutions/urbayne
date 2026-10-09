import type { Locale, RegionCode } from './types.js';

/**
 * Election packages: everything a first client needs for one election, ready to apply to a new campaign. A pack creates DRAFT
 * content (nothing is public or callable until the owner fills it in and approves it), turns on the right modules, and gives the
 * onboarding checklist for that election: who must approve what, and in what order.
 *
 * Text in ⟦double brackets⟧ is a blank the candidate must fill in. Content that still has one cannot be approved.
 * {DISCLOSURE} and {CAMPAIGN} are filled in when the pack is applied (the AI disclosure line the region requires, and the campaign's name).
 */
export const BLANK_OPEN = '⟦';

export interface PackSurveyQuestion { key: string; question: string; options: { value: string; label: string; dtmf: string }[] }
export interface PackContent { kind: 'page' | 'faq' | 'script'; locale: Locale; title: string; body: string; survey?: PackSurveyQuestion[] }

/** What a checklist item looks at in the campaign to know it is done. `manual`: the owner ticks it. */
export type CheckKey = 'slug' | 'pollClose' | 'spendLimit' | 'retention' | 'contentApproved' | 'team' | 'rolls' | 'dlt' | 'callingHours' | 'manual';
export interface ChecklistItem { id: string; title: string; why: string; check: CheckKey; phase: 'before_launch' | 'before_first_call' | 'before_election' }

export interface ElectionPack {
  id: string;
  region: RegionCode;
  province?: string;
  title: string;
  election: string;
  raceTypes: string[];
  locales: Locale[];
  enabledModules: string[];
  content: PackContent[];
  checklist: ChecklistItem[];
  /** Settings the pack cannot decide for the client: each needs a figure from the election office or counsel. */
  confirmWithCounsel: string[];
}

const ISSUE_OPTIONS_IN = (l: { water: string; roads: string; electricity: string; health: string; education: string; jobs: string }) =>
  [['water', l.water], ['roads', l.roads], ['electricity', l.electricity], ['health', l.health], ['education', l.education], ['jobs', l.jobs]]
    .map(([value, label], i) => ({ value: value!, label: label!, dtmf: String(i + 1) }));

const IN_SURVEY = (question: string, labels: Parameters<typeof ISSUE_OPTIONS_IN>[0]): PackSurveyQuestion[] => [{ key: 'top_issue', question, options: ISSUE_OPTIONS_IN(labels) }];

const PUNJAB_CHECKLIST: ChecklistItem[] = [
  { id: 'profile', phase: 'before_launch', check: 'slug', title: 'Set the campaign page address and candidate name', why: 'Voters reach the campaign at this address (it is on posters and in texts).' },
  { id: 'poll-close', phase: 'before_launch', check: 'pollClose', title: 'Enter the poll close time', why: 'Bulk calls and texts stop 48 hours before it. Without it, nothing can be sent.' },
  { id: 'spend-limit', phase: 'before_launch', check: 'spendLimit', title: 'Enter the expenditure limit for your constituency', why: 'Take the figure from the Election Commission for your seat. The register warns at 90% and stops calls that would pass it.' },
  { id: 'team', phase: 'before_launch', check: 'team', title: 'Add your manager, finance agent and booth workers', why: 'The election agent signs off the expenditure register; booth workers use the canvassing app.' },
  { id: 'rolls', phase: 'before_launch', check: 'rolls', title: 'Import the electoral roll copy for each booth you will canvass', why: 'Give the source: who supplied it and when. The copy is kept as proof and deleted after the election.' },
  { id: 'content', phase: 'before_launch', check: 'contentApproved', title: 'Fill in and approve the voter pages', why: 'Pages stay hidden from voters until the candidate approves them. Record Punjabi and Hindi voices for each page.' },
  { id: 'mcmc', phase: 'before_first_call', check: 'manual', title: 'Get every script, text and advertisement certified by the district MCMC committee', why: 'Enter the certificate number when approving. A call or text without one is blocked.' },
  { id: 'dlt', phase: 'before_first_call', check: 'dlt', title: 'Register the sender header and SMS templates on the DLT portal', why: 'Indian operators drop texts that are not sent from a registered template.' },
  { id: 'calling-hours', phase: 'before_first_call', check: 'callingHours', title: 'Calling hours confirmed by Wayne E Solutions', why: 'Voice calls stay blocked until the permitted hours are confirmed with the telecom provider.' },
  { id: 'counsel', phase: 'before_first_call', check: 'manual', title: 'Legal sign-off on the AI disclosure wording, consent texts and evidence format', why: 'The draft wording ships with a "confirm with counsel" flag until this is done.' },
  { id: 'retention', phase: 'before_first_call', check: 'retention', title: 'Choose when personal data is deleted after the election', why: 'The privacy promise to voters. Counsel confirms the number of days.' },
  { id: 'pilot', phase: 'before_first_call', check: 'manual', title: 'Pilot one booth with about 50 people before a full run', why: 'Check consent, calling hours and the evidence pack on a small group first.' },
  { id: 'permissions', phase: 'before_election', check: 'manual', title: 'Apply for permission for each rally, sabha and vehicle', why: 'An event cannot be confirmed here until its permission reference is entered.' },
];

const MANITOBA_CHECKLIST: ChecklistItem[] = [
  { id: 'profile', phase: 'before_launch', check: 'slug', title: 'Set the campaign page address and candidate name', why: 'Voters reach the campaign at this address (it is on signs and in texts).' },
  { id: 'poll-close', phase: 'before_launch', check: 'pollClose', title: 'Enter the voting-day close time', why: 'Needed to apply any blackout period for calls and texts.' },
  { id: 'agent', phase: 'before_launch', check: 'manual', title: 'Appoint your official agent and register the campaign with Elections Manitoba', why: 'The official agent signs the finance return. Check Elections Manitoba for the current requirements and deadlines.' },
  { id: 'spend-limit', phase: 'before_launch', check: 'spendLimit', title: 'Enter the spending limit from Elections Manitoba', why: 'The platform does not guess provincial limits: take the figure for your race from the election office.' },
  { id: 'team', phase: 'before_launch', check: 'team', title: 'Add your manager, finance agent and canvassers', why: 'Canvassers use the door-to-door app; the finance agent keeps the register.' },
  { id: 'content', phase: 'before_launch', check: 'contentApproved', title: 'Fill in and approve the voter pages', why: 'Pages are hidden until the candidate approves them. English, French, Punjabi and Tagalog are available; have a native speaker review translated text.' },
  { id: 'counsel', phase: 'before_first_call', check: 'manual', title: 'Counsel confirms the calling hours, AI disclosure wording and consent texts', why: 'Calling hours follow the CRTC rules for unsolicited telecommunications; texts need consent. The draft values carry a "confirm with counsel" flag.' },
  { id: 'calling-hours', phase: 'before_first_call', check: 'callingHours', title: 'Calling hours in place', why: 'Voice calls are blocked outside the permitted hours.' },
  { id: 'retention', phase: 'before_first_call', check: 'retention', title: 'Choose when personal data is deleted after the election', why: 'The privacy promise to voters. Counsel confirms the number of days.' },
  { id: 'pilot', phase: 'before_first_call', check: 'manual', title: 'Pilot a few streets before a full run', why: 'Check consent, calling hours and the evidence pack on a small group first.' },
  { id: 'signs', phase: 'before_election', check: 'manual', title: 'Check sign rules with the municipality and Elections Manitoba', why: 'Sign placement rules differ by municipality.' },
];

const PUNJAB_CONTENT: PackContent[] = [
  { kind: 'page', locale: 'pa', title: 'ਸਾਡੀ ਯੋਜਨਾ', body: '⟦ਇਸ ਇਲਾਕੇ ਲਈ ਉਮੀਦਵਾਰ ਦੀ ਯੋਜਨਾ ਇੱਥੇ ਲਿਖੋ: ਪਾਣੀ, ਸੜਕਾਂ, ਸਿਹਤ, ਸਿੱਖਿਆ।⟧' },
  { kind: 'page', locale: 'hi', title: 'हमारी योजना', body: '⟦इस इलाके के लिए उम्मीदवार की योजना यहाँ लिखें: पानी, सड़कें, स्वास्थ्य, शिक्षा।⟧' },
  { kind: 'page', locale: 'en', title: 'Our plan', body: '⟦Write the candidate\'s plan for this area here: water, roads, health, education.⟧' },
  { kind: 'faq', locale: 'pa', title: 'ਮੁਹਿੰਮ ਦੇ ਦਫ਼ਤਰ ਨਾਲ ਕਿਵੇਂ ਸੰਪਰਕ ਕਰੀਏ?', body: '⟦ਦਫ਼ਤਰ ਦਾ ਪਤਾ, ਫ਼ੋਨ ਅਤੇ ਸਮਾਂ ਲਿਖੋ।⟧' },
  { kind: 'faq', locale: 'hi', title: 'अभियान कार्यालय से कैसे संपर्क करें?', body: '⟦कार्यालय का पता, फ़ोन और समय लिखें।⟧' },
  { kind: 'faq', locale: 'en', title: 'How do I contact the campaign office?', body: '⟦Write the office address, phone and hours.⟧' },
  {
    kind: 'script', locale: 'pa', title: 'ਇਲਾਕੇ ਦਾ ਸਰਵੇ', body: '{DISCLOSURE} ਇਹ {CAMPAIGN} ਵੱਲੋਂ ਇੱਕ ਛੋਟਾ ਸਰਵੇ ਹੈ। ਤੁਹਾਡੇ ਇਲਾਕੇ ਦਾ ਸਭ ਤੋਂ ਵੱਡਾ ਮਸਲਾ ਕੀ ਹੈ? ਪਾਣੀ ਲਈ 1, ਸੜਕਾਂ ਲਈ 2, ਬਿਜਲੀ ਲਈ 3, ਸਿਹਤ ਲਈ 4, ਸਿੱਖਿਆ ਲਈ 5, ਰੁਜ਼ਗਾਰ ਲਈ 6 ਦਬਾਓ। ਧੰਨਵਾਦ।',
    survey: IN_SURVEY('ਤੁਹਾਡੇ ਇਲਾਕੇ ਦਾ ਸਭ ਤੋਂ ਵੱਡਾ ਮਸਲਾ ਕੀ ਹੈ?', { water: 'ਪਾਣੀ', roads: 'ਸੜਕਾਂ', electricity: 'ਬਿਜਲੀ', health: 'ਸਿਹਤ', education: 'ਸਿੱਖਿਆ', jobs: 'ਰੁਜ਼ਗਾਰ' }),
  },
  {
    kind: 'script', locale: 'hi', title: 'इलाके का सर्वे', body: '{DISCLOSURE} यह {CAMPAIGN} की ओर से एक छोटा सर्वे है। आपके इलाके की सबसे बड़ी समस्या क्या है? पानी के लिए 1, सड़कों के लिए 2, बिजली के लिए 3, स्वास्थ्य के लिए 4, शिक्षा के लिए 5, रोज़गार के लिए 6 दबाएँ। धन्यवाद।',
    survey: IN_SURVEY('आपके इलाके की सबसे बड़ी समस्या क्या है?', { water: 'पानी', roads: 'सड़कें', electricity: 'बिजली', health: 'स्वास्थ्य', education: 'शिक्षा', jobs: 'रोज़गार' }),
  },
  {
    kind: 'script', locale: 'en', title: 'Area survey', body: '{DISCLOSURE} This is a short survey from {CAMPAIGN}. What is the biggest problem in your area? Press 1 for water, 2 for roads, 3 for electricity, 4 for health, 5 for education, 6 for jobs. Thank you.',
    survey: IN_SURVEY('What is the biggest problem in your area?', { water: 'Water', roads: 'Roads', electricity: 'Electricity', health: 'Health', education: 'Education', jobs: 'Jobs' }),
  },
];

const MB_SURVEY = (question: string, l: [string, string, string, string, string, string]): PackSurveyQuestion[] => [{
  key: 'top_issue', question,
  options: ['roads_transit', 'housing', 'health', 'schools', 'safety', 'jobs_cost'].map((value, i) => ({ value, label: l[i]!, dtmf: String(i + 1) })),
}];

const MANITOBA_CONTENT: PackContent[] = [
  { kind: 'page', locale: 'en', title: 'Our plan', body: '⟦Write the candidate\'s plan for this area here.⟧' },
  { kind: 'page', locale: 'fr', title: 'Notre plan', body: '⟦Écrivez ici le plan du candidat pour ce secteur.⟧' },
  { kind: 'page', locale: 'pa', title: 'ਸਾਡੀ ਯੋਜਨਾ', body: '⟦ਇਸ ਇਲਾਕੇ ਲਈ ਉਮੀਦਵਾਰ ਦੀ ਯੋਜਨਾ ਇੱਥੇ ਲਿਖੋ।⟧' },
  { kind: 'page', locale: 'tl', title: 'Ang aming plano', body: '⟦Isulat dito ang plano ng kandidato para sa lugar na ito.⟧' },
  { kind: 'faq', locale: 'en', title: 'How do I contact the campaign office?', body: '⟦Write the office address, phone and hours.⟧' },
  { kind: 'faq', locale: 'fr', title: 'Comment joindre le bureau de campagne ?', body: "⟦Écrivez l'adresse, le téléphone et les heures du bureau.⟧" },
  {
    kind: 'script', locale: 'en', title: 'Neighbourhood survey', body: '{DISCLOSURE} We are asking neighbours one question. What is the most important issue in your area? Press 1 for roads and transit, 2 for housing, 3 for health care, 4 for schools, 5 for safety, 6 for jobs and cost of living. Thank you.',
    survey: MB_SURVEY('What is the most important issue in your area?', ['Roads and transit', 'Housing', 'Health care', 'Schools', 'Safety', 'Jobs and cost of living']),
  },
  {
    kind: 'script', locale: 'fr', title: 'Sondage de quartier', body: "{DISCLOSURE} Nous posons une question à nos voisins. Quel est l'enjeu le plus important dans votre secteur ? Appuyez sur 1 pour les routes et le transport en commun, 2 pour le logement, 3 pour les soins de santé, 4 pour les écoles, 5 pour la sécurité, 6 pour l'emploi et le coût de la vie. Merci.",
    survey: MB_SURVEY("Quel est l'enjeu le plus important dans votre secteur ?", ['Routes et transport', 'Logement', 'Soins de santé', 'Écoles', 'Sécurité', 'Emploi et coût de la vie']),
  },
  {
    kind: 'script', locale: 'tl', title: 'Survey sa kapitbahayan', body: '{DISCLOSURE} Isang tanong ito para sa mga kapitbahay. Ano ang pinakamahalagang isyu sa inyong lugar? Pindutin ang 1 para sa kalsada at transit, 2 para sa pabahay, 3 para sa kalusugan, 4 para sa paaralan, 5 para sa kaligtasan, 6 para sa trabaho at gastusin. Salamat.',
    survey: MB_SURVEY('Ano ang pinakamahalagang isyu sa inyong lugar?', ['Kalsada at transit', 'Pabahay', 'Kalusugan', 'Paaralan', 'Kaligtasan', 'Trabaho at gastusin']),
  },
];

export const PACKS: ElectionPack[] = [
  {
    id: 'in-punjab-2027', region: 'IN', title: 'Punjab Vidhan Sabha 2027', election: 'Punjab Legislative Assembly general election, due early 2027 (confirm the schedule with the Election Commission of India)',
    raceTypes: ['assembly'], locales: ['pa', 'hi', 'en'], enabledModules: ['hub', 'assistant', 'calls', 'field', 'ops', 'finance', 'results'], content: PUNJAB_CONTENT, checklist: PUNJAB_CHECKLIST,
    confirmWithCounsel: ['callingHours', 'aiDisclosure.spoken', 'silenceWindowHours', 'spendLimit', 'retentionDays'],
  },
  {
    id: 'ca-mb-2027', region: 'CA', province: 'MB', title: 'Manitoba provincial election 2027', election: 'Manitoba general election, fixed date in October 2027 (confirm with Elections Manitoba)',
    raceTypes: ['municipal', 'ward', 'other'], locales: ['en', 'fr', 'pa', 'tl'], enabledModules: ['hub', 'assistant', 'calls', 'field', 'ops', 'finance', 'results'], content: MANITOBA_CONTENT, checklist: MANITOBA_CHECKLIST,
    confirmWithCounsel: ['callingHours', 'aiDisclosure.spoken', 'spendLimit', 'contributionLimit', 'retentionDays', 'expenseCategories'],
  },
];

export const packsFor = (region: RegionCode) => PACKS.filter((p) => p.region === region);
export const getPack = (id: string) => PACKS.find((p) => p.id === id);
