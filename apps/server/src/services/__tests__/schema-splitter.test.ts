import {describe,it,expect,vi} from 'vitest';
vi.mock('../../lib/db.js',()=>({sql:{}}));
vi.mock('../../lib/logger.js',()=>({logger:{info(){},warn(){},error(){}}}));
import {splitStatements} from '../ensure-capture-schema.js';
describe('boot migration statement boundaries',()=>{
 it('retains dollar-quoted trigger bodies and their internal comments/semicolons as one statement',()=>{
  const parts=splitStatements("-- setup\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN PERFORM ';'; -- inner comment\nPERFORM 2; END $body$; SELECT 3;");
  expect(parts).toHaveLength(2);expect(parts[0]).toContain("PERFORM ';';");expect(parts[0]).toContain('-- inner comment');expect(parts[1]).toBe('SELECT 3');
 });
 it('handles escaped strings, quoted identifiers and nested comments without splitting their content',()=>{
  expect(splitStatements(String.raw`SELECT E'one\';two'; SELECT "semi;colon"; /* outer ; /* nested ; */ end */ SELECT 'a;''b';`)).toHaveLength(3);
  expect(splitStatements('-- only a comment')).toEqual([]);expect(splitStatements('SELECT 1; -- trailing')).toEqual(['SELECT 1']);
 });
 it('rejects unterminated literals and block comments before executing partial SQL',()=>{
  for(const sql of ["SELECT 'unfinished",'DO $$ BEGIN; END;','/* never closed'])expect(()=>splitStatements(sql)).toThrow('UNTERMINATED_SQL_LITERAL_OR_COMMENT');
 });
});
