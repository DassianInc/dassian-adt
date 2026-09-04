/**
 * Unit tests for the DOMA / DTEL create and delete paths in ObjectHandlers.
 *
 * Domains and data elements are XML-based ADT objects with no source endpoint, so
 * abap_create builds them through the classic DDIF_* function modules in a classrun.
 * These tests stub runClassrun and assert on the ABAP the handler generates — that is
 * the contract that was wrong in production (verified on d23, 2026-09-03):
 *
 *   - abap_create ignored package/transport → no TADIR row, no E071 entry (orphan)
 *   - abap_create never activated, and its DTEL stub could not activate (SCRLEN 0)
 *   - abap_create's success message pointed at abap_set_source, which 404s for XML objects
 *   - abap_delete removed DD01L/DD04L but left TADIR + E071 behind, reporting success
 *
 * No SAP connection is needed.
 */
import { ObjectHandlers } from '../../handlers/ObjectHandlers';
import { parseResult } from '../helpers/setup';

interface Harness {
  handler: ObjectHandlers;
  bodies: string[];
  runClassrun: jest.Mock;
  client: any;
}

/**
 * Build an ObjectHandlers with runClassrun stubbed. `outputs` are returned in order,
 * the last one repeating. The fake ADT client covers the lock/DELETE calls abap_delete makes.
 */
function makeHarness(outputs: string[] = ['OK']): Harness {
  const client: any = {
    lock: jest.fn(async () => ({ LOCK_HANDLE: 'LH1', CORRNR: 'D23K901888', IS_LOCAL: '' })),
    unLock: jest.fn(async () => undefined),
    h: { request: jest.fn(async () => ({})) },
  };
  const handler = new ObjectHandlers(client);
  const bodies: string[] = [];
  let i = 0;
  const runClassrun = jest.fn(async (body: string) => {
    bodies.push(body);
    const out = outputs[Math.min(i, outputs.length - 1)];
    i++;
    return out;
  });
  (handler as any).runClassrun = runClassrun;
  return { handler, bodies, runClassrun, client };
}

const DOMA_ARGS = {
  name: 'ZDUMMY_TEST_DOM',
  type: 'DOMA',
  package: 'Z_C_TEST',
  transport: 'D23K901888',
  description: 'Dummy test domain',
};

const DTEL_ARGS = {
  name: 'ZDUMMY_TEST_DTE',
  type: 'DTEL',
  package: 'Z_C_TEST',
  transport: 'D23K901888',
  description: 'Dummy test data element',
};

describe('abap_create DOMA: CTS registration and activation', () => {
  it('registers the domain in TADIR/E071 via RS_CORR_INSERT with the given package and transport', async () => {
    const { handler, bodies } = makeHarness();
    await handler.validateAndHandle('abap_create', { ...DOMA_ARGS });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/RS_CORR_INSERT/);
    expect(abap).toMatch(/object_class\s*=\s*'DOMA'/);
    expect(abap).toMatch(/devclass\s*=\s*'Z_C_TEST'/);
    expect(abap).toMatch(/korrnum\s*=\s*'D23K901888'/);
    expect(abap).toMatch(/suppress_dialog\s*=\s*'X'/);
  });

  it('activates the domain and verifies DD01L.AS4LOCAL = A before reporting success', async () => {
    const { handler, bodies } = makeHarness();
    await handler.validateAndHandle('abap_create', { ...DOMA_ARGS });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/DDIF_DOMA_ACTIVATE/);
    expect(abap).toMatch(/FROM dd01l/i);
    expect(abap).toMatch(/as4local\s*=\s*'A'/i);
    expect(abap).toMatch(/COMMIT WORK/);
  });

  it('honours datatype, length and decimals instead of hard-coding CHAR 1', async () => {
    const { handler, bodies } = makeHarness();
    await handler.validateAndHandle('abap_create', {
      ...DOMA_ARGS, datatype: 'DEC', length: 13, decimals: 2, outputLength: 16,
    });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/datatype\s*=\s*'DEC'/);
    expect(abap).toMatch(/leng\s*=\s*13\b/);
    expect(abap).toMatch(/decimals\s*=\s*2\b/);
    expect(abap).toMatch(/outputlen\s*=\s*16\b/);
    expect(abap).not.toMatch(/leng\s*=\s*1\b/);
  });

  it('emits fixed values into dd07v_tab and sets valexi when fixedValues are given', async () => {
    const { handler, bodies } = makeHarness();
    await handler.validateAndHandle('abap_create', {
      ...DOMA_ARGS,
      fixedValues: [{ value: 'ALPHA', text: 'Alpha value' }, { value: 'BETA', text: 'Beta value' }],
    });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/valexi\s*=\s*'X'/);
    expect(abap).toMatch(/dd07v_tab/);
    expect(abap).toMatch(/domvalue_l\s*=\s*'ALPHA'/);
    expect(abap).toMatch(/domvalue_l\s*=\s*'BETA'/);
    expect(abap).toMatch(/ddtext\s*=\s*'Beta value'/);
  });

  it('does not tell the caller to use abap_get_source / abap_set_source', async () => {
    const { handler } = makeHarness();
    const result = parseResult(await handler.validateAndHandle('abap_create', { ...DOMA_ARGS }));
    expect(result.status).toBe('success');
    expect(result.message).not.toMatch(/set_source|get_source/);
    expect(result.transport).toBe('D23K901888');
    expect(result.package).toBe('Z_C_TEST');
  });

  it('rejects a transportable package with no transport instead of creating an orphan', async () => {
    const { handler, runClassrun } = makeHarness();
    await expect(
      handler.validateAndHandle('abap_create', { ...DOMA_ARGS, transport: undefined })
    ).rejects.toThrow(/transport/i);
    expect(runClassrun).not.toHaveBeenCalled();
  });

  it('does not report success when the classrun did not confirm activation', async () => {
    const { handler } = makeHarness(['DDIF_DOMA_ACTIVATE rc = 8']);
    await expect(
      handler.validateAndHandle('abap_create', { ...DOMA_ARGS })
    ).rejects.toThrow(/DDIF_DOMA_ACTIVATE rc = 8/);
  });
});

describe('abap_create DTEL: activatable definition', () => {
  it('sets SCRLEN1/2/3 = 10/20/40 and HEADLEN = 55 so the element can activate', async () => {
    const { handler, bodies } = makeHarness();
    await handler.validateAndHandle('abap_create', { ...DTEL_ARGS });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/scrlen1\s*=\s*10\b/);
    expect(abap).toMatch(/scrlen2\s*=\s*20\b/);
    expect(abap).toMatch(/scrlen3\s*=\s*40\b/);
    expect(abap).toMatch(/headlen\s*=\s*55\b/);
  });

  it('references a domain with refkind D when domain is given', async () => {
    const { handler, bodies } = makeHarness();
    await handler.validateAndHandle('abap_create', { ...DTEL_ARGS, domain: 'zdummy_test_dom' });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/refkind\s*=\s*'D'/);
    expect(abap).toMatch(/domname\s*=\s*'ZDUMMY_TEST_DOM'/);
  });

  it('registers in CTS and activates the data element', async () => {
    const { handler, bodies } = makeHarness();
    await handler.validateAndHandle('abap_create', { ...DTEL_ARGS });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/RS_CORR_INSERT/);
    expect(abap).toMatch(/object_class\s*=\s*'DTEL'/);
    expect(abap).toMatch(/DDIF_DTEL_ACTIVATE/);
    expect(abap).toMatch(/FROM dd04l/i);
  });
});

describe('abap_delete DOMA/DTEL: TADIR and E071 cleanup', () => {
  const DELETE_ARGS = { name: 'ZDUMMY_TEST_DOM', type: 'DOMA', transport: 'D23K901888' };

  it('removes the transport entry and the TADIR row after the ADT delete', async () => {
    const { handler, bodies, client } = makeHarness(['CLEAN']);
    await handler.validateAndHandle('abap_delete', { ...DELETE_ARGS });
    expect(client.h.request).toHaveBeenCalledWith(
      expect.stringContaining('/ddic/domains/'),
      expect.objectContaining({ method: 'DELETE' })
    );
    const abap = bodies.join('\n');
    expect(abap).toMatch(/TR_DELETE_COMM_OBJECT_KEYS/);
    expect(abap).toMatch(/iv_dialog_flag\s*=\s*' '/);
    expect(abap).toMatch(/TR_TADIR_INTERFACE/);
    expect(abap).toMatch(/wi_test_modus\s*=\s*' '/);
    expect(abap).toMatch(/wi_delete_tadir_entry\s*=\s*'X'/);
  });

  it('passes TADIR-typed variables to TR_TADIR_INTERFACE (CALL_FUNCTION_CONFLICT_TYPE regression)', async () => {
    const { handler, bodies } = makeHarness(['CLEAN']);
    await handler.validateAndHandle('abap_delete', { ...DELETE_ARGS });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/TYPE tadir-obj_name/);
    expect(abap).toMatch(/TYPE tadir-object/);
  });

  it('verifies TADIR and E071 are empty and reports that in the message', async () => {
    const { handler, bodies } = makeHarness(['CLEAN']);
    const result = parseResult(await handler.validateAndHandle('abap_delete', { ...DELETE_ARGS }));
    const abap = bodies.join('\n');
    expect(abap).toMatch(/FROM tadir/i);
    expect(abap).toMatch(/FROM e071/i);
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/TADIR/);
  });

  it('does not report success when TADIR or E071 rows survive the cleanup', async () => {
    const { handler } = makeHarness(['LEFTOVER TADIR=1 E071=1']);
    await expect(
      handler.validateAndHandle('abap_delete', { ...DELETE_ARGS })
    ).rejects.toThrow(/LEFTOVER/);
  });

  it('runs the same cleanup for DTEL', async () => {
    const { handler, bodies } = makeHarness(['CLEAN']);
    await handler.validateAndHandle('abap_delete', { name: 'ZDUMMY_TEST_DTE', type: 'DTEL', transport: 'D23K901888' });
    const abap = bodies.join('\n');
    expect(abap).toMatch(/object\s*=\s*'DTEL'/);
    expect(abap).toMatch(/TR_TADIR_INTERFACE/);
  });

  it('does not run a cleanup classrun for object types the ADT delete handles fully', async () => {
    const { handler, runClassrun } = makeHarness();
    await handler.validateAndHandle('abap_delete', { name: 'ZCL_SOMETHING', type: 'CLAS', transport: 'D23K901888' });
    expect(runClassrun).not.toHaveBeenCalled();
  });
});
