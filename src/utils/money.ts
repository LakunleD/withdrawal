import Decimal from 'decimal.js';

/**
 * Decimal constructor for all monetary maths. The default decimal.js precision (20
 * significant digits) is too small for a NUMERIC(19,2) amount multiplied by an
 * exchange rate, so we raise it well above anything we can produce.
 */
export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type MoneyValue = Decimal;

/**
 * Converts a USD amount at `rate`, rounding half-up to the currency's minor units
 * (e.g. 2 for EUR, 0 for JPY).
 */
export function convertAmount(amountUsd: Decimal, rate: Decimal, minorUnits: number): Decimal {
  return new Money(amountUsd).times(rate).toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP);
}
