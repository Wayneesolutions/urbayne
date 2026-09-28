export const money = (minor: number | null | undefined, currency: 'INR' | 'CAD') =>
  minor == null ? '–' : new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-CA', { style: 'currency', currency, maximumFractionDigits: currency === 'INR' ? 0 : 2 }).format(minor / 100);
export const toMinor = (s: string) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);
