/**
 * api region: messages the API layer creates itself (`api/`). Text coming back
 * from the server in `error` is passed through untouched — translating it belongs
 * to the backend.
 */
export default {
  httpFailed: 'Request failed (HTTP {status})',
  failed: 'Request failed',
  cancelled: 'Request cancelled',
  networkFailed: 'Network request failed: {message}',
  unknownError: 'unknown error',
  loginExpired: 'Your session expired, please sign in again',
  noStreamSupport: 'This browser does not support streaming responses'
};
