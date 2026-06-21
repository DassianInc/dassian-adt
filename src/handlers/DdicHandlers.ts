import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';

export type TransparentTableFieldType = 'CLNT' | 'CHAR' | 'SSTRING' | 'INT4';

export interface TransparentTableFieldInput {
  name: string;
  type?: TransparentTableFieldType | string;
  ddicType?: TransparentTableFieldType | string;
  ddic_type?: TransparentTableFieldType | string;
  length?: number;
  key?: boolean;
  notNull?: boolean;
  not_null?: boolean;
}

export interface TransparentTableCreateArgs {
  name: string;
  package?: string;
  devclass?: string;
  description: string;
  transport?: string;
  transportTask?: string;
  dryRun?: boolean;
  confirmPermanentCreation?: boolean;
  activate?: boolean;
  fields: TransparentTableFieldInput[];
}

export interface TransparentTableFieldPlan {
  position: number;
  name: string;
  type: TransparentTableFieldType;
  length: number;
  key: boolean;
  notNull: boolean;
  datatype: string;
  inttype: string;
  intlen: number;
  leng: number;
  decimals: number;
  rollname: string;
  domname: string;
  comptype: string;
  checktable: string;
}

export interface TransparentTablePlan {
  name: string;
  package: string;
  description: string;
  transport?: string;
  transportTask?: string;
  dryRun: boolean;
  confirmPermanentCreation: boolean;
  activate: true;
  permanent: boolean;
  dd02l: {
    tabclass: 'TRANSP';
    clidep: 'X';
    contflag: 'A';
    exclass: '1';
    mainflag: '';
    wrongcl: '';
  };
  dd09l: {
    tabart: 'APPL1';
    tabkat: '0';
    pufferung: '';
    bufallow: 'N';
    protokoll: '';
    roworcolst: 'C';
  };
  fields: TransparentTableFieldPlan[];
  readback: {
    activeVersion: { as4local: 'A'; as4vers: '0000' };
    requireNoForeignKeys: true;
    requireTadirPackage: true;
    requireE071OnSelectedRequestOrTask: boolean;
  };
}

const TABLE_NAME_RE = /^(?:\/[A-Z0-9_]{2,10}\/[A-Z0-9_]{1,20}|[A-Z][A-Z0-9_]{0,29})$/;
const FIELD_NAME_RE = /^[A-Z][A-Z0-9_]{0,29}$/;
const TRANSPORT_RE = /^[A-Z0-9]{3}K[0-9]{6}$/;

function upper(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function escapeAbap(value: string): string {
  return value.replace(/'/g, "''");
}

function abapLiteral(value: string): string {
  return `'${escapeAbap(value)}'`;
}

function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value as number;
}

function normalizeDescription(value: unknown): string {
  const description = String(value ?? '').trim();
  if (!description) throw new Error('description is required');
  return description.slice(0, 60);
}

function normalizeField(input: TransparentTableFieldInput, position: number): TransparentTableFieldPlan {
  const name = upper(input.name);
  if (!FIELD_NAME_RE.test(name)) {
    throw new Error(`fields[${position - 1}].name must be a DDIC field name (A-Z, 0-9, underscore, max 30 chars)`);
  }

  const rawType = upper(input.type ?? input.ddicType ?? input.ddic_type);
  const type = rawType as TransparentTableFieldType;
  if (!['CLNT', 'CHAR', 'SSTRING', 'INT4'].includes(type)) {
    throw new Error(`fields[${position - 1}].type must be one of CLNT, CHAR, SSTRING, INT4`);
  }

  const key = input.key === true;
  const notNull = key || input.notNull === true || input.not_null === true;

  if (type === 'CLNT') {
    const length = input.length === undefined ? 3 : integer(input.length, `${name}.length`);
    if (name !== 'MANDT') throw new Error('CLNT field must be named MANDT');
    if (length !== 3) throw new Error('MANDT CLNT length must be 3');
    if (!key) throw new Error('MANDT must be a key field');
    return {
      position,
      name,
      type,
      length,
      key,
      notNull: true,
      datatype: 'CLNT',
      inttype: 'C',
      intlen: 6,
      leng: 3,
      decimals: 0,
      rollname: 'MANDT',
      domname: 'MANDT',
      comptype: 'E',
      checktable: '',
    };
  }

  if (type === 'CHAR') {
    const length = integer(input.length, `${name}.length`);
    if (length < 1 || length > 255) throw new Error(`${name}.length for CHAR must be between 1 and 255`);
    return {
      position,
      name,
      type,
      length,
      key,
      notNull,
      datatype: 'CHAR',
      inttype: 'C',
      intlen: length * 2,
      leng: length,
      decimals: 0,
      rollname: '',
      domname: '',
      comptype: '',
      checktable: '',
    };
  }

  if (type === 'SSTRING') {
    const length = integer(input.length, `${name}.length`);
    if (length < 1 || length > 1333) throw new Error(`${name}.length for SSTRING must be between 1 and 1333`);
    return {
      position,
      name,
      type,
      length,
      key,
      notNull,
      datatype: 'SSTR',
      inttype: 'g',
      intlen: 8,
      leng: length,
      decimals: 0,
      rollname: '',
      domname: '',
      comptype: '',
      checktable: '',
    };
  }

  const length = input.length === undefined ? 10 : integer(input.length, `${name}.length`);
  if (length !== 10) throw new Error(`${name}.length for INT4 must be omitted or 10`);
  return {
    position,
    name,
    type,
    length: 10,
    key,
    notNull,
    datatype: 'INT4',
    inttype: 'X',
    intlen: 4,
    leng: 10,
    decimals: 0,
    rollname: '',
    domname: '',
    comptype: '',
    checktable: '',
  };
}

export function buildTransparentTablePlan(args: TransparentTableCreateArgs): TransparentTablePlan {
  const tableName = upper(args.name);
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error('name must be a DDIC table name (Z*, Y*, or /NAMESPACE/NAME, max 30 chars)');
  }

  const packageName = upper(args.package || args.devclass);
  if (!packageName) throw new Error('package is required');

  if (!Array.isArray(args.fields) || args.fields.length === 0) {
    throw new Error('fields must be a non-empty array');
  }

  const fields = args.fields.map((field, index) => normalizeField(field, index + 1));
  const fieldNames = new Set<string>();
  let sawNonKey = false;
  for (const field of fields) {
    if (fieldNames.has(field.name)) throw new Error(`duplicate field ${field.name}`);
    fieldNames.add(field.name);
    if (field.key && field.type === 'SSTRING') throw new Error(`SSTRING field ${field.name} cannot be a key field`);
    if (!field.key) sawNonKey = true;
    if (field.key && sawNonKey) throw new Error(`key field ${field.name} appears after a non-key field`);
    if (field.key && !field.notNull) throw new Error(`key field ${field.name} must be notNull`);
  }

  const first = fields[0];
  if (!first || first.name !== 'MANDT' || first.type !== 'CLNT' || !first.key) {
    throw new Error('client-dependent tables must start with key field MANDT CLNT(3)');
  }
  if (!fields.some(field => field.key)) throw new Error('at least one key field is required');

  const dryRun = args.dryRun !== false;
  const permanent = packageName !== '$TMP';
  const transport = upper(args.transport) || undefined;
  const transportTask = upper(args.transportTask) || undefined;
  const confirmPermanentCreation = args.confirmPermanentCreation === true;

  if (args.activate === false && !dryRun) {
    throw new Error('non-dry-run transparent table creation must activate and read back active metadata');
  }
  if (transport && !TRANSPORT_RE.test(transport)) {
    throw new Error(`transport must look like a CTS request/task number, got ${transport}`);
  }
  if (transportTask && !TRANSPORT_RE.test(transportTask)) {
    throw new Error(`transportTask must look like a CTS task number, got ${transportTask}`);
  }
  if (!dryRun && permanent && transport && transportTask && transport === transportTask) {
    throw new Error('transportTask must be the child task, not the parent transport request');
  }
  if (!dryRun && permanent && !confirmPermanentCreation) {
    throw new Error('confirmPermanentCreation must be true for non-$TMP non-dry-run table creation');
  }
  if (!dryRun && permanent && !transport) {
    throw new Error('transport is required for non-$TMP non-dry-run table creation');
  }

  return {
    name: tableName,
    package: packageName,
    description: normalizeDescription(args.description),
    ...(transport ? { transport } : {}),
    ...(transportTask ? { transportTask } : {}),
    dryRun,
    confirmPermanentCreation,
    activate: true,
    permanent,
    dd02l: {
      tabclass: 'TRANSP',
      clidep: 'X',
      contflag: 'A',
      exclass: '1',
      mainflag: '',
      wrongcl: '',
    },
    dd09l: {
      tabart: 'APPL1',
      tabkat: '0',
      pufferung: '',
      bufallow: 'N',
      protokoll: '',
      roworcolst: 'C',
    },
    fields,
    readback: {
      activeVersion: { as4local: 'A', as4vers: '0000' },
      requireNoForeignKeys: true,
      requireTadirPackage: true,
      requireE071OnSelectedRequestOrTask: permanent,
    },
  };
}

function buildFieldPut(field: TransparentTableFieldPlan, tableName: string): string {
  return `
CLEAR ls_dd03p.
ls_dd03p-tabname    = ${abapLiteral(tableName)}.
ls_dd03p-fieldname  = ${abapLiteral(field.name)}.
ls_dd03p-position   = ${field.position}.
ls_dd03p-keyflag    = ${abapLiteral(field.key ? 'X' : '')}.
ls_dd03p-notnull    = ${abapLiteral(field.notNull ? 'X' : '')}.
ls_dd03p-checktable = ${abapLiteral(field.checktable)}.
ls_dd03p-datatype   = ${abapLiteral(field.datatype)}.
ls_dd03p-inttype    = ${abapLiteral(field.inttype)}.
ls_dd03p-intlen     = ${field.intlen}.
ls_dd03p-leng       = ${field.leng}.
ls_dd03p-decimals   = ${field.decimals}.
ls_dd03p-rollname   = ${abapLiteral(field.rollname)}.
ls_dd03p-domname    = ${abapLiteral(field.domname)}.
ls_dd03p-comptype   = ${abapLiteral(field.comptype)}.
APPEND ls_dd03p TO lt_dd03p.`;
}

function buildFieldReadback(field: TransparentTableFieldPlan, tableName: string): string {
  return `
CLEAR ls_dd03l.
SELECT SINGLE * FROM dd03l INTO ls_dd03l
  WHERE tabname = ${abapLiteral(tableName)}
    AND fieldname = ${abapLiteral(field.name)}
    AND as4local = 'A'
    AND as4vers = '0000'.
IF sy-subrc <> 0.
  out->write( ${abapLiteral(`READBACK DD03L ${field.name} missing`)} ).
  lv_failed = abap_true.
ELSEIF ls_dd03l-position <> ${field.position}
    OR ls_dd03l-keyflag <> ${abapLiteral(field.key ? 'X' : '')}
    OR ls_dd03l-notnull <> ${abapLiteral(field.notNull ? 'X' : '')}
    OR ls_dd03l-checktable <> ${abapLiteral(field.checktable)}
    OR ls_dd03l-datatype <> ${abapLiteral(field.datatype)}
    OR ls_dd03l-inttype <> ${abapLiteral(field.inttype)}
    OR ls_dd03l-intlen <> ${field.intlen}
    OR ls_dd03l-leng <> ${field.leng}
    OR ls_dd03l-decimals <> ${field.decimals}
    OR ls_dd03l-rollname <> ${abapLiteral(field.rollname)}
    OR ls_dd03l-domname <> ${abapLiteral(field.domname)}
    OR ls_dd03l-comptype <> ${abapLiteral(field.comptype)}.
  out->write( ${abapLiteral(`READBACK DD03L ${field.name} mismatch`)} ).
  out->write( |pos={ ls_dd03l-position } key={ ls_dd03l-keyflag } nn={ ls_dd03l-notnull } check={ ls_dd03l-checktable }| ).
  out->write( |dt={ ls_dd03l-datatype } it={ ls_dd03l-inttype } il={ ls_dd03l-intlen } len={ ls_dd03l-leng }| ).
  out->write( |roll={ ls_dd03l-rollname } dom={ ls_dd03l-domname } comp={ ls_dd03l-comptype }| ).
  lv_failed = abap_true.
ELSE.
  out->write( |READBACK DD03L ${field.position} ${field.name} OK| ).
ENDIF.`;
}

export function buildTransparentTableClassrun(plan: TransparentTablePlan): string {
  const tableName = plan.name;
  const packageName = plan.package;
  const request = plan.transport || '';
  const task = plan.transportTask || '';
  const fieldPuts = plan.fields.map(field => buildFieldPut(field, tableName)).join('\n');
  const fieldReadbacks = plan.fields.map(field => buildFieldReadback(field, tableName)).join('\n');

  return `
DATA: ls_dd02v  TYPE dd02v,
      ls_dd09l  TYPE dd09l,
      lt_dd03p  TYPE STANDARD TABLE OF dd03p,
      ls_dd03p  TYPE dd03p,
      ls_got02v TYPE dd02v,
      ls_got09l TYPE dd09l,
      lt_got03p TYPE STANDARD TABLE OF dd03p,
      ls_dd02l  TYPE dd02l,
      ls_dd03l  TYPE dd03l,
      ls_dd09la TYPE dd09l,
      ls_tadir  TYPE tadir,
      ls_e070_req  TYPE e070,
      ls_e070_task TYPE e070,
      ls_e071   TYPE e071,
      lv_rc     TYPE sy-subrc,
      lv_count  TYPE i,
      lv_e071   TYPE i,
      lv_maxpos TYPE e071-as4pos,
      lv_pos_i  TYPE i,
      lv_failed TYPE abap_bool,
      lv_request TYPE trkorr VALUE ${abapLiteral(request)},
      lv_task    TYPE trkorr VALUE ${abapLiteral(task)}.

out->write( ${abapLiteral(`START DDIC_TRANSPARENT_TABLE_CREATE ${tableName}`)} ).
out->write( ${abapLiteral(`PACKAGE ${packageName}`)} ).
out->write( |REQUEST { lv_request } TASK { lv_task }| ).

IF lv_request IS NOT INITIAL.
  SELECT SINGLE * FROM e070 INTO ls_e070_req
    WHERE trkorr = lv_request.
  IF sy-subrc <> 0 OR ls_e070_req-trfunction <> 'K' OR ls_e070_req-trstatus <> 'D'.
    out->write( |REQUEST { lv_request } is not an open Workbench request| ).
    out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
    RETURN.
  ENDIF.

  IF lv_task IS INITIAL.
    out->write( 'TASK is required for permanent transport capture' ).
    out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
    RETURN.
  ENDIF.

  SELECT SINGLE * FROM e070 INTO ls_e070_task
    WHERE trkorr = lv_task.
  IF sy-subrc <> 0
      OR ls_e070_task-trfunction <> 'S'
      OR ls_e070_task-trstatus <> 'D'
      OR ls_e070_task-strkorr <> lv_request.
    out->write( |TASK { lv_task } is not an open child task of { lv_request }| ).
    out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
    RETURN.
  ENDIF.
ENDIF.

ls_dd02v-tabname    = ${abapLiteral(tableName)}.
ls_dd02v-ddlanguage = sy-langu.
ls_dd02v-ddtext     = ${abapLiteral(plan.description)}.
ls_dd02v-tabclass   = 'TRANSP'.
ls_dd02v-clidep     = 'X'.
ls_dd02v-contflag   = 'A'.
ls_dd02v-exclass    = '1'.
ls_dd02v-mainflag   = ''.

ls_dd09l-tabname   = ${abapLiteral(tableName)}.
ls_dd09l-tabart    = 'APPL1'.
ls_dd09l-tabkat    = '0'.
ls_dd09l-pufferung = ''.
ls_dd09l-bufallow  = 'N'.
ls_dd09l-protokoll = ''.
ls_dd09l-roworcolst = 'C'.
${fieldPuts}

CALL FUNCTION 'DDIF_TABL_PUT'
  EXPORTING
    name      = ${abapLiteral(tableName)}
    dd02v_wa  = ls_dd02v
    dd09l_wa  = ls_dd09l
  TABLES
    dd03p_tab = lt_dd03p
  EXCEPTIONS
    tabl_not_found = 1
    name_inconsistent = 2
    tabl_inconsistent = 3
    put_failure = 4
    put_refused = 5
    OTHERS = 6.
IF sy-subrc <> 0.
  out->write( |DDIF_TABL_PUT failed sy-subrc={ sy-subrc }| ).
  out->write( |msg={ sy-msgid }/{ sy-msgno } { sy-msgv1 } { sy-msgv2 }| ).
  out->write( |msg2={ sy-msgv3 } { sy-msgv4 }| ).
  out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
  RETURN.
ENDIF.
out->write( 'DDIF_TABL_PUT OK' ).

CALL FUNCTION 'DDIF_TABL_ACTIVATE'
  EXPORTING
    name     = ${abapLiteral(tableName)}
    auth_chk = 'X'
    excommit = 'X'
  IMPORTING
    rc       = lv_rc
  EXCEPTIONS
    not_found = 1
    put_failure = 2
    OTHERS = 3.
IF sy-subrc <> 0 OR lv_rc > 4.
  out->write( |DDIF_TABL_ACTIVATE failed sy-subrc={ sy-subrc } rc={ lv_rc }| ).
  out->write( |msg={ sy-msgid }/{ sy-msgno } { sy-msgv1 } { sy-msgv2 }| ).
  out->write( |msg2={ sy-msgv3 } { sy-msgv4 }| ).
  out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
  RETURN.
ENDIF.
COMMIT WORK AND WAIT.
out->write( |DDIF_TABL_ACTIVATE OK rc={ lv_rc }| ).

SELECT SINGLE * FROM tadir INTO ls_tadir
  WHERE pgmid = 'R3TR'
    AND object = 'TABL'
    AND obj_name = ${abapLiteral(tableName)}.
IF sy-subrc <> 0.
  CLEAR ls_tadir.
  ls_tadir-pgmid      = 'R3TR'.
  ls_tadir-object     = 'TABL'.
  ls_tadir-obj_name   = ${abapLiteral(tableName)}.
  ls_tadir-srcsystem  = sy-sysid.
  ls_tadir-author     = sy-uname.
  ls_tadir-devclass   = ${abapLiteral(packageName)}.
  ls_tadir-masterlang = sy-langu.
  ls_tadir-created_on = sy-datum.
  ls_tadir-check_date = sy-datum.
  INSERT INTO tadir VALUES ls_tadir.
  IF sy-subrc <> 0.
    out->write( |TADIR insert failed sy-subrc={ sy-subrc }| ).
    out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
    RETURN.
  ENDIF.
ELSE.
  ls_tadir-devclass = ${abapLiteral(packageName)}.
  ls_tadir-srcsystem = sy-sysid.
  IF ls_tadir-author IS INITIAL.
    ls_tadir-author = sy-uname.
  ENDIF.
  IF ls_tadir-masterlang IS INITIAL.
    ls_tadir-masterlang = sy-langu.
  ENDIF.
  IF ls_tadir-created_on IS INITIAL.
    ls_tadir-created_on = sy-datum.
  ENDIF.
  ls_tadir-check_date = sy-datum.
  MODIFY tadir FROM ls_tadir.
  IF sy-subrc <> 0.
    out->write( |TADIR update failed sy-subrc={ sy-subrc }| ).
    out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
    RETURN.
  ENDIF.
ENDIF.
COMMIT WORK AND WAIT.
out->write( ${abapLiteral(`TADIR ${packageName} recorded`)} ).

IF lv_request IS NOT INITIAL OR lv_task IS NOT INITIAL.
  SELECT COUNT(*) FROM e071 INTO lv_e071
    WHERE ( trkorr = lv_request OR trkorr = lv_task )
      AND pgmid = 'R3TR'
      AND object = 'TABL'
      AND obj_name = ${abapLiteral(tableName)}.
  IF lv_e071 = 0.
    CLEAR ls_e071.
    SELECT MAX( as4pos ) FROM e071 INTO lv_maxpos
      WHERE trkorr = lv_task.
    lv_pos_i = lv_maxpos.
    lv_pos_i = lv_pos_i + 1.
    ls_e071-trkorr   = lv_task.
    ls_e071-as4pos   = lv_pos_i.
    ls_e071-pgmid    = 'R3TR'.
    ls_e071-object   = 'TABL'.
    ls_e071-obj_name = ${abapLiteral(tableName)}.
    ls_e071-objfunc  = ''.
    ls_e071-lockflag = 'X'.
    INSERT INTO e071 VALUES ls_e071.
    IF sy-subrc <> 0.
      out->write( |E071 insert failed sy-subrc={ sy-subrc }| ).
      out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
      RETURN.
    ENDIF.
    COMMIT WORK AND WAIT.
    out->write( |E071 inserted on { lv_task } pos={ ls_e071-as4pos }| ).
  ELSEIF lv_e071 = 1.
    out->write( 'E071 selected request/task already contains table' ).
  ELSE.
    out->write( |E071 duplicate selected request/task rows count={ lv_e071 }| ).
    out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
    RETURN.
  ENDIF.
ENDIF.

CALL FUNCTION 'DDIF_TABL_GET'
  EXPORTING
    name      = ${abapLiteral(tableName)}
    state     = 'A'
    langu     = sy-langu
  IMPORTING
    dd02v_wa  = ls_got02v
    dd09l_wa  = ls_got09l
  TABLES
    dd03p_tab = lt_got03p
  EXCEPTIONS
    illegal_input = 1
    OTHERS = 2.
IF sy-subrc <> 0.
  out->write( |DDIF_TABL_GET STATE=A failed sy-subrc={ sy-subrc }| ).
  lv_failed = abap_true.
ELSE.
  out->write( |DDIF_TABL_GET STATE=A OK fields={ lines( lt_got03p ) }| ).
ENDIF.

SELECT SINGLE * FROM dd02l INTO ls_dd02l
  WHERE tabname = ${abapLiteral(tableName)}
    AND as4local = 'A'
    AND as4vers = '0000'.
IF sy-subrc <> 0.
  out->write( 'READBACK DD02L active row missing' ).
  lv_failed = abap_true.
ELSEIF ls_dd02l-tabclass <> 'TRANSP'
    OR ls_dd02l-clidep <> 'X'
    OR ls_dd02l-contflag <> 'A'
    OR ls_dd02l-exclass <> '1'
    OR ls_dd02l-mainflag <> ''
    OR ls_dd02l-wrongcl <> ''.
  out->write( 'READBACK DD02L mismatch' ).
  out->write( |class={ ls_dd02l-tabclass } cli={ ls_dd02l-clidep } cont={ ls_dd02l-contflag }| ).
  out->write( |ex={ ls_dd02l-exclass } main={ ls_dd02l-mainflag } wrong={ ls_dd02l-wrongcl }| ).
  lv_failed = abap_true.
ELSE.
  out->write( |READBACK DD02L OK class={ ls_dd02l-tabclass } cli={ ls_dd02l-clidep } cont={ ls_dd02l-contflag } ex={ ls_dd02l-exclass } main={ ls_dd02l-mainflag }| ).
ENDIF.

SELECT SINGLE * FROM dd09l INTO ls_dd09la
  WHERE tabname = ${abapLiteral(tableName)}
    AND as4local = 'A'
    AND as4vers = '0000'.
IF sy-subrc <> 0.
  out->write( 'READBACK DD09L active row missing' ).
  lv_failed = abap_true.
ELSEIF ls_dd09la-tabart <> 'APPL1'
    OR ls_dd09la-tabkat <> '0'
    OR ls_dd09la-pufferung <> ''
    OR ls_dd09la-bufallow <> 'N'
    OR ls_dd09la-protokoll <> ''
    OR ls_dd09la-roworcolst <> 'C'.
  out->write( 'READBACK DD09L mismatch' ).
  out->write( |tabart={ ls_dd09la-tabart } tabkat={ ls_dd09la-tabkat } puff={ ls_dd09la-pufferung }| ).
  out->write( |buf={ ls_dd09la-bufallow } prot={ ls_dd09la-protokoll } row={ ls_dd09la-roworcolst }| ).
  lv_failed = abap_true.
ELSE.
  out->write( |READBACK DD09L OK tabart={ ls_dd09la-tabart } tabkat={ ls_dd09la-tabkat } buf={ ls_dd09la-bufallow } row={ ls_dd09la-roworcolst }| ).
ENDIF.
${fieldReadbacks}

SELECT COUNT(*) FROM dd08l INTO lv_count
  WHERE tabname = ${abapLiteral(tableName)}
    AND as4local = 'A'
    AND as4vers = '0000'.
IF lv_count <> 0.
  out->write( |READBACK DD08L unexpected foreign keys count={ lv_count }| ).
  lv_failed = abap_true.
ELSE.
  out->write( 'READBACK DD08L no foreign keys OK' ).
ENDIF.

SELECT COUNT(*) FROM dd05s INTO lv_count
  WHERE tabname = ${abapLiteral(tableName)}
    AND as4local = 'A'
    AND as4vers = '0000'.
IF lv_count <> 0.
  out->write( |READBACK DD05S unexpected foreign keys count={ lv_count }| ).
  lv_failed = abap_true.
ELSE.
  out->write( 'READBACK DD05S no foreign keys OK' ).
ENDIF.

SELECT COUNT(*) FROM tadir INTO lv_count
  WHERE pgmid = 'R3TR'
    AND object = 'TABL'
    AND obj_name = ${abapLiteral(tableName)}
    AND devclass = ${abapLiteral(packageName)}.
IF lv_count <> 1.
  out->write( |READBACK TADIR expected exactly 1 row in package ${packageName}, got { lv_count }| ).
  lv_failed = abap_true.
ELSE.
  out->write( ${abapLiteral(`READBACK TADIR ${packageName} OK`)} ).
ENDIF.

IF lv_request IS NOT INITIAL OR lv_task IS NOT INITIAL.
  IF lv_task IS INITIAL.
    SELECT COUNT(*) FROM e071 INTO lv_e071
      WHERE trkorr = lv_request
        AND pgmid = 'R3TR'
        AND object = 'TABL'
        AND obj_name = ${abapLiteral(tableName)}.
  ELSE.
    SELECT COUNT(*) FROM e071 INTO lv_e071
      WHERE ( trkorr = lv_request OR trkorr = lv_task )
        AND pgmid = 'R3TR'
        AND object = 'TABL'
        AND obj_name = ${abapLiteral(tableName)}.
  ENDIF.
  IF lv_e071 <> 1.
    out->write( |READBACK E071 expected exactly 1 selected request/task row, got { lv_e071 }| ).
    lv_failed = abap_true.
  ELSE.
    out->write( |READBACK E071 selected request/task OK count={ lv_e071 }| ).
  ENDIF.
ENDIF.

IF lv_failed = abap_true.
  out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_FAILED' ).
ELSE.
  out->write( 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_OK' ).
ENDIF.`;
}

export function validateTransparentTableOutput(plan: TransparentTablePlan, output: string): string[] {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const requiredPrefixes = [
    'DDIF_TABL_PUT OK',
    'DDIF_TABL_ACTIVATE OK',
    'DDIF_TABL_GET STATE=A OK',
    'READBACK DD02L OK',
    'READBACK DD09L OK',
    'READBACK DD08L no foreign keys OK',
    'READBACK DD05S no foreign keys OK',
    `READBACK TADIR ${plan.package} OK`,
    'RESULT DDIC_TRANSPARENT_TABLE_CREATE_OK',
  ];

  for (const field of plan.fields) {
    requiredPrefixes.push(`READBACK DD03L ${field.position} ${field.name} OK`);
  }
  if (plan.readback.requireE071OnSelectedRequestOrTask) {
    requiredPrefixes.push('READBACK E071 selected request/task OK');
  }

  const failures = lines.filter(line =>
    line.includes('DDIC_TRANSPARENT_TABLE_CREATE_FAILED') ||
    /\bfailed\b/i.test(line) ||
    /\bmismatch\b/i.test(line) ||
    /\bmissing\b/i.test(line) ||
    /\bunexpected\b/i.test(line) ||
    line.includes('expected exactly 1')
  );
  if (failures.length > 0) {
    throw new Error(`transparent table readback failed: ${failures.join('; ')}`);
  }

  const missing = requiredPrefixes.filter(prefix => !lines.some(line => line.startsWith(prefix)));
  if (missing.length > 0) {
    throw new Error(`transparent table readback missing required evidence: ${missing.join(', ')}`);
  }

  const resultLines = lines.filter(line => line.startsWith('RESULT DDIC_TRANSPARENT_TABLE_CREATE_'));
  if (resultLines.length !== 1 || resultLines[0] !== 'RESULT DDIC_TRANSPARENT_TABLE_CREATE_OK') {
    throw new Error(`transparent table readback produced invalid result sentinel: ${resultLines.join(', ') || '<none>'}`);
  }

  return lines;
}

export class DdicHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'ddic_create_transparent_table',
        description:
          'Safely create a client-dependent transparent DDIC table through a guarded ADT writer. ' +
          'Defaults to dryRun=true and returns the exact plan plus generated DDIF ABAP without mutating SAP. ' +
          'For non-$TMP creation, dryRun must be false, transport must be supplied, and confirmPermanentCreation must be true. ' +
          'The writer creates the DDIC table with DDIF_TABL_PUT, records TADIR/E071 ownership for the selected request/task, activates with DDIF_TABL_ACTIVATE, then verifies active DD02L/DD03L/DD09L, no DD08L/DD05S foreign keys, TADIR package, and request/task-bound E071.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Transparent table name, e.g. ZGCTS_LOAD.'
            },
            package: {
              type: 'string',
              description: 'Target package/devclass. Use $TMP only for temporary proof tables.'
            },
            devclass: {
              type: 'string',
              description: 'Alias for package.'
            },
            description: {
              type: 'string',
              description: 'DDIC short text, truncated to 60 chars.'
            },
            transport: {
              type: 'string',
              description: 'Workbench request for non-$TMP creation, e.g. D25K900268.'
            },
            transportTask: {
              type: 'string',
              description: 'Optional child task. If omitted, the handler resolves the current user task from the request before mutating SAP.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Default true. When true, returns the plan and generated ABAP without contacting SAP.'
            },
            confirmPermanentCreation: {
              type: 'boolean',
              description: 'Must be exactly true for non-$TMP non-dry-run creation.'
            },
            activate: {
              type: 'boolean',
              description: 'Must remain true for non-dry-run creation; active readback is part of the safety contract.'
            },
            fields: {
              type: 'array',
              description: 'Ordered field definitions. Key fields must be contiguous and the first field must be MANDT CLNT(3).',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'DDIC field name.' },
                  type: { type: 'string', enum: ['CLNT', 'CHAR', 'SSTRING', 'INT4'], description: 'Field type.' },
                  ddicType: { type: 'string', enum: ['CLNT', 'CHAR', 'SSTRING', 'INT4'], description: 'Alias for type.' },
                  ddic_type: { type: 'string', enum: ['CLNT', 'CHAR', 'SSTRING', 'INT4'], description: 'Alias for type.' },
                  length: { type: 'number', description: 'Required for CHAR and SSTRING; CLNT fixed at 3, INT4 fixed at 10.' },
                  key: { type: 'boolean', description: 'Primary-key flag.' },
                  notNull: { type: 'boolean', description: 'NOT NULL flag. Key fields are forced to true.' },
                  not_null: { type: 'boolean', description: 'Alias for notNull.' }
                },
                required: ['name']
              }
            }
          },
          required: ['name', 'package', 'description', 'fields']
        }
      },
      {
        name: 'ddic_element',
        annotations: { readOnlyHint: true },
        description:
          'Retrieve DDIC metadata for a CDS view or data element — field names, data types, ' +
          'key flags, data element labels, lengths, decimals, and CDS annotations. ' +
          'Pass the CDS entity path (e.g. /DSN/C_MY_VIEW or SEPM_I_PRODUCT_E). ' +
          'For associations, set getTargetForAssociation=true to resolve the target entity\'s fields. ' +
          'For extension views, set getExtensionViews=true.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'CDS entity or data element path, e.g. /DSN/C_MY_VIEW or SEPM_I_PRODUCT_E. ' +
                           'For multiple paths pass a comma-separated string.'
            },
            getTargetForAssociation: {
              type: 'boolean',
              description: 'Resolve association targets (default: false)'
            },
            getExtensionViews: {
              type: 'boolean',
              description: 'Include extension views (default: false)'
            },
            getSecondaryObjects: {
              type: 'boolean',
              description: 'Include secondary objects (default: false)'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'ddic_references',
        annotations: { readOnlyHint: true },
        description:
          'List all DDIC objects that reference a given CDS entity or data element. ' +
          'Returns each referencing object\'s URI, type, name, and path. ' +
          'Useful for understanding the impact of changing a data model.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'CDS entity or DDIC path to find references for. ' +
                           'For multiple paths pass a comma-separated string.'
            }
          },
          required: ['path']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'ddic_create_transparent_table': return this.handleCreateTransparentTable(args);
      case 'ddic_element':    return this.handleDdicElement(args);
      case 'ddic_references': return this.handleDdicReferences(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private parsePath(raw: string): string | string[] {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
  }

  private async handleCreateTransparentTable(args: TransparentTableCreateArgs): Promise<any> {
    try {
      let plan = buildTransparentTablePlan(args);
      let methodBody = buildTransparentTableClassrun(plan);

      if (plan.dryRun) {
        return this.success({
          dryRun: true,
          message: 'Dry run only; no SAP mutation was attempted.',
          plan,
          generatedAbap: methodBody,
        });
      }

      if (plan.permanent && plan.transport && !plan.transportTask) {
        const task = await this.resolveTaskNumber(plan.transport);
        if (!task || task.toUpperCase() === plan.transport) {
          this.fail(
            `ddic_create_transparent_table(${plan.name}): could not resolve a child task for ${plan.transport}; ` +
            `pass transportTask explicitly before permanent creation.`
          );
        }
        plan = { ...plan, transportTask: task.toUpperCase() };
        methodBody = buildTransparentTableClassrun(plan);
      }

      // The guarded ABAP validates that the selected transportTask is an open
      // Correction task before inserting E071. Do not issue ADT "classify" here:
      // D25 rejects classify on an already-correction task with SCTS_ADT_MSG 25.
      const output = await this.runClassrun(methodBody, 'ZCL_TMP_DDIC_TABL');
      try {
        validateTransparentTableOutput(plan, output);
      } catch (validationError: any) {
        this.fail(
          `ddic_create_transparent_table(${plan.name}): creation/readback did not finish cleanly: ` +
          `${validationError.message}\n${output.trim()}`
        );
      }

      return this.success({
        dryRun: false,
        message: `Created and activated transparent table ${plan.name}; readback contract passed.`,
        name: plan.name,
        package: plan.package,
        transport: plan.transport,
        transportTask: plan.transportTask,
        output,
        plan,
      });
    } catch (error: any) {
      this.fail(formatError(`ddic_create_transparent_table(${args?.name || '<unknown>'})`, error));
    }
  }

  private async handleDdicElement(args: any): Promise<any> {
    const path = this.parsePath(args.path);
    try {
      const element = await this.withSession(() =>
        this.adtclient.ddicElement(
          path,
          args.getTargetForAssociation ?? false,
          args.getExtensionViews       ?? false,
          args.getSecondaryObjects     ?? false
        )
      );
      return this.success(element);
    } catch (error: any) {
      this.fail(formatError(`ddic_element(${args.path})`, error));
    }
  }

  private async handleDdicReferences(args: any): Promise<any> {
    const path = this.parsePath(args.path);
    try {
      const refs = await this.withSession(() =>
        this.adtclient.ddicRepositoryAccess(path)
      );
      return this.success({ path: args.path, count: (refs as any[]).length, references: refs });
    } catch (error: any) {
      this.fail(formatError(`ddic_references(${args.path})`, error));
    }
  }
}
