/**
 * Supabase Edge Functions return useful JSON error bodies, but supabase-js wraps
 * non-2xx responses in a FunctionsHttpError. This helper unwraps the response
 * when possible so the UI can show the real server-side validation message.
 */
export async function throwFunctionError(error: unknown, fallbackMessage: string): Promise<never> {
  const response = getFunctionErrorResponse(error);
  if (response) {
    try {
      const payload = await response.clone().json() as { error?: unknown; message?: unknown };
      const message = normalizeErrorMessage(payload.error) || normalizeErrorMessage(payload.message);
      if (message) throw new Error(message);
    } catch (jsonError) {
      if (jsonError instanceof Error && jsonError.message && jsonError.message !== 'Unexpected end of JSON input') {
        throw jsonError;
      }
    }

    try {
      const text = await response.clone().text();
      if (text.trim()) throw new Error(text.trim());
    } catch (textError) {
      if (textError instanceof Error && textError.message) throw textError;
    }
  }

  if (error instanceof Error && error.message) throw error;
  throw new Error(fallbackMessage);
}

function getFunctionErrorResponse(error: unknown): Response | null {
  if (!error || typeof error !== 'object') return null;
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) return context;
  const response = (error as { response?: unknown }).response;
  if (response instanceof Response) return response;
  return null;
}

function normalizeErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message.trim();
  }
  return '';
}
