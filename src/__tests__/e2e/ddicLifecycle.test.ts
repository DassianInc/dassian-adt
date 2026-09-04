/**
 * End-to-end DOMA + DTEL lifecycle in a REAL package on a REAL transport.
 *
 * Creates a domain (with fixed values), a data element over it, proves both are ACTIVE and
 * registered in TADIR and E071, then deletes both and proves TADIR/E071 are clean again.
 * This is the test that would have caught the two production defects found on d23 2026-09-03:
 * abap_create leaving an orphan (no TADIR/E071) and abap_delete leaving TADIR/E071 behind.
 *
 * Requires: SAP_URL, SAP_USER, SAP_PASSWORD  (live connection)
 *           SAP_TEST_PACKAGE, SAP_TEST_TRANSPORT  (a transportable package and an open task/request)
 * Skips automatically when any is missing. Cleanup runs even on failure.
 */
import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const pkg = process.env.SAP_TEST_PACKAGE;
const transport = process.env.SAP_TEST_TRANSPORT;
const describeE2E = hasLiveConfig() && pkg && transport ? describe : describe.skip;

describeE2E('DDIC lifecycle: DOMA + DTEL in a transportable package', () => {
  let client: ADTClient;
  let handlers: TestHandlers;
  const suffix = Date.now().toString(36).toUpperCase().slice(-5);
  const domName = `ZMCPDOM${suffix}`;
  const dtelName = `ZMCPDTE${suffix}`;

  async function rows(sql: string): Promise<any[]> {
    const r = parseResult(await handlers.data.validateAndHandle('abap_query', { sql }));
    return r?.result?.values ?? [];
  }

  async function repoState(objectType: string, name: string) {
    const tadir = await rows(`SELECT obj_name FROM TADIR WHERE pgmid = 'R3TR' AND object = '${objectType}' AND obj_name = '${name}'`);
    const e071 = await rows(`SELECT trkorr FROM E071 WHERE pgmid = 'R3TR' AND object = '${objectType}' AND obj_name = '${name}'`);
    return { tadir: tadir.length, e071: e071.length };
  }

  beforeAll(async () => {
    client = createClient();
    handlers = createHandlers(client);
    await client.login();
  }, 30000);

  afterAll(async () => {
    // Best-effort cleanup in dependency order: data element first, then its domain.
    for (const [name, type] of [[dtelName, 'DTEL'], [domName, 'DOMA']] as const) {
      try { await handlers.object.validateAndHandle('abap_delete', { name, type, transport }); } catch (_) {}
    }
    try { await client.logout(); } catch (_) {}
  }, 90000);

  it('creates the domain active, with fixed values, registered in TADIR and on the transport', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_create', {
      name: domName, type: 'DOMA', package: pkg, transport,
      description: 'MCP regression test - safe to delete',
      datatype: 'CHAR', length: 10,
      fixedValues: [{ value: 'ALPHA', text: 'Alpha value' }, { value: 'BETA', text: 'Beta value' }],
    }));
    expect(result.status).toBe('success');
    expect(result.active).toBe(true);
    expect(result.message).not.toMatch(/set_source|get_source/);

    const dd01l = await rows(`SELECT as4local, datatype, leng, valexi FROM DD01L WHERE domname = '${domName}'`);
    expect(dd01l).toHaveLength(1);
    expect(dd01l[0].AS4LOCAL).toBe('A');
    expect(dd01l[0].DATATYPE).toBe('CHAR');
    expect(Number(dd01l[0].LENG)).toBe(10);
    expect(dd01l[0].VALEXI).toBe('X');

    const dd07l = await rows(`SELECT domvalue_l FROM DD07L WHERE domname = '${domName}' AND as4local = 'A'`);
    expect(dd07l.map((r: any) => r.DOMVALUE_L).sort()).toEqual(['ALPHA', 'BETA']);

    expect(await repoState('DOMA', domName)).toEqual({ tadir: 1, e071: 1 });
  }, 120000);

  it('creates the data element active over that domain, with labels, registered in TADIR and on the transport', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_create', {
      name: dtelName, type: 'DTEL', package: pkg, transport,
      description: 'MCP regression test - safe to delete',
      domain: domName,
      labels: { short: 'MCP', medium: 'MCP Test Field', long: 'MCP Test Data Element', heading: 'MCP Test' },
    }));
    expect(result.status).toBe('success');
    expect(result.active).toBe(true);

    const dd04l = await rows(`SELECT as4local, refkind, domname, scrlen1, scrlen2, scrlen3 FROM DD04L WHERE rollname = '${dtelName}'`);
    expect(dd04l).toHaveLength(1);
    expect(dd04l[0].AS4LOCAL).toBe('A');
    expect(dd04l[0].REFKIND).toBe('D');
    expect(dd04l[0].DOMNAME).toBe(domName);
    expect([dd04l[0].SCRLEN1, dd04l[0].SCRLEN2, dd04l[0].SCRLEN3].map(Number)).toEqual([10, 20, 40]);

    const dd04t = await rows(`SELECT scrtext_s, scrtext_m FROM DD04T WHERE rollname = '${dtelName}'`);
    expect(dd04t.length).toBeGreaterThan(0);
    expect(dd04t[0].SCRTEXT_S).toBe('MCP');

    expect(await repoState('DTEL', dtelName)).toEqual({ tadir: 1, e071: 1 });
  }, 120000);

  it('deletes the data element and leaves no TADIR or E071 entry behind', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_delete', {
      name: dtelName, type: 'DTEL', transport,
    }));
    expect(result.status).toBe('success');
    expect(result.message).toMatch(/TADIR/);

    expect(await rows(`SELECT rollname FROM DD04L WHERE rollname = '${dtelName}'`)).toHaveLength(0);
    expect(await repoState('DTEL', dtelName)).toEqual({ tadir: 0, e071: 0 });
  }, 120000);

  it('deletes the domain and leaves no TADIR or E071 entry behind', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_delete', {
      name: domName, type: 'DOMA', transport,
    }));
    expect(result.status).toBe('success');

    expect(await rows(`SELECT domname FROM DD01L WHERE domname = '${domName}'`)).toHaveLength(0);
    expect(await repoState('DOMA', domName)).toEqual({ tadir: 0, e071: 0 });
  }, 120000);
});
