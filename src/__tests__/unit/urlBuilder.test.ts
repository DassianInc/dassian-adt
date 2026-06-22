import {
  encodeAbapName,
  buildObjectUrl,
  buildSourceUrl,
  buildClassIncludeUrl,
  buildFunctionModuleUrl,
  buildFunctionIncludeUrl,
  buildPackageUrl,
  getSupportedTypes,
  NESTED_TYPES
} from '../../lib/urlBuilder';

describe('encodeAbapName', () => {
  it('lowercases plain name', () => {
    expect(encodeAbapName('ZCL_TEST')).toBe('zcl_test');
  });

  it('encodes namespace slashes', () => {
    expect(encodeAbapName('/DSN/CL_TEST')).toBe('%2fdsn%2fcl_test');
  });

  it('encodes dollar sign', () => {
    expect(encodeAbapName('$TMP')).toBe('%24tmp');
  });

  it('handles double-namespace object', () => {
    expect(encodeAbapName('/DSN/CL_S4CM_CMB_CONTRACT')).toBe('%2fdsn%2fcl_s4cm_cmb_contract');
  });

  it('throws on empty string', () => {
    expect(() => encodeAbapName('')).toThrow('Object name is required');
  });

  it('throws on undefined', () => {
    expect(() => encodeAbapName(undefined as any)).toThrow();
  });

  it('throws on null', () => {
    expect(() => encodeAbapName(null as any)).toThrow();
  });
});

describe('buildObjectUrl', () => {
  // Classes
  it('CLAS', () => {
    expect(buildObjectUrl('ZCL_TEST', 'CLAS')).toBe('/sap/bc/adt/oo/classes/zcl_test');
  });

  it('CLAS/OC (alias)', () => {
    expect(buildObjectUrl('ZCL_TEST', 'CLAS/OC')).toBe('/sap/bc/adt/oo/classes/zcl_test');
  });

  it('namespaced CLAS', () => {
    expect(buildObjectUrl('/DSN/CL_TEST', 'CLAS')).toBe('/sap/bc/adt/oo/classes/%2fdsn%2fcl_test');
  });

  // Interfaces
  it('INTF/OI', () => {
    expect(buildObjectUrl('ZIF_TEST', 'INTF/OI')).toBe('/sap/bc/adt/oo/interfaces/zif_test');
  });

  // Programs
  it('PROG/P', () => {
    expect(buildObjectUrl('ZPROG', 'PROG/P')).toBe('/sap/bc/adt/programs/programs/zprog');
  });

  it('PROG/I (includes — different path)', () => {
    expect(buildObjectUrl('ZINCL', 'PROG/I')).toBe('/sap/bc/adt/programs/includes/zincl');
  });

  // Function groups
  it('FUGR/F', () => {
    expect(buildObjectUrl('/DSN/010BWE', 'FUGR/F')).toBe('/sap/bc/adt/functions/groups/%2fdsn%2f010bwe');
  });

  // CDS
  it('DDLS/DF', () => {
    expect(buildObjectUrl('/DSN/C_CPR_SQL_VIEW', 'DDLS/DF')).toBe('/sap/bc/adt/ddic/ddl/sources/%2fdsn%2fc_cpr_sql_view');
  });

  it('DDLX/EX', () => {
    expect(buildObjectUrl('ZEXT', 'DDLX/EX')).toBe('/sap/bc/adt/ddic/ddlx/sources/zext');
  });

  // DDIC objects
  it('TABL/DT', () => {
    expect(buildObjectUrl('ZTABLE', 'TABL/DT')).toBe('/sap/bc/adt/ddic/tables/ztable');
  });

  it('TABL/DS (structures)', () => {
    expect(buildObjectUrl('ZSTRUCT', 'TABL/DS')).toBe('/sap/bc/adt/ddic/structures/zstruct');
  });

  it('DTEL/DE', () => {
    expect(buildObjectUrl('ZDTEL', 'DTEL/DE')).toBe('/sap/bc/adt/ddic/dataelements/zdtel');
  });

  it('DOMA/DD', () => {
    expect(buildObjectUrl('ZDOMA', 'DOMA/DD')).toBe('/sap/bc/adt/ddic/domains/zdoma');
  });

  // Access control
  it('DCLS/DL', () => {
    expect(buildObjectUrl('ZDCLS', 'DCLS/DL')).toBe('/sap/bc/adt/dcls/zdcls');
  });

  // RAP / OData
  it('BDEF', () => {
    expect(buildObjectUrl('ZBDEF', 'BDEF')).toBe('/sap/bc/adt/bo/behaviordefinitions/zbdef');
  });

  it('SRVD/SRV', () => {
    expect(buildObjectUrl('ZSRVD', 'SRVD/SRV')).toBe('/sap/bc/adt/ddic/srvd/sources/zsrvd');
  });

  it('SRVB/SVB', () => {
    expect(buildObjectUrl('ZSRVB', 'SRVB/SVB')).toBe('/sap/bc/adt/businessservices/bindings/zsrvb');
  });

  // Enhancements
  it('ENHO/XHH', () => {
    expect(buildObjectUrl('ZENHO', 'ENHO/XHH')).toBe('/sap/bc/adt/enhancements/enhoxhh/zenho');
  });

  it('ENHS', () => {
    expect(buildObjectUrl('ZENHS', 'ENHS')).toBe('/sap/bc/adt/enhancements/spots/zenhs');
  });

  // Packages
  it('DEVC', () => {
    expect(buildObjectUrl('ZPACKAGE', 'DEVC')).toBe('/sap/bc/adt/packages/zpackage');
  });

  // Message classes
  it('MSAG/N', () => {
    expect(buildObjectUrl('ZMSG', 'MSAG/N')).toBe('/sap/bc/adt/messageclass/zmsg');
  });

  // Views
  it('VIEW/DV', () => {
    expect(buildObjectUrl('ZVIEW', 'VIEW/DV')).toBe('/sap/bc/adt/ddic/views/zview');
  });

  // Table types
  it('TTYP', () => {
    expect(buildObjectUrl('ZTTYP', 'TTYP')).toBe('/sap/bc/adt/ddic/tabletypes/zttyp');
  });

  // Search helps
  it('SHLP', () => {
    expect(buildObjectUrl('ZSHLP', 'SHLP')).toBe('/sap/bc/adt/ddic/searchhelps/zshlp');
  });

  // Case insensitivity for type
  it('accepts lowercase type', () => {
    expect(buildObjectUrl('ZCL_TEST', 'clas/oc')).toBe('/sap/bc/adt/oo/classes/zcl_test');
  });

  // Error cases
  it('throws on unknown type', () => {
    expect(() => buildObjectUrl('FOO', 'BOGUS/XX')).toThrow('Unknown object type');
  });

  it('throws on empty name', () => {
    expect(() => buildObjectUrl('', 'CLAS')).toThrow('Object name is required');
  });

  it('throws on empty type', () => {
    expect(() => buildObjectUrl('ZCL_TEST', '')).toThrow('Object type is required');
  });

  it('throws on undefined name', () => {
    expect(() => buildObjectUrl(undefined as any, 'CLAS')).toThrow();
  });

  it('throws on undefined type', () => {
    expect(() => buildObjectUrl('ZCL_TEST', undefined as any)).toThrow();
  });
});

describe('buildSourceUrl', () => {
  it('appends /source/main', () => {
    expect(buildSourceUrl('ZCL_TEST', 'CLAS')).toBe('/sap/bc/adt/oo/classes/zcl_test/source/main');
  });

  it('works with namespaced objects', () => {
    expect(buildSourceUrl('/DSN/CL_TEST', 'CLAS')).toBe('/sap/bc/adt/oo/classes/%2fdsn%2fcl_test/source/main');
  });

  it('propagates errors from buildObjectUrl', () => {
    expect(() => buildSourceUrl('', 'CLAS')).toThrow();
  });
});

describe('buildClassIncludeUrl', () => {
  it('builds implementations include URL for a namespaced class', () => {
    expect(buildClassIncludeUrl('/DSN/BP_S4FD_PD_I_ITM_MAP_HDR', 'implementations'))
      .toBe('/sap/bc/adt/oo/classes/%2fdsn%2fbp_s4fd_pd_i_itm_map_hdr/includes/implementations');
  });

  it('lowercases include type', () => {
    expect(buildClassIncludeUrl('ZCL_TEST', 'TESTCLASSES'))
      .toBe('/sap/bc/adt/oo/classes/zcl_test/includes/testclasses');
  });

  it('throws on missing include type', () => {
    expect(() => buildClassIncludeUrl('ZCL_TEST', '')).toThrow('Class include type is required');
  });
});

describe('buildFunctionModuleUrl', () => {
  it('builds namespaced FM URL', () => {
    expect(buildFunctionModuleUrl('/DSN/010BWE', '/DSN/010BWE_SC'))
      .toBe('/sap/bc/adt/functions/groups/%2fdsn%2f010bwe/fmodules/%2fdsn%2f010bwe_sc');
  });

  it('builds plain FM URL', () => {
    expect(buildFunctionModuleUrl('ZBILLING', 'ZBILLING_CALC'))
      .toBe('/sap/bc/adt/functions/groups/zbilling/fmodules/zbilling_calc');
  });
});

describe('buildFunctionIncludeUrl', () => {
  it('builds namespaced include URL', () => {
    expect(buildFunctionIncludeUrl('/DSN/010BWE', '/DSN/010BWE_01'))
      .toBe('/sap/bc/adt/functions/groups/%2fdsn%2f010bwe/includes/%2fdsn%2f010bwe_01');
  });
});

describe('buildPackageUrl', () => {
  it('handles $TMP', () => {
    expect(buildPackageUrl('$TMP')).toBe('/sap/bc/adt/packages/%24tmp');
  });

  it('handles namespaced package', () => {
    expect(buildPackageUrl('/DSN/CORE')).toBe('/sap/bc/adt/packages/%2fdsn%2fcore');
  });

  it('handles plain package', () => {
    expect(buildPackageUrl('ZPACKAGE')).toBe('/sap/bc/adt/packages/zpackage');
  });
});

describe('getSupportedTypes', () => {
  const types = getSupportedTypes();

  it('returns array', () => {
    expect(Array.isArray(types)).toBe(true);
  });

  it('includes major types', () => {
    expect(types).toContain('CLAS');
    expect(types).toContain('PROG');
    expect(types).toContain('DDLS');
    expect(types).toContain('FUGR');
    expect(types).toContain('TABL');
    expect(types).toContain('INTF');
  });

  it('is sorted', () => {
    expect(types).toEqual([...types].sort());
  });

  it('contains only primary types (no slashes)', () => {
    expect(types.every(t => !t.includes('/'))).toBe(true);
  });
});

describe('NESTED_TYPES', () => {
  it('contains FUGR/I and FUGR/FF', () => {
    expect(NESTED_TYPES.has('FUGR/I')).toBe(true);
    expect(NESTED_TYPES.has('FUGR/FF')).toBe(true);
  });

  it('does not contain regular FUGR types', () => {
    expect(NESTED_TYPES.has('FUGR')).toBe(false);
    expect(NESTED_TYPES.has('FUGR/F')).toBe(false);
  });

  it('does not contain non-FUGR types', () => {
    expect(NESTED_TYPES.has('CLAS')).toBe(false);
    expect(NESTED_TYPES.has('PROG/P')).toBe(false);
  });
});

describe('buildObjectUrl subtype fallback', () => {
  it('falls back to base CLAS for CLAS/OM, CLAS/OCN, etc.', () => {
    expect(buildObjectUrl('ZCL_FOO', 'CLAS/OM')).toBe('/sap/bc/adt/oo/classes/zcl_foo');
    expect(buildObjectUrl('ZCL_FOO', 'CLAS/OCN')).toBe('/sap/bc/adt/oo/classes/zcl_foo');
  });

  it('falls back to base BDEF for BDEF/BO', () => {
    expect(buildObjectUrl('ZBD', 'BDEF/BO')).toBe('/sap/bc/adt/bo/behaviordefinitions/zbd');
  });

  it('falls back to base ENHS for ENHS/XB', () => {
    expect(buildObjectUrl('ZSPOT', 'ENHS/XB')).toBe('/sap/bc/adt/enhancements/spots/zspot');
  });

  it('still throws for a genuinely unsupported base type', () => {
    expect(() => buildObjectUrl('FOO', 'WAPA')).toThrow('Unknown object type');
  });

  it('exact-match subtypes are unaffected', () => {
    expect(buildObjectUrl('ZV', 'VIEW/DV')).toBe('/sap/bc/adt/ddic/views/zv');
  });
});
