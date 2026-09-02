import { splitEol, normEol, restoreEol, looseMatch } from '../../handlers/SourceHandlers';

/**
 * Regression cover for the abap_edit_method matching bug: SAP returns source with CRLF,
 * callers compose old_string with LF, so every multi-line edit missed and fell into the
 * "not found" path. See splitEol/looseMatch in SourceHandlers.ts.
 */
describe('line-ending normalisation', () => {
  const sapSource = 'METHOD raise_event01.\r\n  DATA lv TYPE i.\r\n  lv = 1.\r\nENDMETHOD.';

  it('detects CRLF source and normalises it to LF', () => {
    const { source, eol } = splitEol(sapSource);
    expect(eol).toBe('\r\n');
    expect(source).not.toContain('\r');
    expect(source.split('\n')).toHaveLength(4);
  });

  it('reports LF for source that has no CRLF', () => {
    expect(splitEol('METHOD x.\nENDMETHOD.').eol).toBe('\n');
  });

  it('round-trips CRLF source unchanged', () => {
    const { source, eol } = splitEol(sapSource);
    expect(restoreEol(source, eol)).toBe(sapSource);
  });

  it('leaves LF source alone on restore', () => {
    expect(restoreEol('a\nb', '\n')).toBe('a\nb');
  });

  it('makes an LF old_string match CRLF source — the actual bug', () => {
    const lfNeedle = '  DATA lv TYPE i.\n  lv = 1.';
    // What the tool used to do: match the caller's LF string against raw CRLF source.
    expect(sapSource.includes(lfNeedle)).toBe(false);
    // What it does now.
    expect(splitEol(sapSource).source.includes(normEol(lfNeedle))).toBe(true);
  });

  it('also accepts an old_string that already uses CRLF', () => {
    const crlfNeedle = '  DATA lv TYPE i.\r\n  lv = 1.';
    expect(splitEol(sapSource).source.includes(normEol(crlfNeedle))).toBe(true);
  });

  it('normEol passes non-strings through untouched', () => {
    expect(normEol(undefined as any)).toBeUndefined();
  });
});

describe('looseMatch', () => {
  const body = 'METHOD go.\n    IF lv_flag = abap_true.\n        rv = 1.\n    ENDIF.\nENDMETHOD.';

  it('matches across differing indentation and returns the real substring', () => {
    const hit = looseMatch(body, 'IF lv_flag = abap_true.\n  rv = 1.\n  ENDIF.');
    expect(hit).toBe('    IF lv_flag = abap_true.\n        rv = 1.\n    ENDIF.');
    // The returned substring must be usable directly as old_string.
    expect(body.includes(hit!)).toBe(true);
  });

  it('captures the first line\'s indentation so a replacement does not double it', () => {
    const hit = looseMatch(body, 'IF lv_flag = abap_true.\n rv = 1.\n ENDIF.');
    expect(hit!.startsWith('    IF')).toBe(true);
  });

  it('refuses to guess when the needle matches more than once', () => {
    const twice = 'METHOD go.\n  a = 1.\n  b = 2.\n  a = 1.\n  b = 2.\nENDMETHOD.';
    expect(looseMatch(twice, 'a = 1.\nb = 2.')).toBeNull();
  });

  it('returns null for a single-line needle — too weak a signal to loosen', () => {
    expect(looseMatch(body, 'rv = 1.')).toBeNull();
  });

  it('returns null when the text genuinely is not there', () => {
    expect(looseMatch(body, 'CALL FUNCTION Z_NOPE.\n  EXPORTING x = 1.')).toBeNull();
  });

  it('ignores leading and trailing blank lines in the needle', () => {
    expect(looseMatch(body, '\nIF lv_flag = abap_true.\n  rv = 1.\n  ENDIF.\n')).not.toBeNull();
  });

  it('does not treat regex metacharacters in ABAP as pattern syntax', () => {
    const meta = 'METHOD go.\n  lv = |{ a }|.\n  rv = lv+0(3).\nENDMETHOD.';
    expect(looseMatch(meta, 'lv = |{ a }|.\nrv = lv+0(3).')).toBe('  lv = |{ a }|.\n  rv = lv+0(3).');
  });
});
