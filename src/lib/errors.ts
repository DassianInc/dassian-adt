/**
 * SAP ADT error parsing.
 * The ADT API returns errors in several formats — this extracts the human-readable message
 * and detects specific conditions (upgrade mode, session timeout) that need special handling.
 */

export interface AdtErrorInfo {
  message: string;
  isSessionTimeout: boolean;
  isUpgradeMode: boolean;
  isLocked: boolean;
  isNotFound: boolean;
  /** True when a 400 has no meaningful body — typically a stale CSRF token or expired session. */
  isAmbiguous400: boolean;
  httpStatus?: number;
}

export function parseAdtError(error: any): AdtErrorInfo {
  // Extract message from various error shapes
  // The abap-adt-api library wraps responses as {body, status, headers} (not axios's {data}).
  // Check both .data (axios shape) and .body (library shape) so SAP error bodies surface correctly.
  let rawMessage: string =
    error?.response?.data?.message ||
    error?.response?.data?.['message'] ||
    (typeof error?.response?.data === 'string' ? error.response.data : '') ||
    (typeof error?.response?.body === 'string' ? error.response.body : '') ||
    error?.message ||
    'Unknown error';

  // SAP ADT returns "I::000" (or similar X::NNN format) when the ADT resource URL is wrong
  // for the object type — typically means "container object has no source endpoint" or "wrong path".
  if (/^[A-Z]+::\d+$/.test(rawMessage.trim())) {
    rawMessage = `SAP ADT returned opaque error code "${rawMessage.trim()}" — this usually means the URL path is wrong for this object type. ` +
      `If you requested source for a FUGR/F (function group), note that function groups are containers with no direct source — ` +
      `use FUGR/I for includes or FUGR/FF for function modules instead.`;
  }

  // SAP rejects writes to system-generated L-prefix includes with this message.
  // The real issue is that you're trying to write to the generated include instead of the FM endpoint.
  if (
    rawMessage.includes('This syntax cannot be used for an object name') ||
    rawMessage.includes('syntax cannot be used')
  ) {
    rawMessage =
      `SAP rejected the object name — this typically means you are writing to a system-generated ` +
      `L-prefix include (e.g. /DSN/L010BWE_01U01), which is read-only. ` +
      `Write to the parent function module instead using type=FUGR/FF with the fugr parameter.`;
  }

  const msg = rawMessage.toLowerCase();
  const status: number | undefined = error?.response?.status;

  // A 400 on basic read operations (get_source, abap_table, abap_search) often means
  // the session cookie has expired — SAP returns 400 instead of 401 in this case.
  // We detect this by checking for 400 with no meaningful error message (empty or generic).
  // Legitimate 400s (bad search pattern, missing param) have descriptive messages.
  const isAmbiguous400 =
    status === 400 &&
    (rawMessage === 'Unknown error' ||
      rawMessage.includes('status code 400') ||  // covers "Error: Request failed with status code 400" prefix variants
      rawMessage.trim() === '' ||
      rawMessage === 'Bad Request');

  return {
    message: rawMessage,
    isSessionTimeout:
      msg.includes('session timed out') ||
      msg.includes('session not found') ||
      msg.includes('not logged on') ||
      status === 401 ||
      isAmbiguous400,
    isUpgradeMode:
      msg.includes('adjustment mode') ||
      msg.includes('in adjustment') ||
      msg.includes('upgradeflag'),
    isLocked:
      // Only true when another user/session holds the lock — not when a lock
      // fails due to object state (inconsistent, syntax errors, etc.)
      (msg.includes('already locked') ||
       msg.includes('locked by user') ||
       msg.includes('locked by another') ||
       // 'enqueue' alone is too broad — SAP uses it in activation-error messages too.
       // Only treat as a lock when enqueue failure implies another holder.
       (msg.includes('enqueue') && (msg.includes('user') || msg.includes('another') || msg.includes('hold')))
      ) &&
      !msg.includes('inconsistent') &&
      !msg.includes('syntax error') &&
      !msg.includes('not active') &&
      !msg.includes('inactive'),
    isNotFound:
      status === 404 ||
      msg.includes('does not exist') ||
      msg.includes('not found'),
    isAmbiguous400,
    httpStatus: status,
  };
}

/**
 * Format a user-facing error message, surfacing actionable context.
 */
export function formatError(operation: string, error: any): string {
  const info = parseAdtError(error);

  if (info.isUpgradeMode) {
    return (
      `${operation} failed: object is in SPAU adjustment mode (upgradeFlag=true). ` +
      `This cannot be resolved via ADT — use SPAU_ENH in SAP GUI to clear the adjustment status first.`
    );
  }

  // A 400 with no meaningful body is almost always a stale CSRF token caused by an expired or
  // externally-killed session (SM04). withSession already attempted a re-login — if the error
  // still reaches here the session state is genuinely broken. Call login() explicitly to reset.
  if (info.isAmbiguous400) {
    return (
      `${operation} failed: HTTP 400 with no error detail — this is a stale CSRF token or expired ` +
      `session, NOT a bad request. Call login() to establish a fresh session, then retry the operation.`
    );
  }

  if (info.isLocked) {
    return (
      `${operation} failed: object is locked by another user or session. ` +
      `Check SM12 to see who holds the lock. ` +
      `If SM12 is empty, the lock is a stale ADT enqueue entry from an expired session — ` +
      `call login() to refresh the session (withSession will retry automatically), or use abap_unlock.`
    );
  }

  // Lock attempt failed for a non-user-lock reason (inconsistency, syntax errors, etc.)
  // Surface the actual SAP message so the agent doesn't go hunting for a phantom lock.
  const msg = info.message.toLowerCase();
  if (msg.includes('enqueue') || msg.includes('cannot be locked') || msg.includes('lock failed')) {
    return (
      `${operation} failed: lock was rejected — NOT a user/session lock. ` +
      `SAP reason: ${info.message}. ` +
      `Check if the object has syntax errors or is in an inconsistent state (run abap_syntax_check).`
    );
  }

  if (info.isNotFound) {
    return (
      `${operation} failed: object not found. ` +
      `Verify the name, type, and that the object exists on this system. ` +
      `(${info.message})`
    );
  }

  return `${operation} failed: ${info.message}`;
}

/**
 * Enrich activation message objects with actionable hints.
 * SAP returns messages like "Syntax error in program" with no guidance — add context.
 */
export function formatActivationMessages(messages: any[]): string {
  if (!messages || messages.length === 0) return 'Activation failed — no error messages returned.';

  return messages.map((m: any) => {
    const type = m.type || 'E';
    const raw = m.shortText || m.objDescr || m.text || JSON.stringify(m);
    const text = typeof raw === 'string' ? raw : String(raw);
    const lower = text.toLowerCase();

    let hint = '';
    if (lower.includes('syntax error') || lower.includes('program contains syntax')) {
      hint = ' → Run abap_syntax_check to see the exact error location.';
    } else if (lower.includes('inactive') || lower.includes('not active')) {
      hint = ' → Activate the listed dependent objects first, then retry.';
    } else if (lower.includes('cannot be used for an object name') || lower.includes('this syntax cannot')) {
      hint = ' → This object type does not support direct source writes via this path. Check the object type is correct.';
    } else if (lower.includes('unmasked') || lower.includes('string template')) {
      hint = ' → Pipe characters (|) are ABAP string template delimiters. Escape literal pipes inside templates with \\|, or use CONCATENATE instead of string templates.';
    } else if (lower.includes('locked')) {
      hint = ' → Object is locked. Check SM12 for active locks.';
    }

    return `[${type}] ${text}${hint}`;
  }).join('\n');
}
