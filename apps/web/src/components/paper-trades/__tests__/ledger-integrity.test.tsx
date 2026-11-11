import type { LooseJson } from '@/lib/loose-json';
import React from 'react';
import {describe,it,expect,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {LedgerIntegrity} from '../ledger-integrity';
const report:LooseJson={scope:'LATEST_100_CURRENT_VERSION',sampled:0,sampleTruncated:false,consistent:0,incomplete:0,inconsistent:0,closedChecked:0,rows:[],note:'Recorded first/latest evidence only; actual fills and profitability are not certified.'};
afterEach(cleanup);
describe('recorded paper ledger quality disclosure',()=>{
 it('does not mistake an empty sample for a passed lifecycle validation',()=>{render(<LedgerIntegrity report={report}/>);expect(screen.getByText('No filled paper records have been checked yet.')).toBeInTheDocument();expect(screen.queryByRole('table')).toBeNull();expect(screen.getByText(/not certified/)).toBeInTheDocument();});
 it('separates incomplete evidence, conflicting P&L and event-policy warnings without claiming older history passed',()=>{render(<LedgerIntegrity report={{...report,sampled:2,sampleTruncated:true,incomplete:1,inconsistent:1,rows:[{id:'a',contract:'NSE_FO:1',positionStatus:'CLOSED',phase:'CLOSED',verdict:'INCONSISTENT',eventEvidenceClass:'EVENT_DATA_UNVERIFIED',issues:['NET_PNL_ROW_MISMATCH'],missing:[]},{id:'b',contract:'MCX_FO:2',positionStatus:'EXIT_PENDING',phase:'EXIT_PENDING',verdict:'INCOMPLETE',eventEvidenceClass:'EVENT_POLICY_UNRECORDED',issues:[],missing:['ENTRY_FILL_EVENT_MISSING']}]}}/>);expect(screen.getByRole('table',{name:'Recent recorded paper ledger checks'})).toHaveTextContent('NET PNL ROW MISMATCH');expect(screen.getByText('ENTRY FILL EVENT MISSING')).toBeInTheDocument();expect(screen.getByText(/older history is outside/)).toBeInTheDocument();expect(screen.getByText('EVENT_DATA_UNVERIFIED')).toBeInTheDocument();});
 it('tolerates an older API without manufacturing a report',()=>{const {container}=render(<LedgerIntegrity report={undefined}/>);expect(container).toBeEmptyDOMElement();});
});
