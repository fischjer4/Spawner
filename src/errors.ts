export class UserFacingError extends Error {}

export function friendlyError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error) {
    if (/invalid schema|response_format/i.test(error.message)) return 'The selected model rejected the summary format. The full answer is still available.';
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'The request timed out. Try again when the connection is available.';
    // AI SDK errors can include provider request bodies; only expose safe, short messages.
    if (/key|auth|401/i.test(error.message)) return 'Check the service API key in Settings.';
    if (/billing|credit|402/i.test(error.message)) return 'The service needs available credits or billing setup.';
    if (/model|404/i.test(error.message)) return 'The selected model is unavailable. Check the model ID in Settings.';
  }
  return 'The service could not complete this request. Check the connection and try again.';
}
