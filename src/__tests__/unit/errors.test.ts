import { parseAdtError, formatError, formatActivationMessages } from '../../lib/errors';

describe('parseAdtError', () => {
  describe('message extraction', () => {
    it('from response.data.message', () => {
      const info = parseAdtError({ response: { data: { message: 'Object not found' } } });
      expect(info.message).toBe('Object not found');
    });

    it('from string response.data', () => {
      const info = parseAdtError({ response: { data: 'Raw error string' } });
      expect(info.message).toBe('Raw error string');
    });

    it('from error.message', () => {
      const info = parseAdtError({ message: 'Connection refused' });
      expect(info.message).toBe('Connection refused');
    });

    it('defaults to Unknown error for empty object', () => {
      expect(parseAdtError({}).message).toBe('Unknown error');
    });

    it('defaults to Unknown error for null', () => {
      expect(parseAdtError(null).message).toBe('Unknown error');
    });

    it('defaults to Unknown error for undefined', () => {
      expect(parseAdtError(undefined).message).toBe('Unknown error');
    });
  });

  describe('opaque error codes', () => {
    it('enriches I::000', () => {
      const info = parseAdtError({ response: { data: 'I::000' } });
      expect(info.message).toContain('URL path is wrong');
    });

    it('enriches E::123', () => {
      const info = parseAdtError({ response: { data: 'E::123' } });
      expect(info.message).toContain('URL path is wrong');
    });

    it('enriches with FUGR hint', () => {
      const info = parseAdtError({ response: { data: 'I::000' } });
      expect(info.message).toContain('FUGR/I');
    });

    it('does not enrich normal messages', () => {
      const info = parseAdtError({ message: 'Normal error' });
      expect(info.message).not.toContain('URL path is wrong');
    });
  });

  describe('L-prefix include detection', () => {
    it('detects "This syntax cannot be used for an object name"', () => {
      const info = parseAdtError({ message: 'This syntax cannot be used for an object name' });
      expect(info.message).toContain('system-generated');
      expect(info.message).toContain('FUGR/FF');
    });

    it('detects partial match "syntax cannot be used"', () => {
      const info = parseAdtError({ message: 'The syntax cannot be used here' });
      expect(info.message).toContain('system-generated');
    });
  });

  describe('session timeout', () => {
    it('detects "session timed out"', () => {
      expect(parseAdtError({ message: 'Session timed out' }).isSessionTimeout).toBe(true);
    });

    it('detects "session not found"', () => {
      expect(parseAdtError({ message: 'Session not found' }).isSessionTimeout).toBe(true);
    });

    it('detects "not logged on"', () => {
      expect(parseAdtError({ message: 'Not logged on' }).isSessionTimeout).toBe(true);
    });

    it('detects HTTP 401', () => {
      expect(parseAdtError({ response: { status: 401 } }).isSessionTimeout).toBe(true);
    });

    it('false for normal errors', () => {
      expect(parseAdtError({ message: 'Object not found' }).isSessionTimeout).toBe(false);
    });
  });

  describe('upgrade mode', () => {
    it('detects "adjustment mode"', () => {
      expect(parseAdtError({ message: 'Enhancement is in adjustment mode' }).isUpgradeMode).toBe(true);
    });

    it('detects "in adjustment"', () => {
      expect(parseAdtError({ message: 'Object is in adjustment' }).isUpgradeMode).toBe(true);
    });

    it('detects "upgradeflag"', () => {
      expect(parseAdtError({ message: 'upgradeFlag set' }).isUpgradeMode).toBe(true);
    });

    it('false for normal errors', () => {
      expect(parseAdtError({ message: 'Object not found' }).isUpgradeMode).toBe(false);
    });
  });

  describe('locked', () => {
    it('detects "already locked"', () => {
      expect(parseAdtError({ message: 'Object already locked' }).isLocked).toBe(true);
    });

    it('detects "locked by user"', () => {
      expect(parseAdtError({ message: 'Locked by user PMCF' }).isLocked).toBe(true);
    });

    it('detects "enqueue" with user context', () => {
      // "enqueue" alone is too broad — activation errors also say "enqueue".
      // Lock is only detected when enqueue failure implies another holder.
      expect(parseAdtError({ message: 'Enqueue failed by user PMCF' }).isLocked).toBe(true);
      expect(parseAdtError({ message: 'Enqueue hold by another' }).isLocked).toBe(true);
      expect(parseAdtError({ message: 'Enqueue failed' }).isLocked).toBe(false);
    });

    it('false for normal errors', () => {
      expect(parseAdtError({ message: 'Object not found' }).isLocked).toBe(false);
    });
  });

  describe('not found', () => {
    it('detects HTTP 404', () => {
      expect(parseAdtError({ response: { status: 404 } }).isNotFound).toBe(true);
    });

    it('detects "does not exist"', () => {
      expect(parseAdtError({ message: 'Object does not exist' }).isNotFound).toBe(true);
    });

    it('detects "not found"', () => {
      expect(parseAdtError({ message: 'Resource not found' }).isNotFound).toBe(true);
    });

    it('false for normal errors', () => {
      expect(parseAdtError({ message: 'Syntax error' }).isNotFound).toBe(false);
    });
  });

  describe('httpStatus', () => {
    it('extracts from response', () => {
      expect(parseAdtError({ response: { status: 500 } }).httpStatus).toBe(500);
    });

    it('undefined when no response', () => {
      expect(parseAdtError({ message: 'Error' }).httpStatus).toBeUndefined();
    });
  });
});

describe('formatError', () => {
  it('upgrade mode → mentions SPAU', () => {
    const result = formatError('abap_delete(FOO)', { message: 'Enhancement is in adjustment mode' });
    expect(result).toContain('SPAU');
    expect(result).toContain('upgradeFlag');
  });

  it('locked → mentions SM12', () => {
    const result = formatError('abap_set_source(FOO)', { message: 'Object already locked' });
    expect(result).toContain('SM12');
  });

  it('not found → mentions verify name', () => {
    const result = formatError('abap_get_source(FOO)', { response: { status: 404 } });
    expect(result).toContain('not found');
    expect(result).toContain('Verify');
  });

  it('generic → includes raw message', () => {
    const result = formatError('abap_search(FOO)', { message: 'Connection reset' });
    expect(result).toContain('Connection reset');
  });

  it('always includes operation name', () => {
    expect(formatError('test_op', { message: 'fail' })).toContain('test_op');
  });
});

describe('formatActivationMessages', () => {
  it('handles empty array', () => {
    expect(formatActivationMessages([])).toContain('no error messages');
  });

  it('handles null', () => {
    expect(formatActivationMessages(null as any)).toContain('no error messages');
  });

  it('formats type prefix', () => {
    const result = formatActivationMessages([{ type: 'E', shortText: 'Syntax error in line 10' }]);
    expect(result).toContain('[E]');
    expect(result).toContain('Syntax error');
  });

  it('adds syntax check hint', () => {
    const result = formatActivationMessages([{ type: 'E', shortText: 'Program contains syntax errors' }]);
    expect(result).toContain('abap_syntax_check');
  });

  it('adds inactive dependency hint', () => {
    const result = formatActivationMessages([{ type: 'W', shortText: 'Object is not active' }]);
    expect(result).toContain('Activate the listed dependent');
  });

  it('adds pipe/string template hint', () => {
    const result = formatActivationMessages([{ type: 'E', shortText: 'Unmasked symbol | in string template' }]);
    expect(result).toContain('Escape literal pipes');
  });

  it('adds locked hint', () => {
    const result = formatActivationMessages([{ type: 'E', shortText: 'Object is locked' }]);
    expect(result).toContain('SM12');
  });

  it('uses objDescr fallback', () => {
    const result = formatActivationMessages([{ type: 'E', objDescr: 'ZCLAS ZCL_FOO' }]);
    expect(result).toContain('ZCL_FOO');
  });

  it('handles non-string shortText (number)', () => {
    const result = formatActivationMessages([{ type: 'E', shortText: 42 }]);
    expect(result).toContain('[E]');
    expect(result).toContain('42');
    // Should not crash — text.toLowerCase() must work on coerced value
  });

  it('handles non-string shortText (object)', () => {
    const result = formatActivationMessages([{ type: 'E', shortText: { msg: 'nested' } }]);
    expect(result).toContain('[E]');
    // Should not crash
  });

  it('handles message with no text fields (JSON fallback)', () => {
    const result = formatActivationMessages([{ type: 'E' }]);
    expect(result).toContain('[E]');
  });

  it('joins multiple messages with newlines', () => {
    const result = formatActivationMessages([
      { type: 'E', shortText: 'Error one' },
      { type: 'W', shortText: 'Warning two' }
    ]);
    expect(result).toContain('Error one');
    expect(result).toContain('Warning two');
    expect(result.split('\n')).toHaveLength(2);
  });

  it('defaults type to E when missing', () => {
    const result = formatActivationMessages([{ shortText: 'Something failed' }]);
    expect(result).toContain('[E]');
  });
});

describe('TK164 transport-request locks (retryable)', () => {
  const tk164 = 'Internal error: Request X22K904156 is locked; action canceled [corrNr=*; T100KEY-ID=TK; T100KEY-NO=164; T100KEY-V1=X22K904156]';

  it('classifies "Request X is locked; action canceled" as locked', () => {
    expect(parseAdtError({ message: tk164 }).isLocked).toBe(true);
  });

  it('classifies via the TK/164 message-key bag', () => {
    const info = parseAdtError({ message: 'something [T100KEY-ID=TK; T100KEY-NO=164]' });
    expect(info.isLocked).toBe(true);
  });

  it('does not misclassify TK164 as a session timeout', () => {
    expect(parseAdtError({ message: tk164 }).isSessionTimeout).toBe(false);
  });

  it('still classifies classic object locks', () => {
    expect(parseAdtError({ message: 'Object is already locked by user PMCFARLING' }).isLocked).toBe(true);
  });

  it('still excludes object-state failures dressed up with "locked"', () => {
    // inconsistent/syntax/inactive must NOT be treated as retryable user locks
    expect(parseAdtError({ message: 'object is inconsistent and cannot be locked' }).isLocked).toBe(false);
  });
});

describe('HTTP status extracted from message string', () => {
  it('treats bare "Request failed with status code 400" as ambiguous-400 session drop', () => {
    // Library re-wraps the axios error and loses .response.status / .err
    const info = parseAdtError({ message: 'Error: Request failed with status code 400' });
    expect(info.httpStatus).toBe(400);
    expect(info.isAmbiguous400).toBe(true);
    expect(info.isSessionTimeout).toBe(true);
  });

  it('extracts 404 from message and classifies not found', () => {
    const info = parseAdtError({ message: 'Error: Request failed with status code 404' });
    expect(info.httpStatus).toBe(404);
    expect(info.isNotFound).toBe(true);
  });

  it('prefers an explicit numeric status over the message', () => {
    const info = parseAdtError({ err: 405, message: 'Request failed with status code 400' });
    expect(info.httpStatus).toBe(405);
    expect(info.isLockNotSupported).toBe(true);
  });

  it('does not treat a 400 with a real body as ambiguous', () => {
    // A genuine bad-request body (e.g. a SQL error) carries no "status code NNN" axios phrasing
    // and no extractable numeric status, so it must not be classified as a session drop.
    const info = parseAdtError({ message: 'Unknown column name "FOO".' });
    expect(info.isAmbiguous400).toBe(false);
    expect(info.isSessionTimeout).toBe(false);
  });

  it('formatError on ambiguous-400 no longer pushes login() looping', () => {
    const msg = formatError('abap_get_source(X)', { message: 'Error: Request failed with status code 400' });
    expect(msg).not.toMatch(/Call login\(\)/);
    expect(msg.toLowerCase()).toContain('do not loop');
  });
});

describe('abap-adt-api 500-wrapper status lie', () => {
  // fromError/fromException wrap errors they don't recognize as AdtErrorException(500, ...)
  // with the real HTTP status only in the stringified message. Observed as the dominant
  // prod failure mode: bare 400s carrying err=500, skipping the re-login path.

  it('trusts the message status when err=500 with no response and message says 400', () => {
    const info = parseAdtError({
      err: 500,
      type: 'Unknown error',
      properties: {},
      message: 'Error: Request failed with status code 400'
    });
    expect(info.httpStatus).toBe(400);
    expect(info.isAmbiguous400).toBe(true);
    expect(info.isSessionTimeout).toBe(true);
  });

  it('handles the no-prefix hasMessage variant (fromError line 2)', () => {
    const info = parseAdtError({ err: 500, type: '', message: 'Request failed with status code 400' });
    expect(info.httpStatus).toBe(400);
    expect(info.isSessionTimeout).toBe(true);
  });

  it('trusts the message for wrapped 404s too', () => {
    const info = parseAdtError({ err: 500, message: 'Error: Request failed with status code 404' });
    expect(info.httpStatus).toBe(404);
    expect(info.isNotFound).toBe(true);
  });

  it('keeps a genuine 500 as 500', () => {
    const info = parseAdtError({ err: 500, message: 'An exception was raised' });
    expect(info.httpStatus).toBe(500);
    expect(info.isSessionTimeout).toBe(false);
  });

  it('keeps a wrapped 500 message as 500', () => {
    const info = parseAdtError({ err: 500, message: 'Error: Request failed with status code 500' });
    expect(info.httpStatus).toBe(500);
  });

  it('does not override when a real response object is present', () => {
    const info = parseAdtError({
      err: 500,
      response: { status: 500 },
      message: 'proxy said: upstream replied status code 400'
    });
    expect(info.httpStatus).toBe(500);
  });

  it('re-classifies our own formatted ambiguous-400 message (index.ts log path)', () => {
    const msg = 'MCP error -32603: abap_table(VBAP) failed: HTTP 400 with no error detail. withSession already re-logged in and retried once';
    const info = parseAdtError({ message: msg });
    expect(info.httpStatus).toBe(400);
    expect(info.isSessionTimeout).toBe(true);
  });

  it('re-classifies the withSession terminal re-login failure message', () => {
    const info = parseAdtError({ message: 'MCP error -32603: Session expired and re-login failed: Request failed with status code 400' });
    expect(info.isSessionTimeout).toBe(true);
  });
});
