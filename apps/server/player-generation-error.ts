/** Keep operator accounting diagnostics in the ledger, not in player responses or caches. */
export function playerGenerationError(code: string | null): string | null {
  if (code === null) return null;
  if (['BETA_USAGE_LIMIT', 'COST_PRICE_REQUIRED', 'COST_BUDGET_REQUIRED', 'COST_RESERVATION_EXPIRED'].includes(code))
    return 'BETA_USAGE_LIMIT';
  if (
    code.startsWith('COST_') ||
    code.startsWith('INVALID_COST_') ||
    code === 'BETA_METERING_REQUIRED' ||
    code === 'BETA_TEXT_PROTOCOL_REQUIRED'
  )
    return 'GENERATION_FAILED';
  return code;
}
