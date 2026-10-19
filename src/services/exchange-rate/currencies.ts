/**
 * ISO 4217 currencies that Frankfurter (ECB reference rates) publishes, mapped to
 * the number of minor-unit decimal places used when rounding converted amounts.
 */
export const SUPPORTED_CURRENCIES: Readonly<Record<string, number>> = Object.freeze({
  AUD: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  ISK: 0,
  JPY: 0,
  KRW: 0,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  PHP: 2,
  PLN: 2,
  RON: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TRY: 2,
  USD: 2,
  ZAR: 2,
});

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, code);
}

export function minorUnits(code: string): number {
  const units = SUPPORTED_CURRENCIES[code];
  if (units === undefined) throw new Error(`Unsupported currency ${code}`);
  return units;
}
