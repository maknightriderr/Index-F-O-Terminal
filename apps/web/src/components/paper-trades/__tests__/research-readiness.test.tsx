import React from 'react';
import {describe,it,expect,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import type {FreshResearchReadiness} from '@fno/shared';
import {ResearchReadiness} from '../research-readiness';
afterEach(cleanup);
const report:FreshResearchReadiness={observedAt:Date.parse('2026-11-01T08:00:00Z'),sources:[{table:'market_ticks',evidence:'PRICE_OBSERVATIONS',limit:'Missing verified depth units',available:true,hasRows:true,estimatedRows:null},{table:'bar_archive',evidence:'SIGNAL_BARS',limit:'Not option execution data',available:false,hasRows:false,estimatedRows:null}],protocol:{id:'protocol',digest:'hash',version:'NEW-INTRADAY-1.3',registered:false,registeredAt:null,captureStart:'2026-11-02T00:00:00+05:30',developmentEnd:'2026-11-30T23:59:59+05:30',validationEnd:'2026-12-31T23:59:59+05:30',holdoutEnd:'2027-06-30T23:59:59+05:30',holdoutBlindnessEnforced:false,note:'Dates do not verify future calendars.'},blockers:['HISTORICAL_DATASET_NOT_QUALIFIED'],note:'Schema presence only; no outcomes read.'};
describe('research preparation is separate from performance validation',()=>{
 it('does not turn table presence or unknown row estimates into a verified backtest',()=>{render(<ResearchReadiness report={report}/>);const table=screen.getByRole('table',{name:'Research data inventory'});expect(table).toHaveTextContent('Rows observed');expect(table).toHaveTextContent('Unknown');expect(table).toHaveTextContent('Table unavailable');expect(screen.getByText(/Protocol registration not verified/)).toBeInTheDocument();expect(screen.getByText(/Previously viewed outcomes cannot be claimed untouched/)).toBeInTheDocument();expect(screen.getByText(/HISTORICAL DATASET NOT QUALIFIED/)).toBeInTheDocument();});
 it('distinguishes an unavailable read from an older API with no report',()=>{const {rerender,container}=render(<ResearchReadiness report={null}/>);expect(screen.getByText(/Research inventory unavailable/)).toBeInTheDocument();rerender(<ResearchReadiness report={undefined}/>);expect(container).toBeEmptyDOMElement();});
});
