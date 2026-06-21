import {
  DdicHandlers,
  buildTransparentTableClassrun,
  buildTransparentTablePlan,
  validateTransparentTableOutput,
  type TransparentTableCreateArgs,
} from '../../handlers/DdicHandlers';
import { parseResult } from '../helpers/setup';

const sampleArgs: TransparentTableCreateArgs = {
  name: 'zgcts_load',
  package: 'zdsn_gcts',
  description: 'gCTS load ledger',
  fields: [
    { name: 'mandt', type: 'CLNT', length: 3, key: true },
    { name: 'load_id', type: 'CHAR', length: 64, key: true },
    { name: 'schema_version', type: 'INT4' },
    { name: 'source_artifact_url', type: 'SSTRING', length: 512 },
  ],
};

function successfulOutputFor(plan = buildTransparentTablePlan({
  ...sampleArgs,
  dryRun: false,
  confirmPermanentCreation: true,
  transport: 'D25K900268',
  transportTask: 'D25K900269',
})): string {
  return [
    'DDIF_TABL_PUT OK',
    'DDIF_TABL_ACTIVATE OK rc=0',
    'DDIF_TABL_GET STATE=A OK fields=4',
    'READBACK DD02L OK class=TRANSP cli=X cont=A ex=1 main=',
    'READBACK DD09L OK tabart=APPL1 tabkat=0 buf=N row=C',
    ...plan.fields.map(field => `READBACK DD03L ${field.position} ${field.name} OK`),
    'READBACK DD08L no foreign keys OK',
    'READBACK DD05S no foreign keys OK',
    `READBACK TADIR ${plan.package} OK`,
    'READBACK E071 selected request/task OK count=1',
    'RESULT DDIC_TRANSPARENT_TABLE_CREATE_OK',
  ].join('\n');
}

describe('ddic_create_transparent_table plan', () => {
  it('defaults to dry-run and maps supported DDIC types exactly', () => {
    const plan = buildTransparentTablePlan(sampleArgs);

    expect(plan.name).toBe('ZGCTS_LOAD');
    expect(plan.package).toBe('ZDSN_GCTS');
    expect(plan.dryRun).toBe(true);
    expect(plan.dd02l).toEqual({
      tabclass: 'TRANSP',
      clidep: 'X',
      contflag: 'A',
      exclass: '1',
      mainflag: '',
      wrongcl: '',
    });
    expect(plan.dd09l).toEqual({
      tabart: 'APPL1',
      tabkat: '0',
      pufferung: '',
      bufallow: 'N',
      protokoll: '',
      roworcolst: 'C',
    });

    expect(plan.fields[0]).toMatchObject({
      name: 'MANDT',
      datatype: 'CLNT',
      inttype: 'C',
      intlen: 6,
      leng: 3,
      rollname: 'MANDT',
      domname: 'MANDT',
      comptype: 'E',
      key: true,
      notNull: true,
    });
    expect(plan.fields[1]).toMatchObject({
      name: 'LOAD_ID',
      datatype: 'CHAR',
      inttype: 'C',
      intlen: 128,
      leng: 64,
      key: true,
      notNull: true,
    });
    expect(plan.fields[2]).toMatchObject({
      name: 'SCHEMA_VERSION',
      datatype: 'INT4',
      inttype: 'X',
      intlen: 4,
      leng: 10,
      decimals: 0,
    });
    expect(plan.fields[3]).toMatchObject({
      name: 'SOURCE_ARTIFACT_URL',
      datatype: 'SSTR',
      inttype: 'g',
      intlen: 8,
      leng: 512,
    });
  });

  it('requires explicit confirmation and transport for permanent non-dry-run creation', () => {
    expect(() => buildTransparentTablePlan({ ...sampleArgs, dryRun: false }))
      .toThrow(/confirmPermanentCreation/);
    expect(() => buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
    })).toThrow(/transport is required/);
    expect(() => buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900268',
    })).toThrow(/child task/);
  });

  it('rejects invalid table layouts before any SAP mutation can happen', () => {
    expect(() => buildTransparentTablePlan({
      ...sampleArgs,
      fields: [
        { name: 'MANDT', type: 'CLNT', key: false },
        { name: 'LOAD_ID', type: 'CHAR', length: 64, key: true },
      ],
    })).toThrow(/MANDT must be a key/);

    expect(() => buildTransparentTablePlan({
      ...sampleArgs,
      fields: [
        { name: 'MANDT', type: 'CLNT', key: true },
        { name: 'TEXT', type: 'SSTRING', length: 128, key: true },
      ],
    })).toThrow(/SSTRING field TEXT cannot be a key/);

    expect(() => buildTransparentTablePlan({
      ...sampleArgs,
      fields: [
        { name: 'MANDT', type: 'CLNT', key: true },
        { name: 'TEXT', type: 'CHAR', length: 10 },
        { name: 'LOAD_ID', type: 'CHAR', length: 64, key: true },
      ],
    })).toThrow(/appears after a non-key/);

    expect(() => buildTransparentTablePlan({
      ...sampleArgs,
      fields: [
        { name: 'MANDT', type: 'CLNT', key: true },
        { name: 'LOAD_ID', type: 'CHAR', length: 64, key: true },
        { name: 'LOAD_ID', type: 'CHAR', length: 64 },
      ],
    })).toThrow(/duplicate field/);
  });
});

describe('ddic_create_transparent_table generated ABAP', () => {
  it('contains the DDIF write, activation, and mandatory readback gates', () => {
    const plan = buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900269',
    });
    const abap = buildTransparentTableClassrun(plan);

    expect(abap).toContain("CALL FUNCTION 'DDIF_TABL_PUT'");
    expect(abap).toContain("CALL FUNCTION 'DDIF_TABL_ACTIVATE'");
    expect(abap).toContain('lv_rc > 4');
    expect(abap).toContain("CALL FUNCTION 'DDIF_TABL_GET'");
    expect(abap).toContain("state     = 'A'");
    expect(abap).toContain("SELECT SINGLE * FROM dd02l");
    expect(abap).toContain("SELECT SINGLE * FROM dd03l");
    expect(abap).toContain("SELECT SINGLE * FROM dd09l");
    expect(abap).toContain('FROM dd08l');
    expect(abap).toContain('FROM dd05s');
    expect(abap).toContain('FROM tadir');
    expect(abap).toContain('FROM e071');
    expect(abap).toContain("ls_dd02v-exclass    = '1'");
    expect(abap).toContain("ls_dd02v-mainflag   = ''");
    expect(abap).toContain("ls_dd09l-tabart    = 'APPL1'");
    expect(abap).toContain("ls_dd03p-datatype   = 'SSTR'");
    expect(abap).toContain("ls_dd03p-inttype    = 'g'");
    expect(abap).toContain('RESULT DDIC_TRANSPARENT_TABLE_CREATE_OK');
  });

  it('keeps generated source lines within the ADT 255-character source limit', () => {
    const plan = buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900269',
    });
    const longLines = buildTransparentTableClassrun(plan)
      .split('\n')
      .map((line, index) => ({ index: index + 1, length: line.length, line }))
      .filter(entry => entry.length > 255);

    expect(longLines).toEqual([]);
  });
});

describe('ddic_create_transparent_table output parser', () => {
  it('accepts only complete readback evidence with a single success sentinel', () => {
    const plan = buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900269',
    });

    expect(validateTransparentTableOutput(plan, successfulOutputFor(plan)))
      .toContain('RESULT DDIC_TRANSPARENT_TABLE_CREATE_OK');
  });

  it('accepts activation rc=4 when the mandatory readback gates pass', () => {
    const plan = buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900269',
    });

    expect(validateTransparentTableOutput(
      plan,
      successfulOutputFor(plan).replace('DDIF_TABL_ACTIVATE OK rc=0', 'DDIF_TABL_ACTIVATE OK rc=4')
    )).toContain('DDIF_TABL_ACTIVATE OK rc=4');
  });

  it('rejects missing evidence, mismatch lines, and duplicate result sentinels', () => {
    const plan = buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900269',
    });

    expect(() => validateTransparentTableOutput(
      plan,
      successfulOutputFor(plan).replace('READBACK DD08L no foreign keys OK\n', '')
    )).toThrow(/missing required evidence/);

    expect(() => validateTransparentTableOutput(
      plan,
      successfulOutputFor(plan).replace('READBACK DD02L OK', 'READBACK DD02L mismatch')
    )).toThrow(/readback failed/);

    expect(() => validateTransparentTableOutput(
      plan,
      `${successfulOutputFor(plan)}\nRESULT DDIC_TRANSPARENT_TABLE_CREATE_OK`
    )).toThrow(/invalid result sentinel/);
  });
});

describe('DdicHandlers dry-run behavior', () => {
  it('does not call ADT write operations when dryRun is omitted', async () => {
    const client = {
      createObject: jest.fn(),
      login: jest.fn(),
    };
    const handler = new DdicHandlers(client as any);

    const result = parseResult(await handler.validateAndHandle('ddic_create_transparent_table', sampleArgs));

    expect(result.status).toBe('success');
    expect(result.dryRun).toBe(true);
    expect(result.generatedAbap).toContain("CALL FUNCTION 'DDIF_TABL_PUT'");
    expect(client.createObject).not.toHaveBeenCalled();
    expect(client.login).not.toHaveBeenCalled();
  });

  it('exposes an explicit non-read-only tool schema', () => {
    const tool = new DdicHandlers(null as any)
      .getTools()
      .find(entry => entry.name === 'ddic_create_transparent_table');

    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBeUndefined();
    expect(tool!.inputSchema.required).toEqual(['name', 'package', 'description', 'fields']);
    expect(tool!.inputSchema.properties.confirmPermanentCreation.description)
      .toContain('Must be exactly true');
  });

  it('uses the guarded DDIF classrun path for permanent creation, not generic ADT TABL shell creation', async () => {
    const client = {
      createObject: jest.fn(),
      login: jest.fn(),
    };
    const handler = new DdicHandlers(client as any) as any;
    const plan = buildTransparentTablePlan({
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900269',
    });
    handler.classifyTask = jest.fn().mockResolvedValue(undefined);
    handler.runClassrun = jest.fn().mockResolvedValue(successfulOutputFor(plan));

    const result = parseResult(await handler.validateAndHandle('ddic_create_transparent_table', {
      ...sampleArgs,
      dryRun: false,
      confirmPermanentCreation: true,
      transport: 'D25K900268',
      transportTask: 'D25K900269',
    }));

    expect(result.status).toBe('success');
    expect(result.dryRun).toBe(false);
    expect(handler.classifyTask).not.toHaveBeenCalled();
    expect(handler.runClassrun).toHaveBeenCalledWith(expect.stringContaining("CALL FUNCTION 'DDIF_TABL_PUT'"), 'ZCL_TMP_DDIC_TABL');
    expect(handler.runClassrun).toHaveBeenCalledWith(expect.stringContaining("ls_e070_task-trfunction <> 'S'"), 'ZCL_TMP_DDIC_TABL');
    expect(client.createObject).not.toHaveBeenCalled();
  });
});
